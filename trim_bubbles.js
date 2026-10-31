// 裁剪 data/skins/bubble_*.png 的透明留白（连通域版）：
// 1) alpha>30 像素做连通域标记，仅保留最大连通域（真实气泡造型是一整块连续区域），
//    其余孤立噪点（JPEG 光晕残留的隐形小点，alpha 可达 100+ 且成簇）直接置透明；
// 2) 再按 alpha>16 bbox 裁剪。
// 为何不用按行/列阈值裁：散点簇会让裁剪提前停住，画布与可见造型之间仍有大片透明区，
// 九宫格铺满后背景盖不住文字（实测踩坑）。
const Jimp = require('jimp');
const path = require('path');
const fs = require('fs');

const DIR = path.join(__dirname, 'data', 'skins');
const ALPHA_MASK = 30;   // 连通域掩码阈值（保留可见内容及柔光边缘）
const ALPHA_TRIM = 16;   // 最终 bbox 裁剪阈值

/**
 * 连通域清理 + 紧贴裁剪（供 prep_bubbles.js 管线复用）：
 * 仅保留 alpha>ALPHA_MASK 的最大连通域（真实造型是一整块连续区域），孤立噪点置透明，
 * 再按可见内容边界裁剪，确保造型顶满画布——九宫格铺满后背景才能完整覆盖文字。
 */
async function keepLargestComponentAndTrim(img) {
    const w = img.getWidth(), h = img.getHeight();
    const d = img.bitmap.data;
    const n = w * h;
    // 连通域标记（4 邻接，迭代栈避免递归爆栈）
    const label = new Int32Array(n).fill(-1);
    const stack = new Int32Array(n);
    let compCount = 0;
    const compSize = [];
    for (let start = 0; start < n; start++) {
        if (label[start] !== -1 || d[start * 4 + 3] <= ALPHA_MASK) continue;
        const id = compCount++;
        let size = 0, top = 0;
        stack[top++] = start;
        label[start] = id;
        while (top > 0) {
            const pIdx = stack[--top];
            size++;
            const x = pIdx % w, y = (pIdx / w) | 0;
            if (x > 0)     { const q = pIdx - 1; if (label[q] === -1 && d[q * 4 + 3] > ALPHA_MASK) { label[q] = id; stack[top++] = q; } }
            if (x < w - 1) { const q = pIdx + 1; if (label[q] === -1 && d[q * 4 + 3] > ALPHA_MASK) { label[q] = id; stack[top++] = q; } }
            if (y > 0)     { const q = pIdx - w; if (label[q] === -1 && d[q * 4 + 3] > ALPHA_MASK) { label[q] = id; stack[top++] = q; } }
            if (y < h - 1) { const q = pIdx + w; if (label[q] === -1 && d[q * 4 + 3] > ALPHA_MASK) { label[q] = id; stack[top++] = q; } }
        }
        compSize.push(size);
    }
    if (compCount === 0) throw new Error('全透明图像');
    let maxId = 0;
    for (let i = 1; i < compSize.length; i++) if (compSize[i] > compSize[maxId]) maxId = i;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let i = 0; i < n; i++) {
        if (d[i * 4 + 3] > ALPHA_TRIM) {
            if (label[i] === maxId) {
                const x = i % w, y = (i / w) | 0;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            } else {
                d[i * 4 + 3] = 0;
            }
        }
    }
    const cw = maxX - minX + 1, ch = maxY - minY + 1;
    if (cw !== w || ch !== h) img.crop(minX, minY, cw, ch);
    return { w, h, cw, ch, compCount };
}

if (require.main === module) {
(async () => {
    const files = fs.readdirSync(DIR).filter(f => f.startsWith('bubble_') && f.endsWith('.png'));
    for (const f of files) {
        const p = path.join(DIR, f);
        const img = await Jimp.read(p);
        const w = img.getWidth(), h = img.getHeight();
        const r = await keepLargestComponentAndTrim(img);
        if (r.cw !== w || r.ch !== h) {
            await img.writeAsync(p);
            console.log(`OK ${f}: ${w}x${h} -> ${r.cw}x${r.ch}（连通域 ${r.compCount} 个）`);
        } else {
            console.log(f, '无变化');
        }
    }
    console.log('ALL DONE');
})();
}
module.exports = { keepLargestComponentAndTrim };
