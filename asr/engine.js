'use strict';

/**
 * AsrEngine 统一接口（工厂 + 配置）。
 *
 * 所有识别调用都必须经过这里，方便后续把 SenseVoice 换成别的本地模型：
 *   const engine = createAsrEngine();       // { name, sampleRate, transcribe(samples) }
 *   engine.transcribe(Float32Array)         // -> { text }
 *
 * 注意：只在 worker 子进程里调用，模型不常驻主服务进程（即用即启动）。
 */

const config = require('./config');

/** @returns {{name:string, sampleRate:number, transcribe:(samples:Float32Array)=>{text:string}}} */
function createAsrEngine(overrides) {
    const conf = { ...config.asr, ...(overrides || {}) };
    switch (conf.engine) {
        case 'sensevoice':
            return createSenseVoice(conf);
        default:
            throw new Error(`未知 ASR 引擎: ${conf.engine}（当前仅支持 sensevoice）`);
    }
}

function createSenseVoice(conf) {
    let recognizer = null;
    // 延迟 require：sherpa native 库较重，只有真正跑任务时才加载
    const sherpa = () => require('sherpa-onnx-node');

    function getRecognizer() {
        if (!recognizer) {
            recognizer = new (sherpa().OfflineRecognizer)({
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                    senseVoice: {
                        model: conf.model,
                        language: 'auto',
                        useInverseTextNormalization: 1,
                    },
                    tokens: conf.tokens,
                    numThreads: conf.numThreads,
                    provider: conf.provider,
                    debug: 0,
                },
            });
        }
        return recognizer;
    }

    return {
        name: 'sensevoice-int8',
        sampleRate: 16000,
        transcribe(samples) {
            const rec = getRecognizer();
            const stream = rec.createStream();
            stream.acceptWaveform({ sampleRate: 16000, samples });
            rec.decode(stream);
            const result = rec.getResult(stream);
            return { text: ((result && result.text) || '').trim() };
        },
    };
}

module.exports = { createAsrEngine };
