/**
 * StarClick 远程协助信令模块（V2 实时屏幕镜像方案 - P0 服务端）
 *
 * 职责：
 *  1. 控制码管理（被控端生成 / 控制端输码匹配）
 *  2. 协助会话管理（session 状态机 + 超时强断）
 *  3. WebSocket 信令路由（WebRTC offer/answer/ICE 转发、Action 指令转发、双向中断）
 *  4. 审计日志（脱敏）
 *
 * 铁律：
 *  - 媒体流（屏幕像素）不经本模块应用层；仅转发 WebRTC 信令字节。
 *  - cmd 仅做 session 归属校验 + 脱敏审计，不解析/不修改指令语义。
 *  - 超时由本模块定时器强制 terminate，客户端无法伪造。
 *
 * 存储：沿用项目统一的 JSON 文件 + withFileLock（与 server.js 一致），不引入新数据库依赖。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');
const { xorBase64 } = require('./crypto-util');

// ---- 路径与存储 ----
const DATA_DIR = path.join(__dirname, 'data', 'remote');
const CONTROL_CODE_FILE = path.join(DATA_DIR, 'control_codes.json');
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
const SUBSCRIPTION_FILE = path.join(DATA_DIR, 'subscriptions.json');

function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
ensureDir();

// 简单文件锁（与 server.js 同款 withFileLock 风格）
const fileLocks = new Map();
async function withFileLock(filePath, operation) {
    while (fileLocks.has(filePath)) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    fileLocks.set(filePath, true);
    try {
        return await operation();
    } finally {
        fileLocks.delete(filePath);
    }
}

function readJson(file, def) {
    try {
        if (!fs.existsSync(file)) return def;
        const c = fs.readFileSync(file, 'utf8');
        if (!c || !c.trim()) return def;
        return JSON.parse(c);
    } catch (e) {
        logError('[remote] 读取失败', file, e);
        return def;
    }
}
function writeJson(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        logError('[remote] 写入失败', file, e);
        return false;
    }
}

// ---- 业务常量 ----
const CODE_TTL_MS = 10 * 60 * 1000;            // 控制码有效期（待命绑定码仍为 10 分钟，仅作"等待匹配"窗口）
const PLAN_LIMITS = {                           // 各套餐单次最长协助时长
    free: 10 * 60 * 1000,
    pro: 60 * 60 * 1000,
    flag: 120 * 60 * 1000,
};
const HEARTBEAT_TIMEOUT_MS = 70 * 1000;         // 心跳 30s，超时 ~2 次判离线
const RECONNECT_GRACE_MS = 45 * 1000;          // 断线宽限期：45s 内重连则保持会话不终止
const TRUST_FILE = path.join(DATA_DIR, 'trust.json');

// 内存态：deviceId -> 该设备的所有活动 ws 连接集合（同一设备可能同时有
//   ①前台 UI 远控页连接 ②RemoteSignalingService 常驻信令连接，二者都应计为"在线"）。
// 采用 Set 而非单值，close 时只移除自身 ws，避免常驻连接被另一条连接的关闭误删导致误判离线。
const online = new Map(); // deviceId -> Set<ws>
const sessions = new Map();
// sid -> setTimeout 句柄（设备断线后的宽限定时器，重连则取消）
const pendingDisconnects = new Map();
// deviceId -> { standby:Boolean, code:String }  被控端待命状态（授权录屏后常驻在线等待）
const standbyMap = new Map();
// deviceId -> { deviceName:String }  系统设备名称（连接时上报），供信任列表默认展示
const deviceInfo = new Map();
// deviceId -> 信任对象集合  { "对方deviceId": { name, addedAt } }  持久化于 TRUST_FILE
let trustCache = readJson(TRUST_FILE, {});

function saveTrustCache() {
    writeJson(TRUST_FILE, trustCache);
}

// 待确认的连接请求 / 待确认的信任绑定：key = code + ':' + 发起方deviceId
const pendingConfirms = new Map();
const pendingTrust = new Map();

// 建立会话（信任直连 / 确认后直连共用）
// mode：控制端发起连接时携带的传输模式（'webrtc' | 'cs'），由控制端最终决定，被控端跟随。
async function establishSession(controller, host, code, tag, mode) {
    const sidNew = genSessionId();
    const plan = getPlan(controller);
    const session = makeSession(sidNew, controller, host, code, plan, mode);
    sessions.set(sidNew, session);
    await persistSession(session, 'connecting');
    await audit(sidNew, controller, 'connect', `code=${code} via=${tag} mode=${session.mode}`);
    if (udpAvailable) {
        udpEndpoints.set(computeSidHash(sidNew), { sid: sidNew, host: null, controller: null, notified: false });
    }
    const udpInfo = udpAvailable ? { udpPort: udpPort } : {};
    // 把选定的传输模式权威下发给两端（被控端必须跟随，控制端也以服务端下发为准消除本地竞态）
    const modeInfo = { mode: session.mode };
    relayTo(host, { op: 'code.matched', sid: sidNew, payload: { role: 'host', peer: controller, plan, ...udpInfo, ...modeInfo } });
    relayTo(controller, { op: 'code.matched', sid: sidNew, payload: { role: 'controller', peer: host, plan, ...udpInfo, ...modeInfo } });
    logInfo(`会话建立(${tag}) sid=${sidNew} 传输模式=${session.mode} 链路=${udpAvailable ? 'UDP' : 'TCP'} plan=${plan}`);
}

// ---- 工具 ----
// 固定控制码：基于 deviceId 哈希生成稳定 6 位纯数字（000000-999999），重启服务器不丢。
// 个人/情侣场景：每台设备有唯一且永久的控制码，无需每次重启用 APP 都重新生成。
function genFixedCode(deviceId) {
    const h = crypto.createHash('sha256').update('starclick:' + deviceId).digest('hex');
    const n = parseInt(h.substring(0, 8), 16) % 1000000;
    return n.toString().padStart(6, '0');
}
function nowMs() { return Date.now(); }

// ================ 【日志系统重构：带时分秒 + 级别 + 去高频重复】 ================
// 所有 console.log/warn/error 一律走这三个包装函数，确保每条日志自带 HH:MM:SS.sss 时间戳
// 和级别标识（INFO/WARN/ERR），便于 grep + 时序对齐分析。
function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function tsTag() {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
const logInfo  = (...a) => console.log (`[${tsTag()}] [INFO]  `, ...a);
const logWarn  = (...a) => console.warn(`[${tsTag()}] [WARN]  `, ...a);
const logError = (...a) => console.error(`[${tsTag()}] [ERROR] `, ...a);
// 节流日志：同一 key 在 Nms 内只允许打一次（防止心跳/信令类高频日志刷屏）
const throttleMap = new Map();
function logThrottled(key, intervalMs, fn) {
    const now = nowMs();
    const last = throttleMap.get(key) || 0;
    if (now - last < intervalMs) return;
    throttleMap.set(key, now);
    fn();
}
// 高频信令 op（心跳、cmd、rtc.quality 等）白名单：超过一次/秒的不重复打印，
// 避免这些每秒 1-2 次的信令覆盖真正关键的二进制丢帧/IDR风暴日志。
const NOISY_OP_RE = /^(heartbeat|rtc\.quality|rtc\.deccap|rtc\.codec|cmd\.ack|udp\.fallback)$/;

// ---- 订阅缓存（避免每次 code.connect 都同步读文件阻塞事件循环）----
let subscriptionCache = null;
function loadSubscriptionCache() {
    try {
        if (fs.existsSync(SUBSCRIPTION_FILE)) {
            const c = fs.readFileSync(SUBSCRIPTION_FILE, 'utf8');
            if (c && c.trim()) subscriptionCache = JSON.parse(c);
        }
    } catch (e) {
        logError('[remote] 订阅缓存加载失败', e);
    }
    if (!subscriptionCache) subscriptionCache = {};
}
loadSubscriptionCache();

function getPlan(deviceId) {
    return subscriptionCache[deviceId] || 'free';
}

function genSessionId() {
    return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
}

// 内存 session 对象
function makeSession(sid, controller, host, code, plan, mode) {
    return {
        sessionId: sid,
        controller,          // deviceId（控制端）
        host,                // deviceId（被控端）
        code,
        plan,
        // 传输模式：由控制端发起连接时携带（'webrtc' | 'cs'），服务端作为权威下发给被控端。
        // 被控端必须无条件跟随，自己本机的后台开关不参与决策，避免两端开关不一致导致协商失败黑屏。
        mode: mode || 'cs',  // 默认自研 CS 中继（兼容旧版控制端未携带该字段）
        status: 'connecting', // connecting | streaming | terminated
        startedAt: nowMs(),
        endedAt: null,
        lastActivity: nowMs(),
        limitMs: PLAN_LIMITS[plan] || PLAN_LIMITS.free,
    };
}

function peerOf(session, deviceId) {
    if (!session) return null;
    return session.controller === deviceId ? session.host : session.controller;
}

// ---- 审计（append-only，避免每条 cmd 都 read-modify-write 整个文件阻塞事件循环）----
const AUDIT_LOG_FILE = path.join(DATA_DIR, 'audit.log');
let auditStream = null;
try {
    auditStream = fs.createWriteStream(AUDIT_LOG_FILE, { flags: 'a' });
} catch (e) {
    logError('[remote] 审计日志流创建失败', e);
}

async function audit(sessionId, actor, action, detail) {
    if (!auditStream) return;
    const line = JSON.stringify({
        sessionId,
        actor,
        action,
        detail: detail || null,
        ts: nowMs(),
    }) + '\n';
    auditStream.write(line);
}

// ---- 控制码（固定码：每台设备一个永久 6 位纯数字码，由 deviceId 派生）----
// 设计：
//  - 被控端开启"被控/待命"时，服务端登记 code -> hostId 映射（status=waiting，10 分钟窗口，
//    仅表示"当前可匹配"，过期只影响"等待中"状态，不影响码本身——码永久有效）。
//  - 控制端输码：码存在即匹配，无需随机生成；重启服务器从 JSON 恢复映射不丢。
async function createControlCode(hostId) {
    const code = genFixedCode(hostId);
    return await withFileLock(CONTROL_CODE_FILE, async () => {
        const list = readJson(CONTROL_CODE_FILE, []);
        // 清理该 host 旧记录（一个 host 同时只挂一个），再写入最新
        const filtered = list.filter(c => !(c.hostId === hostId));
        const rec = {
            code,
            hostId,
            status: 'waiting',
            createdAt: nowMs(),
            expiresAt: nowMs() + CODE_TTL_MS,
        };
        filtered.push(rec);
        writeJson(CONTROL_CODE_FILE, filtered);
        logInfo(`登记固定控制码 code=${code} host=${hostId}`);
        return rec;
    });
}

// 从持久化文件恢复所有已登记的固定控制码（重启服务器不丢映射）
function restoreControlCodes() {
    const raw = readJson(CONTROL_CODE_FILE, []);
    // 迁移清理：丢弃旧随机码方案遗留的记录（与该 hostId 的固定码不符），
    // 并按 hostId 去重，避免文件无限增长导致每次读写全量解析。
    const byHost = new Map();
    for (const rec of raw) {
        if (!rec || !rec.code || !rec.hostId) continue;
        if (rec.code !== genFixedCode(rec.hostId)) continue;
        rec.status = 'waiting';
        rec.expiresAt = nowMs() + CODE_TTL_MS;
        byHost.set(rec.hostId, rec);
    }
    const list = [...byHost.values()];
    const dropped = raw.length - list.length;
    writeJson(CONTROL_CODE_FILE, list);
    if (list.length) logInfo(`已恢复 ${list.length} 个固定控制码`);
    if (dropped > 0) logInfo(`已清理 ${dropped} 条失效/重复的旧控制码记录`);
}
restoreControlCodes();

// 只查询不占用：用于信任绑定等"仅需解析 code -> hostId"的场景。
// 不会把 status 置为 connected，避免一次绑定后该码被标记占用导致后续匹配返回 used。
async function lookupControlCode(code) {
    return await withFileLock(CONTROL_CODE_FILE, async () => {
        const list = readJson(CONTROL_CODE_FILE, []);
        const rec = list.find(c => c.code === code);
        if (!rec) return { ok: false, reason: 'not_found' };
        // 固定码永久有效：只要被控端在线待命就续期，不因过期窗口拒绝绑定
        if (rec.expiresAt < nowMs()) {
            if (standbyMap.has(rec.hostId) && standbyMap.get(rec.hostId).standby) {
                rec.expiresAt = nowMs() + CODE_TTL_MS;
                writeJson(CONTROL_CODE_FILE, list);
            } else {
                return { ok: false, reason: 'expired' };
            }
        }
        return { ok: true, rec };
    });
}

async function consumeControlCode(code) {
    return await withFileLock(CONTROL_CODE_FILE, async () => {
        const list = readJson(CONTROL_CODE_FILE, []);
        const rec = list.find(c => c.code === code);
        if (!rec) return { ok: false, reason: 'not_found' };
        if (rec.status !== 'waiting') return { ok: false, reason: 'used' };
        if (rec.expiresAt < nowMs()) {
            // 固定控制码：只要被控端当前在线且处于待命，就续期并允许连接（码本身永久有效）
            if (standbyMap.has(rec.hostId) && standbyMap.get(rec.hostId).standby) {
                rec.expiresAt = nowMs() + CODE_TTL_MS;
            } else {
                rec.status = 'expired';
                writeJson(CONTROL_CODE_FILE, list);
                return { ok: false, reason: 'expired' };
            }
        }
        rec.status = 'connected';
        writeJson(CONTROL_CODE_FILE, list);
        return { ok: true, rec };
    });
}

async function expireCode(code) {
    await withFileLock(CONTROL_CODE_FILE, async () => {
        const list = readJson(CONTROL_CODE_FILE, []);
        const rec = list.find(c => c.code === code);
        if (rec && rec.status === 'connected') {
            rec.status = 'used';
            writeJson(CONTROL_CODE_FILE, list);
        }
    });
}

// ---- 信任关系 ----
// 双向持久化：trustCache[deviceId][peerId] = { name, deviceName, addedAt }
function isTrusted(a, b) {
    return !!(trustCache[a] && trustCache[a][b]);
}
function addTrust(a, b, nameA, nameB) {
    if (!trustCache[a]) trustCache[a] = {};
    if (!trustCache[b]) trustCache[b] = {};
    // 优先用对方上报的系统设备名（deviceInfo），回退到已存设备名，最后空串
    const dnA = (deviceInfo.get(a) && deviceInfo.get(a).deviceName) || (trustCache[a][b] && trustCache[a][b].deviceName) || '';
    const dnB = (deviceInfo.get(b) && deviceInfo.get(b).deviceName) || (trustCache[b][a] && trustCache[b][a].deviceName) || '';
    trustCache[a][b] = { name: nameB || b, deviceName: dnB, addedAt: nowMs() };
    trustCache[b][a] = { name: nameA || a, deviceName: dnA, addedAt: nowMs() };
    saveTrustCache();
}
function getTrustList(deviceId) {
    const m = trustCache[deviceId] || {};
    return Object.keys(m).map(peerId => ({
        deviceId: peerId,
        name: m[peerId].name,
        deviceName: m[peerId].deviceName || (deviceInfo.get(peerId) && deviceInfo.get(peerId).deviceName) || '',
        // 在线且处于待命状态才视为"可一键连接"
        online: online.has(peerId) && online.get(peerId).size > 0,
        standby: !!(standbyMap.get(peerId) && standbyMap.get(peerId).standby),
    }));
}

/**
 * 设备在线/待命状态变化时，主动把最新信任列表推给"信任了该设备"的在线对端。
 * 这样控制端进入页面后无需轮询即可实时看到对方上线/下线。
 */
