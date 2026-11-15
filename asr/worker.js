'use strict';

/**
 * ASR 任务进程（一次性）：
 *   node asr/worker.js --job <job.json>
 *
 * 生命周期由 call-transcript.js 控制：每个任务 spawn 一个子进程，跑完即退出，
 * 主服务进程不常驻模型。崩溃后可从 segments/ 的已完成段续跑。
 *
 * job.json 结构：
 *   { callId, dataDir, output, progressFile, segmentsDir,
 *     tracks:[{speaker:'A'|'B', ogg, durationMs, complete}] }
 *
 * 输出 transcript.json：
 *   { callId, partial, engine, vad, tracks, segments:[{speaker,startMs,endMs,text}] }
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { createAsrEngine } = require('./engine');
const { splitForAsr } = require('./vad');
const config = require('./config');

const SAMPLE_RATE = config.sampleRate;
/** 识别管线版本：切段/增益策略变化时递增，强制废弃旧的分段缓存与旧终稿 */
const PIPELINE_VERSION = config.pipelineVersion;

/** 去掉标点/空白后比较，用于识别「同一句话被另一条轨的 AEC 残留重复识别」 */
function normText(text) {
    return String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function similarText(a, b) {
    const x = normText(a);
    const y = normText(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const short = x.length <= y.length ? x : y;
    const long = x.length <= y.length ? y : x;
    if (short.length < 2) return false;
    if (long.includes(short) && short.length / long.length >= 0.5) return true;
    // 两条轨对同一句话的识别常有少量字差（"你好你好你好你好" vs "你你你好你好"），
    // 用编辑距离比例兜住，避免同句在记录里出现两遍。
    const dp = new Array(short.length + 1);
    for (let i = 0; i <= short.length; i++) dp[i] = i;
    for (let j = 1; j <= long.length; j++) {
        let prev = dp[0];
        dp[0] = j;
        for (let i = 1; i <= short.length; i++) {
            const tmp = dp[i];
            dp[i] = Math.min(
                dp[i] + 1,
                dp[i - 1] + 1,
                prev + (short[i - 1] === long[j - 1] ? 0 : 1)
            );
            prev = tmp;
        }
    }
    const distance = dp[short.length];
    return 1 - distance / long.length >= 0.5;
}

function overlapRatioMs(a, b) {
    const from = Math.max(a.startMs, b.startMs);
    const to = Math.min(a.endMs, b.endMs);
    if (to <= from) return 0;
    const minLen = Math.max(1, Math.min(a.endMs - a.startMs, b.endMs - b.startMs));
    return (to - from) / minLen;
}

/**
 * 双轨去重 + 串音抑制。
 *
 * 只按电平差丢段会误伤「另一人离得远 / 小声说话」：他说的恰好和别人重叠时会被当成回声。
 * 因此额外加了三道保护，只有满足其一才判定为回声：
 *   1) 该段是极短碎片（归一化后 ≤4 字，回声/噪声的典型形态）；
 *   2) 与同时段强段的包络高度相关（同一声源的衰减副本）；
 *   3) 这一整条轨本身没有近场语音（整轨最响的段都低于 -50dBFS，说明麦克风只拾到了环境/串音）。
 * 正常拿着手机小声说话的人，自己那句话是本轨最响的内容，不会被删。
 */
const ENV_FRAME = 320; // 20ms

function envelope(samples) {
    const n = Math.ceil(samples.length / ENV_FRAME);
    const out = new Float32Array(n);
    for (let f = 0; f < n; f++) {
        const from = f * ENV_FRAME;
        const to = Math.min(from + ENV_FRAME, samples.length);
        let sum = 0;
        for (let i = from; i < to; i++) sum += samples[i] * samples[i];
        out[f] = Math.sqrt(sum / Math.max(1, to - from));
    }
    return out;
}

/** 归一化互相关（允许 ±300ms 延迟），返回 0~1 的相似度 */
function envCorrelation(a, b, maxLag = 15) {
    if (!a || !b || a.length < 2 || b.length < 2) return 0;
    const norm = (v) => {
        let mean = 0;
        for (const x of v) mean += x;
        mean /= v.length;
        let energy = 0;
        const out = new Float32Array(v.length);
        for (let i = 0; i < v.length; i++) { out[i] = v[i] - mean; energy += out[i] * out[i]; }
        energy = Math.sqrt(energy);
        if (energy <= 1e-12) return null;
        for (let i = 0; i < out.length; i++) out[i] /= energy;
        return out;
    };
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return 0;
    let best = 0;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
        let dot = 0;
        for (let i = 0; i < x.length; i++) {
            const j = i + lag;
            if (j >= 0 && j < y.length) dot += x[i] * y[j];
        }
        if (dot > best) best = dot;
    }
    return best;
}

/** 纯语气词/应答（嗯、啊、喂、对、好…）：单字/叠字，不含实际信息 */
const FILLER_RE = /^(嗯+|啊+|哦+|噢+|喂+|哎+|唉+|好+|对+|是的|行+|嗯啊+|啊啊+|嗯嗯+|哦哦+)$/;

function isFiller(text) {
    const n = normText(text);
    return n.length > 0 && n.length <= 3 && FILLER_RE.test(n);
}

/** 降到 4k 的波形，用于双轨回声相关性（回声 = 对方语音的延迟副本） */
function down4k(samples) {
    const n = Math.floor(samples.length / 4);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const k = i * 4;
        out[i] = (samples[k] + samples[k + 1] + samples[k + 2] + samples[k + 3]) / 4;
    }
    return out;
}

