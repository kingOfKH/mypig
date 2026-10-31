// 一次性立绘处理：裁 AI 水印 → 边缘泛洪去白底（不伤主体内部白色）→ 缩放 → PNG 透明底输出
const Jimp = require('jimp');
const path = require('path');
const fs = require('fs');

const SRC = 'D:/AndroidApp/starClick-a/.skins/tmp';
const DST = path.join(__dirname, 'data', 'skins');
fs.mkdirSync(DST, { recursive: true });

const ids = ['sakura', 'cloud', 'honey', 'starry', 'neon', 'marble'];
const THRESHOLD = 244; // r/g/b 全部 ≥ 该值视为背景白

(async () => {
    for (const id of ids) {
        const src = path.join(SRC, `deco_${id}.jpg`);
        if (!fs.existsSync(src)) { console.warn('缺文件:', src); continue; }
        const img = await Jimp.read(src);
        // 裁掉底部 8%（AI 水印区）
        const cw = img.getWidth();
        const ch = Math.floor(img.getHeight() * 0.92);
        img.crop(0, 0, cw, ch);
        // 缩到高 900
        img.resize(Jimp.AUTO, 900);
        const w = img.getWidth(), h = img.getHeight();
        const d = img.bitmap.data;
        const idx = (x, y) => (y * w + x) * 4;
        const isBg = (x, y) => {
            const i = idx(x, y);
            return d[i + 3] > 0 && d[i] >= THRESHOLD && d[i + 1] >= THRESHOLD && d[i + 2] >= THRESHOLD;
        };
        // 边缘泛洪：从四边所有背景白像素 BFS，仅清除与边缘连通的白区（主体内部白色不受影响）
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
            d[i + 3] = 0; // 透明
            stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
        // 输出前裁掉完全透明的边缘（trim）
        img.writeAsync(path.join(DST, `deco_${id}.png`));
        console.log('OK deco_' + id, w + 'x' + h);
    }
    // 等全部写完再退出
    setTimeout(() => console.log('ALL DONE'), 1500);
})();
