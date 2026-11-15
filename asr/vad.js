'use strict';

/**
 * Silero VAD 切分：把整轨音频按语音活动切成短句（单段最长 12s）。
 *
 * 与参考实现相比的两处改动：
 * 1. 返回 { startSample, samples } —— 必须保留起点才能换算成通话时间轴上的 startMs；
 * 2. 时间轴保持连续：这里只决定「哪些区间送去识别」，绝不裁剪或丢弃静音，
 *    存档 Opus 始终是完整连续的一轨。
 */

const fs = require('fs');
const config = require('./config');

const WINDOW_SIZE = config.vad.windowSize;

function createVad() {
    if (!fs.existsSync(config.vad.model)) {
        throw new Error(`VAD 模型缺失: ${config.vad.model}`);
    }
    const sherpa = require('sherpa-onnx-node');
    return new sherpa.Vad(
        {
            sileroVad: {
                model: config.vad.model,
                threshold: config.vad.threshold,
                minSilenceDuration: config.vad.minSilenceDuration,
                minSpeechDuration: config.vad.minSpeechDuration,
                windowSize: WINDOW_SIZE,
                maxSpeechDuration: config.vad.maxSpeechDuration,
            },
            sampleRate: config.sampleRate,
            numThreads: 1,
            provider: 'cpu',
            debug: 0,
        },
        // 环形缓冲需容纳最长段 + 余量
        30
    );
}

/**
 * @param {Float32Array} samples 16k mono
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Array<{startSample:number, samples:Float32Array}>}
 */
function splitByVad(samples, onProgress) {
    const vad = createVad();
    const segments = [];
    let fed = 0;
    for (let i = 0; i + WINDOW_SIZE <= samples.length; i += WINDOW_SIZE) {
        vad.acceptWaveform(samples.subarray(i, i + WINDOW_SIZE));
        fed = i + WINDOW_SIZE;
        while (!vad.isEmpty()) {
            const seg = vad.front();
            // pop() 之后原生缓冲可能被复用，必须拷贝成 JS 自己的数组再保存
            segments.push({ startSample: seg.start || 0, samples: Float32Array.from(seg.samples) });
            vad.pop();
        }
        if (onProgress && (i / WINDOW_SIZE) % 200 === 0) onProgress(fed, samples.length);
    }
    // 不足一个窗口的尾部补齐后再喂一次，避免最后最多 32ms 语音被丢掉
    if (fed < samples.length) {
        const tail = new Float32Array(WINDOW_SIZE);
        tail.set(samples.subarray(fed));
        vad.acceptWaveform(tail);
        while (!vad.isEmpty()) {
            const seg = vad.front();
            segments.push({ startSample: seg.start || 0, samples: Float32Array.from(seg.samples) });
            vad.pop();
        }
    }
    vad.flush();
    while (!vad.isEmpty()) {
        const seg = vad.front();
        // 这里同样必须拷贝：flush 出来的最后一段同样指向原生缓冲
        segments.push({ startSample: seg.start || 0, samples: Float32Array.from(seg.samples) });
        vad.pop();
    }
    if (onProgress) onProgress(samples.length, samples.length);
    return segments;
}

/**
 * 纯能量分段（Silero 的兜底/补充）。
 *
 * 真实手机通话经过系统 AEC/NS 后谱形被破坏，Silero 仍会漏掉整句正常说话；
 * 这里用「帧能量相对本底噪声」做第二路检测，只负责把 VAD 漏掉的、确实有声的区间补回来。
 */
function splitByEnergy(samples) {
    const FRAME = 320;          // 20ms
    const HANG = 12;            // 前后各 240ms 保护带
    const MERGE = 30;           // 合并小于 600ms 的间隙
    const MIN_FRAMES = 12;      // 至少 240ms 才算一段
    const MAX_FRAMES = 600;     // 单段最长 12s

    const n = Math.ceil(samples.length / FRAME);
    if (n === 0) return [];
    const levels = new Float32Array(n);
    for (let f = 0; f < n; f++) {
        const from = f * FRAME;
        const to = Math.min(from + FRAME, samples.length);
        let sum = 0;
        for (let i = from; i < to; i++) sum += samples[i] * samples[i];
        levels[f] = Math.sqrt(sum / Math.max(1, to - from));
    }
    const sorted = Array.from(levels).sort((a, b) => a - b);
    const noise = sorted[Math.floor(sorted.length * 0.2)] || 0;
    const threshold = Math.max(noise * 3.5, 0.004);

    const active = new Uint8Array(n);
    for (let f = 0; f < n; f++) {
        if (levels[f] >= threshold) {
            const from = Math.max(0, f - HANG);
            const to = Math.min(n - 1, f + HANG);
            for (let k = from; k <= to; k++) active[k] = 1;
        }
    }

    const regions = [];
    let f = 0;
    while (f < n) {
        if (!active[f]) { f++; continue; }
        const start = f;
        let last = f;
        while (f < n && active[f]) { last = f; f++; }
        const prev = regions[regions.length - 1];
        if (prev && start - prev.end < MERGE) prev.end = last;
        else regions.push({ start, end: last });
    }

    const out = [];
    for (const r of regions) {
        if (r.end - r.start < MIN_FRAMES) continue;
        let s = r.start;
        while (r.end - s > MAX_FRAMES) {
            out.push({ start: s, end: s + MAX_FRAMES });
            s += MAX_FRAMES;
        }
        out.push({ start: s, end: r.end });
    }
    return out.map((r) => ({
        startSample: r.start * FRAME,
        samples: samples.subarray(r.start * FRAME, Math.min((r.end + 1) * FRAME, samples.length)),
    }));
}