/** seg 与另一轨在 ±500ms 内的最佳归一化相关（lag<0 表示 seg 是更晚到达的副本） */
function matchOtherTrack(seg, otherWave, centerFrame, maxLag = 2000) {
    let mean = 0;
    for (const v of seg) mean += v;
    mean /= seg.length;
    const s = new Float32Array(seg.length);
    for (let i = 0; i < seg.length; i++) s[i] = seg[i] - mean;
    let nrm = 0;
    for (let i = 0; i < s.length; i++) nrm += s[i] * s[i];
    nrm = Math.sqrt(nrm);
    if (nrm < 1e-9) return { corr: 0, lag: 0 };
    for (let i = 0; i < s.length; i++) s[i] /= nrm;

    let best = 0;
    let bestLag = 0;
    for (let lag = -maxLag; lag <= maxLag; lag += 8) {
        let syy = 0;
        let dot = 0;
        const base = centerFrame + lag;
        for (let i = 0; i < s.length; i++) {
            const j = base + i;
            if (j < 0 || j >= otherWave.length) continue;
            const y = otherWave[j];
            syy += y * y;
            dot += s[i] * y;
        }
        const den = Math.sqrt(syy);
        if (den > 1e-9) {
            const c = dot / den;
            if (c > best) { best = c; bestLag = lag; }
        }
    }
    return { corr: best, lag: bestLag };
}

