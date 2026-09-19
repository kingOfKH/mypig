/**
 * 校验 qqface-lottie 归一化结果：
 *  - 内容占画布比例是否与位图基准（scripts/emoji_target.json）一致（= 渲染大小一致）；
 *  - 内容是否**完整落在画布内**（超出就会被裁掉，是"看起来被切/消失"的直接原因）；
 *  - 内容中心是否基本居中（偏移过大说明被移位了）；
 *  - 画布是否已归一为正方形。
 *
 * 用法：node web-server-b/verify_lottie.cjs
 */
const fs = require('fs');
const path = require('path');

const norm = require('./normalize_lottie.cjs');
const DIR = norm.DIR;
const TARGETS = norm.TARGETS;
const DEFAULT_RATIO = 0.906;

function pct(arr, q) {
  const s = arr.slice().sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'manifest.json');
const rows = [];
let noRoot = 0, noGeo = 0;

for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const hasRoot = (j.layers || []).some(l => l.nm === 'normalizeRoot');
  if (!hasRoot) noRoot++;
  let info = norm.visibleBBox(j, true);
  if (!info) info = norm.visibleBBox(j, true, true);
  if (!info) { noGeo++; continue; }
  const { box, W, H } = info;
  const cw = box.x1 - box.x0, ch = box.y1 - box.y0;
  const ratio = Math.max(cw, ch) / Math.max(W, H);
  const id = path.basename(f, '.json');
  const t = TARGETS[id] || {};
  const want = typeof t.ratio === 'number' ? t.ratio : DEFAULT_RATIO;
  // 溢出：内容包围盒超出画布的像素量（>1px 即认为被裁切）
  const over = Math.max(0, -box.x0, -box.y0, box.x1 - W, box.y1 - H);
  const off = Math.max(Math.abs((box.x0 + box.x1) / 2 / W - 0.5), Math.abs((box.y0 + box.y1) / 2 / H - 0.5));
  // 内容是否顶到画布边缘（= 真实范围被画布截断，测到的只是下界，偏差属预期）
  const touches = box.x0 <= 1 || box.y0 <= 1 || box.x1 >= W - 1 || box.y1 >= H - 1;
  rows.push({ f, W, H, hasRoot, touches, ratio: +ratio.toFixed(3), want: +want.toFixed(3), diff: +(ratio - want).toFixed(3), over: +over.toFixed(1), off: +off.toFixed(3) });
}

const rs = rows.map(r => r.ratio);
const ds = rows.map(r => Math.abs(r.diff));
const ov = rows.map(r => r.over);
const of = rows.map(r => r.off);
console.log('文件数:', files.length, ' 有可见内容:', rows.length, ' 无可见内容:', noGeo, ' 未归一化(被闸门放过):', noRoot);
console.log('内容占比:        min=%s 中位=%s max=%s  （位图基准: 0.781 / 0.906 / 1.000）',
  pct(rs, 0).toFixed(3), pct(rs, .5).toFixed(3), pct(rs, 1).toFixed(3));
console.log('与位图基准偏差:   中位=%s p90=%s max=%s', pct(ds, .5).toFixed(3), pct(ds, .9).toFixed(3), pct(ds, 1).toFixed(3));
console.log('内容超出画布(px): 中位=%s p90=%s max=%s  → 超出>2px 的文件数: %d',
  pct(ov, .5).toFixed(1), pct(ov, .9).toFixed(1), pct(ov, 1).toFixed(1), rows.filter(r => r.over > 2).length);
console.log('中心偏离画布中心: 中位=%s p90=%s max=%s  → 偏离>0.10 的文件数: %d',
  pct(of, .5).toFixed(3), pct(of, .9).toFixed(3), pct(of, 1).toFixed(3), rows.filter(r => r.off > 0.10).length);
console.log('非正方形画布的文件数:', rows.filter(r => r.W !== r.H).length);

const normRows = rows.filter(r => r.hasRoot);
console.log('\n已归一化 %d 个：占比偏差 中位=%s p90=%s max=%s',
  normRows.length,
  pct(normRows.map(r => Math.abs(r.diff)), .5).toFixed(3),
  pct(normRows.map(r => Math.abs(r.diff)), .9).toFixed(3),
  pct(normRows.map(r => Math.abs(r.diff)), 1).toFixed(3));

// 只有"内容完整落在画布内"的文件，测量才是精确的 —— 这一组必须接近 0，否则说明算法有问题
const exact = normRows.filter(r => !r.touches);
console.log('其中内容未溢出画布（测量精确）%d 个：偏差 中位=%s p90=%s max=%s  ← 关键指标',
  exact.length,
  pct(exact.map(r => Math.abs(r.diff)), .5).toFixed(3),
  pct(exact.map(r => Math.abs(r.diff)), .9).toFixed(3),
  pct(exact.map(r => Math.abs(r.diff)), 1).toFixed(3));
const badExact = exact.filter(r => Math.abs(r.diff) > 0.03).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
console.log('  该组偏差>0.03:', badExact.length);
for (const r of badExact.slice(0, 15)) console.log('   ', r.f, 'ratio=' + r.ratio, 'want=' + r.want, 'diff=' + r.diff);

const badN = normRows.filter(r => Math.abs(r.diff) > 0.05).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
console.log('\n已归一化但偏差>0.05:', badN.length, '（其中内容溢出画布', badN.filter(r => r.touches).length, '个 —— 溢出时测量只是下界，偏差属预期）');
for (const r of badN.slice(0, 10)) console.log('  ', r.f, 'ratio=' + r.ratio, 'want=' + r.want, 'diff=' + r.diff, r.touches ? '(溢出)' : '(未溢出!)');

const bad = rows.filter(r => !r.hasRoot && Math.abs(r.diff) > 0.05).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
console.log('\n被闸门放过（未修改）且偏差>0.05:', bad.length, '（这部分保持原始观感，未做任何改动）');
for (const r of bad.slice(0, 10)) console.log('  ', r.f, 'ratio=' + r.ratio, 'want=' + r.want, 'diff=' + r.diff);

const cut = rows.filter(r => r.over > 2).sort((a, b) => b.over - a.over);
console.log('\n内容被画布裁切:', cut.length);
for (const r of cut.slice(0, 15)) console.log('  ', r.f, '超出=' + r.over + 'px', '画布=' + r.W + 'x' + r.H);

const shifted = rows.filter(r => r.off > 0.10).sort((a, b) => b.off - a.off);
console.log('\n内容明显偏离中心:', shifted.length, '（其中已归一化', shifted.filter(r => r.hasRoot).length, '个）');
for (const r of shifted.slice(0, 15)) console.log('  ', r.f, 'off=' + r.off, r.hasRoot ? '(已归一化!)' : '(未改动)');
const nOff = normRows.map(r => r.off);
console.log('已归一化文件的中心偏离: 中位=%s p90=%s max=%s（应 ≤0.10）',
  pct(nOff, .5).toFixed(3), pct(nOff, .9).toFixed(3), pct(nOff, 1).toFixed(3));
