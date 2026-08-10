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
        console.error('[remote] 读取失败', file, e);
        return def;
    }
}
function writeJson(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        console.error('[remote] 写入失败', file, e);
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
async function establishSession(controller, host, code, tag) {
    const sidNew = genSessionId();
    const plan = getPlan(controller);
    const session = makeSession(sidNew, controller, host, code, plan);
    sessions.set(sidNew, session);
    await persistSession(session, 'connecting');
    await audit(sidNew, controller, 'connect', `code=${code} via=${tag}`);
    if (udpAvailable) {
        udpEndpoints.set(computeSidHash(sidNew), { sid: sidNew, host: null, controller: null, notified: false });
    }
    const udpInfo = udpAvailable ? { udpPort: udpPort } : {};
    relayTo(host, { op: 'code.matched', sid: sidNew, payload: { role: 'host', peer: controller, plan, ...udpInfo } });
    relayTo(controller, { op: 'code.matched', sid: sidNew, payload: { role: 'controller', peer: host, plan, ...udpInfo } });
    console.log(`[remote] 会话建立(${tag}) sid=${sidNew} 传输=${udpAvailable ? 'UDP' : 'TCP'} plan=${plan}`);
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

// ---- 订阅缓存（避免每次 code.connect 都同步读文件阻塞事件循环）----
let subscriptionCache = null;
function loadSubscriptionCache() {
    try {
        if (fs.existsSync(SUBSCRIPTION_FILE)) {
            const c = fs.readFileSync(SUBSCRIPTION_FILE, 'utf8');
            if (c && c.trim()) subscriptionCache = JSON.parse(c);
        }
    } catch (e) {
        console.error('[remote] 订阅缓存加载失败', e);
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
function makeSession(sid, controller, host, code, plan) {
    return {
        sessionId: sid,
        controller,          // deviceId（控制端）
        host,                // deviceId（被控端）
        code,
        plan,
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
    console.error('[remote] 审计日志流创建失败', e);
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
        console.log(`[remote] 登记固定控制码 code=${code} host=${hostId}`);
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
    if (list.length) console.log(`[remote] 已恢复 ${list.length} 个固定控制码`);
    if (dropped > 0) console.log(`[remote] 已清理 ${dropped} 条失效/重复的旧控制码记录`);
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
        console.warn('[remote] notifyTrustPeers 失败:', e && e.message);
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

// 调试日志开关：默认关闭，避免每帧 BINARY 日志狂刷拖垮服务器。
// 设置环境变量 REMOTE_DEBUG=1 可重新开启（仅排查问题时临时开启）。
const REMOTE_DEBUG = process.env.REMOTE_DEBUG === '1';

// 判断 NALU 流首帧是否为关键帧（IDR=5 / SPS=7 / PPS=8）。
// 客户端统一 type=1 承载所有视频帧，故不能再用 type 区分关键帧，
// 必须从 NALU 数据本身解析第一个 NALU 的单元类型（低5位）。
// 起始码为 00 00 00 01 或 00 00 01。
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
    // 视频流只发送给对端第一个可用的连接（同一设备多连接时避免重复推流）
    let peerWs = null;
    for (const w of set) { if (w && w.readyState === w.OPEN) { peerWs = w; break; } }
    if (peerWs) {
        // 背压丢帧：缓冲区积压时，仅丢弃非关键帧(P帧)，保留关键帧(IDR/SPS/PPS)，
        // 否则对端解码器失去参考帧会花屏/卡死。原画大帧易触发，故阈值调低至 256KB。
        try {
            if (peerWs.bufferedAmount > RELAY_BACKPRESSURE_BYTES && type === 1) {
                // type 固定为 1，需解析 NALU 判断是否为关键帧
                const nalu = buf.subarray(5 + sidLen);
                if (!isKeyFrameBuffer(nalu)) {
                    session.droppedFrames = (session.droppedFrames || 0) + 1;
                    return;
                }
            }
            peerWs.send(buf);
        } catch (e) { /* 忽略单次发送失败 */ }
    }
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
            console.log('[remote] UDP 绑定全部失败，视频走 TCP（WebSocket）');
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
                            console.log(`[remote] 传输切换: UDP 就绪 sid=${ep.sid} host=${ep.host.addr}:${ep.host.port} ctrl=${ep.controller.addr}:${ep.controller.port}`);
                        }
                    }
                }
                return;
            }

            // 视频包：转发给对端（按发送者地址判断角色）
            const fromHost = ep.host && ep.host.addr === rinfo.address && ep.host.port === rinfo.port;
            const peer = fromHost ? ep.controller : ep.host;
            if (peer) {
                try { sock.send(msg, peer.port, peer.addr); } catch (e) { /* ignore */ }
            }
        });
        sock.on('error', (e) => {
            // 绑定阶段错误：尝试下一个端口；运行期错误：回退 TCP
            if (!udpAvailable) {
                console.warn(`[remote] UDP 绑定端口 ${port} 失败: ${e.message}，尝试下一个`);
                try { sock.close(); } catch (_) {}
                tryBind();
            } else {
                console.warn(`[remote] UDP 运行错误，回退 TCP: ${e.message}`);
                udpAvailable = false;
            }
        });
        sock.bind(port, () => {
            udpServer = sock;
            udpPort = sock.address().port;
            udpAvailable = true;
            console.log(`[remote] UDP 中继已启动 端口=${udpPort}${port === 0 ? '(随机)' : ''}`);
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
            try { initUdpRelay(httpPort); } catch (e) { console.warn(`[remote] UDP 自动启用失败: ${e.message}`); }
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
            console.warn(`[remote] 连接被拒 unauthorized deviceId=${deviceId} token=${token ? '***' : '(空)'}`);
            try { ws.close(4001, 'unauthorized'); } catch (e) {}
            return;
        }
        // 记录系统设备名称（设置→关于手机→设备名称，如「荣耀60SE」「妈妈的手机」），
        // 供信任列表默认展示（无需备注即可区分不同设备）
        if (dname) deviceInfo.set(deviceId, { deviceName: dname });
        console.log(`[remote] 新 WebSocket 连接建立 deviceId=${deviceId}${dname ? ' deviceName=' + dname : ''}（此时在线 ${online.size} 台）`);

        ws.deviceId = deviceId;
        ws.isAlive = true;
        // 同一设备可有多个连接（常驻信令 + 远控页），全部计入在线集合
        if (!online.has(deviceId)) online.set(deviceId, new Set());
        online.get(deviceId).add(ws);
        // 若此前处于待命（授权录屏常驻等待），重新上线后恢复待命状态并续期控制码
        if (standbyMap.has(deviceId)) {
            const st = standbyMap.get(deviceId);
            st.ws = ws;
            createControlCode(deviceId).catch(e => console.error('[remote] 待命续期失败', e));
        }
        console.log(`[remote] 设备上线: ${deviceId}, 在线数: ${online.size}`);
        // 通知信任对端：该设备已上线，控制端列表实时点亮
        notifyTrustPeers(deviceId);

        // 设备重连恢复：若该设备参与的活动会话有宽限定时器，取消它，会话无缝继续
        for (const [sid, session] of sessions) {
            if (session.status === 'terminated') continue;
            if ((session.controller === deviceId || session.host === deviceId) && pendingDisconnects.has(sid)) {
                clearTimeout(pendingDisconnects.get(sid));
                pendingDisconnects.delete(sid);
                console.log(`[remote] 设备 ${deviceId} 重连，恢复会话 ${sid}`);
            }
        }

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', async (raw) => {
            const isBuf = Buffer.isBuffer(raw);
            // 调试：仅当 REMOTE_DEBUG=1 时打印每帧原始消息（平时关闭，避免日志狂刷拖垮服务器）
            if (REMOTE_DEBUG) {
                const t = isBuf ? `BINARY(${raw.length}B)` : `TEXT(${String(raw).length}ch)`;
                console.log(`[remote][raw] deviceId=${deviceId} type=${t} head=${isBuf ? raw.slice(0, 12).toString('hex') : String(raw).slice(0, 80)}`);
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
                console.log(`[remote] 收到消息(二进制承载的JSON) deviceId=${deviceId} op=${m && m.op} sid=${m && m.sid || ''}`);
                try {
                    await handleMessage(ws, m);
                } catch (e) {
                    console.error('[remote] 处理消息异常', e);
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
            console.log(`[remote] 收到消息 deviceId=${deviceId} op=${m && m.op} sid=${m && m.sid || ''}`);
            try {
                await handleMessage(ws, m);
            } catch (e) {
                console.error('[remote] 处理消息异常', e);
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
            console.log(`[remote] 连接关闭 deviceId=${deviceId}, 该设备剩余在线连接: ${online.has(deviceId) ? online.get(deviceId).size : 0}, 总在线设备数: ${online.size}`);
            // 设备已通过其它连接（如常驻信令）保持在线：无需通知离线
            if (online.has(deviceId)) return;
            // 通知信任对端：该设备已离线，控制端列表实时置灰
            notifyTrustPeers(deviceId);
            // 若该设备参与了活动 session，启动宽限定时器（而非立即终止）
            for (const [sid, session] of sessions) {
                if (session.status === 'terminated') continue;
                if (session.controller === deviceId || session.host === deviceId) {
                    if (pendingDisconnects.has(sid)) continue; // 已有宽限定时器
                    console.log(`[remote] 设备 ${deviceId} 断线，会话 ${sid} 进入 ${RECONNECT_GRACE_MS / 1000}s 宽限期`);
                    const timer = setTimeout(() => {
                        pendingDisconnects.delete(sid);
                        const s = sessions.get(sid);
                        if (!s || s.status === 'terminated') return;
                        const peer = peerOf(s, deviceId);
                        console.log(`[remote] 设备 ${deviceId} 宽限期超时未重连，终止会话 ${sid}`);
                        forceTerminate(sid, 'peer_offline').then(() => {
                            relayTo(peer, { op: 'terminate', sid, payload: { reason: 'peer_offline' } });
                        });
                    }, RECONNECT_GRACE_MS);
                    pendingDisconnects.set(sid, timer);
                }
            }
        });

        ws.on('error', (e) => { console.error('[remote] ws error', deviceId, e.message); });
    });

    // 心跳检测
    const heartbeat = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                try { ws.terminate(); } catch (e) {}
                return;
            }
            ws.isAlive = false;
            try { ws.ping(); } catch (e) {}
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
            console.log(`[remote] >>> code.create 来自 deviceId=${deviceId}，开始生成控制码`);
            const rec = await createControlCode(deviceId);
            await audit(rec.code, deviceId, 'open', 'create_code');
            const resp = JSON.stringify({ op: 'code.created', payload: { code: rec.code, expiresAt: rec.expiresAt } });
            console.log(`[remote] <<< 回包 code.created code=${rec.code} -> ${resp}`);
            ws.send(resp);
            break;
        }

        case 'code.connect': {
            const code = (m.payload && m.payload.code || '').trim();
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
                establishSession(deviceId, hostId, code, 'trust');
                break;
            }
            // 非信任设备：向被控端推送"连接请求确认"弹窗，由被控端决定是否允许
            pendingConfirms.set(code + ':' + deviceId, { controller: deviceId, host: hostId, code });
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
            console.log(`[remote] 连接请求待确认 controller=${deviceId} -> host=${hostId} code=${code}`);
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
            establishSession(controller, deviceId, code, 'confirm');
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
            console.log(`[remote] 连接请求被拒绝 host=${deviceId} -> controller=${controller}`);
            break;
        }

        // 被控端授权录屏后进入"待命"：保持在线并等待控制端连接（无需每次进页面点开始）
        case 'standby': {
            const on = !!(m.payload && m.payload.on);
            if (on) {
                standbyMap.set(deviceId, { standby: true, ws, code: genFixedCode(deviceId), since: nowMs() });
                const rec = await createControlCode(deviceId);
                relayTo(deviceId, { op: 'standby.ok', payload: { code: rec.code } });
                console.log(`[remote] 设备进入待命 deviceId=${deviceId} code=${rec.code}`);
            } else {
                standbyMap.delete(deviceId);
                console.log(`[remote] 设备退出待命 deviceId=${deviceId}`);
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
            console.log(`[remote] 信任绑定请求 from=${deviceId} -> to=${peerId} code=${code}`);
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
            console.log(`[remote] 信任绑定确认 from=${pend.from} <-> to=${pend.to}`);
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
            establishSession(deviceId, peerId, code, 'trust');
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
            console.log(`[remote] 移除信任 deviceId=${deviceId} peer=${peerId}`);
            break;
        }

        case 'rtc.offer':
        case 'rtc.answer':
        case 'rtc.ice':
        case 'rtc.meta':
        case 'rtc.quality':
        case 'rtc.connected':
        case 'rtc.encres':
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
            console.log(`[remote] keyframe.request controller=${deviceId} -> host=${session.host} sid=${sid}`);
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
            const peer = peerOf(session, deviceId);
            relayTo(peer, { op: 'udp.fallback', sid });
            console.log(`[remote] 传输切换: UDP->TCP 回退 sid=${sid} from=${deviceId}`);
            break;
        }

        case 'ping': {
            ws.send(JSON.stringify({ op: 'pong' }));
            // 待命设备：心跳时续期固定控制码，确保长期在线期间码持续有效
            if (standbyMap.has(deviceId) && standbyMap.get(deviceId).standby) {
                createControlCode(deviceId).catch(e => console.error('[remote] 待命心跳续期失败', e));
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
        if (e) console.error('[remote] 订阅缓存刷盘失败', e);
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
                console.log(`[remote] 会话超时强断: ${sid}, plan=${session.plan}, elapsed=${elapsed}ms`);
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
function getIceConfig() {
    const servers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ];
    const turnUrl = process.env.TURN_URL;
    if (turnUrl && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
        for (const raw of turnUrl.split('|')) {
            const u = raw.trim();
            if (!u) continue;
            servers.push({
                urls: u,
                username: process.env.TURN_USERNAME,
                credential: process.env.TURN_CREDENTIAL,
            });
        }
        console.log(`[ice] 已加载 TURN 配置，共 ${turnUrl.split('|').filter(Boolean).length} 个 TURN 服务器`);
    } else {
        console.log('[ice] 未配置 TURN 环境变量，仅使用公共 STUN（跨网络可能无法直连）');
    }
    return { iceServers: servers };
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