function dedupeEcho(list, waves) {
    const peakDb = {};
    for (const s of list) {
        const db = 20 * Math.log10((s.rms || 0) + 1e-9);
        if (!(s.speaker in peakDb) || db > peakDb[s.speaker]) peakDb[s.speaker] = db;
    }

    const drop = new Set();
    /** 被“波形相关”证实为回声的说话人：用于最后清理该侧残留的碎响 */
    const echoSpeakers = new Set();

    // 整轨级：这条轨最响的句子都低于 -50dBFS，说明麦克风根本没拾到近场人声。
    for (let i = 0; i < list.length; i++) {
        if ((peakDb[list[i].speaker] ?? 0) < -50) drop.add(i);
    }

    // 段级：孤立应答碎片且电平远低于正常语音（< -65dBFS）→ 噪声
    for (let i = 0; i < list.length; i++) {
        if (drop.has(i) || !isFiller(list[i].text)) continue;
        const db = 20 * Math.log10((list[i].rms || 0) + 1e-9);
        if (db < -65 && (list[i].endMs - list[i].startMs) < 1200) drop.add(i);
    }

    // 波形级回声判定：seg 与对方整轨在 ±500ms 内高度相关且延迟为负 → 它是对方语音的副本
    const isDelayedEcho = (seg) => {
        const other = seg.speaker === 'A' ? 'B' : 'A';
        const ownWave = waves[seg.speaker];
        const otherWave = waves[other];
        if (!ownWave || !otherWave) return false;
        const from = Math.max(0, Math.round(seg.startMs * 4));
        const to = Math.min(ownWave.length, Math.round(seg.endMs * 4));
        if (to - from < 240) return false; // 太短（<60ms）不可靠
        const r = matchOtherTrack(ownWave.subarray(from, to), otherWave, from);
        return r.corr >= 0.6 && r.lag <= -40;
    };

    for (let i = 0; i < list.length; i++) {
        if (drop.has(i)) continue;
        for (let j = i + 1; j < list.length; j++) {
            if (drop.has(j) || list[i].speaker === list[j].speaker) continue;
            if (overlapRatioMs(list[i], list[j]) < 0.5) continue;
            const a = list[i];
            const b = list[j];

            // 1) 先看波形：谁更晚，谁就是回声
            const aEcho = isDelayedEcho(a);
            const bEcho = !aEcho && isDelayedEcho(b);
            if (aEcho && !bEcho) {
                drop.add(i);
                echoSpeakers.add(a.speaker);
                break;
            }
            if (bEcho && !aEcho) {
                drop.add(j);
                echoSpeakers.add(b.speaker);
                continue;
            }

            // 2) 同文去重
            if (similarText(a.text, b.text)) {
                if ((a.rms || 0) < (b.rms || 0)) drop.add(i);
                else drop.add(j);
                if (drop.has(i)) break;
                continue;
            }

            // 3) 电平差兜底：只处理非应答词，避免误删真实的「嗯/对」
            if (isFiller(a.text) || isFiller(b.text)) continue;
            const ra = a.rms || 0;
            const rb = b.rms || 0;
            if (ra <= 0 || rb <= 0) continue;
            const aDb = 20 * Math.log10(ra);
            const bDb = 20 * Math.log10(rb);
            const gap = aDb - bDb;

            let quietIdx, quiet, loud, quietDb;
            if (gap <= -12) { quietIdx = i; quiet = a; loud = b; quietDb = aDb; }
            else if (gap >= 12) { quietIdx = j; quiet = b; loud = a; quietDb = bDb; }
            else continue;
            if (quietDb >= -45) continue;

            const correlated = envCorrelation(quiet.env, loud.env) >= 0.6;
            if (correlated || (peakDb[quiet.speaker] ?? 0) < -50) {
                drop.add(quietIdx);
                if (quietIdx === i) break;
            }
        }
    }

    // 最后：某侧已经被“波形相关”证实是回声轨时，它剩下的短碎片若电平不超过已证实回声的 1.4 倍，
    // 也一并清掉（真实近场说话通常明显高于串音电平，不会被误删）。
    for (const sp of echoSpeakers) {
        let echoPeak = 0;
        for (let i = 0; i < list.length; i++) {
            if (list[i].speaker === sp && drop.has(i)) {
                echoPeak = Math.max(echoPeak, list[i].rms || 0);
            }
        }
        for (let i = 0; i < list.length; i++) {
            if (list[i].speaker !== sp || drop.has(i)) continue;
            const dur = list[i].endMs - list[i].startMs;
            const weak = (list[i].rms || 0) <= echoPeak * 1.4;
            if (isFiller(list[i].text) || (dur < 1200 && weak)) drop.add(i);
        }
    }
    return list.filter((_, i) => !drop.has(i));
}

/** 同一轨相邻、内容相同的碎片并成一句（切段过细时会出现「Yeah.」「Yeah.」两条） */
function mergeRepeats(list) {
    const sorted = [...list].sort((a, b) => a.startMs - b.startMs || a.speaker.localeCompare(b.speaker));
    const out = [];
    for (const seg of sorted) {
        const prev = out[out.length - 1];
        if (prev && prev.speaker === seg.speaker &&
            normText(prev.text) === normText(seg.text) &&
            seg.startMs - prev.endMs <= 300) {
            prev.endMs = Math.max(prev.endMs, seg.endMs);
            continue;
        }
        out.push({ ...seg });
    }
    return out;
}

