'use strict';
/**
 * 只读内存探针（可观测性模块，不含任何业务逻辑）。
 *
 * 设计约束：
 *  - 不改任何现有路由 / 中间件 / 业务函数，只在 server.js 尾部调用一次 attach()。
 *  - 只读取 Node/V8/OS 的只读指标，以及各模块通过 register() 主动登记的 Map/Buffer。
 *  - MEMORY_PROBE=0 时 attach() 直接返回，不注册路由、不注册定时器、不注册任何监听。
 *
 * 环境变量：
 *  MEMORY_PROBE=0                 关闭全部能力（默认开启）
 *  MEMORY_PROBE_TOKEN            设置后用 Bearer / ?token= 鉴权；未设置则回退 requirePageAuthJson
 *  MEMORY_PROBE_INTERVAL_SEC     定时日志间隔秒数，默认 0（关闭）；开启后定时器 unref
 *  MEMORY_PROBE_SNAPSHOT=1       开放 POST /api/memory/snapshot（默认关闭）
 *  MEMORY_PROBE_TRACK_PATH=1     记录峰值发生时的最近请求路径（默认关闭）
 *
 * 接口：
 *  GET  /api/memory              完整 JSON 报告
 *  GET  /api/memory?view=text    一页纯文本报告
 *  GET  /api/memory?gc=1         可选：做一次 global.gc() 并给出前后差值（需 --expose-gc，限频 60s）
 *  POST /api/memory/snapshot     流式写 heap snapshot 到 data/diag/（需开关，限频 10min）
 *
 * 其它模块可选登记业务账本（每个模块末尾加 1 行，不改函数体）：
 *  require('./memory-probe').register('lottieThumbs', () => memCache);
 *  getter 可返回 Map / Set / Array / 普通对象 / Buffer，或直接返回 { count, bytes, note }。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const v8 = require('v8');
const inspector = require('inspector');

const MB = 1024 * 1024;
const round2 = (n) => {
    const v = Math.round(n * 100) / 100;
    return (v === 0 && Math.abs(n) >= 0.0001) ? Math.round(n * 10000) / 10000 : v;
};
const toMB = (bytes) => round2(bytes / MB);

const ENABLED = String(process.env.MEMORY_PROBE ?? '1') !== '0';
const TOKEN = process.env.MEMORY_PROBE_TOKEN ? String(process.env.MEMORY_PROBE_TOKEN) : '';
const INTERVAL_SEC = Number(process.env.MEMORY_PROBE_INTERVAL_SEC || 0);
const SNAPSHOT_ENABLED = String(process.env.MEMORY_PROBE_SNAPSHOT || '0') === '1';
const TRACK_PATH = String(process.env.MEMORY_PROBE_TRACK_PATH || '0') === '1';

const SAMPLE_THROTTLE_MS = 250;
const SAMPLE_CAP = 120;
const GC_COOLDOWN_MS = 60 * 1000;
const SNAPSHOT_COOLDOWN_MS = 10 * 60 * 1000;
const SOURCE_SCAN_LIMIT = 5000;

const samples = [];
const sourceDefs = new Map();
const sourceBaseline = new Map();
const peak = { rss: 0, external: 0, heapUsed: 0, heapTotal: 0 };
const peakAt = { rss: null, external: null, heapUsed: null, heapTotal: null };
const peakPath = { rss: null, external: null, heapUsed: null, heapTotal: null };

let lastPath = '(unknown)';
let lastSampleAt = 0;
let lastGcAt = 0;
let lastSnapshotAt = 0;
let snapshotRunning = false;
let probeTimer = null;

// ---------------------------------------------------------------- OS 层
function readOsMemory() {
    const out = {
        platform: process.platform,
        rssIsWorkingSet: true,
        virtualBytes: null,   // VmSize：虚拟地址空间，不是物理内存占用
        vmRssBytes: null,
        rssAnonBytes: null,
        rssFileBytes: null,
        swapBytes: null,
        pages: {}             // /proc/self/smaps_rollup 的物理页归因（字节）
    };
    if (process.platform !== 'linux') return out;
    try {
        const txt = fs.readFileSync('/proc/self/status', 'utf8');
        const pick = (key) => {
            const m = txt.match(new RegExp('^' + key + ':\\s+(\\d+)\\s+kB', 'm'));
            return m ? Number(m[1]) * 1024 : null;
        };
        out.vmRssBytes = pick('VmRSS');
        out.virtualBytes = pick('VmSize');
        out.rssAnonBytes = pick('RssAnon');
        out.rssFileBytes = pick('RssFile');
        out.swapBytes = pick('VmSwap');
    } catch (e) { /* 容器里可能无权限，忽略 */ }
    // smaps_rollup 的 Pss 是「比例集」：私有页全算、共享页按共享进程数摊分。
    // 用它把 rss - heapTotal - external 的未归因段拆成「本进程独占」与「共享库/文件页」。
    try {
        const rollup = fs.readFileSync('/proc/self/smaps_rollup', 'utf8');
        const keys = ['Rss', 'Pss', 'Pss_Anon', 'Pss_File', 'Pss_Shmem',
            'Shared_Clean', 'Shared_Dirty', 'Private_Clean', 'Private_Dirty', 'Anonymous'];
        for (const k of keys) {
            const m = rollup.match(new RegExp('^' + k + ':\\s+(\\d+)\\s+kB', 'm'));
            if (m) out.pages[k] = Number(m[1]) * 1024;
        }
    } catch (e) { /* 老内核或容器未暴露该文件 */ }
    return out;
}

