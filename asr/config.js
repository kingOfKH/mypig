'use strict';

/**
 * 本地 ASR 配置：模型全部走本地 onnx，禁用任何云识别。
 * 模型目录默认在 web-server-a/models，可由 ASR_MODEL_DIR 覆盖。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODEL_DIR = process.env.ASR_MODEL_DIR
    ? path.resolve(process.env.ASR_MODEL_DIR)
    : path.join(ROOT, 'models');

const SAMPLE_RATE = 16000;

module.exports = {
    modelDir: MODEL_DIR,
    sampleRate: SAMPLE_RATE,

    /**
     * 识别管线版本：切段/增益/模型策略变化时递增。
     * 写进 transcript.json，服务重启时据此把旧版本结果自动重跑一遍。
     */
    pipelineVersion: 'v4.9.1-echo-corr',

    /** Silero VAD：切成 <=12s 的短语音段，贴合 SenseVoice 的训练分布 */
    vad: {
        model: path.join(MODEL_DIR, 'vad', 'silero_vad.onnx'),
        // 手机通话音频经过系统 AEC/NS 处理，电平与谱形都被削弱：
        // 实测阈值 0.5 会把整段正常说话判成静音（18s 通话只切出 1 句），
        // 0.1 + 更长的静音合并窗才能在真实录音上保住完整语句。
        threshold: Number(process.env.ASR_VAD_THRESHOLD || 0.1),
        minSilenceDuration: 0.6,
        minSpeechDuration: 0.1,
        maxSpeechDuration: 12,
        windowSize: 512,
    },

    /** SenseVoice int8（sherpa-onnx OfflineRecognizer） */
    asr: {
        engine: process.env.ASR_ENGINE || 'sensevoice',
        model: path.join(MODEL_DIR, 'sensevoice', 'model.int8.onnx'),
        tokens: path.join(MODEL_DIR, 'sensevoice', 'tokens.txt'),
        numThreads: Number(process.env.ASR_THREADS || 2),
        provider: 'cpu',
    },

    /** 服务启动时自动补齐模型（下载失败只告警，不阻塞通话） */
    autoDownload: process.env.ASR_AUTO_DOWNLOAD !== '0',
};
