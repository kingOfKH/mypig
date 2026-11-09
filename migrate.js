'use strict';
/**
 * StarClick 服务端「数据迁移」核心：一键导出 / 覆盖导入。
 *
 * 目标：
 *  - 老服务器：后台点「导出」得到一个 zip，里面只有运行时数据，不含源码、
 *    node_modules、.git；
 *  - 新服务器：git clone 源码后，后台点「导入」上传该 zip，即可完整接管老服务器数据。
 *
 * 覆盖范围（按需求确认：「以老服务器导出的数据为准 / 全部带走 / 自定义表情进包」）：
 *  ① data/                 —— 设备档案、信任关系、积分、聊天/快照/头像/剪贴板、
 *                              自定义表情元数据、TLS 证书密钥、后台登录签名密钥
 *                              .session-secret 等全部运行时状态
 *  ② updates/              —— 已发布 APK 与版本元数据
 *  ③ public/emoji/custom/  —— 用户上传的自定义表情图片（不随 git clone 携带）
 *  ④ .env*                 —— 环境变量 / 后台账号配置（.env.example 属仓库模板，不进包）
 *
 * 不含：*.js / *.html / public 下的静态资源（随 git clone 获取）、node_modules、.git、backups。
 *
 * 包结构：
 *   manifest.json                     —— 格式标识、生成时间、各区统计
 *   payload/data/...
 *   payload/updates/...
 *   payload/public/emoji/custom/...
 *   payload/env/.env
 *
 * 安全护栏：路径白名单 + 逐段防目录穿越 + 目标 resolve 二次校验 + 拒绝符号链接 +
 *   文件数/总大小/单文件大小上限 + 先全量校验再落盘 + 导入前自动备份 +
 *   写入失败自动回滚。
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const FORMAT = 'starclick-migrate';
const FORMAT_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';
const PAYLOAD_PREFIX = 'payload/';

const MAX_FILES = 50000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_SINGLE_BYTES = 512 * 1024 * 1024;     // 512 MB

const SECTIONS = [
    { key: 'data', zipPrefix: 'payload/data/', dest: 'data', label: 'data/ · 全部运行时状态与密钥证书' },
    { key: 'updates', zipPrefix: 'payload/updates/', dest: 'updates', label: 'updates/ · 已发布安装包与版本信息' },
    { key: 'emojiCustom', zipPrefix: 'payload/public/emoji/custom/', dest: 'public/emoji/custom', label: 'public/emoji/custom/ · 自定义表情图片' },
    { key: 'env', zipPrefix: 'payload/env/', dest: '', label: '.env* · 环境变量与后台账号配置' },
];

class MigrateError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MigrateError';
        this.status = 400;
    }
}

function formatBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
    return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 本地时间戳（避免 toISOString 的 UTC 与国内时间差 8 小时） */
function localStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function checkLimits(stats, singleSize, rel) {
    if (stats.files > MAX_FILES) throw new MigrateError(`文件数量超过上限 ${MAX_FILES} 个，请拆分后手动迁移`);
    if (stats.bytes > MAX_TOTAL_BYTES) throw new MigrateError(`数据总量超过上限 ${formatBytes(MAX_TOTAL_BYTES)}，请手动打包迁移`);
    if (singleSize > MAX_SINGLE_BYTES) throw new MigrateError(`单文件过大（${rel}），超过 ${formatBytes(MAX_SINGLE_BYTES)}`);
}

/** 递归收集目录（不跟随符号链接；空目录也保留，保证导入后目录结构与老服务器一致） */
function collectDir(absRoot, relPrefix, out, stats) {
    if (!fs.existsSync(absRoot)) return;
    let names;
    try { names = fs.readdirSync(absRoot); } catch (e) { return; }
    for (const name of names) {
        const abs = path.join(absRoot, name);
        let st;
        try { st = fs.lstatSync(abs); } catch (e) { continue; }
        if (st.isSymbolicLink()) continue;
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        if (st.isDirectory()) {
            out.dirs.push(rel);
            collectDir(abs, rel, out, stats);
        } else if (st.isFile()) {
            stats.files += 1;
            stats.bytes += st.size;
            checkLimits(stats, st.size, rel);
            out.files.push({ abs, rel, size: st.size });
        }
    }
}