function readBase() {
    const m = process.memoryUsage();
    let spaces = {};
    try {
        for (const s of v8.getHeapSpaceStatistics()) {
            spaces[s.space_name] = { usedMB: toMB(s.space_used_size), totalMB: toMB(s.space_size) };
        }
    } catch (e) { /* 老版本 Node 无此 API */ }
    let resources = {};
    try {
        if (typeof process.getActiveResourcesInfo === 'function') {
            for (const t of process.getActiveResourcesInfo()) resources[t] = (resources[t] || 0) + 1;
        }
    } catch (e) { /* ignore */ }
    return { m, spaces, resources, osInfo: readOsMemory() };
}

// ---------------------------------------------------------------- 采样与峰值
function sample(route) {
    const now = Date.now();
    if (now - lastSampleAt < SAMPLE_THROTTLE_MS) return null;
    lastSampleAt = now;
    const m = process.memoryUsage();
    const p = {
        t: now,
        rss: toMB(m.rss),
        heapTotal: toMB(m.heapTotal),
        heapUsed: toMB(m.heapUsed),
        external: toMB(m.external),
        arrayBuffers: toMB(m.arrayBuffers)
    };
    samples.push(p);
    if (samples.length > SAMPLE_CAP) samples.shift();
    for (const k of Object.keys(peak)) {
        if (p[k] > peak[k]) {
            peak[k] = p[k];
            peakAt[k] = new Date(now).toISOString();
            peakPath[k] = TRACK_PATH ? (route || lastPath) : null;
        }
    }
    return p;
}

// ---------------------------------------------------------------- 业务账本（L2，可选）
function bytesOf(v) {
    if (v == null) return 0;
    if (Buffer.isBuffer(v)) return v.byteLength;
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return v.byteLength;
    if (typeof v === 'string') return v.length * 2;
    if (typeof v === 'number' || typeof v === 'boolean') return 8;
    if (typeof v === 'object') return 32 + Object.keys(v).length * 48;
    return 0;
}