function argOf(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : '';
}

function ffmpegPath() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    try {
        return require('ffmpeg-static');
    } catch (e) {
        return 'ffmpeg';
    }
}

function atomicWriteJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
}

/** 解析 16bit PCM WAV，返回 { samples: Float32Array, sampleRate, channels } */
function readWavPcm16(buf) {
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('不是合法的 WAV 文件');
    }
    let offset = 12;
    let sampleRate = SAMPLE_RATE;
    let channels = 1;
    let bits = 16;
    while (offset + 8 <= buf.length) {
        const id = buf.toString('ascii', offset, offset + 4);
        const size = buf.readUInt32LE(offset + 4);
        const body = offset + 8;
        if (id === 'fmt ') {
            channels = buf.readUInt16LE(body + 2);
            sampleRate = buf.readUInt32LE(body + 4);
            bits = buf.readUInt16LE(body + 14);
        } else if (id === 'data') {
            if (bits !== 16) throw new Error(`仅支持 16bit PCM，实际 ${bits}bit`);
            const count = Math.floor(Math.min(size, buf.length - body) / 2);
            const out = new Float32Array(count);
            for (let i = 0; i < count; i++) out[i] = buf.readInt16LE(body + i * 2) / 32768;
            return { samples: out, sampleRate, channels };
        }
        offset = body + size + (size % 2);
    }
    throw new Error('WAV 缺少 data 段');
}

/** 单声道化 + 线性重采样到 16k（存档已是 48k Opus，这里只做一次高质量降采样） */
function toMono16k(samples, sampleRate, channels) {
    let mono = samples;
    if (channels > 1) {
        const frames = Math.floor(samples.length / channels);
        mono = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
            let sum = 0;
            for (let c = 0; c < channels; c++) sum += samples[i * channels + c];
            mono[i] = sum / channels;
        }
    }
    if (sampleRate === SAMPLE_RATE) return mono;
    const ratio = SAMPLE_RATE / sampleRate;
    const outLen = Math.floor(mono.length * ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const pos = i / ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, mono.length - 1);
        const t = pos - i0;
        out[i] = mono[i0] * (1 - t) + mono[i1] * t;
    }
    return out;
}

/**
 * 识别前的自动增益（20ms 帧 + 慢释放包络）。
 *
 * 真实手机通话的 mic 电平常常只有 -40dBFS 上下：Silero VAD 会把大段语音判成静音，
 * 导致终稿「只识别出一两句」。这里把语音段抬到正常电平再送 VAD/识别，
 * 静音段保持不变（不把本底噪声放大成假语音）。
 *
 * @returns {{ samples: Float32Array, gainDb: number, maxLevel: number, silent: boolean }}
 */
