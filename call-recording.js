'use strict';

/**
 * 通话录音归档（服务端）。
 *
 * 数据流：客户端本地上行 mic → 原始 PCM 分块 HTTP 上传 → 这里按参与者存 A/B 双轨
 *        → finalize 时合并成连续 PCM → Opus/Ogg 存档（24kbps 单声道，关 DTX）。
 *
 * 红线：
 * - 只收各自的 mic 轨，A/B 绝不混音；
 * - 存档永不自动删除，只在磁盘超水位时拒绝新归档；
 * - 轨不完整标 complete=false 并保留分块支持补传，绝不产出看似完整的终稿。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CALLS_DIR = path.join(__dirname, 'data', 'calls');
const MAX_CHUNK_BYTES = 512 * 1024;
const READ_CHUNK_LIMIT = 40 * 1024 * 1024; // 单片回听最多 40MB（约 20 分钟）
const MAX_STORAGE_GB = Number(process.env.CALL_REC_MAX_GB || 8);
const SAMPLE_RATE = 16000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

const log = (msg) => console.log(`[call-rec] ${msg}`);

/** 异步路由兜底：响应头已发出时只结束连接，避免二次 setHeader 抛错 */
function fail(res, e) {
    log(`接口异常: ${(e && e.message) || e}`);
    if (res.headersSent) {
        try { res.end(); } catch (_) { /* 忽略 */ }
    } else {
        res.status(500).json({ ok: false, reason: (e && e.message) || 'internal_error' });
    }
}

function ensureDirs() {
    fs.mkdirSync(CALLS_DIR, { recursive: true });
}

function safeCallId(callId) {
    return typeof callId === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(callId) ? callId : null;
}

function callDir(callId) {
    return path.join(CALLS_DIR, callId);
}

function readMeta(callId) {
    const file = path.join(callDir(callId), 'meta.json');
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return null;
    }
}

function writeMeta(callId, meta) {
    const dir = callDir(callId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'meta.json');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, file);
}

function updateMeta(callId, patch) {
    const meta = readMeta(callId) || { callId, tracks: {} };
    const next = { ...meta, ...patch };
    writeMeta(callId, next);
    return next;
}

// ---- 上传/读取令牌 ----
function secret() {
    if (process.env.CALL_REC_SECRET) return process.env.CALL_REC_SECRET;
    ensureDirs();
    const file = path.join(CALLS_DIR, '.secret');
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    return fs.readFileSync(file, 'utf8').trim();
}

function sign(payload) {
    return crypto.createHmac('sha256', secret()).update(payload).digest('hex').slice(0, 32);
}

/** exp=0 表示长期有效（读取令牌） */
function issueToken(callId, role, exp) {
    const payload = `${callId}|${role}|${exp || 0}`;
    return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

function verifyToken(token, callId, role) {
    if (typeof token !== 'string' || !token.includes('.')) return false;
    const [body, sig] = token.split('.');
    let payload = '';
    try {
        payload = Buffer.from(body, 'base64url').toString('utf8');
    } catch (e) {
        return false;
    }
    const expect = sign(payload);
    if (sig.length !== expect.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
    const [cid, r, exp] = payload.split('|');
    if (cid !== callId) return false;
    // 上传令牌只能写自己那条轨，读取令牌只能读：职责不混用
    if (r !== role) return false;
    if (Number(exp) > 0 && Date.now() > Number(exp)) return false;
    return true;
}

// ---- ffmpeg ----
function ffmpegPath() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    try {
        return require('ffmpeg-static');
    } catch (e) {
        return 'ffmpeg';
    }
}

/**
 * 异步执行 ffmpeg。
 * 之前用 execFileSync：长通话归档/首次回听解码会把整个 Node 事件循环卡住
 * （实测 10 分钟音频编码 13.5s、解码 2.6s），期间所有人的 WS/HTTP 都停摆。
 */
function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        execFile(ffmpegPath(), args, { windowsHide: true }, (err) => {
            if (err) reject(err); else resolve();
        });
    });
}