function notifyTrustPeers(deviceId) {
    try {
        for (const peerId of Object.keys(trustCache)) {
            if (peerId === deviceId) continue;
            // 只推给确实信任了该设备、且当前在线的对端
            if (!trustCache[peerId] || !trustCache[peerId][deviceId]) continue;
            if (!online.has(peerId) || online.get(peerId).size === 0) continue;
            relayTo(peerId, { op: 'trust.list', payload: { list: getTrustList(peerId) } });
        }
    } catch (e) {
        logWarn('notifyTrustPeers 失败:', e && e.message);
    }
}

// ---- 会话落盘 ----
async function persistSession(session, statusOverride) {
    await withFileLock(SESSION_FILE, async () => {
        const list = readJson(SESSION_FILE, []);
        const idx = list.findIndex(s => s.sessionId === session.sessionId);
        const rec = {
            sessionId: session.sessionId,
            controller: session.controller,
            host: session.host,
            code: session.code,
            plan: session.plan,
            status: statusOverride || session.status,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
        };
        if (idx === -1) list.push(rec); else list[idx] = rec;
        writeJson(SESSION_FILE, list);
    });
}

// ---- 强制终止（服务端驱动） ----
async function forceTerminate(sid, reason) {
    const session = sessions.get(sid);
    if (!session) return;
    if (session.status === 'terminated') return;
    session.status = 'terminated';
    session.endedAt = nowMs();
    await persistSession(session, 'terminated');
    await audit(sid, 'server', 'terminate', reason || 'server_force');

    const msg = JSON.stringify({ op: 'terminate', sid, payload: { reason: reason || 'server_force' } });
    [session.controller, session.host].forEach(peer => {
        const set = online.get(peer);
        if (!set) return;
        for (const ws of set) {
            if (ws && ws.readyState === ws.OPEN) {
                try { ws.send(msg); } catch (e) { /* ignore */ }
            }
        }
    });
    sessions.delete(sid);
    // 清理 UDP 端点表和宽限定时器
    udpEndpoints.delete(computeSidHash(sid));
    if (pendingDisconnects.has(sid)) { clearTimeout(pendingDisconnects.get(sid)); pendingDisconnects.delete(sid); }
}

// ---- 转发辅助 ----
function relayTo(deviceId, obj) {
    const set = online.get(deviceId);
    if (!set || set.size === 0) return false;
    let sent = false;
    for (const ws of set) {
        if (ws && ws.readyState === ws.OPEN) {
            try { ws.send(JSON.stringify(obj)); sent = true; } catch (e) { /* 忽略单连接失败，继续其余连接 */ }
        }
    }
    return sent;
}

// ---- 二进制视频帧中转（CS 中继模式）----
// 帧格式：[1B type][4B sidLen(大端)][sid UTF8][NALU 原始字节]
// 服务端不解析 NALU，仅按 sid 找到对端 session 并原样转发整段 Buffer（含帧头，
// 由客户端自行解析 type/sid 后取 NALU）。type 目前固定 1=视频，预留扩展音频/控制。
// 中继背压阈值：对端发送缓冲区超过该字节数，说明客户端消费慢（弱网/卡顿），
// 此时丢弃非关键帧(P帧)，只保关键帧(IDR/SPS-PPS)与最新帧，避免延迟无限堆积。
// 实时流允许"丢旧帧保新帧"以提升流畅度与降低端到端延迟。
// 原画档单帧可达 300~560KB，阈值设 256KB 即可在缓冲刚开始积压时就丢非关键帧，
// 避免缓冲区被超大帧快速撑爆导致对端永久冻结。
const RELAY_BACKPRESSURE_BYTES = 128 * 1024; // 128KB（高延迟下需更低阈值快速泄压）

// ---- TCP 视频中继运行统计（滚动窗口，非阻塞：每 10s 仅输出一次汇总，绝不每帧打印）----
// 这些统计直接反映"花屏/延迟"的服务端侧根因：
//   - droppedFrames：背压丢帧数（服务端缓冲区满丢弃 P 帧）→ 直接对应控制端花屏/卡顿
//   - idrRelayed：关键帧转发数（IDR 是否真到达控制端）
//   - 当前对端 bufferedAmount：实时背压水位
const relayStats = { relayed: 0, dropped: 0, idr: 0, lastLogMs: 0 };

