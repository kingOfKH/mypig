/**
 * qqface-lottie 矢量表情尺寸归一化（仅用于"矢量内容占比明显偏小/偏位"的表情，让其渲染大小与位图版一致）。
 *
 * 重要前提：表情素材本身是正确的（QQ 能正常展示同一个文件）。渲染端的方框为正方形，
 * 用 ContentScale.Fit 等比缩放 + 居中即可正确显示，非正方形画布（如 512x245）也会被等比缩放进方框，
 * 不会"变小/偏上"。本脚本只修正"内容在画布里占比过小/过偏"这类问题，绝不做画布形状变换。
 *
 * 做法：
 *  1) 计算每个表情"用户真正看得见的内容包围盒"——
 *     - 跳过隐藏层(hd)、遮罩层(tt/td，几何只作蒙版、不直接绘制)及其子树；
 *     - 只取首帧几何（形变动画的后续关键帧常带极端坐标，会把包围盒撑爆）；
 *     - 丢弃完全落在画布外的形状（不可见），其余形状按画布裁剪后取并集；
 *  2) 以**同一个表情的位图版本**为基准（scripts/emoji_target.json：位图 alpha 内容占画布比例/长宽比/中心），
 *     把矢量内容等比缩放 + 居中，使其渲染大小与位图版本一致（缺位图时回退到中位数 0.906 / 居中）；
 *  3) 可信度闸门：长宽比与位图差异过大、或所需缩放超出 [0.6,2.5]、或内容顶到画布边缘还要放大
 *     一律**原样放过**（宁可不修，也不能改坏）；
 *  4) 内容顶到画布边缘（真实范围被截断、测到的只是下界）时只允许缩小、不允许放大；
 *     缩放+落点还受"变换后内容必须完整落在画布内"约束，保证绝不会被裁切；
 *  5) 通过插入 root null 层（normalizeRoot）并重新 parent 顶层图层实现，可重复执行（幂等）。
 *
 * 用法：node web-server-b/normalize_lottie.cjs
 *       （通常与 scripts/build-lottie.js 连用：先重生成干净原始文件，再归一化）
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'public', 'qqface-lottie');
const TARGET_FILE = path.join(__dirname, 'scripts', 'emoji_target.json');
const DEFAULT_RATIO = 0.906; // 位图内容占比中位数（无对应位图时的回退值）
// 安全闸门：估计不可信时宁可不动，也不要把表情改坏（曾经迭代"收敛"反而把表情移出画布）
const F_SKIP_MIN = 0.6, F_SKIP_MAX = 2.5; // 所需缩放超出此区间 → 判定估计不可信，原样放过
const MAX_ASPECT_ERR = 0.223;             // ln(1.25)：矢量内容长宽比与位图内容长宽比的最大允许差异

const TARGETS = (() => {
  try { return JSON.parse(fs.readFileSync(TARGET_FILE, 'utf8')); } catch (e) { return {}; }
})();

// ---- 2D 仿射矩阵 ----
function ident() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
function compose(m2, m1) {
  return {
    a: m2.a * m1.a + m2.c * m1.b,
    b: m2.b * m1.a + m2.d * m1.b,
    c: m2.a * m1.c + m2.c * m1.d,
    d: m2.b * m1.c + m2.d * m1.d,
    e: m2.a * m1.e + m2.c * m1.f + m2.e,
    f: m2.b * m1.e + m2.d * m1.f + m2.f,
  };
}
function apply(m, p) { return [m.a * p[0] + m.c * p[1] + m.e, m.b * p[0] + m.d * p[1] + m.f]; }

// ---- Lottie 属性取值（拆掉 {a,k} 包装 / 取首帧关键帧 / 支持 x,y 拆分形式）----
function val(v) { if (v && typeof v === 'object' && !Array.isArray(v) && 'k' in v) return v.k; return v; }
function getScalar(v) {
  v = val(v);
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) {
    const f = v[0];
    if (f == null) return 0;
    if (typeof f === 'number') return f;
    // 关键帧：{t,s,...} 取起始值
    if (f.s != null) return Array.isArray(f.s) ? f.s[0] : getScalar(f.s);
    if (f.v != null) return Array.isArray(f.v) ? f.v[0] : getScalar(f.v);
    return getScalar(f);
  }
  return 0;
}
function getXY(v) {
  v = val(v);
  if (v == null) return [0, 0];
  if (Array.isArray(v)) {
    if (typeof v[0] === 'number') return [v[0], v[1] == null ? 0 : v[1]]; // 普通坐标数组 [x,y,z]
    const f = v[0]; // 关键帧数组：取首帧
    if (f == null) return [0, 0];
    if (f.s != null) return Array.isArray(f.s) ? [f.s[0], f.s[1]] : getXY(f.s);
    if (f.v != null) return Array.isArray(f.v) ? [f.v[0], f.v[1]] : getXY(f.v);
    return [0, 0];
  }
  if (typeof v === 'object') {
    // 拆分形式：{s:true, x:{a,k}, y:{a,k}} 或 {x:number, y:number}
    if (v.x != null || v.y != null) return [v.x != null ? getScalar(v.x) : 0, v.y != null ? getScalar(v.y) : 0];
    if (v.k != null) return getXY(v.k);
    return [0, 0];
  }
  return [v, v];
}

/** 缩放属性：支持裸数字、[x,y,z] 数组、{a,k} 包装与关键帧数组，返回 [sx,sy]（百分数） */
function getScale2(v) {
  const x = val(v);
  if (x == null) return [100, 100];
  if (typeof x === 'number') return [x, x];
  if (Array.isArray(x)) {
    const f = x[0];
    if (f == null) return [100, 100];
    if (typeof f === 'number') return [f, x[1] == null ? f : x[1]];
    if (f.s != null) return Array.isArray(f.s) ? [f.s[0], f.s[1] == null ? f.s[0] : f.s[1]] : [getScalar(f.s), getScalar(f.s)];
    if (f.v != null) return Array.isArray(f.v) ? [f.v[0], f.v[1]] : [getScalar(f.v), getScalar(f.v)];
  }
  return [100, 100];
}

