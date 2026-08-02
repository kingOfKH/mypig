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
const CODE_TTL_MS = 10 * 60 * 1000;            // 控制码有效期 10 分钟
const PLAN_LIMITS = {                           // 各套餐单次最长协助时长
    free: 10 * 60 * 1000,
    pro: 60 * 60 * 1000,
    flag: 120 * 60 * 1000,
};
const HEARTBEAT_TIMEOUT_MS = 70 * 1000;         // 心跳 30s，超时 ~2 次判离线

// 内存态：deviceId -> ws（在线表）；sid -> session 对象（便于定时器访问）
const online = new Map();
const sessions = new Map();

// ---- 工具 ----
function gen6() {
    // 去掉易混淆字符 0/O/1/I/L，使用 6 位大写
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}
function nowMs() { return Date.now(); }

function getPlan(deviceId) {
    const subs = readJson(SUBSCRIPTION_FILE, {});
    return subs[deviceId] || 'free';
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

// ---- 审计 ----
async function audit(sessionId, actor, action, detail) {
    await withFileLock(AUDIT_FILE, async () => {
        const list = readJson(AUDIT_FILE, []);
        list.push({
            sessionId,
            actor,
            action,          // open | connect | cmd | terminate
            detail: detail || null,  // 脱敏摘要，如 click@(540,1200)
            ts: nowMs(),
        });
        // 简单裁剪，避免无限增长
        if (list.length > 20000) list.splice(0, list.length - 20000);
        writeJson(AUDIT_FILE, list);
    });
}

// ---- 控制码 ----
async function createControlCode(hostId) {
    return await withFileLock(CONTROL_CODE_FILE, async () => {
        const list = readJson(CONTROL_CODE_FILE, []);
        // 清理该 host 旧等待中的码（一个 host 同时只挂一个）
        const filtered = list.filter(c => !(c.hostId === hostId && c.status === 'waiting'));
        let code;
        do { code = gen6(); } while (filtered.some(c => c.code === code));
        const rec = {
            code,
            hostId,
            status: 'waiting',
            createdAt: nowMs(),
            expiresAt: nowMs() + CODE_TTL_MS,
        };
        filtered.push(rec);
        writeJson(CONTROL_CODE_FILE, filtered);
        return rec;
    });
}

async function consumeControlCode(code) {
    return await withFileLock(CONTROL_CODE_FILE, async () => {
        const list = readJson(CONTROL_CODE_FILE, []);
        const rec = list.find(c => c.code === code);
        if (!rec) return { ok: false, reason: 'not_found' };
        if (rec.status !== 'waiting') return { ok: false, reason: 'used' };
        if (rec.expiresAt < nowMs()) {
            rec.status = 'expired';
            writeJson(CONTROL_CODE_FILE, list);
            return { ok: false, reason: 'expired' };
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
        const ws = online.get(peer);
        if (ws && ws.readyState === ws.OPEN) {
            try { ws.send(msg); } catch (e) { /* ignore */ }
        }
    });
    sessions.delete(sid);
}

// ---- 转发辅助 ----
function relayTo(deviceId, obj) {
    const ws = online.get(deviceId);
    if (ws && ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    }
    return false;
}

// ---- 认证（复用 server.js 的 deviceId token 思路） ----
// 这里采用轻量方案：WebSocket 连接时通过 query ?token=xxx&deviceId=xxx 传递；
// token 校验交由调用方提供的 verify 函数（server.js 注入），默认放行 demo。
let verifyToken = (deviceId, token) => true;

function registerVerify(fn) { verifyToken = fn; }

// ---- 主入口：在一个已存在的 http.Server 上挂载 WebSocket ----
function attach(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: '/ws/remote' });

    wss.on('connection', (ws, req) => {
        const url = new URL(req.url, 'http://localhost');
        const deviceId = url.searchParams.get('deviceId');
        const token = url.searchParams.get('token');

        if (!deviceId || !verifyToken(deviceId, token)) {
            try { ws.close(4001, 'unauthorized'); } catch (e) {}
            return;
        }

        ws.deviceId = deviceId;
        ws.isAlive = true;
        online.set(deviceId, ws);
        console.log(`[remote] 设备上线: ${deviceId}, 在线数: ${online.size}`);

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', async (raw) => {
            let m;
            try { m = JSON.parse(raw.toString()); } catch (e) {
                return ws.send(JSON.stringify({ op: 'error', payload: { msg: 'invalid_json' } }));
            }
            try {
                await handleMessage(ws, m);
            } catch (e) {
                console.error('[remote] 处理消息异常', e);
                ws.send(JSON.stringify({ op: 'error', payload: { msg: 'internal', detail: String(e && e.message) } }));
            }
        });

        ws.on('close', () => {
            online.delete(deviceId);
            console.log(`[remote] 设备离线: ${deviceId}, 在线数: ${online.size}`);
            // 若该设备参与了 session，通知对端终止
            for (const [sid, session] of sessions) {
                if (session.controller === deviceId || session.host === deviceId) {
                    const peer = peerOf(session, deviceId);
                    forceTerminate(sid, 'peer_offline').then(() => {
                        relayTo(peer, { op: 'terminate', sid, payload: { reason: 'peer_offline' } });
                    });
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
            const rec = await createControlCode(deviceId);
            await audit(rec.code, deviceId, 'open', 'create_code');
            ws.send(JSON.stringify({ op: 'code.created', payload: { code: rec.code, expiresAt: rec.expiresAt } }));
            break;
        }

        case 'code.connect': {
            const code = (m.payload && m.payload.code || '').toUpperCase().trim();
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
            const sidNew = genSessionId();
            const plan = getPlan(deviceId);
            const session = makeSession(sidNew, deviceId, hostId, code, plan);
            sessions.set(sidNew, session);
            await persistSession(session, 'connecting');
            await audit(sidNew, deviceId, 'connect', `code=${code}`);

            // 通知双方开始 WebRTC 协商
            relayTo(hostId, { op: 'code.matched', sid: sidNew, payload: { role: 'host', peer: deviceId, plan } });
            ws.send(JSON.stringify({ op: 'code.matched', sid: sidNew, payload: { role: 'controller', peer: hostId, plan } }));
            break;
        }

        case 'rtc.offer':
        case 'rtc.answer':
        case 'rtc.ice':
        case 'rtc.meta':
        case 'rtc.quality': {
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

        case 'cmd': {
            const session = sessions.get(sid);
            if (!session || session.status === 'terminated') {
                ws.send(JSON.stringify({ op: 'error', sid, payload: { msg: 'no_session' } }));
                break;
            }
            // 仅控制端可下发指令
            if (session.controller !== deviceId) {
                ws.send(JSON.stringify({ op: 'error', sid, payload: { msg: 'not_controller' } }));
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

        case 'ping': {
            ws.send(JSON.stringify({ op: 'pong' }));
            break;
        }

        default:
            ws.send(JSON.stringify({ op: 'error', payload: { msg: 'unknown_op', op: m.op } }));
    }
}

// ---- 订阅/套餐查询（供 WebSocket 与 REST 共用） ----
function setSubscription(deviceId, plan) {
    const subs = readJson(SUBSCRIPTION_FILE, {});
    subs[deviceId] = plan;
    writeJson(SUBSCRIPTION_FILE, subs);
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

module.exports = {
    attach,
    registerVerify,
    setSubscription,
    getPlan,
    startTimeoutWatchdog,
    _internal: { online, sessions, consumeControlCode, createControlCode },
};