// ============== 【关键诊断：会话级全链路指标字典(汇总才打印，绝不刷屏)】 ==============
// 每个 session 独立存储以下 7 类采样：
//   tcp / udp：TCP中继、UDP中继的收/发/丢/IDR统计
//   ba：TCP对端bufferedAmount峰值、采样次数
//   idr：IDR到达间隔分布、爆体积计数(>100KB)
//   frameSize：帧字节数直方图 [0-16KB,16-64KB,64-128KB,128KB+] + 爆尺寸帧计数
//   loss：P帧背压丢帧数/突发次数、突发最大连续丢
//   rtt：ping/pong最近RTT、RTT P50/P90近似
//   lastSummaryAt：上一次汇总打印时间戳（每10s才打1次）
const sessionDiag = new Map();
function getDiag(sid) {
    let d = sessionDiag.get(sid);
    if (!d) {
        d = {
            // ===== 原始关键采样（保留原逻辑的事件触发） =====
            lastIdrAt: 0, burstIdrCount: 0,
            lastDropAt: 0, burstDropCount: 0,
            lastBaSampleAt: 0, peakBa: 0,
            // ===== 新增会话级滚动窗口汇总（10s一打印，非阻塞） =====
            wStart: nowMs(),
            tcp: { relayed: 0, dropped: 0, idr: 0, baPeak10s: 0 },
            udp: { recv: 0, fwd: 0, fec: 0, dropped: 0, hostPkts: 0, ctrlPkts: 0 },
            idrStat: { total: 0, sizeGt100KB: 0, sizeGt64KB: 0, minGapMs: 99999, avgGapSum: 0, avgGapN: 0, lastSize: 0 },
            fsz: { hist: [0,0,0,0], hugeFrames: 0, totalBytes: 0, totalFrames: 0 },
            loss: { pDrops: 0, bursts: 0, maxBurst: 0, curBurst: 0 },
            rtt: { samples: 0, pings: 0, pongs: 0, recent: 0, sum: 0, max: 0 },
            role: { host: '', ctrl: '' },
            lastSummaryAt: 0,
        };
        sessionDiag.set(sid, d);
    }
    return d;
}
// 打印会话级10s汇总（所有有效指标一次输出，格式统一便于grep）
function printSessionSummary(sid, now) {
    const d = sessionDiag.get(sid);
    if (!d) return;
    const dt = now - d.wStart;
    if (dt < 10000) return;
    const sess = sessions.get(sid);
    const tag = sess ? `${sess.controller.slice(-8)}→${sess.host.slice(-8)}` : '';
    const fs = d.fsz;
    const idrS = d.idrStat;
    const totalF = fs.totalFrames || 1;
    const avgFB = (fs.totalBytes / totalF) | 0;
    const avgIdrGap = idrS.avgGapN > 0 ? ((idrS.avgGapSum / idrS.avgGapN) | 0) : 0;
    const avgRtt = d.rtt.samples > 0 ? ((d.rtt.sum / d.rtt.samples) | 0) : 0;
    const udpDrop = d.udp.recv - d.udp.fwd;
    const lossRate = (d.tcp.relayed + d.tcp.dropped) > 0
        ? ((d.tcp.dropped * 1000 / (d.tcp.relayed + d.tcp.dropped)) / 10).toFixed(1) : '0.0';
    logInfo(`[会话汇总] sid=${sid.slice(-12)} 对端=${tag} 窗口=${dt}ms`
        + ` | TCP:转${d.tcp.relayed} 丢${d.tcp.dropped}(${lossRate}%) IDR=${d.tcp.idr} TCP背压峰=${d.tcp.baPeak10s}B`
        + ` | UDP:收${d.udp.recv} 转${d.udp.fwd} 丢${udpDrop} FEC=${d.udp.fec} H/C=${d.udp.hostPkts}/${d.udp.ctrlPkts}`
        + ` | 帧:总=${totalF} 均=${avgFB}B 尺寸分[0-16K]=${fs.hist[0]} [16-64K]=${fs.hist[1]} [64-128K]=${fs.hist[2]} [>128K]=${fs.hist[3]} 爆帧=${fs.hugeFrames}`
        + ` | IDR:总=${idrS.total} >64KB=${idrS.sizeGt64KB} >100KB=${idrS.sizeGt100KB} 距上次均=${avgIdrGap}ms 最小=${idrS.minGapMs===99999?-1:idrS.minGapMs}ms 最近=${idrS.lastSize}B`
        + ` | P丢:总=${d.loss.pDrops} 突发=${d.loss.bursts} 最长连续=${d.loss.maxBurst}`
        + ` | RTT:均=${avgRtt}ms 最糟=${d.rtt.max}ms 最近=${d.rtt.recent}ms ping/pong=${d.rtt.pings}/${d.rtt.pongs}`);
    // 异常指标单独打 WARN，方便告警
    if (d.tcp.baPeak10s >= RELAY_BACKPRESSURE_BYTES * 0.8)
        logWarn(`[会话异常:TCP背压爆表] sid=${sid.slice(-12)} baPeak=${d.tcp.baPeak10s}B 阈值=${RELAY_BACKPRESSURE_BYTES}B —— 控制端解码/网络跟不上=花屏/延迟`);
    if (d.loss.maxBurst >= 50)
        logWarn(`[会话异常:连续丢P帧] sid=${sid.slice(-12)} 最长连续丢P=${d.loss.maxBurst} 总数=${d.loss.pDrops} —— 马赛克/花屏直接根因`);
    if (idrS.sizeGt100KB >= 2 && idrS.minGapMs < 2000)
        logWarn(`[会话异常:超大IDR风暴] sid=${sid.slice(-12)} >100KB的IDR=${idrS.sizeGt100KB}个 最小间隔=${idrS.minGapMs}ms —— IDR占满带宽=P帧全丢=全屏马赛克`);
    if (udpDrop > d.udp.recv * 0.1 && d.udp.recv > 100)
        logWarn(`[会话异常:UDP高丢包] sid=${sid.slice(-12)} 丢包率=${((udpDrop*100/d.udp.recv)|0)}% —— 控制端收不齐=局部花屏`);
    // 重置滚动窗口
    d.wStart = now;
    d.tcp.relayed = 0; d.tcp.dropped = 0; d.tcp.idr = 0; d.tcp.baPeak10s = 0;
    d.udp.recv = 0; d.udp.fwd = 0; d.udp.fec = 0; d.udp.dropped = 0; d.udp.hostPkts = 0; d.udp.ctrlPkts = 0;
    d.idrStat.total = 0; d.idrStat.sizeGt100KB = 0; d.idrStat.sizeGt64KB = 0;
    d.idrStat.minGapMs = 99999; d.idrStat.avgGapSum = 0; d.idrStat.avgGapN = 0; d.idrStat.lastSize = 0;
    d.fsz.hist = [0,0,0,0]; d.fsz.hugeFrames = 0; d.fsz.totalBytes = 0; d.fsz.totalFrames = 0;
    d.loss.pDrops = 0; d.loss.bursts = 0; d.loss.maxBurst = 0; d.loss.curBurst = 0;
    d.lastSummaryAt = now;
}
// 统一帧大小直方图分桶（供TCP/UDP共用，非阻塞：O(1)分桶+计数，绝不打印逐帧）
function bucketFrameSize(bytes) {
    if (bytes < 16 * 1024) return 0;
    if (bytes < 64 * 1024) return 1;
    if (bytes < 128 * 1024) return 2;
    return 3;
}

// ---- UDP 中继运行统计（滚动窗口，非阻塞：每 10s 仅输出一次汇总）----
// 直接反映 UDP 链路健康度：
//   - recv：服务端收到的总包数（含 FEC）
//   - fwd：成功转发出去的包数（转发失败=对端地址未知/未就绪，对应控制端收不到=花屏）
//   - fec：冗余包数（FEC 是否在工作）
//   - fromHost / fromCtrl：按方向细分（方向错乱=周期性卡顿根因）
const udpStats = { recv: 0, fwd: 0, fec: 0, fromHost: 0, fromCtrl: 0, lastLogMs: 0 };

// 调试日志开关：默认关闭，避免每帧 BINARY 日志狂刷拖垮服务器。
// 设置环境变量 REMOTE_DEBUG=1 可重新开启（仅排查问题时临时开启）。
const REMOTE_DEBUG = process.env.REMOTE_DEBUG === '1';

// 关键帧判定方案（修复 HEVC 关键帧误判根因）：
// 旧逻辑 isKeyFrameBuffer 用 AVC 的 NALU 单元类型算法 ((byte&0x1F)!=1) 解析关键帧，
// 但本项目实际编码为 HEVC（H.265），该算法在 HEVC 下会把 P 帧也误判为"关键帧"
// （HEVC 的 NALU type 在高 6 位而非低 5 位），导致背压丢帧策略完全失效——
// bufferedAmount 无限堆积→延迟 3-10s，且控制端 TCP 的 P 帧不被过滤而与 UDP P 帧重复。
// 现改为：帧头 type 字段直接携带关键帧语义（type=1 普通视频/P，type=3 关键视频/IDR，type=2 音频），
// 发送端编码器已精确知道 BUFFER_FLAG_KEY_FRAME，直接打标，权威且无歧义。
// 这里保留 isKeyFrameBuffer 仅作 type 缺失(old client)的保守兜底，新协议一律按 type 判定。
function isKeyFrameBuffer(buf) {
    const len = buf.length;
    let i = 0;
    while (i < len - 3) {
        if (buf[i] === 0x00 && buf[i + 1] === 0x00) {
            if (buf[i + 2] === 0x00 && i + 4 < len && buf[i + 3] === 0x01) {
                return (buf[i + 4] & 0x1F) !== 1; // 4 字节起始码：type 1=P(非关键)，其余(5/7/8)为关键
            }
            if (buf[i + 2] === 0x01 && i + 3 < len) {
                return (buf[i + 3] & 0x1F) !== 1; // 3 字节起始码
            }
        }
        i++;
    }
    return false; // 无法识别，保守按非关键帧处理（可被背压丢弃）
}