/** 根目录 .env* 配置（.env.example 是仓库模板，随 git clone 获取，不进包） */
function collectEnv(rootDir, out, stats) {
    let names;
    try { names = fs.readdirSync(rootDir); } catch (e) { return; }
    for (const name of names) {
        if (!name.startsWith('.env') || name === '.env.example') continue;
        const abs = path.join(rootDir, name);
        let st;
        try { st = fs.lstatSync(abs); } catch (e) { continue; }
        if (!st.isFile() || st.isSymbolicLink()) continue;
        stats.files += 1;
        stats.bytes += st.size;
        checkLimits(stats, st.size, name);
        out.files.push({ abs, rel: name, size: st.size });
    }
}

/** 构建迁移包（导出与「导入前自动备份」共用同一套打包逻辑） */
function buildExportZip(options) {
    const opts = options || {};
    const rootDir = path.resolve(opts.rootDir || __dirname);
    const kind = opts.kind === 'backup' ? 'backup' : 'export';
    const zip = new AdmZip();
    const stats = { files: 0, bytes: 0, dirs: 0 };
    const sectionStats = {};

    for (const sec of SECTIONS) {
        const out = { files: [], dirs: [] };
        if (sec.key === 'env') collectEnv(rootDir, out, stats);
        else collectDir(path.resolve(rootDir, sec.dest), '', out, stats);
        stats.dirs += out.dirs.length;
        sectionStats[sec.key] = {
            files: out.files.length,
            bytes: out.files.reduce((s, f) => s + f.size, 0)
        };
        for (const rel of out.dirs) zip.addFile(sec.zipPrefix + rel + '/', Buffer.alloc(0));
        for (const f of out.files) zip.addFile(sec.zipPrefix + f.rel, fs.readFileSync(f.abs));
    }

    const manifest = {
        format: FORMAT,
        version: FORMAT_VERSION,
        kind,
        createdAt: new Date().toISOString(),
        createdAtLocal: new Date().toLocaleString('zh-CN'),
        sections: SECTIONS.map(s => ({ key: s.key, label: s.label, ...sectionStats[s.key] })),
        files: stats.files,
        dirs: stats.dirs,
        bytes: stats.bytes,
        note: '覆盖导入：目标机器现有 data/、updates/、public/emoji/custom/、.env* 会先被清空，以本包为准。'
    };
    zip.addFile(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    return { buffer: zip.toBuffer(), manifest };
}

function readManifest(zip) {
    const entry = zip.getEntry(MANIFEST_NAME);
    if (!entry) throw new MigrateError('缺少 manifest.json，这不是 StarClick 数据迁移包');
    let obj;
    try { obj = JSON.parse(entry.getData().toString('utf8')); }
    catch (e) { throw new MigrateError('manifest.json 解析失败，迁移包已损坏'); }
    if (!obj || obj.format !== FORMAT) throw new MigrateError('迁移包格式不匹配（format 不是 starclick-migrate）');
    if (!Number.isInteger(obj.version) || obj.version < 1 || obj.version > FORMAT_VERSION) {
        throw new MigrateError(`不支持的迁移包版本 v${obj.version}，当前服务端最高支持 v${FORMAT_VERSION}`);
    }
    return obj;
}

/**
 * 全量校验 zip 内每个条目，产出写入计划。
 * 必须先完整校验通过再动磁盘，避免「写了一半才发现非法路径」留下半套数据。
 */
function validateEntries(rootDir, entries) {
    const plan = [];
    const counts = { files: 0, dirs: 0, bytes: 0, sections: {} };

    for (const entry of entries) {
        const name = String(entry.entryName || '').replace(/\\/g, '/');
        if (name === MANIFEST_NAME) continue;
        if (!name.startsWith(PAYLOAD_PREFIX)) throw new MigrateError(`包内含非授权路径：${name}`);
        if (name.indexOf('\0') >= 0) throw new MigrateError('包内含非法空字符路径');

        const sec = SECTIONS.find(s => name.startsWith(s.zipPrefix));
        if (!sec) throw new MigrateError(`包内含非授权目录：${name}`);

        let rel = name.slice(sec.zipPrefix.length);
        const isDir = rel === '' || rel.endsWith('/');
        rel = rel.replace(/\/+$/, '');
        if (rel === '') continue; // section 根条目本身，忽略

        const parts = rel.split('/').filter(p => p !== '');
        if (parts.some(p => p === '.' || p === '..' || p.indexOf(':') >= 0)) {
            throw new MigrateError(`包内含目录穿越路径：${name}`);
        }
        if (sec.key === 'env' && (isDir || parts.length !== 1 || !parts[0].startsWith('.env') || parts[0] === '.env.example')) {
            throw new MigrateError(`env 区只允许 .env* 配置文件：${name}`);
        }

        const destRoot = path.resolve(rootDir, sec.dest);
        const dest = path.resolve(destRoot, ...parts);
        if (dest !== destRoot && !dest.startsWith(destRoot + path.sep)) {
            throw new MigrateError(`包内路径越界：${name}`);
        }

        // 拒绝符号链接（zip Unix 外部属性高 16 位记录文件类型，0o120000 = symlink）
        const attr = (entry.header && entry.header.attr) || 0;
        if (((attr >>> 16) & 0o170000) === 0o120000) {
            throw new MigrateError(`包内含符号链接，已拒绝：${name}`);
        }

        const size = isDir ? 0 : (Number(entry.header && entry.header.size) || 0);
        if (size > MAX_SINGLE_BYTES) throw new MigrateError(`包内单文件过大：${name}`);
        if (!isDir) {
            counts.files += 1;
            counts.bytes += size;
            if (counts.files > MAX_FILES) throw new MigrateError(`包内文件数量超过上限 ${MAX_FILES}`);
            if (counts.bytes > MAX_TOTAL_BYTES) throw new MigrateError(`包内数据总量超过上限 ${formatBytes(MAX_TOTAL_BYTES)}`);
            counts.sections[sec.key] = (counts.sections[sec.key] || 0) + 1;
        } else {
            counts.dirs += 1;
        }
        plan.push({ dest, isDir, entry });
    }
    return { plan, counts };
}

function removeTree(dir) {
    if (typeof fs.rmSync === 'function') fs.rmSync(dir, { recursive: true, force: true });
    else fs.rmdirSync(dir, { recursive: true });
}

/**
 * 清空目标但保留目录本身：data/ 下可能有服务正在写的日志流（Windows 上被占用的
 * 目录无法整体删除），逐项删除 + 单文件失败跳过，可让导入在低峰期稳定运行。
 * 跳过的文件会在导入摘要里列出，并提示重启服务。
 */
function clearDir(dir) {
    const skipped = [];
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        return skipped;
    }
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return skipped; }
    for (const name of names) {
        const abs = path.join(dir, name);
        try {
            const st = fs.lstatSync(abs);
            if (st.isDirectory()) removeTree(abs);
            else fs.unlinkSync(abs);
        } catch (e) {
            skipped.push(name);
        }
    }
    return skipped;
}

