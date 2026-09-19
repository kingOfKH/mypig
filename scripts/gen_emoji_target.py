#!/usr/bin/env python3
"""
生成 web-server-b/scripts/emoji_target.json —— 矢量表情归一化的"目标尺寸表"。

原理：位图表情（app/src/main/assets/qqface/s{id}.png）是用户已习惯的观感基准。
对每个表情测量其位图 alpha 内容包围盒，得到：
  ratio = max(内容宽, 内容高) / max(画布宽, 画布高)   —— 内容占画布的比例
  cx/cy = 内容中心在画布中的相对位置
归一化脚本（normalize_lottie.cjs）据此把矢量内容缩放/居中，
使矢量表情在客户端固定的 96dp 方框里渲染出与位图版本一致的大小。

依赖：Pillow（pip install pillow）
用法：python web-server-b/scripts/gen_emoji_target.py
"""
import json
import os
import statistics
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
ASSETS = os.path.join(ROOT, "app", "src", "main", "assets", "qqface")
LOTTIE_DIR = os.path.join(ROOT, "github", "QFace-master", "QFace-master", "public", "assets", "qq_emoji")
OUT = os.path.join(HERE, "emoji_target.json")

ids = []
for f in os.listdir(LOTTIE_DIR):
    p = os.path.join(LOTTIE_DIR, f, "lottie", f + ".json")
    if f.isdigit() and os.path.exists(p):
        ids.append(f)
ids.sort(key=lambda x: int(x))

targets = {}
ratios = []
for i in ids:
    fp = os.path.join(ASSETS, "s%s.png" % i)
    if not os.path.exists(fp):
        continue
    try:
        im = Image.open(fp).convert("RGBA")
    except Exception:
        continue
    W, H = im.size
    bb = im.split()[3].point(lambda v: 255 if v > 8 else 0).getbbox()
    if not bb:
        continue
    bw, bh = bb[2] - bb[0], bb[3] - bb[1]
    ratio = max(bw, bh) / max(W, H)
    targets[i] = {
        "ratio": round(ratio, 4),
        "aspect": round(bw / bh, 4) if bh > 0 else 1.0,
        "cx": round((bb[0] + bb[2]) / 2.0 / W, 4),
        "cy": round((bb[1] + bb[3]) / 2.0 / H, 4),
    }
    ratios.append(ratio)

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(targets, f, ensure_ascii=False, indent=0, sort_keys=True)

print("已生成 %d 个表情的目标表 -> %s" % (len(targets), OUT))
print("内容占比: 均值=%.3f 中位=%.3f 最小=%.3f 最大=%.3f" % (
    statistics.mean(ratios), statistics.median(ratios), min(ratios), max(ratios)))
print("回退默认值（无对应位图时使用）建议取中位数：%.3f" % statistics.median(ratios))