function trMatrix(t) {
  if (!t) return ident();
  const sc = getScale2(t.s != null ? t.s : 100);
  const sx = sc[0] / 100 || 1;
  const sy = sc[1] / 100 || 1;
  const a = getXY(t.a), p = getXY(t.p);
  const rad = getScalar(t.r != null ? t.r : 0) * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const Tneg = { a: 1, b: 0, c: 0, d: 1, e: -a[0], f: -a[1] };
  const S = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
  const R = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
  const Tpos = { a: 1, b: 0, c: 0, d: 1, e: p[0], f: p[1] };
  return compose(Tpos, compose(R, compose(S, Tneg)));
}
function layerMatrix(ks) { return trMatrix(ks); }

/** 图层不透明度（首帧），用于剔除完全透明的层 */
function layerOpacity(ks) {
  const o = ks && ks.o;
  if (o == null) return 100;
  return getScalar(o);
}

// ---- 形状几何 ----
/**
 * 路径顶点。只取**首帧**（第一个关键帧的起始值）：
 * 形变动画的后续关键帧常带极端坐标，会把包围盒撑到离谱大小，导致表情被缩得极小。
 */
function pathObjs(pk) {
  const out = [];
  pk = val(pk);
  if (Array.isArray(pk)) {
    const kf = pk[0];
    let o = kf && (kf.s != null ? kf.s : (kf.e != null ? kf.e : kf));
    if (o != null) { if (Array.isArray(o)) o = o[0]; if (o && o.v) out.push(o); }
  } else if (pk && pk.v) out.push(pk);
  return out;
}
function shapePoints(sh, M) {
  const pts = [];
  const push = (x, y) => { const w = apply(M, [x, y]); if (Number.isFinite(w[0]) && Number.isFinite(w[1])) pts.push(w); };
  if (sh.ty === 'sh') {
    for (const o of pathObjs(sh.ks)) for (const v of (o.v || [])) push(v[0], v[1]);
  } else if (sh.ty === 'rc' || sh.ty === 'el') {
    const s = getXY(sh.s), p = getXY(sh.p);
    const hw = s[0] / 2, hh = s[1] / 2;
    push(p[0] - hw, p[1] - hh); push(p[0] + hw, p[1] - hh);
    push(p[0] + hw, p[1] + hh); push(p[0] - hw, p[1] + hh);
  } else if (sh.ty === 'sr') {
    const p = getXY(sh.p), or = getScalar(sh.or);
    push(p[0] - or, p[1] - or); push(p[0] + or, p[1] - or);
    push(p[0] + or, p[1] + or); push(p[0] - or, p[1] + or);
  }
  return pts;
}
function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

/**
 * 收集所有"可见"形状的包围盒（未裁剪，画布坐标系）。
 * visible=false 表示处于隐藏层/遮罩层/全透明层之下，其几何不计入内容范围。
 */
/** 极端情况下的兜底：完全忽略可见性标记（hd/tt/td），仅用于避免"整图无几何"被跳过 */
let ignoreVisibility = false;