function normalizeSource(raw) {
    if (raw == null) return { count: 0, bytes: 0, note: 'null' };
    if (typeof raw === 'number') return { count: raw, bytes: 0, note: '' };
    if (Buffer.isBuffer(raw)) return { count: 1, bytes: raw.byteLength, note: 'Buffer(精确)' };
    if (typeof raw === 'object' && typeof raw.count === 'number' && typeof raw.bytes === 'number') {
        return { count: raw.count, bytes: raw.bytes, note: String(raw.note || '精确') };
    }
    let count = 0, bytes = 0, i = 0;
    // 惰性遍历 + 条数上限，避免为超大对象再构造一份完整的临时数组。
    if (raw instanceof Map) {
        count = raw.size;
        for (const [k, v] of raw) { if (++i > SOURCE_SCAN_LIMIT) break; bytes += bytesOf(k) + bytesOf(v); }
    } else if (raw instanceof Set) {
        count = raw.size;
        for (const v of raw) { if (++i > SOURCE_SCAN_LIMIT) break; bytes += bytesOf(v); }
    } else if (Array.isArray(raw)) {
        count = raw.length;
        for (const v of raw) { if (++i > SOURCE_SCAN_LIMIT) break; bytes += bytesOf(v); }
    } else {
        const keys = Object.keys(raw);
        count = keys.length;
        for (const k of keys) { if (++i > SOURCE_SCAN_LIMIT) break; bytes += bytesOf(k) + bytesOf(raw[k]); }
    }
    return { count, bytes, note: i > SOURCE_SCAN_LIMIT ? '估算(仅前5000条)' : '估算' };
}

function collectSources() {
    const items = [];
    for (const [name, getter] of sourceDefs) {
        let s;
        try { s = normalizeSource(getter()); }
        catch (e) { s = { count: 0, bytes: 0, note: 'getter error: ' + e.message }; }
        if (!sourceBaseline.has(name)) sourceBaseline.set(name, { count: s.count, bytes: s.bytes });
        const b = sourceBaseline.get(name);
        items.push({
            name,
            count: s.count,
            mb: toMB(s.bytes),
            note: s.note,
            deltaCount: s.count - b.count,
            deltaMB: toMB(s.bytes - b.bytes)
        });
    }
    return {
        enabled: items.length > 0,
        items,
        hint: items.length > 0 ? '' :
            '未启用。若要精确到业务对象，在对应模块末尾加 1 行 require(\'./memory-probe\').register(名称, () => 该Map)；' +
            '建议登记 lottieThumb.memCache / emojiCatalogCache / emojiFileMetaCache / online+wss.bufferedAmount / ' +
            'pendingInteractMsgs / pendingTrust / throttleMap / pointsCache。'
    };
}

