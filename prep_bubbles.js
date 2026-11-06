// 完整气泡造型处理：裁 AI 水印 → 边缘泛洪去白底（造型外区域透明，边框/内部保留）
// → 连通域清理+紧贴裁剪（造型顶满画布，九宫格铺满后才能盖住文字）→ PNG
const Jimp = require('jimp');
const path = require('path');
const fs = require('fs');
const { keepLargestComponentAndTrim } = require('./trim_bubbles');

const SRC = 'D:/AndroidApp/starClick-a/.skins/tmp';
const DST = path.join(__dirname, 'data', 'skins');
fs.mkdirSync(DST, { recursive: true });

// id 映射到客户端 BubbleSkins 的 imageId；threshold 越高去背越保守（云朵白边用 252 防泄漏）
const files = [
    ['bubble_goldframe.jpg', 'bubble_marble.png', 246],
    ['bubble_cat.jpg',        'bubble_honey.png',  246],
    ['bubble_starry.jpg',     'bubble_starry.png', 246],
    ['bubble_cloud.jpg',      'bubble_cloud.png',  252],
    ['bubble_neon.jpg',       'bubble_neon.png',   246],
];

(async () => {
    for (const [srcName, dstName, TH] of files) {
        const src = path.join(SRC, srcName);
        if (!fs.existsSync(src)) { console.warn('缺文件:', src); continue; }
        const img = await Jimp.read(src);
        // 裁掉底部 8% + 右侧 4%（AI 水印区）
        const cw = Math.floor(img.getWidth() * 0.96);
        const ch = Math.floor(img.getHeight() * 0.92);
        img.crop(0, 0, cw, ch);
        img.resize(1500, Jimp.AUTO);
        const w = img.getWidth(), h = img.getHeight();
        const d = img.bitmap.data;
        const idx = (x, y) => (y * w + x) * 4;
        const isBg = (x, y) => {
            const i = idx(x, y);
            return d[i + 3] > 0 && d[i] >= TH && d[i + 1] >= TH && d[i + 2] >= TH;
        };
        // 边缘泛洪：仅清除与画布边缘连通的白区（气泡造型内部由边框包围，不受影响）
        const visited = new Uint8Array(w * h);
        const stack = [];
        for (let x = 0; x < w; x++) { stack.push([x, 0]); stack.push([x, h - 1]); }
        for (let y = 0; y < h; y++) { stack.push([0, y]); stack.push([w - 1, y]); }
        while (stack.length) {
            const [x, y] = stack.pop();
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const p = y * w + x;
            if (visited[p]) continue;
            visited[p] = 1;
            if (!isBg(x, y)) continue;
            const i = idx(x, y);
            d[i + 3] = 0;
            stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
        // 连通域清理 + 紧贴裁剪：清除泛洪残留的孤立噪点口袋，并让造型顶满画布
        const r = await keepLargestComponentAndTrim(img);
        await img.writeAsync(path.join(DST, dstName));
        console.log('OK', dstName, `${r.cw}x${r.ch}（原图 ${r.w}x${r.h}，连通域 ${r.compCount} 个）`);
    }
    console.log('ALL DONE');
})();