/** 从 Ogg OpusHead 读 pre-skip（单位 48k 样本） */
function readOpusPreSkipMs(oggFile) {
    try {
        const fd = fs.openSync(oggFile, 'r');
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const idx = buf.subarray(0, n).indexOf(Buffer.from('OpusHead'));
        if (idx < 0 || idx + 12 > n) return 0;
        const preSkip = buf.readUInt16LE(idx + 10);
        return Math.round(preSkip / 48);
    } catch (e) {
        return 0;
    }
}

/** 连续 PCM -> Opus/Ogg 存档（24kbps、单声道、关 DTX）；异步，不阻塞事件循环 */
async function encodeOpus(pcmFile, oggFile) {
    fs.mkdirSync(path.dirname(oggFile), { recursive: true });
    await runFfmpeg([
        '-y',
        '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', pcmFile,
        '-c:a', 'libopus', '-b:a', '24k', '-ar', '48000', '-ac', '1',
        '-application', 'voip', '-frame_duration', '20', '-dtx', '0',
        oggFile,
    ]);
}

// ---- 磁盘水位 ----
let usageCache = { at: 0, bytes: 0 };

function dirBytes(dir) {
    let total = 0;
    if (!fs.existsSync(dir)) return 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) total += dirBytes(p);
        else if (entry.isFile()) {
            try { total += fs.statSync(p).size; } catch (e) { /* 忽略 */ }
        }
    }
    return total;
}