// ---------------------------------------------------------------- 报告
function buildReport(gcInfo) {
    const base = readBase();
    const m = base.m;
    const rss = toMB(m.rss);
    const heapTotal = toMB(m.heapTotal);
    const heapUsed = toMB(m.heapUsed);
    const external = toMB(m.external);
    const arrayBuffers = toMB(m.arrayBuffers);
    const otherExternal = round2(external - arrayBuffers);
    const trimmed = rss < (heapTotal + external) * 0.6;
    const native = Math.max(0, round2(rss - heapTotal - external));
    const pct = (x) => (rss > 0 ? Math.round((x / rss) * 1000) / 10 : 0);
    const virtualMB = base.osInfo.virtualBytes != null ? toMB(base.osInfo.virtualBytes) : null;
    const pg = base.osInfo.pages || {};
    const pgAvailable = Object.keys(pg).length > 0;
    const physical = {
        available: pgAvailable,
        rssMB: pg.Rss != null ? toMB(pg.Rss) : null,
        pssMB: pg.Pss != null ? toMB(pg.Pss) : null,
        pssAnonMB: pg.Pss_Anon != null ? toMB(pg.Pss_Anon) : null,
        pssFileMB: pg.Pss_File != null ? toMB(pg.Pss_File) : null,
        privateMB: pgAvailable ? toMB((pg.Private_Clean || 0) + (pg.Private_Dirty || 0)) : null,
        sharedMB: pgAvailable ? toMB((pg.Shared_Clean || 0) + (pg.Shared_Dirty || 0)) : null
    };

    // 用本次读数刷新峰值，避免响应采样被节流后出现「当前 rss > 峰值 rss」的矛盾。
    const cur = { rss, heapTotal, heapUsed, external };
    const nowIso = new Date().toISOString();
    for (const k of Object.keys(peak)) {
        if (cur[k] > peak[k]) {
            peak[k] = cur[k];
            peakAt[k] = nowIso;
            peakPath[k] = TRACK_PATH ? lastPath : null;
        }
    }

    const breakdown = [
        { key: 'v8Heap', label: 'V8 堆预留', mb: heapTotal, pct: pct(heapTotal), note: 'used ' + heapUsed + 'MB / free ' + round2(heapTotal - heapUsed) + 'MB' },
        { key: 'external', label: 'external (Buffer/WASM/native绑定)', mb: external, pct: pct(external), note: 'arrayBuffers ' + arrayBuffers + 'MB / other ' + otherExternal + 'MB' },
        { key: 'native', label: '其它 / 运行时基线', mb: native, pct: pct(native), note: trimmed ? 'rss 已被 OS trim，此项不可靠，请看 Pss' : '共享库页/libuv/线程栈/malloc 保留 + V8 未计入项' }
    ];

    const largeObjectMB = base.spaces.large_object_space ? base.spaces.large_object_space.usedMB : 0;
    const sources = collectSources();
    const sourceTotalMB = round2(sources.items.reduce((a, x) => a + x.mb, 0));

    const diagnosis = [];
    if (trimmed) {
        diagnosis.push('rss 明显低于 heapTotal+external，说明工作集被 OS trim 了；请以 Pss / vmRss 为准，不要按任务管理器的工作集判断。');
    }
    if (virtualMB != null && virtualMB > rss * 4) {
        diagnosis.push('虚拟地址空间 ' + virtualMB + 'MB 远大于 rss，是 V8 / 线程栈 / malloc 预留的虚拟地址，不消耗物理内存；容器 OOM 判定不看此项。');
    }
    if (heapTotal - heapUsed > 30) {
        diagnosis.push('V8 堆预留 ' + heapTotal + 'MB 但实际使用仅 ' + heapUsed + 'MB，差值 ' +
            round2(heapTotal - heapUsed) + 'MB 是历史大对象峰值固化，GC 后不归还 OS，通常非泄漏。');
    }
    if (external > 50 && arrayBuffers < external / 3) {
        diagnosis.push('external 占 ' + external + 'MB 但 arrayBuffers 仅 ' + arrayBuffers +
            'MB，大头是 Buffer 池 / WASM linear memory / native 保留页，典型来源是历史上的大请求(base64 截图、APK 上传、jimp 解码)峰值。');
    }
    if (largeObjectMB > 20) {
        diagnosis.push('large_object_space 已用 ' + largeObjectMB + 'MB，存在大 Buffer / 大字符串常驻。');
    }
    if (!trimmed && native > 40) {
        let tail = '需结合 gc=1 与业务高峰时 external / arrayBuffers 的变化判断。';
        if (physical.available && physical.pssMB != null) {
            const gap = round2(rss - physical.pssMB);
            tail = gap > 15
                ? 'Pss 仅 ' + physical.pssMB + 'MB（比 rss 少 ' + gap +
                  'MB），差额主要是共享库 / 文件映射页，可与其它进程共享，本进程实际独占远小于 rss。'
                : 'Pss=' + physical.pssMB +
                  'MB 与 rss 接近，基本都是本进程独占的匿名页，建议用 heap snapshot 或 smaps 继续下钻。';
        }
        diagnosis.push('rss 中无法归入 V8 堆 / external 的部分为 ' + native +
            'MB（Node/V8 运行时 C++ 对象、共享库代码页、libuv/线程栈、malloc 保留页）。' + tail);
    }
    for (const s of sources.items) {
        if (s.deltaMB > 1 || s.deltaCount > 100) {
            diagnosis.push('业务持有者 ' + s.name + ' 自启动增长 ' + s.deltaMB + 'MB / ' + s.deltaCount +
                ' 条，属只增不删项，建议检查是否有 TTL 或容量上限。');
        }
    }
    if (gcInfo && gcInfo.triggered) {
        const reclaimed = gcInfo.reclaimedHeapMB;
        diagnosis.push(reclaimed < 5
            ? 'gc=1 后 heapUsed 仅回收 ' + reclaimed + 'MB，现有占用基本是固化/外部内存，不是未回收垃圾。'
            : 'gc=1 回收 heapUsed ' + reclaimed + 'MB，其中确实存在可回收对象。');
    }
    if (peak.rss > rss + 20) {
        diagnosis.push('历史 rss 峰值 ' + peak.rss + 'MB @ ' + peakAt.rss +
            (peakPath.rss ? ' (最近路径 ' + peakPath.rss + ')' : '') + '，当前已回落 ' + round2(peak.rss - rss) + 'MB。');
    }
    if (diagnosis.length === 0) diagnosis.push('各项指标均在正常区间，未发现明显异常。');

    return {
        ok: true,
        meta: {
            pid: process.pid,
            now: new Date().toISOString(),
            uptimeSec: Math.round(process.uptime()),
            node: process.version,
            platform: base.osInfo.platform,
            rssIsWorkingSet: base.osInfo.rssIsWorkingSet,
            sampling: '响应结束时采样，节流 ' + SAMPLE_THROTTLE_MS + 'ms',
            gcAvailable: typeof global.gc === 'function',
            snapshotEnabled: SNAPSHOT_ENABLED,
            trackPath: TRACK_PATH,
            notes: ['commitMB 为兼容旧版的别名，与 virtualMB 同值，取自 VmSize（虚拟地址空间），不是物理内存占用']
        },
        total: {
            rssMB: rss,
            virtualMB: virtualMB,
            commitMB: virtualMB,
            physicalPages: physical,
            vmRssMB: base.osInfo.vmRssBytes != null ? toMB(base.osInfo.vmRssBytes) : null,
            rssAnonMB: base.osInfo.rssAnonBytes != null ? toMB(base.osInfo.rssAnonBytes) : null,
            peakRssMB: peak.rss,
            peakRssAt: peakAt.rss,
            peakRssPath: peakPath.rss
        },
        breakdown,
        v8: {
            heapTotalMB: heapTotal,
            heapUsedMB: heapUsed,
            heapFreeMB: round2(heapTotal - heapUsed),
            spaces: base.spaces
        },
        external: { totalMB: external, arrayBuffersMB: arrayBuffers, otherMB: otherExternal },
        resources: base.resources,
        sources: { ...sources, totalMB: sourceTotalMB },
        trend: {
            sampleCount: samples.length,
            firstSampleAt: samples.length ? new Date(samples[0].t).toISOString() : null,
            peakExternalMB: peak.external,
            peakHeapUsedMB: peak.heapUsed,
            peakHeapTotalMB: peak.heapTotal,
            rssGrowthSinceBootMB: samples.length ? round2(rss - samples[0].rss) : 0
        },
        gc: gcInfo || { available: typeof global.gc === 'function', triggered: false },
        diagnosis
    };
}

