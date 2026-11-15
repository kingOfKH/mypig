'use strict';

/**
 * 模型自检 / 一次性下载（服务启动时调用）。
 *
 * 说明：sherpa-onnx-node 是 npm 依赖，npm install 即可装好；
 * 但 Silero VAD 与 SenseVoice 是 .onnx 权重文件，不在 npm registry，必须单独下载。
 * 这里按「已存在则跳过」的幂等逻辑补齐，失败只告警，不影响通话功能。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const config = require('../asr/config');

const SENSEVOICE_REPO = 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main';

const FILES = [
    {
        name: 'Silero VAD',
        required: () => [config.vad.model],
        // 643KB 小文件；GitHub 国内可能超时，优先走 hf-mirror 兜底
        direct: [
            {
                url: 'https://hf-mirror.com/onnx-community/silero-vad/resolve/main/onnx/model.onnx',
                target: config.vad.model,
            },
            {
                url: 'https://hf-mirror.com/deepghs/silero-vad-onnx/resolve/main/silero_vad.onnx',
                target: config.vad.model,
            },
            {
                url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
                target: config.vad.model,
            },
        ],
    },
    {
        name: 'SenseVoice int8',
        required: () => [config.asr.model, config.asr.tokens],
        // 只下 int8 单文件（约 228MB）；官方归档包 999MB（含 fp32），不适合启动时自动下载
        direct: [
            { url: `${SENSEVOICE_REPO}/model.int8.onnx`, target: config.asr.model },
            { url: `${SENSEVOICE_REPO}/tokens.txt`, target: config.asr.tokens },
        ],
    },
];

function download(url, dest, redirects = 0) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('http://') ? http : https;
        const req = client.get(url, { headers: { 'User-Agent': 'starclick-asr-setup' } }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 8) {
                res.resume();
                // hf-mirror 的 Location 可能是相对路径（/api/resolve-cache/...），必须按原 URL 解析
                const next = new URL(res.headers.location, url).toString();
                return resolve(download(next, dest, redirects + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const total = Number(res.headers['content-length'] || 0);
            let got = 0;
            let lastLog = 0;
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            const out = fs.createWriteStream(dest);
            res.on('data', (chunk) => {
                got += chunk.length;
                if (total && Date.now() - lastLog > 5000) {
                    lastLog = Date.now();
                    console.log(`[asr-setup] 下载中 ${path.basename(dest)} ${(got / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)}MB`);
                }
            });
            res.on('error', reject);
            res.pipe(out);
            out.on('finish', () => out.close(() => resolve(dest)));
            out.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(60000, () => req.destroy(new Error('连接超时')));
    });
}

/** 逐文件下载并校验；任一必需文件失败则整体失败 */
async function fetchOne(file, log) {
    for (const item of file.direct || []) {
        if (fs.existsSync(item.target)) continue;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                log(`[asr-setup] 下载 ${file.name}: ${item.url}`);
                const tmp = `${item.target}.part`;
                await download(item.url, tmp);
                if (!fs.statSync(tmp).size) throw new Error('文件为空');
                fs.mkdirSync(path.dirname(item.target), { recursive: true });
                fs.renameSync(tmp, item.target);
                break;
            } catch (e) {
                log(`[asr-setup] 下载失败（${item.url}，第 ${attempt} 次）: ${e.message}`);
                try { fs.rmSync(`${item.target}.part`, { force: true }); } catch (_) { /* ignore */ }
            }
        }
    }
    return file.required().every((p) => fs.existsSync(p));
}

/**
 * @returns {Promise<{ready:boolean, missing:string[]}>}
 */
async function ensureModels(log = console.log) {
    const missing = [];
    for (const file of FILES) {
        if (file.required().every((p) => fs.existsSync(p))) continue;
        if (!config.autoDownload) {
            log(`[asr-setup] 缺少 ${file.name}，ASR_AUTO_DOWNLOAD=0 已跳过下载`);
            missing.push(file.name);
            continue;
        }
        if (!(await fetchOne(file, log))) missing.push(file.name);
    }
    if (missing.length) {
        log(`[asr-setup] 模型缺失: ${missing.join(', ')}；转写任务会失败，但通话功能不受影响`);
    } else {
        log('[asr-setup] 模型就绪');
    }
    return { ready: missing.length === 0, missing };
}

module.exports = { ensureModels };
