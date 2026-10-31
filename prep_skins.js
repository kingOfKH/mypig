// 一次性素材处理：裁掉 AI 水印（右下角）+ 压缩尺寸，输出到 data/skins/
const Jimp = require('jimp');
const path = require('path');
const fs = require('fs');

const SRC = 'D:/AndroidApp/starClick-a/.skins/tmp';
const DST = path.join(__dirname, 'data', 'skins');
fs.mkdirSync(DST, { recursive: true });

const ids = ['sakura', 'starry', 'marble', 'honey', 'cloud', 'neon'];

(async () => {
    for (const id of ids) {
        const src = path.join(SRC, `${id}.jpg`);
        if (!fs.existsSync(src)) { console.warn('缺文件:', src); continue; }
        const img = await Jimp.read(src);
        // 裁掉右下 12%（AI 水印区），保留左上 88%
        const w = Math.floor(img.getWidth() * 0.88);
        const h = Math.floor(img.getHeight() * 0.88);
        img.crop(0, 0, w, h);
        // 压缩到 1500 宽（气泡最大 72% 屏宽 ~860px，足够清晰且体积小）
        img.resize(1500, Jimp.AUTO);
        img.quality(88);
        await img.writeAsync(path.join(DST, `${id}.jpg`));
        console.log('OK', id, img.getWidth() + 'x' + img.getHeight());
    }
    console.log('ALL DONE');
})();