function relayBinary(deviceId, buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 5) return;
    const type = buf.readUInt8(0);
    const sidLen = buf.readUInt32BE(1);
    if (buf.length < 5 + sidLen) return;
    const sid = buf.toString('utf8', 5, 5 + sidLen);
    const session = sessions.get(sid);
    if (!session || session.status === 'terminated') return;
    const peer = peerOf(session, deviceId);
    const set = online.get(peer);
    if (!set) return;
    let peerWs = null;
    for (const w of set) { if (w && w.readyState === w.OPEN) { peerWs = w; break; } }
    if (peerWs) {
        const now = nowMs();
        const diag = getDiag(sid);
        const ba = peerWs.bufferedAmount;
        // 【会话级】TCP背压峰值（滚动窗口10s）
        if (ba > diag.peakBa) diag.peakBa = ba;
        if (ba > diag.tcp.baPeak10s) diag.tcp.baPeak10s = ba;
        if (now - diag.lastBaSampleAt >= 3000) {
            if (diag.peakBa > RELAY_BACKPRESSURE_BYTES / 2) {
                logWarn(`[TCP背压采样] sid=${sid} 对端=${peer.slice(-8)} bufferedAmount峰=${diag.peakBa}B 当前=${ba}B 阈值=${RELAY_BACKPRESSURE_BYTES}B —— 若持续偏高=控制端弱网/解码慢=延迟累积/花屏`);
            }
            diag.lastBaSampleAt = now;
            diag.peakBa = 0;
        }

        const payloadLen = buf.length - 5 - sidLen;
        // 【会话级】帧尺寸分桶（TCP视频帧，type=1/3）
        if (type === 1 || type === 3) {
            const bucket = bucketFrameSize(payloadLen);
            diag.fsz.hist[bucket]++;
            diag.fsz.totalFrames++;
            diag.fsz.totalBytes += payloadLen;
            if (payloadLen >= 128 * 1024) diag.fsz.hugeFrames++;
        }

        try {
            if (ba > RELAY_BACKPRESSURE_BYTES && type === 1) {
                // 【会话级】P帧背压丢：总数+连续丢检测
                diag.tcp.dropped++;
                diag.loss.pDrops++;
                diag.loss.curBurst++;
                if (diag.loss.curBurst > diag.loss.maxBurst) diag.loss.maxBurst = diag.loss.curBurst;
                session.droppedFrames = (session.droppedFrames || 0) + 1;
                relayStats.dropped++;
                // 原有事件触发：3s内丢>=30打WARN（但用会话级loss可回溯，不用依赖这条瞬时告警）
                diag.burstDropCount++;
                if (now - diag.lastDropAt < 3000 && diag.burstDropCount >= 30) {
                    diag.loss.bursts++;
                    logWarn(`[TCP丢帧突发] sid=${sid} 对端=${peer.slice(-8)} 3s内丢P帧=${diag.burstDropCount} ba=${ba}B —— 控制端花屏=对端弱网/解码慢`);
                    diag.burstDropCount = 0; diag.lastDropAt = now;
                } else if (now - diag.lastDropAt >= 3000) {
                    diag.burstDropCount = 1; diag.lastDropAt = now;
                }
                relayStatsLog();
                printSessionSummary(sid, now);  // 丢帧也要尝试汇总（内部10s才打，非阻塞）
                return;
            }
            // 丢帧中断=本帧未丢，重置连续丢计数
            diag.loss.curBurst = 0;

            peerWs.send(buf);
            diag.tcp.relayed++;
            relayStats.relayed++;
            if (type === 3) {
                diag.tcp.idr++;
                relayStats.idr++;
                diag.idrStat.total++;
                diag.idrStat.lastSize = payloadLen;
                if (payloadLen >= 64 * 1024) diag.idrStat.sizeGt64KB++;
                if (payloadLen >= 100 * 1024) diag.idrStat.sizeGt100KB++;
                const gap = now - diag.lastIdrAt;
                if (diag.lastIdrAt > 0) {
                    if (gap < diag.idrStat.minGapMs) diag.idrStat.minGapMs = gap;
                    diag.idrStat.avgGapSum += gap;
                    diag.idrStat.avgGapN++;
                }
                diag.burstIdrCount = (gap < 1000) ? (diag.burstIdrCount + 1) : 1;
                if (diag.burstIdrCount >= 3) {
                    logWarn(`[!!IDR风暴!!] sid=${sid} 1s内转发 IDR>=${diag.burstIdrCount} 个 当前ba=${ba}B size=${payloadLen}B —— HOST端强制产 IDR 过密，会反向挤没 P 帧=冻结/花屏`);
                    diag.burstIdrCount = 0;
                } else if (gap < 500) {
                    logThrottled('shallow_idr_' + sid, 2000, () =>
                        logInfo(`[IDR过密] sid=${sid} 距上次 IDR=${gap}ms size=${payloadLen}B —— 若频繁出现=IDR风暴前兆`));
                }
                diag.lastIdrAt = now;
            }
        } catch (e) { /* 忽略单次发送失败 */ }
        // 每帧都调用汇总（内部10s才打印，非阻塞）
        printSessionSummary(sid, now);
    }
}

// TCP 视频中继统计：每 10s 输出一次滚动窗口汇总（增量），避免每帧打印拖垮服务器。
// 这是服务端侧定位"花屏/延迟"的唯一硬指标：丢帧率 + 对端实时背压水位 + IDR 到达率。
function relayStatsLog() {
    const now = nowMs();
    const dt = now - relayStats.lastLogMs;
    if (dt < 10000) return;
    const dRelayed = relayStats.relayed;
    const dDropped = relayStats.dropped;
    const dIdr = relayStats.idr;
    relayStats.relayed = 0; relayStats.dropped = 0; relayStats.idr = 0;
    relayStats.lastLogMs = now;
    // 反映"当前"水位的样本：取最近一次被丢弃帧时的 bufferedAmount（已积满）
    if (dDropped > 0 || dRelayed > 0) {
        const total = dRelayed + dDropped;
        const lossRate = total > 0 ? ((dDropped * 1000 / total) / 10).toFixed(1) : '0.0';
        logInfo(`[TCP中继] 窗口${dt}ms 转发帧=${dRelayed} 背压丢帧=${dDropped} 丢帧率=${lossRate}% IDR转发=${dIdr}`);
    }
}

// UDP 中继统计：每 10s 输出一次滚动窗口汇总（增量），绝不每包打印。
// 转发数 < 收包数（fwd<recv）说明有包因对端地址未就绪被丢弃 → 控制端收不到=花屏/卡顿；
// 方向计数(fromHost/fromCtrl)异常说明 role 错乱 → 周期性卡顿根因；fec>0 说明冗余通道工作。
function udpStatsLog() {
    const now = nowMs();
    const dt = now - udpStats.lastLogMs;
    if (dt < 10000) return;
    const dRecv = udpStats.recv;
    const dFwd = udpStats.fwd;
    const dFec = udpStats.fec;
    const dFromHost = udpStats.fromHost;
    const dFromCtrl = udpStats.fromCtrl;
    udpStats.recv = 0; udpStats.fwd = 0; udpStats.fec = 0;
    udpStats.fromHost = 0; udpStats.fromCtrl = 0;
    udpStats.lastLogMs = now;
    if (dRecv <= 0) return;
    const dropPkts = dRecv - dFwd;
    logInfo(`[UDP中继] 窗口${dt}ms 收包=${dRecv} 转发=${dFwd} 丢弃=${dropPkts} FEC包=${dFec} fromHost=${dFromHost} fromCtrl=${dFromCtrl}`);
    // 【关键采样 4: UDP 丢包/方向异常】丢包率>10% 或 方向异常（fromCtrl>fromHost）打 WARN
    const lossPktRate = (dRecv > 0) ? (dropPkts * 100 / dRecv) : 0;
    if (lossPktRate >= 10) logWarn(`[UDP高丢包] 丢包率=${lossPktRate.toFixed(1)}% 丢=${dropPkts}/${dRecv} —— 控制端持续花屏/卡顿根因`);
    if (dFromCtrl > dFromHost * 1.5) logWarn(`[UDP方向异常] fromHost=${dFromHost} fromCtrl=${dFromCtrl} 控制器发包占比过高 —— 可能端点错乱=周期性卡顿`);
}

// ---- UDP 中继（CS 中继模式增强：视频流走 UDP，消除 TCP HOL 阻塞）----
// UDP 包格式：[1B magic=0xFC][4B sidHash][4B seq][2B fragIdx][2B fragCount][payload...]
// FEC 冗余包：[1B magic=0xFD][4B sidHash][4B seq][2B fecIdx][2B fragCount]
//             [2B groupStart][2B groupLen][2B payloadLen][xorPayload...]
// Hello/Keepalive 包：magic=0xFC, fragIdx=0xFFFF, fragCount=0xFFFF, 额外 1B role(0=host,1=controller)
// 服务端不解析视频负载，仅按 sidHash 找到对端 UDP 端点并原样转发整包。
const UDP_MAGIC = 0xFC;
// FEC 冗余包魔数：服务端需与数据包同样中继，否则 FEC 永远无法生效。
const UDP_MAGIC_FEC = 0xFD;
const UDP_HEADER_SIZE = 13;
// UDP 端口自动启用：优先与 HTTP 同端口；冲突则用 OS 随机端口；再失败则静默回退 TCP。
// 仍支持 UDP_PORT 环境变量显式指定（向后兼容）。
let udpPort = process.env.UDP_PORT ? parseInt(process.env.UDP_PORT) : 0;
let udpServer = null;
let udpAvailable = false;
// sidHash -> { sid, host: {addr,port}, controller: {addr,port}, notified }
const udpEndpoints = new Map();

