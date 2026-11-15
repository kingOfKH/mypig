'use strict';

/**
 * ffmpeg 自检 / 自动补装（服务启动时调用，仿 download-model.js 的幂等风格）。
 *
 * 背景：ffmpeg-static 是 npm 依赖，正常 npm install 时由 postinstall 从 GitHub
 * 下载二进制；国内网络下这一步经常失败，只剩空壳包，call-recording.js 与
 * asr/worker.js 的 ffmpegPath() 回退到裸命令 ffmpeg，系统又没有 → spawn ENOENT，
 * 导致录音无法编码、转写拿不到音轨。
 *
 * 逻辑：
 *  1) 检测已存在的可用 ffmpeg（FFMPEG_PATH → ffmpeg-static 包 → 系统 PATH →
 *     本模块历史缓存），找到就写回 process.env.FFMPEG_PATH 供两处调用点共用。
 *  2) 缺失则后台异步下载静态二进制：外网 GitHub 优先、国内 npmmirror 兜底，
 *     下 .gz（约 29MB）解压后 chmod +x，原子改名到 data/.ffmpeg-bin/，并写回 env。
 *  3) 全程失败只告警，不阻塞启动；下次重启自动重试。FFMPEG_AUTO_INSTALL=0 可关闭下载。
 *
 * 子进程（asr/worker.js）未显式传 env，默认继承父进程 process.env，故写回一次即可生效；
 * 两处 ffmpegPath() 均在调用时读取 env，因此异步下载完成后再写回同样生效。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const VERSION = 'b6.1.1';
const BIN_DIR = path.join(__dirname, '..', 'data', '.ffmpeg-bin');
const AUTO_INSTALL = process.env.FFMPEG_AUTO_INSTALL !== '0';

// 外网优先、国内兜底；外网超时更激进，网络不通时快速切国内
const SOURCES = [
    { name: '外网(GitHub)', base: 'https://github.com/eugeneware/ffmpeg-static/releases/download/' + VERSION, timeout: 8000 },
    { name: '国内(npmmirror)', base: 'https://registry.npmmirror.com/-/binary/ffmpeg-static/' + VERSION, timeout: 20000 },
];

// platform-arch -> ffmpeg-static 二进制文件名（已对照 b6.1.1 release 资产清单）
const ASSET_MAP = {
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
    'linux-arm': 'linux-arm',
    'linux-ia32': 'linux-ia32',
    'darwin-x64': 'darwin-x64',
    'darwin-arm64': 'darwin-arm64',
    'win32-x64': 'win32-x64',
};

function assetKey() {
    return `${process.platform}-${process.arch}`;
}

function extForPlatform() {
    return process.platform === 'win32' ? '.exe' : '';
}

function targetPath(asset) {
    return path.join(BIN_DIR, `ffmpeg-${VERSION}-${asset}${extForPlatform()}`);
}

/** 真正执行一次 `-version`，比只看文件存在更可靠（能识别损坏/无执行权限的二进制） */
function isExecutable(bin) {
    if (!bin) return false;
    try {
        const r = spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 8000, windowsHide: true });
        return !r.error && r.status === 0;
    } catch (_) {
        return false;
    }
}

/** 找到已存在的可用 ffmpeg；找到就写回 process.env.FFMPEG_PATH 供两处调用点共用 */
function findExisting(log) {
    if (process.env.FFMPEG_PATH && isExecutable(process.env.FFMPEG_PATH)) {
        log(`[ffmpeg-setup] 使用 FFMPEG_PATH: ${process.env.FFMPEG_PATH}`);
        return { ok: true, path: process.env.FFMPEG_PATH, source: 'FFMPEG_PATH', version: 'existing' };
    }
    try {
        const bundled = require('ffmpeg-static');
        if (bundled && isExecutable(bundled)) {
            process.env.FFMPEG_PATH = bundled;
            log(`[ffmpeg-setup] 使用 npm 包 ffmpeg-static: ${bundled}`);
            return { ok: true, path: bundled, source: 'ffmpeg-static', version: 'bundled' };
        }
    } catch (_) { /* 包缺失或二进制未下载，继续 */ }
    if (isExecutable('ffmpeg')) {
        process.env.FFMPEG_PATH = 'ffmpeg';
        log('[ffmpeg-setup] 使用系统 PATH 中的 ffmpeg');
        return { ok: true, path: 'ffmpeg', source: 'system-path', version: 'system' };
    }
    // 本模块历史下载过的缓存
    try {
        if (fs.existsSync(BIN_DIR)) {
            for (const name of fs.readdirSync(BIN_DIR)) {
                if (!/^ffmpeg-/.test(name) || /\.(part|gz)$/.test(name)) continue;
                const p = path.join(BIN_DIR, name);
                if (isExecutable(p)) {
                    process.env.FFMPEG_PATH = p;
                    log(`[ffmpeg-setup] 使用本地缓存: ${p}`);
                    return { ok: true, path: p, source: 'cache', version: name };
                }
            }
        }
    } catch (_) { /* ignore */ }
    return null;
}