function renderText(r) {
    const L = [];
    L.push('[MEM] ' + r.meta.now + '  uptime=' + Math.round(r.meta.uptimeSec / 60) + 'min  pid=' + r.meta.pid +
        '  ' + r.meta.platform + '  ' + r.meta.node);
    L.push('TOTAL  rss=' + r.total.rssMB + 'MB' +
        (r.total.virtualMB != null ? '  virtual=' + r.total.virtualMB + 'MB(虚拟地址空间,非占用)' : '') +
        '   peak rss=' + r.total.peakRssMB + 'MB @ ' + (r.total.peakRssAt || '-') +
        (r.total.peakRssPath ? ' (' + r.total.peakRssPath + ')' : ''));
    L.push('');
    L.push('[按内存区域分解，合计≈rss]');
    for (const b of r.breakdown) {
        L.push('  ' + b.label.padEnd(38) + String(b.mb).padStart(8) + 'MB ' + String(b.pct).padStart(5) + '%   ' + b.note);
    }
    L.push('');
    const pp = r.total.physicalPages;
    const fmt = (v) => (v == null ? '-' : v + 'MB');
    L.push('[进程物理页 / smaps_rollup]  ' + (pp && pp.available
        ? 'Rss=' + fmt(pp.rssMB) + '  Pss=' + fmt(pp.pssMB) + '(实际独占口径)' +
          '  私有页=' + fmt(pp.privateMB) + '  共享页=' + fmt(pp.sharedMB) +
          '  匿名Pss=' + fmt(pp.pssAnonMB) + '  文件Pss=' + fmt(pp.pssFileMB)
        : '不可用（非 Linux 或容器未暴露 /proc/self/smaps_rollup）'));
    const sp = Object.keys(r.v8.spaces).map((k) => k + '=' + r.v8.spaces[k].usedMB + 'MB').join(' | ');
    L.push('[V8 堆空间]  ' + (sp || '不可用'));
    const rs = Object.keys(r.resources).map((k) => k + ' ' + r.resources[k]).join(' | ');
    L.push('[活跃资源]  ' + (rs || '不可用'));
    L.push('');
    L.push('[业务持有者]                              当前              自启动变化');
    if (!r.sources.enabled) {
        L.push('  (L2 未启用) ' + r.sources.hint);
    } else {
        for (const s of r.sources.items) {
            L.push('  ' + s.name.padEnd(34) + (s.count + ' 条 ' + s.mb + 'MB').padEnd(20) +
                '+' + s.deltaMB + 'MB / +' + s.deltaCount + ' 条  ' + s.note);
        }
        L.push('  业务缓存小计                                      ' + r.sources.totalMB + 'MB');
    }
    L.push('');
    L.push('[自动诊断]');
    r.diagnosis.forEach((d, i) => L.push('  ' + (i + 1) + '. ' + d));
    L.push('');
    L.push('[采样]  ' + r.trend.sampleCount + ' 点  峰值 external=' + r.trend.peakExternalMB +
        'MB  峰值 heapUsed=' + r.trend.peakHeapUsedMB + 'MB  rss 自启动变化=' + r.trend.rssGrowthSinceBootMB + 'MB');
    if (r.gc.triggered) {
        L.push('[GC]    before heapUsed=' + r.gc.before.heapUsedMB + 'MB → after=' + r.gc.after.heapUsedMB +
            'MB  回收 ' + r.gc.reclaimedHeapMB + 'MB');
    } else if (r.gc.note) {
        L.push('[GC]    ' + r.gc.note);
    }
    return L.join('\n');
}