/** 按写入计划覆盖落盘：先清空全部目标，再按包重建（新服务器多余数据不保留） */
function applyPlan(rootDir, plan) {
    const skipped = [];
    for (const sec of SECTIONS) {
        if (sec.key === 'env') {
            let names = [];
            try { names = fs.readdirSync(rootDir); } catch (e) { /* 忽略 */ }
            for (const name of names) {
                if (!name.startsWith('.env') || name === '.env.example') continue;
                const abs = path.join(rootDir, name);
                try { if (fs.lstatSync(abs).isFile()) fs.unlinkSync(abs); }
                catch (e) { skipped.push(name); }
            }
        } else {
            const dir = path.resolve(rootDir, sec.dest);
            for (const s of clearDir(dir)) skipped.push(`${sec.dest}/${s}`);
        }
    }
    for (const item of plan) {
        if (item.isDir) {
            fs.mkdirSync(item.dest, { recursive: true });
        } else {
            fs.mkdirSync(path.dirname(item.dest), { recursive: true });
            fs.writeFileSync(item.dest, item.entry.getData());
        }
    }
    // 清空阶段被占用而没删掉的旧文件，若包里同名则已被覆盖；这里只回报给页面供人工确认。
    return skipped;
}

/** 导入前自动备份：只保留最新一份（先写新包，再删上一份），便于失败回滚 / 人工恢复 */
function createBackup(rootDir) {
    const dir = path.join(rootDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const name = `migrate-before-import_${localStamp()}_${process.pid}.zip`;
    const target = path.join(dir, name);
    const { buffer } = buildExportZip({ rootDir, kind: 'backup' });
    fs.writeFileSync(target, buffer);
    removeZipFiles(dir, name);
    // 顺带清理 10 分钟前的上传临时残留（正常流程 finally 已删，仅进程崩溃残留会留下）
    removeZipFiles(path.join(dir, '_uploads'), '', UPLOAD_RESIDUE_MIN_AGE_MS);
    return {
        name,
        relPath: `backups/${name}`,
        path: target,
        bytes: buffer.length
    };
}

/**
 * 覆盖导入一个迁移包。
 * @param {{rootDir?:string, buffer:Buffer, onApplied?:Function}} options
 *        onApplied 在落盘成功后调用（由 server.js 热重载内存缓存），其异常不影响导入结果。
 */
function importZipBuffer(options) {
    const opts = options || {};
    const rootDir = path.resolve(opts.rootDir || __dirname);
    const startedAt = Date.now();
    if (!Buffer.isBuffer(opts.buffer) || opts.buffer.length === 0) throw new MigrateError('上传内容为空');

    let zip;
    try { zip = new AdmZip(opts.buffer); }
    catch (e) { throw new MigrateError('不是有效的 zip 文件：' + (e && e.message)); }

    const manifest = readManifest(zip);
    const { plan, counts } = validateEntries(rootDir, zip.getEntries());
    if (counts.files === 0 && counts.dirs === 0) throw new MigrateError('迁移包内没有任何数据文件');

    const backup = createBackup(rootDir);
    let skipped = [];
    try {
        skipped = applyPlan(rootDir, plan);
    } catch (e) {
        let rollback = '自动回滚失败';
        try {
            const bz = new AdmZip(fs.readFileSync(backup.path));
            const bp = validateEntries(rootDir, bz.getEntries());
            applyPlan(rootDir, bp.plan);
            rollback = '已自动回滚到导入前数据';
        } catch (re) {
            rollback = `自动回滚失败（${re && re.message}）`;
        }
        throw new MigrateError(`写入失败：${e && e.message}；${rollback}；备份包：${backup.relPath}`);
    }

    if (typeof opts.onApplied === 'function') {
        try { opts.onApplied(); }
        catch (e) { console.warn('[migrate] onApplied 回调失败:', e && e.message); }
    }

    return {
        success: true,
        files: counts.files,
        dirs: counts.dirs,
        bytes: counts.bytes,
        sections: counts.sections,
        packageCreatedAt: manifest.createdAtLocal || manifest.createdAt || '',
        packageKind: manifest.kind || '',
        backup: { name: backup.name, relPath: backup.relPath, bytes: backup.bytes },
        skipped,
        elapsedMs: Date.now() - startedAt,
        needRestart: true,
        message: '数据已按老服务器迁移包完整覆盖，请重启服务以刷新全部运行时状态。'
    };
}

// ==================== 服务端留存包（导出不落盘，备份自动轮转） ====================
// 约定：导出的 zip 是「即打即下」的 Buffer，从不落盘，服务端不产生任何导出副本；
//       只有「导入前自动备份」会落盘，且每次迁入先写新包再删上一份，始终只保留最新一份；
//       _uploads/ 崩溃残留由每次迁入顺带清理（只清 10 分钟前的，避免误删正在上传的文件）。
//       页面只提供列举 / 下载，不再有手动删除 / 清空。
const BACKUP_NAME_RE = /^(?:_uploads\/)?[A-Za-z0-9._-]+\.zip$/;
const UPLOAD_RESIDUE_MIN_AGE_MS = 10 * 60 * 1000;

function backupDir(rootDir) {
    return path.join(path.resolve(rootDir || __dirname), 'backups');
}

/** 严格限定只能操作 backups/ 下的 zip，杜绝 ../ 与任意路径读取 */
function safeBackupPath(rootDir, name) {
    const n = String(name || '');
    if (!BACKUP_NAME_RE.test(n) || n.indexOf('..') >= 0) throw new MigrateError('留存包文件名不合法');
    const base = path.resolve(backupDir(rootDir));
    const abs = path.resolve(base, n);
    if (abs !== base && !abs.startsWith(base + path.sep)) throw new MigrateError('留存包路径不合法');
    return abs;
}

/**
 * 删除目录内的 .zip 留存包（只删文件、不递归、不删目录）。
 * keepName：刚写入的新包，保留它；minAgeMs：只删比该时长更旧的文件，避免误删正在上传的临时包。
 */
function removeZipFiles(dir, keepName, minAgeMs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return 0; }
    let deleted = 0;
    for (const name of names) {
        if (name === keepName || !/^[A-Za-z0-9._-]+\.zip$/.test(name)) continue;
        const abs = path.join(dir, name);
        try {
            const st = fs.lstatSync(abs);
            if (!st.isFile() || st.isSymbolicLink()) continue;
            if (minAgeMs && (Date.now() - st.mtimeMs) < minAgeMs) continue;
            fs.unlinkSync(abs);
            deleted += 1;
        } catch (e) { /* 被占用或已消失，跳过 */ }
    }
    return deleted;
}

