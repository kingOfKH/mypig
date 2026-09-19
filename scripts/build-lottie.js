#!/usr/bin/env node
/**
 * 从 QFace 仓库拷贝 Lottie 矢量表情到服务端 public/qqface-lottie/，并生成 manifest.json。
 *
 * QFace 结构：public/assets/qq_emoji/{id}/lottie/{id}.json（部分含 _1.._6 多状态变体，本脚本只取基础变体）。
 * 输出：public/qqface-lottie/{id}.json + public/qqface-lottie/manifest.json（数字 id 数组，升序）。
 *
 * 用法：node scripts/build-lottie.js [QFace qq_emoji 目录]
 *   目录缺省为 d:/AndroidApp/starClick-b/github/QFace-master/QFace-master/public/assets/qq_emoji
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_SRC = 'd:/AndroidApp/starClick-b/github/QFace-master/QFace-master/public/assets/qq_emoji';
const src = process.argv[2] || DEFAULT_SRC;
const outDir = path.join(__dirname, '..', 'public', 'qqface-lottie');

if (!fs.existsSync(src)) {
    console.error('[build-lottie] 源目录不存在:', src);
    process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const ids = [];
const entries = fs.readdirSync(src, { withFileTypes: true });
for (const e of entries) {
    if (!e.isDirectory()) continue;
    const id = e.name;
    const lottieDir = path.join(src, id, 'lottie');
    if (!fs.existsSync(lottieDir)) continue;
    const base = path.join(lottieDir, `${id}.json`);
    if (!fs.existsSync(base)) {
        console.warn('[build-lottie] 跳过(无基础变体):', id);
        continue;
    }
    fs.copyFileSync(base, path.join(outDir, `${id}.json`));
    ids.push(id);
}

ids.sort((a, b) => Number(a) - Number(b));
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(ids));
console.log(`[build-lottie] 已生成 ${ids.length} 个 Lottie 表情 -> ${outDir}`);
console.log('[build-lottie] 示例:', ids.slice(0, 12).join(', '));
