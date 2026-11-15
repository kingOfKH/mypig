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
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { once } = require('events');
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
            out.files.push({ abs, rel, size: st.size, mtimeMs: st.mtimeMs });
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
        out.files.push({ abs, rel: name, size: st.size, mtimeMs: st.mtimeMs });
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

// ==================== 异步流式导出（不阻塞事件循环 / 不整体入内存） ====================
// 旧实现 buildExportZip 是纯同步的：逐文件 readFileSync + AdmZip.addFile，最后 toBuffer()
// 把整包塞进一个超大 Buffer。GB 级生产数据下会长时间占死 Node 单线程（页面全部无响应），
// 且内存峰值约等于「全量数据 + 整包」两份。新的导出改为：
//   ① 只 stat 扫描；② 用 createReadStream 逐文件流式写入临时 zip（STORE 不压缩）；
//   ③ CRC32 用 Node 内置 zlib.crc32 边读边算（配合 data descriptor，只读一遍）；
//   ④ 全程 await 让出事件循环，服务端其余请求照常响应；⑤ 通过任务对象汇报进度。
// 导出的 zip 仍由 importZipBuffer 用 adm-zip 读取，格式完全兼容（data descriptor + 中央目录 CRC）。
const EXPORT_JOB_TTL_MS = 30 * 60 * 1000; // 任务/临时包保留 30 分钟
const EXPORT_MAX_JOBS = 8;
const exportJobs = new Map(); // jobId -> job（进程内临时状态，重启即失效）