/**
 * 在长区间内部按「能量低谷」再切一刀：并集容易把相邻几句话连成 6~10s 的长段，
 * 既影响阅读，也让点句回听定位不准。低谷判定相对于该段自身语音电平，不依赖全局阈值。
 */
function splitAtValleys(samples, start, end) {
    const FRAME = 320;          // 20ms
    const QUIET_FRAMES = 18;    // 连续 360ms 低于低谷线才切，避免把一句话切碎
    const MIN_PIECE = 15;       // 切出来的碎片至少 300ms

    const n = Math.ceil((end - start) / FRAME);
    if (n < 2) return [{ start, end }];
    const levels = new Float32Array(n);
    for (let f = 0; f < n; f++) {
        const from = start + f * FRAME;
        const to = Math.min(from + FRAME, end);
        let sum = 0;
        for (let i = from; i < to; i++) sum += samples[i] * samples[i];
        levels[f] = Math.sqrt(sum / Math.max(1, to - from));
    }
    const sorted = Array.from(levels).sort((a, b) => a - b);
    const speech = sorted[Math.floor(sorted.length * 0.9)] || 0;
    const gate = Math.max(speech * 0.12, 0.002);

    const cuts = [];
    let f = 0;
    while (f < n) {
        if (levels[f] >= gate) { f++; continue; }
        const begin = f;
        while (f < n && levels[f] < gate) f++;
        if (f - begin >= QUIET_FRAMES) cuts.push(Math.floor((begin + f) / 2));
    }
    if (cuts.length === 0) return [{ start, end }];

    const pieces = [];
    let cursor = 0;
    for (const c of cuts) {
        if (c - cursor < MIN_PIECE) continue;
        pieces.push({ start: start + cursor * FRAME, end: start + c * FRAME });
        cursor = c;
    }
    if (pieces.length === 0) return [{ start, end }];

    // 尾巴太短就并回上一句，避免为了切句把最后一点内容丢掉
    const tailStart = start + cursor * FRAME;
    if (end - tailStart >= MIN_PIECE * FRAME) pieces.push({ start: tailStart, end });
    else pieces[pieces.length - 1].end = end;
    return pieces;
}

/**
 * 识别用切段：Silero 与能量检测取并集。
 *
 * 只做「取 Silero 段」会漏掉整句（实测 14s 通话只切出 4 个残句）；
 * 只做能量段又容易把句子边界放得太宽。两路取并集后，
 * 一句话既不会被 VAD 截断，也不会被切成两半重复识别。
 */
function splitForAsr(samples) {
    const silero = splitByVad(samples);
    const energy = splitByEnergy(samples);
    const intervals = [...silero, ...energy]
        .map((s) => ({ start: s.startSample, end: s.startSample + s.samples.length }))
        .sort((a, b) => a.start - b.start);

    const union = [];
    for (const iv of intervals) {
        const prev = union[union.length - 1];
        // 相邻不足 100ms 的区间直接并起来（同一句话被两路各切了一半）
        if (prev && iv.start - prev.end <= 1600) prev.end = Math.max(prev.end, iv.end);
        else union.push({ start: iv.start, end: iv.end });
    }

    const out = [];
    for (const iv of union) {
        // 并集后的长区间先按能量低谷切成句子，再做 12s 上限保护
        for (const piece of splitAtValleys(samples, iv.start, Math.min(iv.end, samples.length))) {
            let s = piece.start;
            const end = Math.min(piece.end, samples.length);
            while (end - s > MAX_SEGMENT_SAMPLES) {
                out.push({ startSample: s, samples: samples.subarray(s, s + MAX_SEGMENT_SAMPLES) });
                s += MAX_SEGMENT_SAMPLES;
            }
            out.push({ startSample: s, samples: samples.subarray(s, end) });
        }
    }
    return out;
}

const MAX_SEGMENT_SAMPLES = config.vad.maxSpeechDuration * config.sampleRate;

module.exports = { splitByVad, splitByEnergy, splitForAsr, createVad };