// ---------------------------------------------------------------- 鉴权
function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    if (x.length !== y.length) return false;
    return crypto.timingSafeEqual(x, y);
}

function makeAuthorize(opts) {
    const fallback = opts && typeof opts.authorize === 'function' ? opts.authorize : null;
    return (req, res, next) => {
        if (TOKEN) {
            const h = String(req.headers.authorization || '');
            const bearer = h.toLowerCase().startsWith('bearer ') ? h.slice(7) : '';
            const q = req.query && req.query.token ? String(req.query.token) : '';
            if (safeEqual(bearer, TOKEN) || safeEqual(q, TOKEN)) return next();
        }
        if (fallback) return fallback(req, res, next);
        if (!TOKEN) return res.status(403).json({ ok: false, error: 'memory probe 未配置鉴权' });
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    };
}

// ---------------------------------------------------------------- heap snapshot（L3，默认关闭）
function writeHeapSnapshot(cb) {
    if (snapshotRunning) return cb(null, { skipped: '快照正在生成中' });
    const now = Date.now();
    if (now - lastSnapshotAt < SNAPSHOT_COOLDOWN_MS) return cb(null, { skipped: '限频 10 分钟' });
    snapshotRunning = true;
    lastSnapshotAt = now;
    let fd = null;
    try {
        const dir = path.join(__dirname, 'data', 'diag');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'heap-' + new Date(now).toISOString().replace(/[:.]/g, '-') + '.heapsnapshot');
        fd = fs.openSync(file, 'w');
        let bytes = 0;
        const session = new inspector.Session();
        session.connect();
        // 同步写盘，避免 createWriteStream 在背压时把快照块缓存在内存里。
        session.on('HeapProfiler.addHeapSnapshotChunk', (msg) => {
            const chunk = msg.params.chunk;
            bytes += Buffer.byteLength(chunk);
            if (fd != null) fs.writeSync(fd, chunk);
        });
        session.post('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, (err) => {
            try { session.disconnect(); } catch (e) { /* ignore */ }
            if (fd != null) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
            fd = null;
            snapshotRunning = false;
            if (err) return cb(err);
            cb(null, { file, mb: toMB(bytes), note: '用 Chrome DevTools → Memory → Load 打开此文件' });
        });
    } catch (e) {
        if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
        snapshotRunning = false;
        cb(e);
    }
}