function conditionForAsr(samples) {
    const FRAME = 320;          // 20ms @16k
    const FLOOR = 3e-4;         // -70dBFS 以下视为静音，不做增益
    const TARGET = 0.25;        // 目标语音帧电平（约 -12dBFS）
    const MAX_GAIN = 30;        // 最多 +29.5dB，避免把噪声彻底拉起来

    const n = Math.ceil(samples.length / FRAME);
    const level = new Float32Array(n);
    for (let f = 0; f < n; f++) {
        const from = f * FRAME;
        const to = Math.min(from + FRAME, samples.length);
        let sum = 0;
        for (let i = from; i < to; i++) sum += samples[i] * samples[i];
        level[f] = Math.sqrt(sum / Math.max(1, to - from));
    }

    // 慢释放峰值包络（每帧衰减少量），避免单个点击声把整段增益永久压低
    const env = new Float32Array(n);
    let peak = 0;
    for (let f = 0; f < n; f++) {
        peak = Math.max(peak * 0.995, level[f]);
        env[f] = peak;
    }
    // 反向再跟一次：语音起点之前也能提前获得合适增益，避免句首被压
    for (let f = n - 1; f >= 0; f--) {
        peak = Math.max(peak * 0.995, env[f]);
        env[f] = Math.max(env[f], peak);
    }

    let maxLevel = 0;
    const gain = new Float32Array(n);
    for (let f = 0; f < n; f++) {
        if (level[f] > maxLevel) maxLevel = level[f];
        gain[f] = env[f] < FLOOR ? 1 : Math.min(TARGET / env[f], MAX_GAIN);
    }

    // 增益再做 200ms 平滑，避免逐帧台阶造成额外失真
    const smooth = new Float32Array(n);
    const W = 10;
    let acc = 0;
    let used = 0;
    for (let f = 0; f < n; f++) {
        acc += gain[f];
        used++;
        if (f >= W) acc -= gain[f - W];
        smooth[f] = acc / Math.min(used, W);
    }

    const silent = maxLevel < FLOOR;
    if (silent) return { samples, gainDb: 0, maxLevel, silent };

    const out = new Float32Array(samples.length);
    let sumGain = 0;
    for (let i = 0; i < samples.length; i++) {
        const g = smooth[Math.min(n - 1, Math.floor(i / FRAME))];
        sumGain += g;
        out[i] = Math.max(-1, Math.min(1, samples[i] * g));
    }
    const avgGain = sumGain / Math.max(1, samples.length);
    return { samples: out, gainDb: 20 * Math.log10(avgGain + 1e-9), maxLevel, silent };
}