function collectBoxes(shapes, M, visible, out) {
  if (!shapes) return;
  for (const sh of shapes) {
    if (!sh || !sh.ty) continue;
    const vis = visible && (ignoreVisibility || !sh.hd);
    if (sh.ty === 'gr') {
      const tr = (sh.it || []).find(i => i.ty === 'tr');
      collectBoxes(sh.it.filter(i => i !== tr), compose(M, trMatrix(tr)), vis, out);
      continue;
    }
    const pts = shapePoints(sh, M);
    if (pts.length === 0) continue;
    if (!vis) continue; // 不可见：完全不参与包围盒
    const b = bboxOf(pts);
    if (b) out.push(b);
  }
}

function processLayer(layer, parentM, layerList, assetMap, visible, out) {
  // 只排除：隐藏层(hd)、遮罩层(tt/td，其几何只作蒙版不直接绘制)及其子树。
  // 注意不能按"首帧不透明度=0"排除——很多表情是淡入动画，首帧透明度本来就是 0。
  const vis = visible && (ignoreVisibility || (!layer.hd && layer.tt == null && layer.td == null));
  const M = compose(parentM, layerMatrix(layer.ks));
  collectBoxes(layer.shapes, M, vis, out);
  if (layer.ty === 0 && layer.refId) {
    const asset = assetMap[layer.refId];
    if (asset && asset.layers) for (const cl of asset.layers) processLayer(cl, M, asset.layers, assetMap, vis, out);
  }
  for (const ch of layerList) if (ch.parent === layer.ind) processLayer(ch, M, layerList, assetMap, vis, out);
}

function isTop(layer, layerList) {
  if (layer.parent == null) return true;
  return !layerList.some(l => l.ind === layer.parent);
}

/** 移除历史 normalizeRoot，保证重复执行时基于等价的原始结构 */
function stripRoot(j) {
  const roots = (j.layers || []).filter(l => l.nm === 'normalizeRoot');
  if (roots.length === 0) return false;
  const inds = new Set(roots.map(l => l.ind));
  j.layers = j.layers.filter(l => !inds.has(l.ind));
  for (const l of j.layers) if (inds.has(l.parent)) delete l.parent;
  return true;
}

const EMPTY = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
function union(a, b) {
  if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}
function sizeOf(b) { return b ? [b.x1 - b.x0, b.y1 - b.y0] : [0, 0]; }

/**
 * 计算表情的可见内容包围盒。
 * @param j  composition
 * @param clipToCanvas 是否只统计画布内的可见部分（归一化用 true；校验时可传 false 看原始范围）
 */
function visibleBBox(j, clipToCanvas, ignore) {
  const W = j.w || 512, H = j.h || 512;
  const assetMap = {};
  for (const a of (j.assets || [])) if (a.id != null) assetMap[a.id] = a;

  const prev = ignoreVisibility;
  if (ignore) ignoreVisibility = true;
  const boxes = [];
  for (const l of (j.layers || [])) if (isTop(l, j.layers)) processLayer(l, ident(), j.layers, assetMap, true, boxes);
  ignoreVisibility = prev;

  let clipped = { ...EMPTY }, raw = { ...EMPTY };
  let nClipped = 0, nRaw = 0;
  for (const b of boxes) {
    raw = union(raw, b); nRaw++;
    const x0 = Math.max(b.x0, 0), y0 = Math.max(b.y0, 0), x1 = Math.min(b.x1, W), y1 = Math.min(b.y1, H);
    if (x1 > x0 && y1 > y0) { clipped = union(clipped, { x0, y0, x1, y1 }); nClipped++; }
  }
  const use = (clipToCanvas && nClipped > 0) ? clipped : raw;
  const n = (use === clipped) ? nClipped : nRaw;
  if (n === 0) return null;
  return { box: use, W, H, count: n, rawBox: nRaw ? raw : null };
}