/** 下载单个文件到 dest（支持重定向/进度/超时）；返回下载字节数 */
function download(url, dest, log, label, timeout, redirects) {
    const times = redirects || 0;
    return new Promise((resolve, reject) => {
        const client = url.startsWith('http://') ? http : https;
        const req = client.get(url, {
            headers: { 'User-Agent': 'starclick-ffmpeg-setup' },
            timeout: timeout,
        }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && times < 8) {
                res.resume();
                const next = new URL(res.headers.location, url).toString();
                return resolve(download(next, dest, log, label, timeout, times + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const total = Number(res.headers['content-length'] || 0);
            let got = 0;
            let lastLog = 0;
            try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (e) { return reject(e); }
            const out = fs.createWriteStream(dest);
            res.on('data', (chunk) => {
                got += chunk.length;
                if (total && Date.now() - lastLog > 5000) {
                    lastLog = Date.now();
                    log(`[ffmpeg-setup] ${label} 下载中 ${(got / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)}MB`);
                }
            });
            res.on('error', (e) => { try { out.destroy(); } catch (_) {} reject(e); });
            out.on('error', reject);
            out.on('finish', () => out.close(() => resolve(got)));
            res.pipe(out);
        });
        req.on('error', reject);
        req.setTimeout(timeout, () => req.destroy(new Error('连接/传输超时')));
    });
}

function gunzipFile(src, dest) {
    return new Promise((resolve, reject) => {
        const gin = zlib.createGunzip();
        const input = fs.createReadStream(src);
        const output = fs.createWriteStream(dest);
        let firstErr = null;
        const onErr = (e) => {
            firstErr = firstErr || e;
            try { input.destroy(); } catch (_) {}
            try { gin.destroy(); } catch (_) {}
            try { output.destroy(); } catch (_) {}
        };
        input.on('error', onErr);
        gin.on('error', onErr);
        output.on('error', onErr);
        output.on('finish', () => { if (firstErr) reject(firstErr); else resolve(); });
        input.pipe(gin).pipe(output);
    });
}

function isGzip(file) {
    try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(2);
        fs.readSync(fd, buf, 0, 2, 0);
        fs.closeSync(fd);
        return buf[0] === 0x1f && buf[1] === 0x8b;
    } catch (_) {
        return false;
    }
}

function rm(file) {
    try { fs.rmSync(file, { force: true }); } catch (_) {}
}

/** 依次尝试外网/国内源下载安装；成功写回 env 并返回结果，全失败返回 null */
async function install(log, asset) {
    const target = targetPath(asset);
    const gzPart = target + '.gz.part';
    const binPart = target + '.part';

    for (const src of SOURCES) {
        const url = `${src.base}/ffmpeg-${asset}.gz`;
        log(`[ffmpeg-setup] 尝试 ${src.name}: ${url}`);
        try {
            await download(url, gzPart, log, src.name, src.timeout);
            if (!isGzip(gzPart)) throw new Error('下载内容不是 gzip 文件');
            if (fs.statSync(gzPart).size < 1024 * 1024) throw new Error('gzip 文件过小');
            log('[ffmpeg-setup] 下载完成，正在解压...');
            await gunzipFile(gzPart, binPart);
            if (fs.statSync(binPart).size < 10 * 1024 * 1024) throw new Error('解压后文件过小');
            if (process.platform !== 'win32') fs.chmodSync(binPart, 0o755);
            if (!isExecutable(binPart)) throw new Error('解压后的文件无法执行');
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.renameSync(binPart, target);
            rm(gzPart);
            process.env.FFMPEG_PATH = target;
            log(`[ffmpeg-setup] ffmpeg 就绪: ${target}`);
            return { ok: true, path: target, source: src.name, version: VERSION };
        } catch (e) {
            log(`[ffmpeg-setup] ${src.name} 失败: ${e && e.message}`);
            rm(gzPart);
            rm(binPart);
        }
    }
    return null;
}

async function doEnsure(log) {
    const existing = findExisting(log);
    if (existing) return existing;

    const asset = ASSET_MAP[assetKey()];
    if (!asset) {
        log(`[ffmpeg-setup] 未支持的平台/架构 ${assetKey()}，请手动安装 ffmpeg 或设置 FFMPEG_PATH`);
        return { ok: false, reason: `unsupported platform ${assetKey()}` };
    }
    if (!AUTO_INSTALL) {
        log('[ffmpeg-setup] 未检测到可用 ffmpeg，且 FFMPEG_AUTO_INSTALL=0 已关闭自动安装');
        return { ok: false, reason: 'auto-install disabled' };
    }

    log(`[ffmpeg-setup] 未检测到可用 ffmpeg，开始自动安装（${VERSION} / ${asset}）...`);
    const installed = await install(log, asset);
    if (installed) return installed;
    log('[ffmpeg-setup] 自动安装失败：外网与国内源均不可用。转写功能将不可用；可手动安装 ffmpeg 或设置 FFMPEG_PATH 后重启。');
    return { ok: false, reason: 'all sources failed' };
}

// 幂等：同一次进程内只执行一次；失败也不 reject，避免未处理的 Promise 异常
let ensurePromise = null;
function ensureFfmpeg(log) {
    const logger = typeof log === 'function' ? log : console.log;
    if (!ensurePromise) {
        ensurePromise = doEnsure(logger).catch((e) => {
            logger('[ffmpeg-setup] 自检异常:', e && e.message);
            return { ok: false, reason: e && e.message };
        });
    }
    return ensurePromise;
}

module.exports = { ensureFfmpeg };

// 供本地测试的纯函数入口，不影响正常运行
module.exports._internals = { findExisting, download, gunzipFile, isGzip, isExecutable, assetKey, targetPath };