function main() {
    const jobFile = argOf('--job');
    if (!jobFile || !fs.existsSync(jobFile)) {
        console.error('[asr] 缺少 --job 或文件不存在');
        process.exit(2);
    }
    const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    const engine = createAsrEngine({ engine: job.engine || config.asr.engine });
    fs.mkdirSync(job.segmentsDir, { recursive: true });
    fs.mkdirSync(path.dirname(job.progressFile), { recursive: true });

    const segments = [];
    /** speaker -> 4k 波形，供双轨回声相关性判定 */
    const waves = {};
    // 少任何一条音轨都只能算部分结果；宁可明确标注，也不把半通通话包装成完整终稿
    const expected = Array.isArray(job.expectedRoles) && job.expectedRoles.length
        ? job.expectedRoles
        : ['A', 'B'];
    let partial = (job.tracks || []).length < expected.length;

    for (const track of job.tracks || []) {
        if (!track.ogg || !fs.existsSync(track.ogg)) {
            partial = true;
            continue;
        }
        if (!track.complete || track.short) partial = true;

        // 音轨指纹：重新 finalize / 补传会改变它；再叠加管线版本，策略升级后旧文本自动失效
        const fingerprint = `${PIPELINE_VERSION}|${track.finalizedAt || track.durationMs || 0}`;

        const wav = path.join(job.dataDir, 'wav', `${track.speaker}.wav`);
        fs.mkdirSync(path.dirname(wav), { recursive: true });
        // 两阶段格式：识别用的 WAV 是临时文件，任务结束（含异常）即删除
        try {
            execFileSync(ffmpegPath(), [
                '-y', '-i', track.ogg,
                '-ar', String(SAMPLE_RATE), '-ac', '1', '-acodec', 'pcm_s16le',
                wav,
            ], { stdio: 'ignore' });

            const { samples, sampleRate, channels } = readWavPcm16(fs.readFileSync(wav));
            const mono = toMono16k(samples, sampleRate, channels);
            // 4k 波形保留给双轨回声相关判定（回声是对方语音的延迟副本）
            waves[track.speaker] = down4k(mono);

            // 先做自动增益再切段：手机 mic 电平偏低时，VAD 会漏掉大段正常说话
            const cond = conditionForAsr(mono);
            const peakDb = 20 * Math.log10(cond.maxLevel + 1e-9);
            if (cond.silent) {
                console.log(`[asr] ${job.callId} 轨${track.speaker}: 峰值 ${peakDb.toFixed(1)}dBFS，全程静音，跳过`);
                continue;
            }
            const list = splitForAsr(cond.samples);
            console.log(`[asr] ${job.callId} 轨${track.speaker}: ${(mono.length / SAMPLE_RATE).toFixed(1)}s 峰值=${peakDb.toFixed(1)}dBFS 增益=${cond.gainDb.toFixed(1)}dB -> ${list.length} 段`);
            if (list.length === 0) {
                // 绝不把整轨静音/噪声硬塞给识别器：那只会得到「The.」这类幻觉
                console.log(`[asr] ${job.callId} 轨${track.speaker}: VAD 未检测到语音段`);
                continue;
            }

            list.forEach((piece, idx) => {
                const cacheFile = path.join(job.segmentsDir, `${track.speaker}-${idx}.json`);
                let text = '';
                if (fs.existsSync(cacheFile)) {
                    // 分段续跑：只有同一版音轨（指纹一致）才复用上次的识别结果
                    try {
                        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                        if (String(cached.fp || '') === fingerprint) text = cached.text || '';
                    } catch (e) { text = ''; }
                }
                if (!text) {
                    const r = engine.transcribe(piece.samples);
                    text = (r.text || '').trim();
                    atomicWriteJson(cacheFile, { text, fp: fingerprint, at: Date.now() });
                }
                if (!text) return;
                // 纯标点/符号（"." "。"）是模型对噪声的输出，不是内容，直接丢弃
                const norm = normText(text);
                if (!norm) return;
                // 短促的单个英文虚词（The / Yeah / Thank）基本都是噪声幻觉，中文通话里没有信息量
                if (/^[a-z]{1,5}$/.test(norm) && piece.samples.length / SAMPLE_RATE < 2.5) return;
                // 纯假名/谚文的短碎片（はい / で / あみ / 아）：环境音在 SenseVoice 上的典型幻觉
                if (/^[\u3040-\u30ff\uac00-\ud7af]{1,4}$/.test(norm)) return;
                // 记录该段在「原始（未增益）音频」上的电平，供双轨去重时判断哪条是串音
                const s0 = piece.startSample;
                const s1 = Math.min(mono.length, s0 + piece.samples.length);
                let energy = 0;
                for (let k = s0; k < s1; k++) energy += mono[k] * mono[k];
                segments.push({
                    speaker: track.speaker,
                    startMs: Math.round(piece.startSample / SAMPLE_RATE * 1000),
                    endMs: Math.round((piece.startSample + piece.samples.length) / SAMPLE_RATE * 1000),
                    text,
                    rms: Math.sqrt(energy / Math.max(1, s1 - s0)),
                    // 原始音频的能量包络：串音判定用来和同时段的强段做相关性比较
                    env: envelope(mono.subarray(s0, s1)),
                });
                atomicWriteJson(job.progressFile, {
                    done: segments.length, speakers: track.speaker,
                });
            });
        } finally {
            try { if (fs.existsSync(wav)) fs.unlinkSync(wav); } catch (e) { /* 忽略 */ }
        }
    }

    // A/B 双轨各切各的，最后只按时间轴排序合并；绝不混音
    const merged = mergeRepeats(dedupeEcho(segments, waves));
    merged.sort((a, b) => a.startMs - b.startMs || a.speaker.localeCompare(b.speaker));

    atomicWriteJson(job.output, {
        callId: job.callId,
        partial,
        engine: engine.name,
        pipeline: PIPELINE_VERSION,
        vad: 'silero-v5+energy',
        sampleRate: SAMPLE_RATE,
        tracks: (job.tracks || []).map(t => ({
            speaker: t.speaker, complete: !!t.complete, durationMs: t.durationMs || 0,
        })),
        segments: merged.map((s) => ({
            speaker: s.speaker, startMs: s.startMs, endMs: s.endMs, text: s.text,
        })),
        createdAt: Date.now(),
    });
    console.log(`[asr] ${job.callId} 完成：${merged.length} 句${partial ? '（不完整）' : ''}`);
}

main();