function computeSidHash(sid) {
    return crypto.createHash('sha1').update(sid).digest().readUInt32BE(0);
}

function initUdpRelay(preferredPort) {
    // 已显式指定端口则只用它；否则依次尝试 preferredPort、0(随机)
    const tryPorts = udpPort ? [udpPort] : (preferredPort ? [preferredPort, 0] : [0]);
    let idx = 0;
    const tryBind = () => {
        if (idx >= tryPorts.length) {
            logWarn('UDP 绑定全部失败，视频走 TCP（WebSocket）');
            return;
        }
        const port = tryPorts[idx++];
        const sock = dgram.createSocket('udp4');
        sock.on('message', (msg, rinfo) => {
            const magic = msg[0];
            if (msg.length < UDP_HEADER_SIZE) return;
            // 同时接受数据包(0xFC)与 FEC 冗余包(0xFD)；FEC 包必须原样中继，
            // 否则控制端收不到冗余数据，分组 XOR 恢复完全失效。
            if (magic !== UDP_MAGIC && magic !== UDP_MAGIC_FEC) return;
            const isFec = magic === UDP_MAGIC_FEC;
            const sidHash = msg.readUInt32BE(1);
            const fragIdx = msg.readUInt16BE(9);
            const fragCount = msg.readUInt16BE(11);
            const ep = udpEndpoints.get(sidHash);
            if (!ep) return;

            // Hello/Keepalive：记录端点并尝试通知双方就绪（仅数据包魔数携带 hello）
            if (!isFec && fragIdx === 0xFFFF && fragCount === 0xFFFF) {
                if (msg.length >= 14) {
                    const role = msg[13];
                    if (role === 0) ep.host = { addr: rinfo.address, port: rinfo.port };
                    else ep.controller = { addr: rinfo.address, port: rinfo.port };
                    if (ep.host && ep.controller && !ep.notified) {
                        ep.notified = true;
                        const session = sessions.get(ep.sid);
                        if (session) {
                            relayTo(session.controller, { op: 'udp.ready', sid: ep.sid });
                            relayTo(session.host, { op: 'udp.ready', sid: ep.sid });
                            logInfo(`传输切换: UDP 就绪 sid=${ep.sid} host=${ep.host.addr}:${ep.host.port} ctrl=${ep.controller.addr}:${ep.controller.port}`);
                        }
                    }
                }
                return;
            }

            // 视频/FEC 包：直接按包头 [13] 的 role 转发，不再靠地址猜测角色。
            // role 由客户端权威写入（host=0 / controller=1），彻底消除 NAT 端口重映射 /
            // 同源公网 IP 场景下「按地址猜角色」导致的端点错乱（花屏 + 周期性 4-8s 卡顿根因）。
            // 端点地址端口仍由 hello 包（role 已知）建立，role 仅决定「这个包该发给谁」。
            if (msg.length < 14) return;
            const role = msg[13];
            // role 0 = host 发出的包 → 转发给 controller；role 1 = controller 发出的包 → 转发给 host
            const target = role === 0 ? ep.controller : ep.host;
            if (role === 0) { udpStats.fromHost++; } else { udpStats.fromCtrl++; }
            // 【会话级】按sid把UDP统计也写入sessionDiag（和TCP同源统一查看）
            const nowUdp = nowMs();
            const diagUdp = getDiag(ep.sid);
            if (role === 0) diagUdp.udp.hostPkts++; else diagUdp.udp.ctrlPkts++;
            diagUdp.udp.recv++;
            let thisFwd = false;
            if (target && !(target.addr === rinfo.address && target.port === rinfo.port)) {
                try {
                    sock.send(msg, target.port, target.addr);
                    udpStats.fwd++;
                    diagUdp.udp.fwd++;
                    thisFwd = true;
                } catch (e) { /* ignore */ }
            }
            if (!thisFwd) diagUdp.udp.dropped++;
            if (isFec) { udpStats.fec++; diagUdp.udp.fec++; }
            udpStatsLog();
            // 每包调用（内部10s才打印，非阻塞）
            printSessionSummary(ep.sid, nowUdp);
        });
        sock.on('error', (e) => {
            // 绑定阶段错误：尝试下一个端口；运行期错误：回退 TCP
            if (!udpAvailable) {
                logWarn(`UDP 绑定端口 ${port} 失败: ${e.message}，尝试下一个`);
                try { sock.close(); } catch (_) {}
                tryBind();
            } else {
                logWarn(`UDP 运行错误，回退 TCP: ${e.message}`);
                udpAvailable = false;
            }
        });
        sock.bind(port, () => {
            udpServer = sock;
            udpPort = sock.address().port;
            udpAvailable = true;
            logInfo(`UDP 中继已启动 端口=${udpPort}${port === 0 ? '(随机)' : ''}`);
        });
    };
    tryBind();
}

// ---- 认证（复用 server.js 的 deviceId token 思路） ----
// 这里采用轻量方案：WebSocket 连接时通过 query ?token=xxx&deviceId=xxx 传递；
// token 校验交由调用方提供的 verify 函数（server.js 注入），默认放行 demo。
let verifyToken = (deviceId, token) => true;

function registerVerify(fn) { verifyToken = fn; }