/** 列出服务端留存包（按时间倒序）：导入前备份 / 上传临时残留 */
function listBackups(rootDir) {
    const dir = backupDir(rootDir);
    const out = [];
    const scan = (subDir, prefix) => {
        let names = [];
        try { names = fs.readdirSync(subDir); } catch (e) { return; }
        for (const name of names) {
            if (!BACKUP_NAME_RE.test(prefix + name)) continue;
            const abs = path.join(subDir, name);
            let st;
            try { st = fs.lstatSync(abs); } catch (e) { continue; }
            if (!st.isFile() || st.isSymbolicLink()) continue;
            const isBackup = prefix === '' && name.indexOf('migrate-before-import_') === 0;
            out.push({
                name: prefix + name,
                size: st.size,
                mtime: st.mtimeMs,
                mtimeText: new Date(st.mtimeMs).toLocaleString('zh-CN'),
                kind: isBackup ? 'backup' : 'upload',
                kindText: isBackup ? '导入前备份' : '上传临时残留'
            });
        }
    };
    scan(dir, '');
    scan(path.join(dir, '_uploads'), '_uploads/');
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
}

function readBackup(rootDir, name) {
    const abs = safeBackupPath(rootDir, name);
    if (!fs.existsSync(abs)) throw new MigrateError('留存包不存在或已被自动替换');
    return { name: path.basename(abs), buffer: fs.readFileSync(abs) };
}

module.exports = {
    FORMAT,
    FORMAT_VERSION,
    SECTIONS,
    MigrateError,
    buildExportZip,
    importZipBuffer,
    listBackups,
    readBackup,
    formatBytes,
    localStamp,
    limits: { maxFiles: MAX_FILES, maxTotalBytes: MAX_TOTAL_BYTES, maxSingleBytes: MAX_SINGLE_BYTES },
};
