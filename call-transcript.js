'use strict';

/**
 * 终稿转写调度：通话结束后解码存档 → VAD 切段 → SenseVoice 逐段识别。
 *
 * 生命周期：任务来了才 spawn 一次性子进程（asr/worker.js），跑完即退出，模型不常驻。
 * 可靠性：串行执行、超时强杀、失败重试、服务重启后扫描 meta 里的 queued/running 续跑。
 * 红线：任何一轨不完整都只产出 partial 结果，绝不伪造「看似完整」的终稿。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const recording = require('./call-recording');
const asrConfig = require('./asr/config');

const GRACE_MS = 120 * 1000;       // 结束后等客户端补传的宽限
const JOB_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_ATTEMPTS = 2;

const queue = [];
const scheduled = new Map();
let running = false;

const log = (msg) => console.log(`[call-asr] ${msg}`);

function setAsrState(callId, patch) {
    const meta = recording.readMeta(callId);
    if (!meta) return;
    const asr = { ...(meta.asr || {}), ...patch, updatedAt: Date.now() };
    recording.updateMeta(callId, { asr });
}

/**
 * 已归档音轨的指纹：任一轨重新 finalize（补传/补块/覆盖）都会改变，
 * 用来判断「现有 transcript 是否还代表当前音轨」。
 */
function trackSignature(meta) {
    return ['A', 'B'].map((r) => {
        const t = (meta.tracks || {})[r];
        if (!t || !t.finalized) return `${r}:-`;
        return `${r}:${t.finalizedAt || 0}:${t.durationMs || 0}:${t.chunks || 0}`;
    }).join('|');
}

function delayed(callId, ms) {
    if (scheduled.has(callId)) return;
    const timer = setTimeout(() => {
        scheduled.delete(callId);
        enqueueIfReady(callId).catch(e => log(`延迟入队失败 ${callId}: ${e.message}`));
    }, ms);
    if (timer.unref) timer.unref();
    scheduled.set(callId, timer);
}

/**
 * 判断是否可以开始转写；条件不足时按需延迟重试。
 * 已完成的转写若音轨指纹变化（后补的另一轨 / 补传后的更完整音频）会自动重跑，
 * 否则「先到的一轨」会永久占住终稿，看起来就是解析内容缺了一半。
 * @returns {Promise<boolean>} 是否已入队
 */
async function enqueueIfReady(callId) {
    const meta = recording.readMeta(callId);
    if (!meta) return false;
    const asr = meta.asr || {};
    const state = asr.state || 'idle';
    if (queue.includes(callId)) return false;
    if (state === 'running') {
        // 正在跑：记下需要重跑，等本任务收尾后再按最新音轨补一遍
        if (asr.signature !== trackSignature(meta)) setAsrState(callId, { rerun: true });
        return false;
    }
    if (state === 'queued') return false;
    if (!meta.endedAt) return false;               // 还没结束，不生成任何归档结论
    const signature = trackSignature(meta);
    if (state === 'done' && asr.signature === signature && !asr.rerun) return false;

    const tracks = meta.tracks || {};
    const roles = ['A', 'B'];
    const finalized = roles.filter(r => tracks[r] && tracks[r].finalized);
    const usable = finalized.filter(r => tracks[r].complete);

    if (finalized.length < 2) {
        // 另一轨还没归档：先等宽限期，给慢网补传机会
        if (Date.now() - meta.endedAt < GRACE_MS) {
            delayed(callId, GRACE_MS);
            return false;
        }
    }
    if (usable.length === 0) {
        setAsrState(callId, { state: 'failed', error: 'no_complete_track', partial: true });
        log(`${callId} 没有完整音轨，放弃转写（不产出终稿）`);
        return false;
    }

    // 音轨虽然「上传完整」，但明显短于整通通话：说明该端录音中途被系统/进程截断，
    // 缺失时段无法还原，必须标 partial，不能包装成完整终稿。
    const shortTracks = finalized.filter(r => tracks[r].short);
    const partial = usable.length < 2 || shortTracks.length > 0;
    setAsrState(callId, {
        state: 'queued', partial, error: '', signature, rerun: false,
        ...(shortTracks.length ? { shortTracks } : {}),
    });
    queue.push(callId);
    drain();
    return true;
}

function drain() {
    if (running || queue.length === 0) return;
    running = true;
    const callId = queue.shift();
    runJob(callId)
        .catch(e => log(`${callId} 任务异常: ${e.message}`))
        .finally(() => {
            running = false;
            drain();
        });
}