/** 只统计存档目录（tracks/transcript），不含上传暂存与可淘汰缓存 */
function archiveBytes() {
    if (Date.now() - usageCache.at < 30000) return usageCache.bytes;
    let total = 0;
    if (fs.existsSync(CALLS_DIR)) {
        for (const entry of fs.readdirSync(CALLS_DIR, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(CALLS_DIR, entry.name);
            total += dirBytes(path.join(dir, 'tracks'));
            const transcript = path.join(dir, 'transcript.json');
            if (fs.existsSync(transcript)) total += fs.statSync(transcript).size;
        }
    }
    usageCache = { at: Date.now(), bytes: total };
    return total;
}

function storageFull() {
    return archiveBytes() >= MAX_STORAGE_GB * 1024 * 1024 * 1024;
}

// ---- 信令钩子 ----
function onCallActive(info) {
    const callId = safeCallId(info.callId);
    if (!callId) return null;
    const meta = readMeta(callId) || {
        callId,
        caller: info.caller,
        callee: info.callee,
        t0: info.t0,
        callerRole: 'A',
        calleeRole: 'B',
        tracks: {},
        asr: { state: 'idle', updatedAt: Date.now() },
    };
    meta.t0 = info.t0;
    meta.tracks = meta.tracks || {};
    for (const role of ['A', 'B']) {
        meta.tracks[role] = {
            finalized: false,
            complete: false,
            codec: 'opus',
            sampleRate: SAMPLE_RATE,
            bitrate: 24000,
            channels: 1,
            ...(meta.tracks[role] || {}),
        };
    }
    writeMeta(callId, meta);
    log(`开始归档 callId=${callId} t0=${info.t0}`);

    const exp = Number(info.t0 || Date.now()) + Number(info.maxDurationMs || 0) + 15 * 60 * 1000;
    return {
        sampleRate: SAMPLE_RATE,
        chunkMs: 2000,
        maxChunkBytes: MAX_CHUNK_BYTES,
        upload: {
            A: issueToken(callId, 'A', exp),
            B: issueToken(callId, 'B', exp),
        },
        read: issueToken(callId, 'R', 0),
    };
}

function onCallEnded(info) {
    const callId = safeCallId(info.callId);
    if (!callId) return null;
    const meta = readMeta(callId);
    if (!meta) return null;
    updateMeta(callId, {
        endedAt: info.endedAt || Date.now(),
        durationMs: info.durationMs || 0,
        reason: info.reason || '',
    });
    // 给慢网留补传窗口；到点仍未 finalize 的按不完整处理（绝不伪装成完整的终稿）
    setTimeout(() => maybeStartAsr(callId), 120 * 1000);
    log(`通话结束 callId=${callId} duration=${info.durationMs}ms`);
    // 长期读取令牌：随 call.ended 下发给客户端并写进聊天记录，之后随时可回看/回听
    return { read: issueToken(callId, 'R', 0) };
}

let asrModule = null;
function maybeStartAsr(callId) {
    if (!asrModule) asrModule = require('./call-transcript');
    asrModule.enqueueIfReady(callId).catch((e) => log(`入队失败 ${callId}: ${e.message}`));
}

// ---- 分块上传 ----
function listChunks(callId, role) {
    const dir = path.join(callDir(callId), 'chunks', role);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(n => /^\d{6}\.pcm$/.test(n))
        .map(n => Number(n.slice(0, 6)))
        .sort((a, b) => a - b);
}

function handleChunk(callId, role, req, res) {
    const token = req.get('X-Token') || '';
    if (!verifyToken(token, callId, role)) return res.status(403).json({ ok: false, reason: 'bad_token' });
    if (storageFull()) return res.status(507).json({ ok: false, reason: 'storage_full' });

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ ok: false, reason: 'empty' });
    if (body.length > MAX_CHUNK_BYTES) return res.status(413).json({ ok: false, reason: 'chunk_too_large' });

    const seq = Number(req.get('X-Seq'));
    const startMs = Number(req.get('X-Start-Ms'));
    if (!Number.isInteger(seq) || seq < 0 || seq > 999999) return res.status(400).json({ ok: false, reason: 'bad_seq' });
    if (!Number.isFinite(startMs) || startMs < 0) return res.status(400).json({ ok: false, reason: 'bad_start' });

    const dir = path.join(callDir(callId), 'chunks', role);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${String(seq).padStart(6, '0')}.pcm`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file); // 幂等：同 seq 重传直接覆盖

    const meta = readMeta(callId) || { callId, tracks: {} };
    meta.tracks = meta.tracks || {};
    meta.tracks[role] = meta.tracks[role] || { finalized: false, complete: false };
    meta.tracks[role].lastSeq = seq;
    meta.tracks[role].chunkCount = listChunks(callId, role).length;
    if (meta.tracks[role].firstStartMs == null) meta.tracks[role].firstStartMs = startMs;
    writeMeta(callId, meta);
    return res.json({ ok: true, seq, startMs });
}

async function doFinalize(callId, role, req, res) {
    const p = req.body || {};
    if (!verifyToken(p.token, callId, role)) return res.status(403).json({ ok: false, reason: 'bad_token' });

    const seqs = listChunks(callId, role);
    const declared = Number(p.chunkCount || 0);

    // 幂等：客户端重试 finalize 时上一轮已清理分块，不能再用空分块把完整归档降级成 incomplete
    const metaBefore = readMeta(callId) || {};
    const prevTrack = (metaBefore.tracks || {})[role] || {};
    if (seqs.length === 0 && prevTrack.finalized && prevTrack.complete) {
        return res.json({
            ok: true,
            track: {
                complete: true,
                durationMs: prevTrack.durationMs || 0,
                codec: 'opus',
                sampleRate: SAMPLE_RATE,
                preSkipMs: prevTrack.preSkipMs || 0,
                error: '',
            },
        });
    }

    // 只拼接从 0 开始连续的前缀：中间缺块时绝不把后面的音频前移（会篡改时间轴）
    let contiguous = 0;
    while (contiguous < seqs.length && seqs[contiguous] === contiguous) contiguous++;
    const complete = declared > 0 && contiguous === declared && seqs.length === declared;

    const pcmDir = path.join(callDir(callId), 'pcm');
    fs.mkdirSync(pcmDir, { recursive: true });
    const pcmFile = path.join(pcmDir, `${role}.pcm`);
    const fd = fs.openSync(pcmFile, 'w');
    for (let i = 0; i < contiguous; i++) {
        const buf = fs.readFileSync(path.join(callDir(callId), 'chunks', role, `${String(i).padStart(6, '0')}.pcm`));
        fs.writeSync(fd, buf);
    }
    fs.closeSync(fd);

    const bytes = fs.statSync(pcmFile).size;
    const durationMs = Math.round(bytes / BYTES_PER_MS);
    const ogg = path.join(callDir(callId), 'tracks', `${role}.ogg`);
    let codecError = '';
    if (bytes > 0) {
        try {
            await encodeOpus(pcmFile, ogg);
        } catch (e) {
            codecError = e.message;
            log(`编码失败 callId=${callId} 轨${role}: ${e.message}`);
        }
    }
    const preSkipMs = fs.existsSync(ogg) ? readOpusPreSkipMs(ogg) : 0;

    const meta = readMeta(callId) || { callId, tracks: {} };
    // 「上传完整」不等于「覆盖完整」：客户端可能在通话中途被系统杀掉，
    // 醒来后把手上现有的分块 finalize，declared 与实际块数一致 → complete 为 true，
    // 但这段录音其实只覆盖了通话的前半段。必须与通话时长相比较，才能如实标注。
    const callMs = Number(meta.durationMs || 0);
    const tolerance = Math.max(3000, callMs * 0.1);
    const short = callMs >= 10000 && durationMs + tolerance < callMs;
    meta.tracks = meta.tracks || {};
    meta.tracks[role] = {
        ...(meta.tracks[role] || {}),
        finalized: true,
        complete: complete && !codecError,
        codec: 'opus',
        sampleRate: SAMPLE_RATE,
        bitrate: 24000,
        channels: 1,
        durationMs,
        callDurationMs: callMs,
        short,
        preSkipMs,
        chunks: declared,
        receivedChunks: seqs.length,
        error: codecError || (complete ? '' : 'incomplete'),
        finalizedAt: Date.now(),
    };
    writeMeta(callId, meta);

    // 完整才清理暂存；不完整保留分块，供客户端补传后重新 finalize
    if (complete) {
        try { fs.rmSync(path.join(callDir(callId), 'chunks', role), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
        try { fs.unlinkSync(pcmFile); } catch (e) { /* 忽略 */ }
    }
    usageCache.at = 0;
    log(`归档 callId=${callId} 轨${role} ${durationMs}ms complete=${complete} preSkip=${preSkipMs}ms`);
    if (complete) maybeStartAsr(callId);
    return res.json({
        ok: true,
        track: {
            complete: complete && !codecError,
            durationMs,
            codec: 'opus',
            sampleRate: SAMPLE_RATE,
            preSkipMs,
            error: codecError || (complete ? '' : 'incomplete'),
        },
    });
}

/** 同一轨的 finalize 串行：客户端重试/补传不会并发跑两次 ffmpeg 覆盖同一个 ogg */
const finalizeChains = new Map();

function handleFinalize(callId, role, req, res) {
    const key = `${callId}|${role}`;
    const prev = finalizeChains.get(key) || Promise.resolve();
    const job = prev.catch(() => {}).then(() => doFinalize(callId, role, req, res));
    const tail = job.catch(() => {});
    finalizeChains.set(key, tail);
    tail.finally(() => {
        if (finalizeChains.get(key) === tail) finalizeChains.delete(key);
    });
    return job;
}

// ---- 回听切片 ----
function decodedPcmPath(callId, role) {
    return path.join(callDir(callId), 'cache', `${role}.pcm`);
}

/** 同一轨的并发解码请求合并成一次 ffmpeg，避免点句 + 整轨同时点开时重复解码 */
const decodeJobs = new Map();

async function decodeNow(callId, role) {
    const ogg = path.join(callDir(callId), 'tracks', `${role}.ogg`);
    if (!fs.existsSync(ogg)) return null;
    const pcm = decodedPcmPath(callId, role);
    fs.mkdirSync(path.dirname(pcm), { recursive: true });
    const stamp = `${fs.statSync(ogg).mtimeMs}`;
    const stampFile = `${pcm}.stamp`;
    if (fs.existsSync(pcm) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp) {
        return pcm;
    }
    // 先写临时文件再 rename：解码中途失败不会留下半截 PCM 被误当成有效缓存
    const tmp = `${pcm}.part`;
    try {
        await runFfmpeg(['-y', '-i', ogg, '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', tmp]);
        fs.renameSync(tmp, pcm);
        fs.writeFileSync(stampFile, stamp);
        return pcm;
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch (_) { /* 忽略 */ }
        throw e;
    }
}

/** 把存档解码成 16k 单声道 s16le 缓存（可淘汰，不属于存档）；异步执行 */
function ensureDecoded(callId, role) {
    const key = `${callId}|${role}`;
    const running = decodeJobs.get(key);
    if (running) return running;
    const job = decodeNow(callId, role).finally(() => {
        if (decodeJobs.get(key) === job) decodeJobs.delete(key);
    });
    decodeJobs.set(key, job);
    return job;
}

function wavHeader(dataBytes) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + dataBytes, 4);
    h.write('WAVE', 8);
    h.write('fmt ', 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(SAMPLE_RATE, 24);
    h.writeUInt32LE(SAMPLE_RATE * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36);
    h.writeUInt32LE(dataBytes, 40);
    return h;
}

async function handleClip(callId, req, res) {
    const token = String(req.query.token || '');
    if (!verifyToken(token, callId, 'R')) return res.status(403).json({ ok: false, reason: 'bad_token' });
    const role = req.query.speaker === 'B' ? 'B' : 'A';
    const reqStart = Math.max(0, Number(req.query.startMs) || 0);
    const reqEnd = Math.max(reqStart + 50, Number(req.query.endMs) || reqStart + 4000);

    const meta = readMeta(callId);
    if (!meta) return res.status(404).json({ ok: false, reason: 'not_found' });
    const track = (meta.tracks || {})[role] || {};
    const pcm = await ensureDecoded(callId, role);
    if (!pcm) return res.status(404).json({ ok: false, reason: 'no_audio' });

    // 前后各留一点余量并把尾部补静音：个别机型 MediaPlayer 播 WAV 会在最后一帧提前收尾，
    // 句子末尾的一两个字（如「…衣服」）会被吃掉。余量不影响时间轴，只是多播一点上下文。
    const LEAD_MS = 100;
    const TAIL_MS = 300;
    const startMs = Math.max(0, reqStart - LEAD_MS);
    const endMs = reqEnd + TAIL_MS;

    const fd = fs.openSync(pcm, 'r');
    let data;
    try {
        const size = fs.fstatSync(fd).size;
        // 先补偿 Opus pre_skip：解码器若未按 granule 裁掉头部，实际时长会比 meta 多出这段
        const decodedMs = size / BYTES_PER_MS;
        const extraMs = Math.max(0, Math.round(decodedMs - (track.durationMs || 0)));
        const shiftMs = extraMs > 20 ? extraMs : 0;
        let from = Math.round((startMs + shiftMs) * BYTES_PER_MS) & ~1;
        let to = Math.round((endMs + shiftMs) * BYTES_PER_MS) & ~1;
        from = Math.min(from, size);
        to = Math.max(to, from + 2);
        if (to - from > READ_CHUNK_LIMIT) to = from + READ_CHUNK_LIMIT;

        const want = Math.max(0, to - from);
        data = Buffer.alloc(want); // 全零：读不满的部分天然是静音
        const avail = Math.min(want, Math.max(0, size - from));
        let off = 0;
        while (off < avail) {
            const n = fs.readSync(fd, data, off, avail - off, from + off);
            if (n <= 0) break;
            off += n;
        }
        res.setHeader('X-Pre-Skip-Ms', String(shiftMs || track.preSkipMs || 0));
    } finally {
        fs.closeSync(fd);
    }

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Speaker', role);
    return res.end(Buffer.concat([wavHeader(data.length), data]));
}

/**
 * 整轨回听：把存档 Opus 解码出的 PCM 按需包成 WAV 流，支持 HTTP Range。
 *
 * 存储红线：存档只有一份连续 Opus（tracks/*.ogg），整轨播放与点句切片都是
 * 由它派生出来的「视图」，不额外保存完整 WAV / 片段文件；解码结果放在 cache/，
 * 属于可淘汰缓存（见 sweepCache），随时可以删掉重新生成。
 */
async function handleTrack(callId, req, res) {
    const token = String(req.query.token || '');
    if (!verifyToken(token, callId, 'R')) return res.status(403).json({ ok: false, reason: 'bad_token' });
    const role = req.query.speaker === 'B' ? 'B' : 'A';

    const meta = readMeta(callId);
    if (!meta) return res.status(404).json({ ok: false, reason: 'not_found' });
    if (!(meta.tracks || {})[role] || !meta.tracks[role].finalized) {
        return res.status(404).json({ ok: false, reason: 'no_audio' });
    }
    const pcm = await ensureDecoded(callId, role);
    if (!pcm) return res.status(404).json({ ok: false, reason: 'no_audio' });
    sweepCache();

    const size = fs.statSync(pcm).size;
    const total = 44 + size;
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Speaker', role);

    const header = wavHeader(size);
    const range = String(req.headers.range || '');
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = 0;
    let end = total - 1;
    if (m) {
        if (m[1] === '' && m[2] === '') {
            res.setHeader('Content-Range', `bytes */${total}`);
            return res.status(416).end();
        }
        if (m[1] === '') {
            // bytes=-N：最后 N 字节
            start = Math.max(0, total - Number(m[2]));
        } else {
            start = Number(m[1]);
            if (m[2] !== '') end = Math.min(Number(m[2]), total - 1);
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
            res.setHeader('Content-Range', `bytes */${total}`);
            return res.status(416).end();
        }
    }

    res.status(m ? 206 : 200);
    res.setHeader('Content-Length', String(end - start + 1));
    if (m) res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);

    // WAV 头只有 44 字节，先按请求区间把头部字节写出去
    if (start < 44) res.write(header.subarray(start, Math.min(end + 1, 44)));
    if (end >= 44) {
        const from = Math.max(0, start - 44);
        const to = Math.min(size, end - 43); // 开区间
        if (to > from) fs.createReadStream(pcm, { start: from, end: to - 1 }).pipe(res);
        else res.end();
    } else {
        res.end();
    }
}

// ---- 点句/整轨解码缓存淘汰（不属于存档，可按预算回收） ----
const CACHE_MAX_BYTES = Number(process.env.CALL_REC_CACHE_GB || 1) * 1024 * 1024 * 1024;
let lastSweepAt = 0;

function sweepCache(force = false) {
    if (!force && Date.now() - lastSweepAt < 10 * 60 * 1000) return;
    lastSweepAt = Date.now();
    if (!fs.existsSync(CALLS_DIR)) return;
    const files = [];
    let total = 0;
    for (const dir of fs.readdirSync(CALLS_DIR, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const cacheDir = path.join(CALLS_DIR, dir.name, 'cache');
        if (!fs.existsSync(cacheDir)) continue;
        for (const f of fs.readdirSync(cacheDir, { withFileTypes: true })) {
            if (!f.isFile()) continue;
            const p = path.join(cacheDir, f.name);
            try {
                const st = fs.statSync(p);
                files.push({ p, size: st.size, at: st.mtimeMs });
                total += st.size;
            } catch (e) { /* 忽略 */ }
        }
    }
    if (total <= CACHE_MAX_BYTES) return;
    files.sort((a, b) => a.at - b.at);
    for (const f of files) {
        if (total <= CACHE_MAX_BYTES) break;
        try { fs.unlinkSync(f.p); total -= f.size; } catch (e) { /* 忽略 */ }
    }
    log(`回听缓存回收到 ${(total / 1048576).toFixed(1)}MB（上限 ${(CACHE_MAX_BYTES / 1048576).toFixed(0)}MB）`);
}

/**
 * 用本端上传令牌换长期读取令牌。
 * 断网挂断时服务端的 call.ended 送不到客户端，读取令牌只能靠重连后主动补领。
 */
function handleReadToken(callId, role, req, res) {
    const token = String((req.body && req.body.token) || '');
    if (!verifyToken(token, callId, role)) return res.status(403).json({ ok: false, reason: 'bad_token' });
    if (!readMeta(callId)) return res.status(404).json({ ok: false, reason: 'not_found' });
    return res.json({ ok: true, read: issueToken(callId, 'R', 0) });
}

function handleStatus(callId, req, res) {
    const token = String(req.query.token || '');
    if (!verifyToken(token, callId, 'R')) return res.status(403).json({ ok: false, reason: 'bad_token' });
    const meta = readMeta(callId);
    if (!meta) return res.status(404).json({ ok: false, reason: 'not_found' });
    return res.json({
        ok: true,
        callId,
        t0: meta.t0 || 0,
        endedAt: meta.endedAt || 0,
        durationMs: meta.durationMs || 0,
        tracks: meta.tracks || {},
        asr: meta.asr || { state: 'idle' },
    });
}

function handleTranscript(callId, req, res) {
    const token = String(req.query.token || '');
    if (!verifyToken(token, callId, 'R')) return res.status(403).json({ ok: false, reason: 'bad_token' });
    const file = path.join(callDir(callId), 'transcript.json');
    if (!fs.existsSync(file)) {
        const meta = readMeta(callId);
        return res.status(409).json({
            ok: false,
            reason: 'not_ready',
            asr: (meta && meta.asr) || { state: 'idle' },
        });
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(fs.readFileSync(file));
}

function handleUsage(req, res) {
    const bytes = archiveBytes();
    return res.json({
        ok: true,
        bytes,
        limitBytes: MAX_STORAGE_GB * 1024 * 1024 * 1024,
        full: bytes >= MAX_STORAGE_GB * 1024 * 1024 * 1024,
    });
}

function attachRoutes(app) {
    ensureDirs();
    const raw = require('express').raw({ type: 'application/octet-stream', limit: MAX_CHUNK_BYTES });
    app.post('/api/call/rec/:callId/:role/chunk', raw, (req, res) => {
        const callId = safeCallId(req.params.callId);
        if (!callId || !['A', 'B'].includes(req.params.role)) return res.status(400).json({ ok: false, reason: 'bad_path' });
        try { handleChunk(callId, req.params.role, req, res); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
    });
    app.post('/api/call/rec/:callId/:role/finalize', (req, res) => {
        const callId = safeCallId(req.params.callId);
        if (!callId || !['A', 'B'].includes(req.params.role)) return res.status(400).json({ ok: false, reason: 'bad_path' });
        handleFinalize(callId, req.params.role, req, res).catch((e) => fail(res, e));
    });
    app.post('/api/call/rec/:callId/:role/read', (req, res) => {
        const callId = safeCallId(req.params.callId);
        if (!callId || !['A', 'B'].includes(req.params.role)) return res.status(400).json({ ok: false, reason: 'bad_path' });
        try { handleReadToken(callId, req.params.role, req, res); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
    });
    app.get('/api/call/rec/:callId/status', (req, res) => {
        const callId = safeCallId(req.params.callId);
        if (!callId) return res.status(400).json({ ok: false, reason: 'bad_path' });
        try { handleStatus(callId, req, res); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
    });
    app.get('/api/call/rec/:callId/transcript', (req, res) => {
        const callId = safeCallId(req.params.callId);
        if (!callId) return res.status(400).json({ ok: false, reason: 'bad_path' });
        try { handleTranscript(callId, req, res); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
    });
    app.get('/api/call/rec/:callId/clip', (req, res) => {
        const callId = safeCallId(req.params.callId);
        if (!callId) return res.status(400).json({ ok: false, reason: 'bad_path' });
        handleClip(callId, req, res).catch((e) => fail(res, e));
    });
    // 整轨回听：同一份存档 Opus 的 WAV 视图，支持 Range（拖动进度条不下载整段）
    app.get('/api/call/rec/:callId/track', (req, res) => {
        const callId = safeCallId(req.params.callId);
        if (!callId) return res.status(400).json({ ok: false, reason: 'bad_path' });
        handleTrack(callId, req, res).catch((e) => fail(res, e));
    });
    app.get('/api/call/rec/usage', (req, res) => {
        try { handleUsage(req, res); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
    });
    log('录音归档路由已挂载');
}

module.exports = {
    CALLS_DIR,
    ensureDirs,
    callDir,
    readMeta,
    writeMeta,
    updateMeta,
    issueToken,
    verifyToken,
    onCallActive,
    onCallEnded,
    attachRoutes,
    archiveBytes,
};