// ---- 主入口：在一个已存在的 http.Server 上挂载 WebSocket ----
function attach(httpServer) {
    // UDP 自动启用：HTTP listening 后尝试同端口绑定 UDP，失败回退 TCP
    if (!udpAvailable && !udpServer) {
        const startUdp = () => {
            const addr = httpServer.address();
            const httpPort = (addr && typeof addr === 'object') ? addr.port : 0;
            try { initUdpRelay(httpPort); } catch (e) { logWarn(`UDP 自动启用失败: ${e.message}`); }
        };
        if (httpServer.listening) startUdp();
        else httpServer.once('listening', startUdp);
    }

    const wss = new WebSocketServer({ server: httpServer, path: '/ws/remote' });

    wss.on('connection', (ws, req) => {
        const url = new URL(req.url, 'http://localhost');
        const deviceId = url.searchParams.get('deviceId');
        const token = url.searchParams.get('token');
        const dname = (url.searchParams.get('dname') || '').trim();

        if (!deviceId || !verifyToken(deviceId, token)) {
            logWarn(`连接被拒 unauthorized device=${deviceId && deviceId.slice(-8)} token=${token ? '***' : '(空)'}`);
            try { ws.close(4001, 'unauthorized'); } catch (e) {}
            return;
        }
        // 记录系统设备名称（设置→关于手机→设备名称，如「荣耀60SE」「妈妈的手机」），
        // 供信任列表默认展示（无需备注即可区分不同设备）
        if (dname) deviceInfo.set(deviceId, { deviceName: dname });
        logInfo(`新 WebSocket 连接建立 device=${deviceId.slice(-8)}${dname ? ' dname=' + dname : ''} 在线=${online.size}`);

        ws.deviceId = deviceId;
        ws.isAlive = true;
        // 同一设备可有多个连接（常驻信令 + 远控页），全部计入在线集合
        if (!online.has(deviceId)) online.set(deviceId, new Set());
        online.get(deviceId).add(ws);
        // 若此前处于待命（授权录屏常驻等待），重新上线后恢复待命状态并续期控制码
        if (standbyMap.has(deviceId)) {
            const st = standbyMap.get(deviceId);
            st.ws = ws;
            createControlCode(deviceId).catch(e => logError('待命续期失败', e));
        }
        logInfo(`设备上线: ${deviceId.slice(-8)}, 在线数: ${online.size}`);
        // 通知信任对端：该设备已上线，控制端列表实时点亮
        notifyTrustPeers(deviceId);

        // 设备重连恢复：若该设备参与的活动会话有宽限定时器，取消它，会话无缝继续
        for (const [sid, session] of sessions) {
            if (session.status === 'terminated') continue;
            if ((session.controller === deviceId || session.host === deviceId) && pendingDisconnects.has(sid)) {
                clearTimeout(pendingDisconnects.get(sid));
                pendingDisconnects.delete(sid);
                logInfo(`设备 ${deviceId.slice(-8)} 重连，恢复会话 ${sid}`);
            }
        }

        // 【会话级RTT探针】服务端主动发ping→客户端回pong，测量WS链路真实RTT（ms）
        // 写入 sessionDiag.rtt：均/最糟/最近 值，每10s会话汇总必打印
        ws.on('pong', () => {
            ws.isAlive = true;
            if (!ws._pingAt) return;
            const rtt = nowMs() - ws._pingAt;
            ws._pingAt = 0;
            // 找到该ws所属所有sid（1个设备可能参与1~2个会话同时期）
            const deviceId = ws.deviceId;
            for (const [sid, sess] of sessions.entries()) {
                if (!sess || sess.status === 'terminated') continue;
                if (sess.controller !== deviceId && sess.host !== deviceId) continue;
                const d = getDiag(sid);
                d.rtt.pongs++;
                d.rtt.recent = rtt;
                d.rtt.samples++;
                d.rtt.sum += rtt;
                if (rtt > d.rtt.max) d.rtt.max = rtt;
            }
        });

        ws.on('message', async (raw) => {
            const isBuf = Buffer.isBuffer(raw);
            // 调试：仅当 REMOTE_DEBUG=1 时打印每帧原始消息（平时关闭，避免日志狂刷拖垮服务器）
            if (REMOTE_DEBUG) {
                const t = isBuf ? `BINARY(${raw.length}B)` : `TEXT(${String(raw).length}ch)`;
                const head = isBuf ? raw.slice(0, 12).toString('hex') : String(raw).slice(0, 80);
                logInfo(`[DEBUG raw] device=${deviceId.slice(-8)} type=${t} head=${head}`);
            }

            // 容错：客户端（OkHttp）可能把 JSON 信令以二进制帧(opcode=0x2)发出，
            // 此时 raw 是 Buffer 但内容其实是 UTF-8 的 JSON 文本（以 '{' 开头）。
            // 视频流是真正的二进制 NALU（首字节为 type=0x01），不会以 '{' 开头，
            // 因此用"首字节是否为 '{' 且能 JSON.parse"来把信令从二进制帧中识别出来。
            const buf = isBuf ? raw : Buffer.from(raw);
            const looksLikeJson = buf.length > 0 && buf[0] === 0x7b; // '{'
            if (looksLikeJson) {
                let m;
                try { m = JSON.parse(buf.toString('utf8')); } catch (e) {
                    return ws.send(JSON.stringify({ op: 'error', payload: { msg: 'invalid_json' } }));
                }
                // 【日志去噪】高频信令(heartbeat/rtc.quality/cmd_ack 等)节流 1s 打一次，
                // 其余关键 op 每次都打（code.connect/keyframe.request/trust 绑定等）。
                const op = (m && m.op) || '';
                const noisy = NOISY_OP_RE.test(op);
                if (noisy) {
                    logThrottled('op_' + deviceId + '_' + op, 1000, () =>
                        logInfo(`[CS信令-高频节流] device=${deviceId.slice(-8)} op=${op} sid=${(m && m.sid) || ''} —— 同类消息已节流，实际每 1s 至多一条`));
                } else {
                    logInfo(`[CS信令] device=${deviceId.slice(-8)} op=${op} sid=${(m && m.sid) || ''}`);
                }
                try {
                    await handleMessage(ws, m);
                } catch (e) {
                    logError(`[处理消息异常] device=${deviceId.slice(-8)} op=${op} err=${e && e.message} stack=${e && e.stack && e.stack.split('\n')[0] || ''}`);
                    ws.send(JSON.stringify({ op: 'error', payload: { msg: 'internal', detail: String(e && e.message) } }));
                }
                return;
            }

            // 二进制帧 = 视频流（CS 中继模式）：[1B type][4B sidLen][sid UTF8][NALU bytes]
            if (isBuf) {
                relayBinary(deviceId, raw);
                return;
            }
            // 其余文本（理论上不会到这，纯文本信令也已在上面 JSON 分支处理）
            let m;
            try { m = JSON.parse(raw.toString()); } catch (e) {
                return ws.send(JSON.stringify({ op: 'error', payload: { msg: 'invalid_json' } }));
            }
            const op = (m && m.op) || '';
            const noisy = NOISY_OP_RE.test(op);
            if (noisy) {
                logThrottled('op_' + deviceId + '_' + op, 1000, () =>
                    logInfo(`[WS信令-高频节流] device=${deviceId.slice(-8)} op=${op} sid=${(m && m.sid) || ''}`));
            } else {
                logInfo(`[WS信令] device=${deviceId.slice(-8)} op=${op} sid=${(m && m.sid) || ''}`);
            }
            try {
                await handleMessage(ws, m);
            } catch (e) {
                logError(`[处理消息异常] device=${deviceId.slice(-8)} op=${op} err=${e && e.message}`);
                ws.send(JSON.stringify({ op: 'error', payload: { msg: 'internal', detail: String(e && e.message) } }));
            }
        });

        ws.on('close', () => {
            // 多连接集合：只移除自身这条 ws，保留同一设备的其它连接（如常驻信令），
            // 避免远控页关闭时把"仍在后台保活"的常驻信令连接误判为离线。
            const set = online.get(deviceId);
            if (set) {
                set.delete(ws);
                if (set.size === 0) online.delete(deviceId);
            }
            // 待命设备在"该连接"为待命连接且已无其他连接时才清除（待命前提是保持连接在线）
            // 注：standbyMap.ws 指向的是发起待命的那条连接；若常驻信令连接仍存在则保留待命态。
            if (standbyMap.has(deviceId) && standbyMap.get(deviceId).ws === ws && (!online.has(deviceId))) {
                standbyMap.delete(deviceId);
            }
            logInfo(`连接关闭 device=${deviceId.slice(-8)} 该设备剩余连接=${online.has(deviceId) ? online.get(deviceId).size : 0} 总在线=${online.size}`);
            // 设备已通过其它连接（如常驻信令）保持在线：无需通知离线
            if (online.has(deviceId)) return;
            // 通知信任对端：该设备已离线，控制端列表实时置灰
            notifyTrustPeers(deviceId);
            // 若该设备参与了活动 session，启动宽限定时器（而非立即终止）
            for (const [sid, session] of sessions) {
                if (session.status === 'terminated') continue;
                if (session.controller === deviceId || session.host === deviceId) {
                    if (pendingDisconnects.has(sid)) continue; // 已有宽限定时器
                    logInfo(`设备 ${deviceId.slice(-8)} 断线，会话 ${sid} 进入 ${RECONNECT_GRACE_MS / 1000}s 宽限期`);
                    const timer = setTimeout(() => {
                        pendingDisconnects.delete(sid);
                        const s = sessions.get(sid);
                        if (!s || s.status === 'terminated') return;
                        const peer = peerOf(s, deviceId);
                        logInfo(`设备 ${deviceId.slice(-8)} 宽限期超时未重连，终止会话 ${sid}`);
                        forceTerminate(sid, 'peer_offline').then(() => {
                            relayTo(peer, { op: 'terminate', sid, payload: { reason: 'peer_offline' } });
                        });
                    }, RECONNECT_GRACE_MS);
                    pendingDisconnects.set(sid, timer);
                }
            }
        });

        ws.on('error', (e) => { logError('ws error', deviceId && deviceId.slice(-8), e.message); });
    });

    // 心跳检测
    const heartbeat = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                try { ws.terminate(); } catch (e) {}
                return;
            }
            ws.isAlive = false;
            try {
                // 【会话级RTT】ping前记录时间戳，pong回调中算差值=真实WS RTT
                ws._pingAt = nowMs();
                const deviceId = ws.deviceId;
                // 把这次ping也记录到所属会话的rtt.pings（用于pings/pongs比例核对=心跳健康度）
                if (deviceId) {
                    for (const [sid, sess] of sessions.entries()) {
                        if (!sess || sess.status === 'terminated') continue;
                        if (sess.controller !== deviceId && sess.host !== deviceId) continue;
                        const d = getDiag(sid);
                        d.rtt.pings++;
                        // 会话建立时记录role缩写，便于汇总打印
                        if (!d.role.host) d.role.host = sess.host && sess.host.slice(-8);
                        if (!d.role.ctrl) d.role.ctrl = sess.controller && sess.controller.slice(-8);
                    }
                }
                ws.ping();
            } catch (e) {}
        });
    }, 30 * 1000);

    wss.on('close', () => clearInterval(heartbeat));
    return wss;
}