/** 插入/替换 root null 层：把 anchor 处的点按 F 缩放后落到 pos 处 */
function applyRoot(j, F, anchor, pos) {
  stripRoot(j);
  const newInd = (j.layers.reduce((m, l) => Math.max(m, l.ind || 0), 0)) + 1;
  const root = {
    ddd: 0, ind: newInd, ty: 3, nm: 'normalizeRoot', sr: 1,
    ks: {
      o: { a: 0, k: 100, ix: 11 },
      r: { a: 0, k: 0, ix: 10 },
      p: { a: 0, k: [pos[0], pos[1], 0], ix: 2 },
      a: { a: 0, k: [anchor[0], anchor[1], 0], ix: 1 },
      s: { a: 0, k: [F * 100, F * 100, 100], ix: 6 },
    },
    ao: 0, ip: j.ip || 0, op: j.op || 100, st: 0, bm: 0,
  };
  for (const l of j.layers) if (isTop(l, j.layers)) l.parent = newInd;
  j.layers.unshift(root);
  return j;
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function normalizeFile(file) {
  const full = path.join(DIR, file);
  const raw = fs.readFileSync(full, 'utf8');
  const orig = JSON.parse(raw);
  stripRoot(orig);

  // 极少数表情的内容整体位于遮罩层之下（严格过滤后无几何），此时兜底忽略可见性标记
  let ignore = false;
  let base = visibleBBox(orig, true);
  if (!base) { ignore = true; base = visibleBBox(orig, true, true); }
  if (!base) { console.log(file, 'skip(无可见几何)'); return; }
  const { box, W, H } = base;
  const [cw, ch] = sizeOf(box);
  const cSize = Math.max(cw, ch);
  if (!(cSize > 1)) { console.log(file, 'skip(尺寸为0)'); return; }

  const id = path.basename(file, '.json');
  const t = TARGETS[id] || {};
  const ratio = typeof t.ratio === 'number' ? t.ratio : DEFAULT_RATIO;
  const cx = clamp(typeof t.cx === 'number' ? t.cx : 0.5, 0.4, 0.6);
  const cy = clamp(typeof t.cy === 'number' ? t.cy : 0.5, 0.4, 0.6);

  // 客户端 Fit 到方框：可见内容最终尺寸 = cSize * (boxSize / max(W,H))，
  // 要让它等于位图的 ratio * boxSize，故目标 cSize = ratio * max(W,H)
  const ref = Math.max(W, H);
  const wanted = ratio * ref;
  const F = wanted / cSize;

  // —— 可信度闸门：估计不可信就原样放过，宁可不修也不能改坏 ——
  // 1) 矢量内容长宽比与该表情位图内容长宽比差异过大 → 包围盒估计大概率错了
  if (typeof t.aspect === 'number' && t.aspect > 0) {
    const aspErr = Math.abs(Math.log((cw / ch) / t.aspect));
    if (aspErr > MAX_ASPECT_ERR) {
      console.log(file, 'skip(长宽比与位图不符 aspErr=' + aspErr.toFixed(2) + '，估计不可信)');
      return;
    }
  }
  // 2) 所需缩放超出安全区间 → 多半也是估计偏差，改了风险大于收益
  if (F < F_SKIP_MIN || F > F_SKIP_MAX) {
    console.log(file, 'skip(所需缩放 F=' + F.toFixed(2) + ' 超出安全区间)');
    return;
  }
  // 3) 内容已顶到画布边缘（真实范围被画布截断，测到的只是下界）时还要继续放大 → 放弃。
  //    这种情况下放大只会把主体推出画布（就是"表情不见了"的成因）。
  const touchesEdge = box.x0 <= 1 || box.y0 <= 1 || box.x1 >= W - 1 || box.y1 >= H - 1;
  if (touchesEdge && F > 1.02) {
    console.log(file, 'skip(内容溢出画布且需放大 F=' + F.toFixed(2) + '，放大有把主体推出画布的风险)');
    return;
  }

  // 缩放上限：保证变换后的内容仍然完整落在画布内（留 2% 边距），绝不会被裁切
  const fitMax = 0.98 * Math.min(W / cw, H / ch);
  const usedF = Math.min(F, fitMax);

  const j = clone(orig);
  // 内容中心 → 目标中心（位图内容中心，实测基本就是画布中心）
  const anchor = [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2];
  // 落点再夹一次：保证变换后的内容盒完整落在画布内，绝不会被推出画布
  const halfW = cw * usedF / 2, halfH = ch * usedF / 2;
  const px = halfW * 2 >= W ? W / 2 : clamp(cx * W, halfW, W - halfW);
  const py = halfH * 2 >= H ? H / 2 : clamp(cy * H, halfH, H - halfH);
  applyRoot(j, usedF, anchor, [px, py]);
  fs.writeFileSync(full, JSON.stringify(j));
  console.log(file, 'content=' + cw.toFixed(0) + 'x' + ch.toFixed(0),
    'F=' + usedF.toFixed(3) + (usedF < F - 1e-6 ? '(受画布上限约束, 理想 ' + F.toFixed(3) + ')' : ''),
    '画布 ' + W + 'x' + H + '→' + S + 'x' + S, 'off=' + Math.hypot(px - S / 2, py - S / 2).toFixed(0));
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function main() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'manifest.json');
  for (const f of files) normalizeFile(f);
  console.log('done, 共处理', files.length, '个文件');
}

if (require.main === module) main();

module.exports = {
  visibleBBox, processLayer, isTop, stripRoot, compose, trMatrix, ident,
  getXY, getScalar, getScale2, val, shapePoints, bboxOf, TARGETS, DIR,
};
