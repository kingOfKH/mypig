'use strict';
// 服务端把 .tgs / .json 表情渲染成静态 PNG 缩略图。
// 使用 rlottie（wasm，与 Android APP 同引擎家族），可渲染 lottie-web 在浏览器中渲染为空白的 v5.12.x 文件。
// 自带最小 PNG 编码器，不依赖 node-canvas 等原生模块。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');

const DIR = path.join(__dirname, 'public', 'qqface-lottie');
const RL_WASM = path.join(__dirname, 'node_modules', 'rlottie', 'rlottie.wasm');
const RL_JS = path.join(__dirname, 'node_modules', 'rlottie', 'rlottie.js');

let RL = null;
async function getRL() {
  if (RL) return RL;
  const wasmU8 = new Uint8Array(fs.readFileSync(RL_WASM));
  const wasmBin = wasmU8.buffer.slice(wasmU8.byteOffset, wasmU8.byteOffset + wasmU8.byteLength);
  const Module = (await import(pathToFileURL(RL_JS).href)).default;
  const mod = await Module({ wasmBinary: wasmBin });
  RL = {
    init: mod.cwrap('lottie_init', 'number', []),
    load: mod.cwrap('lottie_load_from_data', 'number', ['number', 'number']),
    resize: mod.cwrap('lottie_resize', null, ['number', 'number', 'number']),
    buffer: mod.cwrap('lottie_buffer', 'number', ['number']),
    render: mod.cwrap('lottie_render', null, ['number', 'number']),
    destroy: mod.cwrap('lottie_destroy', null, ['number']),
    HEAPU8: mod.HEAPU8,
    malloc: mod._malloc,
  };
  return RL;
}

// ---- 最小 PNG 编码器（RGBA -> PNG） ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x];
  }
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

const memCache = new Map();
async function renderLottieThumb(num, size) {
  size = size || 256;
  const cacheKey = num + '@' + size;
  if (memCache.has(cacheKey)) return memCache.get(cacheKey); // 可能是 null
  let result = null;
  try {
    const rl = await getRL();
    let data = null;
    const tgs = path.join(DIR, num + '.tgs');
    const json = path.join(DIR, num + '.json');
    if (fs.existsSync(tgs)) {
      try { data = JSON.parse(zlib.gunzipSync(fs.readFileSync(tgs)).toString('utf8')); } catch (e) { data = null; }
    } else if (fs.existsSync(json)) {
      try { data = JSON.parse(fs.readFileSync(json, 'utf8')); } catch (e) { data = null; }
    }
    if (data && data.layers && data.layers.length > 0) {
      const w = data.w || 512, h = data.h || 512;
      const total = (data.op - data.ip) || 1;
      const frame = Math.floor(total * 0.5) + (data.ip || 0); // 中段帧：多数「弹出」动画此时已完全可见
      const scale = size / Math.max(w, h);
      const rw = Math.max(1, Math.round(w * scale));
      const rh = Math.max(1, Math.round(h * scale));
      const player = rl.init();
      const jsonStr = JSON.stringify(data);
      const bytes = new TextEncoder().encode(jsonStr);
      const ptr = rl.malloc(bytes.length + 1);
      rl.HEAPU8.set(bytes, ptr);
      rl.HEAPU8[ptr + bytes.length] = 0;
      rl.load(player, ptr);
      rl.resize(player, rw, rh);
      rl.render(player, frame);
      const bufPtr = rl.buffer(player);
      const len = rw * rh * 4;
      const rgba = rl.HEAPU8.subarray(bufPtr, bufPtr + len);
      let nonTransparent = 0;
      for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 8) nonTransparent++;
      if (nonTransparent > 30) {
        const copy = Buffer.from(rgba); // 拷贝出 wasm 内存，避免后续被覆盖
        result = encodePNG(copy, rw, rh);
      }
      rl.destroy(player);
    }
  } catch (e) {
    console.error('[lottieThumb] render fail', num, e && e.message);
    result = null;
  }
  memCache.set(cacheKey, result);
  return result;
}

module.exports = { renderLottieThumb, getRL };