// ---- 消息路由 ----
async function handleMessage(ws, m) {
    const deviceId = ws.deviceId;
    const sid = m.sid;

    switch (m.op) {
        case 'code.create': {
            logInfo(`>>> code.create 来自 device=${deviceId.slice(-8)}，开始生成控制码`);
            const rec = await createControlCode(deviceId);
            await audit(rec.code, deviceId, 'open', 'create_code');
            const resp = JSON.stringify({ op: 'code.created', payload: { code: rec.code, expiresAt: rec.expiresAt } });
            logInfo(`<<< 回包 code.created code=${rec.code}`);
            ws.send(resp);
            break;
        }

        case 'code.connect': {
            const code = (m.payload && m.payload.code || '').trim();
            // 传输模式由控制端决定（'webrtc' | 'cs'）。被控端无条件跟随，自己本机开关不参与决策。
            const mode = (m.payload && m.payload.mode === 'webrtc') ? 'webrtc' : 'cs';
            if (!code) { ws.send(JSON.stringify({ op: 'code.reject', payload: { reason: 'empty' } })); break; }
            const r = await consumeControlCode(code);
            if (!r.ok) {
                ws.send(JSON.stringify({ op: 'code.reject', payload: { reason: r.reason } }));
                break;
            }
            const hostId = r.rec.hostId;
            if (hostId === deviceId) {
                ws.send(JSON.stringify({ op: 'code.reject', payload: { reason: 'self' } }));
                break;
            }
            // 被控端必须在线且处于待命（授权录屏后常驻等待），否则无法连接
            if (!online.has(hostId) || online.get(hostId).size === 0 || !(standbyMap.get(hostId) && standbyMap.get(hostId).standby)) {
                ws.send(JSON.stringify({ op: 'code.reject', payload: { reason: 'host_offline' } }));
                break;
            }
            // 信任设备：免确认，直接匹配
            if (isTrusted(deviceId, hostId)) {
                establishSession(deviceId, hostId, code, 'trust', mode);
                break;
            }
            // 非信任设备：向被控端推送"连接请求确认"弹窗，由被控端决定是否允许
            // 记录控制端决定的传输模式，待被控端确认后建立会话时沿用（被控端必须跟随）
            pendingConfirms.set(code + ':' + deviceId, { controller: deviceId, host: hostId, code, mode });
            const ok = relayTo(hostId, {
                op: 'incoming', sid: '', payload: {
                    controller: deviceId,
                    code,
                    controllerName: (m.payload && m.payload.name) || '',
                }
            });
            if (!ok) {
                ws.send(JSON.stringify({ op: 'code.reject', payload: { reason: 'host_offline' } }));
                break;
            }
            // 控制端先收到"等待确认"提示
            ws.send(JSON.stringify({ op: 'code.waiting', payload: { code, host: hostId } }));
            logInfo(`连接请求待确认 controller=${deviceId.slice(-8)} -> host=${hostId.slice(-8)} code=${code}`);
            break;
        }

        // 被控端在待命页面对"连接请求确认"弹窗的回应
        case 'incoming.confirm': {
            const code = (m.payload && m.payload.code || '').trim();
            const controller = m.payload && m.payload.controller;
            const key = code + ':' + controller;
            const pend = pendingConfirms.get(key);
            if (!pend || pend.host !== deviceId) {
                ws.send(JSON.stringify({ op: 'error', payload: { msg: 'no_pending' } }));
                break;
            }
            pendingConfirms.delete(key);
            establishSession(controller, deviceId, code, 'confirm', pend.mode || 'cs');
            break;
        }

        case 'incoming.reject': {
            const code = (m.payload && m.payload.code || '').trim();
            const controller = m.payload && m.payload.controller;
            const key = code + ':' + controller;
            const pend = pendingConfirms.get(key);
            if (!pend || pend.host !== deviceId) {
                ws.send(JSON.stringify({ op: 'error', payload: { msg: 'no_pending' } }));
                break;
            }
            pendingConfirms.delete(key);
            relayTo(controller, { op: 'code.reject', payload: { reason: 'rejected' } });
            logInfo(`连接请求被拒绝 host=${deviceId.slice(-8)} -> controller=${controller && controller.slice(-8)}`);
            break;
        }

        // 被控端授权录屏后进入"待命"：保持在线并等待控制端连接（无需每次进页面点开始）
        case 'standby': {
            const on = !!(m.payload && m.payload.on);
            if (on) {
                standbyMap.set(deviceId, { standby: true, ws, code: genFixedCode(deviceId), since: nowMs() });
                const rec = await createControlCode(deviceId);
                relayTo(deviceId, { op: 'standby.ok', payload: { code: rec.code } });
                logInfo(`设备进入待命 device=${deviceId.slice(-8)} code=${rec.code}`);
            } else {
                standbyMap.delete(deviceId);
                logInfo(`设备退出待命 device=${deviceId.slice(-8)}`);
            }
            // 待命状态变化时主动推给信任我的对端，使其列表实时显示在线/离线
            notifyTrustPeers(deviceId);
            break;
        }

        // 信任绑定：控制端输入对方控制码发起绑定请求，对方弹窗确认
        case 'trust.bind': {
            const code = (m.payload && m.payload.code || '').trim();
            const peerName = (m.payload && m.payload.name) || '';
            // 绑定只需解析出对方 deviceId，不占用控制码（否则该码会被置为 connected）
            const r = await lookupControlCode(code);
            if (!r.ok) {
                ws.send(JSON.stringify({ op: 'trust.bind.fail', payload: { reason: r.reason } }));
                break;
            }
            const peerId = r.rec.hostId;
            if (peerId === deviceId) {
                ws.send(JSON.stringify({ op: 'trust.bind.fail', payload: { reason: 'self' } }));
                break;
            }
            if (!online.has(peerId) || online.get(peerId).size === 0 || !(standbyMap.get(peerId) && standbyMap.get(peerId).standby)) {
                ws.send(JSON.stringify({ op: 'trust.bind.fail', payload: { reason: 'peer_offline' } }));
                break;
            }
            pendingTrust.set(code + ':' + deviceId, { from: deviceId, fromName: peerName, to: peerId, code });
            relayTo(peerId, {
                op: 'trust.incoming', payload: {
                    from: deviceId,
                    fromName: peerName,
                    code,
                }
            });
            ws.send(JSON.stringify({ op: 'trust.bind.waiting', payload: { code } }));
            logInfo(`信任绑定请求 from=${deviceId.slice(-8)} -> to=${peerId.slice(-8)} code=${code}`);
            break;
        }

        case 'trust.confirm': {
            const code = (m.payload && m.payload.code || '').trim();
            const from = m.payload && m.payload.from;
            const key = code + ':' + from;
            const pend = pendingTrust.get(key);
            if (!pend || pend.to !== deviceId) {
                ws.send(JSON.stringify({ op: 'error', payload: { msg: 'no_pending' } }));
                break;
            }
            pendingTrust.delete(key);
            addTrust(pend.from, pend.to, pend.fromName, (m.payload && m.payload.name) || '');
            relayTo(pend.from, { op: 'trust.confirmed', payload: { peer: pend.to, name: (m.payload && m.payload.name) || pend.to } });
            ws.send(JSON.stringify({ op: 'trust.confirmed', payload: { peer: pend.from, name: pend.fromName || pend.from } }));
            logInfo(`信任绑定确认 from=${pend.from && pend.from.slice(-8)} <-> to=${pend.to && pend.to.slice(-8)}`);
            // 绑定成功后主动把最新信任列表推给双方，确保控制端实时看到对方"在线·可连接"，
            // 而不依赖控制端收到 trust.confirmed 后再主动拉取（主动拉取可能因连接抖动丢失回包）。
            notifyTrustPeers(pend.from);
            notifyTrustPeers(pend.to);
            break;
        }

        case 'trust.reject': {
            const code = (m.payload && m.payload.code || '').trim();
            const from = m.payload && m.payload.from;
            const key = code + ':' + from;
            const pend = pendingTrust.get(key);
            if (!pend || pend.to !== deviceId) break;
            pendingTrust.delete(key);
            relayTo(pend.from, { op: 'trust.bind.fail', payload: { reason: 'rejected' } });
            break;
        }

        // 查询我的信任设备列表（含在线/待命状态）
        case 'trust.list': {
            const list = getTrustList(deviceId);
            ws.send(JSON.stringify({ op: 'trust.list', payload: { list } }));
            break;
        }

        // 信任设备一键连接：免确认直接匹配（前提对方在线且待命）
        case 'trust.request': {
            const peerId = (m.payload && m.payload.peer) || '';
            // 传输模式由控制端决定（'webrtc' | 'cs'），被控端无条件跟随
            const mode = (m.payload && m.payload.mode === 'webrtc') ? 'webrtc' : 'cs';
            const code = genFixedCode(peerId);
            if (!isTrusted(deviceId, peerId)) {
                ws.send(JSON.stringify({ op: 'code.reject', payload: { reason: 'not_trusted' } }));
                break;
            }
            if (!online.has(peerId) || online.get(peerId).size === 0 || !(standbyMap.get(peerId) && standbyMap.get(peerId).standby)) {
                ws.send(JSON.stringify({ op: 'code.reject', payload: { reason: 'host_offline' } }));
                break;
            }
            const r = await consumeControlCode(code);
            if (!r.ok) {
                ws.send(JSON.stringify({ op: 'code.reject', payload: { reason: r.reason } }));
                break;
            }
            establishSession(deviceId, peerId, code, 'trust', mode);
            break;
        }

        case 'trust.remove': {
            const peerId = (m.payload && m.payload.peer) || '';
            if (trustCache[deviceId] && trustCache[deviceId][peerId]) {
                delete trustCache[deviceId][peerId];
                saveTrustCache();
            }
            ws.send(JSON.stringify({ op: 'trust.removed', payload: { peer: peerId } }));
            // 删除成功后主动把最新信任列表推回本端，确保 UI 实时刷新（不依赖客户端主动拉取，
            // 规避"未连接时拉取请求被丢弃/连接抖动导致删除界面无反应"的情况）。
            relayTo(deviceId, { op: 'trust.list', payload: { list: getTrustList(deviceId) } });
            // 同时同步通知对端（被删方）清理该信任关系，保持双向一致
            if (trustCache[peerId] && trustCache[peerId][deviceId]) {
                delete trustCache[peerId][deviceId];
                saveTrustCache();
                relayTo(peerId, { op: 'trust.removed', payload: { peer: deviceId } });
                relayTo(peerId, { op: 'trust.list', payload: { list: getTrustList(peerId) } });
            }
            logInfo(`移除信任 device=${deviceId.slice(-8)} peer=${peerId.slice(-8)}`);
            break;
        }

        case 'rtc.offer':
        case 'rtc.answer':
        case 'rtc.ice':
        case 'rtc.meta':
        case 'rtc.quality':
        case 'rtc.connected':
        case 'rtc.encres':
        // 控制端「声音」开关 -> 被控端据此启停音频采集编码（声音同步）
        case 'rtc.audio':
        // 控制端上报解码能力上限 -> 被控端据此钳制编码分辨率（原画质自适应）
        case 'rtc.deccap': {
            const session = sessions.get(sid);
            if (!session || session.status === 'terminated') {
                ws.send(JSON.stringify({ op: 'error', sid, payload: { msg: 'no_session' } }));
                break;
            }
            const peer = peerOf(session, deviceId);
            session.lastActivity = nowMs();
            relayTo(peer, { op: m.op, sid, payload: m.payload });
            break;
        }

        case 'rtc.connected': {
            const session = sessions.get(sid);
            if (!session) break;
            session.status = 'streaming';
            session.lastActivity = nowMs();
            await persistSession(session, 'streaming');
            break;
        }

        case 'keyframe.request': {
            // 控制端检测到卡顿/丢包，请求被控端立即输出 IDR 关键帧以快速恢复解码。
            // 仅允许控制端发起，转发给对端被控端。
            const session = sessions.get(sid);
            if (!session || session.status === 'terminated') {
                ws.send(JSON.stringify({ op: 'error', sid, payload: { msg: 'no_session' } }));
                break;
            }
            if (session.controller !== deviceId) {
                // 仅控制端可发起关键帧请求
                ws.send(JSON.stringify({ op: 'error', sid, payload: { msg: 'not_controller' } }));
                break;
            }
            session.lastActivity = nowMs();
            relayTo(session.host, { op: 'keyframe.request', sid, payload: m.payload || {} });
            // 【关键采样 5: IDR 请求】控制端每次发起 IDR 请求都打 INFO，
            // 结合 relayStats 的"IDR转发数"可以算出：请求了多少 / 实际到达多少。
            // 若控制端连续请求 >3 次但 IDR 转发 < 对应的被控端真实输出 = 被控端仍在熔断。
            logInfo(`keyframe.request ctrl=${deviceId.slice(-8)} -> host=${session.host.slice(-8)} sid=${sid}`);
            break;
        }

        case 'cmd': {
            const session = sessions.get(sid);
            if (!session || session.status === 'terminated') {
                ws.send(JSON.stringify({ op: 'error', sid, payload: { msg: 'no_session' } }));
                break;
            }
            // 控制端可下发操作指令；被控端仅会回发 PONG（端到端延时应答），同样走 cmd 通道。
            // 被控端发来的 cmd 一律转发给控制端，不再以 not_controller 拒绝（否则 PONG 被拒导致刷屏报错）。
            if (session.controller !== deviceId) {
                relayTo(session.controller, { op: 'cmd', sid, payload: m.payload });
                break;
            }
            session.lastActivity = nowMs();
            // 脱敏审计：仅记录动作类型与坐标摘要
            const action = m.payload && m.payload.action;
            let detail = null;
            if (action) {
                detail = `${action.type || '?'}` +
                    (action.startX != null ? `@(${Math.round(action.startX)},${Math.round(action.startY)})` : '');
            }
            await audit(sid, deviceId, 'cmd', detail);
            // 转发给被控端
            relayTo(session.host, { op: 'cmd', sid, payload: m.payload });
            break;
        }

        case 'cmd_ack': {
            const session = sessions.get(sid);
            if (!session) break;
            session.lastActivity = nowMs();
            relayTo(session.controller, { op: 'cmd_ack', sid, payload: m.payload });
            break;
        }

        // 信任设备间指令：控制端向"在线"的受控端（未必处于活动会话中）下发指令（如锁屏）。
        // 受控端处理完后通过 trust.cmd_ack 回执，服务器再转发回控制端。
        // 约定：peer 一律放在 payload 内，便于客户端统一用 payload.peer 读取。
        case 'trust.cmd': {
            const payload = m.payload || {};
            const peerId = payload.peer;
            const peerSet = online.get(peerId);
            if (!peerSet || peerSet.size === 0) {
                // 对方不在线，直接回执失败
                relayTo(deviceId, { op: 'trust.cmd_ack', payload: { peer: peerId, ok: false, reason: '对方不在线' } });
                break;
            }
            if (!isTrusted(deviceId, peerId)) {
                relayTo(deviceId, { op: 'trust.cmd_ack', payload: { peer: peerId, ok: false, reason: '非信任设备' } });
                break;
            }
            // 透传给受控端（relayTo 按 deviceId 遍历其所有在线连接发送），
            // 携来源 deviceId（控制端，写入 payload.peer）以便其回执；action 为编码后的 ActionJson 字符串
            relayTo(peerId, { op: 'trust.cmd', payload: { peer: deviceId, action: payload.action } });
            break;
        }

        // 受控端处理 trust.cmd 后的回执：payload.peer 为下发时服务器填入的控制端 deviceId
        case 'trust.cmd_ack': {
            const payload = m.payload || {};
            const controllerId = payload.peer;
            const targetSet = online.get(controllerId);
            if (targetSet && targetSet.size > 0) {
                relayTo(controllerId, { op: 'trust.cmd_ack', payload: { peer: deviceId, ok: !!payload.ok, reason: payload.reason || '' } });
            }
            break;
        }

        case 'terminate': {
            const session = sessions.get(sid);
            if (!session) break;
            await forceTerminate(sid, (m.payload && m.payload.reason) || 'user');
            const peer = peerOf(session, deviceId);
            relayTo(peer, { op: 'terminate', sid, payload: { reason: (m.payload && m.payload.reason) || 'user' } });
            await expireCode(session.code);
            break;
        }

        case 'udp.fallback': {
            // 控制端通知：UDP 不可用，回退 TCP。转发给对端（被控端）切换回 WebSocket 发送。
            const session = sessions.get(sid);
            if (!session) break;
            // 关键修复：重置 UDP 端点状态，允许双方重新通过 hello 建立 UDP 传输。
            // 【原问题】notified 一旦置 true 永不复位，回退后即使双端 hello 保活包持续到达，
            // 服务端也不会再发 udp.ready → useUdpVideo 永远无法重新置 true → UDP 永久不可恢复。
            // 重置后，双端 UdpVideoTransport 仍在运行（未停止），hello 保活包会重新注册端点，
            // 服务端收到双端 hello 后再次发 udp.ready，UDP 自动恢复。
            const sidHash = computeSidHash(sid);
            const ep = udpEndpoints.get(sidHash);
            if (ep) {
                ep.host = null;
                ep.controller = null;
                ep.notified = false;
            }
            const peer = peerOf(session, deviceId);
            relayTo(peer, { op: 'udp.fallback', sid });
            logInfo(`传输切换: UDP->TCP 回退 sid=${sid} from=${deviceId.slice(-8)}（已重置端点，允许重新激活）`);
            break;
        }

        case 'ping': {
            ws.send(JSON.stringify({ op: 'pong' }));
            // 待命设备：心跳时续期固定控制码，确保长期在线期间码持续有效
            if (standbyMap.has(deviceId) && standbyMap.get(deviceId).standby) {
                createControlCode(deviceId).catch(e => logError('待命心跳续期失败', e));
            }
            break;
        }

        default:
            ws.send(JSON.stringify({ op: 'error', payload: { msg: 'unknown_op', op: m.op } }));
    }
}