function newJobId() {
    return Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

/** DOS 时间/日期（ZIP 头用，本地时区） */
function dosDateTime(ms) {
    const d = new Date(ms || Date.now());
    const year = Math.max(1980, d.getFullYear());
    const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
    const date = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
    return { time, date };
}

/** 只 stat 收集待打包条目，不读文件内容 */
function collectPayload(rootDir) {
    const stats = { files: 0, bytes: 0, dirs: 0 };
    const sectionStats = {};
    const items = []; // {kind:'dir'|'file', zipName, abs, size, mtimeMs}
    for (const sec of SECTIONS) {
        const out = { files: [], dirs: [] };
        if (sec.key === 'env') collectEnv(rootDir, out, stats);
        else collectDir(path.resolve(rootDir, sec.dest), '', out, stats);
        stats.dirs += out.dirs.length;
        sectionStats[sec.key] = { files: out.files.length, bytes: out.files.reduce((s, f) => s + f.size, 0) };
        for (const rel of out.dirs) items.push({ kind: 'dir', zipName: sec.zipPrefix + rel + '/' });
        for (const f of out.files) items.push({ kind: 'file', zipName: sec.zipPrefix + f.rel, abs: f.abs, size: f.size, mtimeMs: f.mtimeMs });
    }
    return { items, stats, sectionStats };
}

function writeBuf(ws, buf) {
    return new Promise((resolve, reject) => {
        ws.write(buf, (err) => err ? reject(err) : resolve());
    });
}
async function writeChunk(ws, buf) {
    if (!ws.write(buf)) await once(ws, 'drain');
}
async function finishStream(ws) {
    const done = once(ws, 'finish');
    ws.end();
    await done;
}

function localHeader(nameBuf, dt, flag, crc, compSize, uncompSize) {
    const b = Buffer.alloc(30);
    b.writeUInt32LE(0x04034b50, 0); // local file header sig
    b.writeUInt16LE(20, 4);         // version needed
    b.writeUInt16LE(flag, 6);       // flags (bit11 UTF-8, bit3 data descriptor)
    b.writeUInt16LE(0, 8);          // method = STORE
    b.writeUInt16LE(dt.time, 10);
    b.writeUInt16LE(dt.date, 12);
    b.writeUInt32LE(crc >>> 0, 14);
    b.writeUInt32LE(compSize >>> 0, 18);
    b.writeUInt32LE(uncompSize >>> 0, 22);
    b.writeUInt16LE(nameBuf.length, 26);
    b.writeUInt16LE(0, 28);         // extra len
    return Buffer.concat([b, nameBuf]);
}
function dataDescriptor(crc, size) {
    const b = Buffer.alloc(16);
    b.writeUInt32LE(0x08074b50, 0); // descriptor sig
    b.writeUInt32LE(crc >>> 0, 4);
    b.writeUInt32LE(size >>> 0, 8);
    b.writeUInt32LE(size >>> 0, 12);
    return b;
}
function centralRecord(rec) {
    const nameBuf = rec.nameBuf;
    const b = Buffer.alloc(46);
    b.writeUInt32LE(0x02014b50, 0); // central dir sig
    b.writeUInt16LE(20, 4);         // version made by
    b.writeUInt16LE(20, 6);         // version needed
    b.writeUInt16LE(rec.flag, 8);
    b.writeUInt16LE(0, 10);         // method = STORE
    b.writeUInt16LE(rec.dt.time, 12);
    b.writeUInt16LE(rec.dt.date, 14);
    b.writeUInt32LE(rec.crc >>> 0, 16);
    b.writeUInt32LE(rec.size >>> 0, 20);
    b.writeUInt32LE(rec.size >>> 0, 24);
    b.writeUInt16LE(nameBuf.length, 28);
    b.writeUInt16LE(0, 30);         // extra
    b.writeUInt16LE(0, 32);         // comment
    b.writeUInt16LE(0, 34);         // disk start
    b.writeUInt16LE(0, 36);         // internal attrs
    b.writeUInt32LE(0, 38);         // external attrs
    b.writeUInt32LE(rec.offset >>> 0, 42);
    return Buffer.concat([b, nameBuf]);
}
function eocd(count, cdSize, cdOffset) {
    const b = Buffer.alloc(22);
    b.writeUInt32LE(0x06054b50, 0);
    b.writeUInt16LE(0, 4);
    b.writeUInt16LE(0, 6);
    b.writeUInt16LE(count & 0xffff, 8);
    b.writeUInt16LE(count & 0xffff, 10);
    b.writeUInt32LE(cdSize >>> 0, 12);
    b.writeUInt32LE(cdOffset >>> 0, 16);
    b.writeUInt16LE(0, 20);
    return b;
}

/** 清理上次进程崩溃残留的临时导出包 */
function purgeExportTmp(rootDir) {
    const dir = path.join(rootDir || __dirname, 'backups', '_exports');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    const now = Date.now();
    for (const name of names) {
        if (!/^export_[A-Za-z0-9_-]+\.zip$/.test(name)) continue;
        const abs = path.join(dir, name);
        try {
            const st = fs.lstatSync(abs);
            if (st.isFile() && now - st.mtimeMs > EXPORT_JOB_TTL_MS) fs.unlinkSync(abs);
        } catch (e) { /* 占用或已消失，跳过 */ }
    }
}

/** 发起一个异步导出任务，立即返回 job（调用方轮询进度） */
function startExportJob(options) {
    const opts = options || {};
    const rootDir = path.resolve(opts.rootDir || __dirname);
    const kind = opts.kind === 'backup' ? 'backup' : 'export';
    // 淘汰过期 / 过多的历史任务，避免内存与临时包无限增长
    for (const [id, j] of exportJobs) {
        const old = Date.now() - j.startTime > EXPORT_JOB_TTL_MS;
        const over = exportJobs.size > EXPORT_MAX_JOBS && j.status !== 'running';
        if (old || over) {
            if (j.tmpPath) fs.unlink(j.tmpPath, () => {});
            exportJobs.delete(id);
        }
    }
    const job = {
        id: newJobId(), rootDir, status: 'running', phase: 'scan', phaseText: '正在扫描文件…',
        filesTotal: 0, filesDone: 0, bytesTotal: 0, doneBytes: 0,
        current: '', error: null, cancel: false, startTime: Date.now(),
        manifest: null, tmpPath: null, fileName: '', rootDir
    };
    exportJobs.set(job.id, job);
    runExportJob(job, kind).catch((e) => {
        job.status = 'error';
        job.error = (e && e.message) || String(e);
        job.phaseText = '导出失败';
        if (job.tmpPath) fs.unlink(job.tmpPath, () => {});
    });
    return job;
}

async function runExportJob(job, kind) {
    const rootDir = job.rootDir;
    // 1) 只 stat 扫描（不读内容，很快）
    const { items, stats, sectionStats } = collectPayload(rootDir);
    job.filesTotal = items.length;
    job.bytesTotal = stats.bytes;

    // 2) 临时包放在 backups/_exports（不在导出范围内，避免自我包含）
    const tmpDir = path.join(rootDir, 'backups', '_exports');
    await fsp.mkdir(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `export_${job.id}.zip`);
    job.tmpPath = tmpPath;
    const ws = fs.createWriteStream(tmpPath, { highWaterMark: 256 * 1024 });
    let pos = 0;
    const central = [];
    const now = Date.now();

    try {
        // 3) 逐条目流式写入
        job.phase = 'packing';
        job.phaseText = '正在打包…';
        for (let i = 0; i < items.length; i++) {
            if (job.cancel) throw new MigrateError('导出已取消');
            const item = items[i];
            job.current = item.zipName;
            const nameBuf = Buffer.from(item.zipName, 'utf8');
            const dt = dosDateTime(item.mtimeMs || now);
            const offset = pos;
            let flag, crc, size;

            if (item.kind === 'dir') {
                flag = 0x0800; // UTF-8
                crc = 0; size = 0;
                await writeBuf(ws, localHeader(nameBuf, dt, flag, 0, 0, 0));
                pos += 30 + nameBuf.length;
            } else {
                flag = 0x0800 | 0x0008; // UTF-8 + data descriptor
                await writeBuf(ws, localHeader(nameBuf, dt, flag, 0, 0, 0));
                pos += 30 + nameBuf.length;
                crc = 0; size = 0;
                const rs = fs.createReadStream(item.abs, { highWaterMark: 256 * 1024 });
                for await (const chunk of rs) {
                    if (job.cancel) { rs.destroy(); throw new MigrateError('导出已取消'); }
                    crc = zlib.crc32(chunk, crc);
                    size += chunk.length;
                    await writeChunk(ws, chunk);
                    pos += chunk.length;
                    job.doneBytes += chunk.length;
                }
                await writeBuf(ws, dataDescriptor(crc, size));
                pos += 16;
                crc = crc >>> 0;
            }
            central.push(centralRecord({ nameBuf, dt, flag, crc, size, offset }));
            job.filesDone = i + 1;
        }

        // 4) manifest 走内存（很小），不用 data descriptor
        const manifest = {
            format: FORMAT, version: FORMAT_VERSION, kind,
            createdAt: new Date().toISOString(), createdAtLocal: new Date().toLocaleString('zh-CN'),
            sections: SECTIONS.map(s => ({ key: s.key, label: s.label, ...sectionStats[s.key] })),
            files: stats.files, dirs: stats.dirs, bytes: stats.bytes,
            note: '覆盖导入：目标机器现有 data/、updates/、public/emoji/custom/、.env* 会先被清空，以本包为准。'
        };
        job.manifest = manifest;
        const mBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
        const mName = Buffer.from(MANIFEST_NAME, 'utf8');
        const mCrc = zlib.crc32(mBuf) >>> 0;
        const mOffset = pos;
        const mDt = dosDateTime(Date.now());
        await writeBuf(ws, localHeader(mName, mDt, 0x0800, mCrc, mBuf.length, mBuf.length));
        pos += 30 + mName.length;
        await writeChunk(ws, mBuf);
        pos += mBuf.length;
        central.push(centralRecord({ nameBuf: mName, dt: mDt, flag: 0x0800, crc: mCrc, size: mBuf.length, offset: mOffset }));

        // 5) 中央目录 + EOCD
        job.phase = 'finalizing';
        job.phaseText = '正在生成索引…';
        const cdOffset = pos;
        let cdSize = 0;
        for (const rec of central) { await writeBuf(ws, rec); cdSize += rec.length; }
        await writeBuf(ws, eocd(central.length, cdSize, cdOffset));
        await finishStream(ws);

        job.fileName = `starclick_migrate_${localStamp()}.zip`;
        job.status = 'done';
        job.phase = 'done';
        job.phaseText = '打包完成';
        job.doneBytes = job.bytesTotal;
        job.current = '';
    } catch (e) {
        try { ws.destroy(); } catch (_) { /* 忽略 */ }
        throw e;
    }
}

/** 供页面轮询的进度快照（纯数据，不含 Buffer/路径等内部字段） */
function getExportJob(jobId) {
    const job = exportJobs.get(String(jobId || ''));
    if (!job) return null;
    const pct = job.status === 'done'
        ? 100
        : (job.bytesTotal > 0 ? Math.min(99, Math.floor(job.doneBytes / job.bytesTotal * 100)) : 0);
    return {
        jobId: job.id, status: job.status, phase: job.phase, phaseText: job.phaseText,
        filesTotal: job.filesTotal, filesDone: job.filesDone,
        bytesTotal: job.bytesTotal, doneBytes: job.doneBytes, percent: pct,
        current: job.current, error: job.error, manifest: job.manifest,
        fileName: job.fileName,
        startedAt: job.startTime, elapsedMs: Date.now() - job.startTime
    };
}

function cancelExportJob(jobId) {
    const job = exportJobs.get(String(jobId || ''));
    if (!job) return false;
    if (job.status === 'running') job.cancel = true;
    return true;
}

function readExportResult(jobId) {
    const job = exportJobs.get(String(jobId || ''));
    if (!job) throw new MigrateError('导出任务不存在或已过期，请重新发起导出');
    if (job.status === 'running') throw new MigrateError('导出尚未完成');
    if (job.status === 'error') throw new MigrateError('导出失败：' + (job.error || '未知错误'));
    if (!job.tmpPath || !fs.existsSync(job.tmpPath)) throw new MigrateError('导出文件已过期，请重新发起导出');
    return {
        path: job.tmpPath,
        name: job.fileName || `starclick_migrate_${localStamp()}.zip`,
        bytes: job.bytesTotal
    };
}

purgeExportTmp(__dirname);

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
    startExportJob,
    getExportJob,
    cancelExportJob,
    readExportResult,
    importZipBuffer,
    listBackups,
    readBackup,
    formatBytes,
    localStamp,
    limits: { maxFiles: MAX_FILES, maxTotalBytes: MAX_TOTAL_BYTES, maxSingleBytes: MAX_SINGLE_BYTES },
};