// ---------------------------------------------------------------- 挂载
function attach(app, server, opts) {
    if (!ENABLED) return;
    if (!app || typeof app.get !== 'function') return;
    const authorize = makeAuthorize(opts);

    // 用 Node 原生 server 的 request 事件做观察：不插入 Express 中间件链，
    // 因此完全不改变现有请求处理顺序；静态资源与所有路由都能被覆盖。
    if (server && typeof server.on === 'function') {
        server.on('request', (req, res) => {
            const p = String(req.url || '').split('?')[0];
            if (TRACK_PATH) lastPath = p;
            res.once('finish', () => sample(p));
        });
    }

    app.get('/api/memory', authorize, (req, res) => {
        sample('/api/memory');
        let gcInfo = null;
        if (String(req.query.gc || '') === '1') {
            if (typeof global.gc !== 'function') {
                gcInfo = { available: false, triggered: false, note: '启动时未加 --expose-gc，跳过 GC 对比' };
            } else if (Date.now() - lastGcAt < GC_COOLDOWN_MS) {
                gcInfo = { available: true, triggered: false, note: 'gc=1 限频 60 秒，本次跳过' };
            } else {
                lastGcAt = Date.now();
                const before = process.memoryUsage();
                try { global.gc(); } catch (e) { /* ignore */ }
                const after = process.memoryUsage();
                gcInfo = {
                    available: true,
                    triggered: true,
                    before: { heapUsedMB: toMB(before.heapUsed), externalMB: toMB(before.external), rssMB: toMB(before.rss) },
                    after: { heapUsedMB: toMB(after.heapUsed), externalMB: toMB(after.external), rssMB: toMB(after.rss) },
                    reclaimedHeapMB: toMB(before.heapUsed - after.heapUsed)
                };
            }
        }
        const report = buildReport(gcInfo);
        res.setHeader('Cache-Control', 'no-store');
        if (String(req.query.view || '') === 'text') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.end(renderText(report));
        }
        return res.json(report);
    });

    if (SNAPSHOT_ENABLED) {
        app.post('/api/memory/snapshot', authorize, (req, res) => {
            writeHeapSnapshot((err, out) => {
                if (err) return res.status(500).json({ ok: false, error: err.message });
                return res.json({ ok: true, ...out });
            });
        });
    }

    if (Number.isFinite(INTERVAL_SEC) && INTERVAL_SEC > 0) {
        const ms = Math.max(5, INTERVAL_SEC) * 1000;
        probeTimer = setInterval(() => {
            const s = sample('(timer)');
            if (s) {
                console.log('[MEM] rss=' + s.rss + 'MB peak=' + peak.rss + 'MB heapUsed=' + s.heapUsed +
                    'MB heapTotal=' + s.heapTotal + 'MB external=' + s.external + 'MB arrayBuffers=' + s.arrayBuffers + 'MB');
            }
        }, ms);
        if (probeTimer.unref) probeTimer.unref();
    }

    console.log('[memory-probe] 已启用: GET /api/memory?view=text' +
        (TOKEN ? ' (token 鉴权)' : ' (页面登录鉴权)') +
        (SNAPSHOT_ENABLED ? ' | snapshot 已开放' : '') +
        (INTERVAL_SEC > 0 ? ' | 定时日志 ' + Math.max(5, INTERVAL_SEC) + 's' : '') +
        ' | MEMORY_PROBE=0 可关闭');
}

/** 其它模块可选登记业务账本；未登记时报告只含系统级归因。 */
function register(name, getter) {
    if (!ENABLED) return;
    if (name && typeof getter === 'function') sourceDefs.set(String(name), getter);
}

module.exports = { attach, register, getReport: buildReport, sample };