// ---- 订阅/套餐查询（供 WebSocket 与 REST 共用） ----
function setSubscription(deviceId, plan) {
    subscriptionCache[deviceId] = plan;
    fs.writeFile(SUBSCRIPTION_FILE, JSON.stringify(subscriptionCache, null, 2), (e) => {
        if (e) logError('订阅缓存刷盘失败', e);
    });
}

// ---- 超时强断定时器（服务端驱动，客户端无法伪造） ----
function startTimeoutWatchdog() {
    setInterval(async () => {
        const t = nowMs();
        for (const [sid, session] of sessions) {
            if (session.status === 'terminated') { sessions.delete(sid); continue; }
            const elapsed = t - session.startedAt;
            if (elapsed > session.limitMs) {
                logInfo(`会话超时强断: ${sid}, plan=${session.plan}, elapsed=${elapsed}ms`);
                await forceTerminate(sid, 'timeout');
            }
        }
    }, 30 * 1000);
}

// ---- ICE 配置下发（含 TURN 中继）----
// 跨网络（4G/对称 NAT）直连失败时，WebRTC 必须走 TURN 中继才能建立媒体通道，否则控制端黑屏。
// TURN 凭证通过环境变量配置（避免硬编码到客户端 / 防被盗刷）：
//   TURN_URL        可多个，用 | 分隔，例如 turn:turn.example.com:3478?transport=udp|turns:turn.example.com:5349
//   TURN_USERNAME   长期凭证用户名
//   TURN_CREDENTIAL 长期凭证密码
//   ENCRYPT_KEY     与 APP 后台「加密秘钥」一致；配合 TURN_PRE_ENCRYPTED=false（默认）时，服务端子
//                   端用此密钥把明文 TURN 凭证加密后下发，APP 端用同一秘钥解密。
//   TURN_PRE_ENCRYPTED=true  表示 .env 里的 TURN_URL/USERNAME/CREDENTIAL「已经是」用同一密钥加密后的值，
//                   服务端不再二次加密，直接原样作为 payload 下发（APP 端解密即用）。
//                   适用于：不想在 .env 明文存放 TURN 凭证的场景（推荐个人部署使用此模式）。
//                   未配置 ENCRYPT_KEY 且非 PRE_ENCRYPTED 时：若配了 TURN 则拒绝明文下发凭证（返回空 TURN），
//                   避免长期凭证以明文暴露在 /api/ice-config 接口。
// 加密算法与 APP 端 ApiListManager.encryptUrl/decryptUrl 一致：XOR + Base64（见 crypto-util.js）。
function getIceConfig() {
    // STUN 为公共服务，无需加密，始终下发（用于 P2P 打洞）
    const stun = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ];
    const turnUrl = process.env.TURN_URL;
    if (!turnUrl || !process.env.TURN_USERNAME || !process.env.TURN_CREDENTIAL) {
        logInfo('[ice] 未配置 TURN 环境变量，仅使用公共 STUN（跨网络可能无法直连）');
        return { encrypted: false, stun, turn: [] };
    }
    const key = process.env.ENCRYPT_KEY;
    const preEncrypted = process.env.TURN_PRE_ENCRYPTED === 'true';
    if (!preEncrypted) {
        // ---- 明文模式：服务端用 ENCRYPT_KEY 加密后再下发 ----
        if (!key) {
            logWarn('[ice] 已配置 TURN 但未配置 ENCRYPT_KEY，拒绝明文下发长期凭证，仅返回 STUN');
            return { encrypted: false, stun, turn: [] };
        }
        const turnList = turnUrl.split('|').filter(Boolean).map(raw => ({
            urls: raw.trim(),
            username: process.env.TURN_USERNAME,
            credential: process.env.TURN_CREDENTIAL,
        }));
        const payload = xorBase64(JSON.stringify({ turn: turnList }), key);
        logInfo(`[ice] 已加密(明文模式) TURN 配置下发，共 ${turnList.length} 个（凭证已加密）`);
        return { encrypted: true, payload, stun };
    }
    // ---- 预加密模式（TURN_PRE_ENCRYPTED=true）----
    // 约定：TURN_URL 直接填「用 ENCRYPT_KEY 加密整个 {turn:[{urls,username,credential}]} JSON 后的密文」，
    // 服务端原样作为 payload 下发，APP 端用同一秘钥解密即得 {turn:[...]}。USERNAME/CREDENTIAL 无需填写。
    // 这样 .env 里不出现明文 TURN 凭证（个人部署推荐）。
    try {
        const payload = turnUrl.trim();
        logInfo('[ice] 预加密模式：TURN_URL 直接作为加密 payload 下发（长度=%d）', payload.length);
        return { encrypted: true, payload, stun };
    } catch (e) {
        logError('[ice] 预加密模式处理失败，仅返回 STUN：', e.message);
        return { encrypted: false, stun, turn: [] };
    }
}

module.exports = {
    attach,
    registerVerify,
    setSubscription,
    getPlan,
    getIceConfig,
    startTimeoutWatchdog,
    _internal: { online, sessions, consumeControlCode, lookupControlCode, createControlCode },
};