function runJob(callId) {
    return new Promise((resolve) => {
        const meta = recording.readMeta(callId);
        if (!meta) return resolve();
        const dir = recording.callDir(callId);
        const roles = ['A', 'B'].filter(r => meta.tracks && meta.tracks[r] && meta.tracks[r].finalized);
        const signature = trackSignature(meta);
        const job = {
            callId,
            dataDir: dir,
            output: path.join(dir, 'transcript.json'),
            progressFile: path.join(dir, 'progress.json'),
            segmentsDir: path.join(dir, 'segments'),
            engine: 'sensevoice',
            expectedRoles: ['A', 'B'],
            callDurationMs: meta.durationMs || 0,
            tracks: roles.map(role => ({
                speaker: role,
                ogg: path.join(dir, 'tracks', `${role}.ogg`),
                durationMs: (meta.tracks[role] || {}).durationMs || 0,
                // 音轨指纹参与分段缓存：补传/重编码后不会复用旧文本
                finalizedAt: (meta.tracks[role] || {}).finalizedAt || 0,
                short: !!(meta.tracks[role] || {}).short,
                complete: !!(meta.tracks[role] || {}).complete,
            })),
        };
        const jobFile = path.join(dir, 'job.json');
        fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));

        setAsrState(callId, { state: 'running', error: '', signature });
        log(`${callId} 启动转写进程：${job.tracks.map(t => t.speaker).join('+')}`);

        const child = spawn(process.execPath, [path.join(__dirname, 'asr', 'worker.js'), '--job', jobFile], {
            cwd: __dirname,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let killed = false;
        const timer = setTimeout(() => {
            killed = true;
            try { child.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
        }, JOB_TIMEOUT_MS);
        if (timer.unref) timer.unref();

        child.stdout.on('data', d => process.stdout.write(String(d)));
        child.stderr.on('data', d => process.stderr.write(String(d)));

        child.on('close', (code) => {
            clearTimeout(timer);
            const attempts = ((recording.readMeta(callId) || {}).asr || {}).attempts || 0;
            if (code === 0) {
                let partial = true;
                try {
                    partial = !!JSON.parse(fs.readFileSync(job.output, 'utf8')).partial;
                } catch (e) { /* 保持保守值 */ }
                setAsrState(callId, {
                    state: 'done', partial, finishedAt: Date.now(), error: '',
                    signature, rerun: false,
                });
                log(`${callId} 转写完成${partial ? '（不完整）' : ''}`);
                // 转写期间又有一轨 finalize/补传：立即按最新音轨重跑（分段缓存命中，代价很小）
                enqueueIfReady(callId).catch(e => log(`${callId} 补跑检查失败: ${e.message}`));
            } else if (attempts + 1 < MAX_ATTEMPTS && !killed) {
                const asr = (recording.readMeta(callId) || {}).asr || {};
                setAsrState(callId, {
                    state: 'queued',
                    attempts: attempts + 1,
                    error: `exit_${code}`,
                    ...(asr.partial ? { partial: true } : {}),
                });
                log(`${callId} 转写失败(code=${code})，第 ${attempts + 2} 次尝试`);
                setTimeout(() => { queue.push(callId); drain(); }, 5000).unref?.();
            } else {
                setAsrState(callId, { state: 'failed', error: killed ? 'timeout' : `exit_${code}` });
                log(`${callId} 转写最终失败`);
            }
            resolve();
        });
    });
}

/** 读现有终稿的管线版本；没有终稿或读不出来返回空串 */
function transcriptPipeline(callId) {
    try {
        const json = JSON.parse(fs.readFileSync(path.join(recording.callDir(callId), 'transcript.json'), 'utf8'));
        return json.pipeline || 'legacy';
    } catch (e) {
        return '';
    }
}

/** 服务启动后续跑：上次未跑完的任务重新入队（worker 会跳过已识别的分段） */
function resumePending() {
    try {
        if (!fs.existsSync(recording.CALLS_DIR)) return;
        let stale = 0;
        for (const entry of fs.readdirSync(recording.CALLS_DIR, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const meta = recording.readMeta(entry.name);
            if (!meta || !meta.endedAt) continue;
            const state = (meta.asr && meta.asr.state) || 'idle';
            if (state === 'queued' || state === 'running') {
                setAsrState(entry.name, { state: 'queued' });
                queue.push(entry.name);
            } else if (state === 'done' && transcriptPipeline(entry.name) !== asrConfig.pipelineVersion) {
                // 旧版切段/增益策略产出的终稿：自动按新管线重跑一遍，避免用户一直看到缺内容的旧结果
                setAsrState(entry.name, { state: 'queued', rerun: true });
                queue.push(entry.name);
                stale++;
            }
        }
        if (queue.length) {
            log(`续跑 ${queue.length} 个转写任务${stale ? `（其中 ${stale} 个为旧管线终稿）` : ''}`);
            drain();
        }
    } catch (e) {
        log(`续跑扫描失败: ${e.message}`);
    }
}

module.exports = { enqueueIfReady, resumePending };
