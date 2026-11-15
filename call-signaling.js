/**
 * 1v1 语音通话信令状态机（P0 服务端）
 *
 * 职责：呼叫生命周期（振铃/接听/拒绝/取消/挂断/未接）、接听后计费、
 * 接听后下发双轨 MediaMTX WHIP/WHEP 端点与统一时钟基准 t0、上线补投未接来电。
 *
 * 设计约定：
 *  - 媒体不经本模块，只下发端点；双向音频 = A/B 各一个 WHIP 上行 + 对端 WHEP 下行。
 *  - 入站 op：call.invite / call.ringing / call.accept / call.reject / call.cancel / call.hangup
 *  - 出站 op：call.preparing（主叫预热）/ call.invite（被叫来电+预热）/ call.ringing /
 *             call.active（接听解锁）/ call.ended / call.missed
 *  - 媒体端点在 invite 阶段即生成：双方振铃期后台静音预热，接听只做解除静音（零握手延迟）；
 *    拒绝 / 取消 / 未接均由 call.ended 触发客户端释放 MediaMTX 资源。
 *  - 所有失败与结束统一用 call.ended + reason，客户端只需处理 4 类入站帧。
 *  - peer 一律放在 payload 内（与 remote-assist.js 的 trust.cmd 约定一致）。
 *  - 计费：仅被叫 call.accept 接听时扣主叫 2 积分；管理设备发起的通话全程免费；
 *    call.invite 只做余额预检不扣费；拒绝 / 取消 / 未接 / 超时 / 离线一律不扣费。
 *  - 状态与定时器由服务端驱动，客户端无法伪造时长或逃避扣费。
 */

'use strict';

const CALL_COST = 2;                          // 接听后一次性扣主叫 2 积分（管理设备豁免、不按分钟计费）
const RING_TIMEOUT_MS = 60 * 1000;            // 振铃 60s 无应答 -> 未接
const MAX_CALL_MS = 5 * 3600 * 1000;          // 单通时长上限 5h（服务端强制）
const MISSED_RETENTION_MS = 7 * 24 * 3600 * 1000; // 未接来电上线补投保留 7 天
const MISSED_MAX_PER_DEVICE = 50;

function createCallSignaling(deps) {
    const {
        relayTo,
        relayWithDelivery,
        isTrusted,
        getPoints,
        deduct,
        isAdmin,
        isOnline,
        mtxBaseFor,
        logInfo,
        logWarn,
        // 录音归档钩子（可选）：不注入时信令行为与原来完全一致
        onCallActive,
        onCallEnded,
    } = deps;

    /** callId -> call */
    const calls = new Map();
    /** deviceId -> callId：任一设备同一时刻最多一通通话 */
    const activeByDevice = new Map();
    /** calleeId -> [{ callId, peer, at, reason }]：离线期间的未接来电 */
    const pendingMissed = new Map();

    const now = () => Date.now();
    const log = (msg) => { if (typeof logInfo === 'function') logInfo(`[call] ${msg}`); };
    const warn = (msg) => { if (typeof logWarn === 'function') logWarn(`[call] ${msg}`); };

    function genCallId() {
        return 'call_' + now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
    }

    function send(deviceId, op, payload) {
        return !!relayTo(deviceId, { op, payload });
    }

    function liveCallOf(deviceId) {
        const id = activeByDevice.get(deviceId);
        const c = id ? calls.get(id) : null;
        return c && c.state !== 'ended' ? c : null;
    }

    function clearTimers(c) {
        if (c.ringTimer) { clearTimeout(c.ringTimer); c.ringTimer = null; }
        if (c.maxTimer) { clearTimeout(c.maxTimer); c.maxTimer = null; }
    }

    function queueMissed(callee, caller, callId, reason) {
        const arr = pendingMissed.get(callee) || [];
        arr.push({ callId, peer: caller, at: now(), reason });
        if (arr.length > MISSED_MAX_PER_DEVICE) arr.splice(0, arr.length - MISSED_MAX_PER_DEVICE);
        pendingMissed.set(callee, arr);
    }

    /** 统一的结束出口：广播 call.ended、回收状态与定时器（幂等） */
    function finish(c, reason, extra) {
        if (!c || c.state === 'ended') return;
        clearTimers(c);
        const wasActive = c.state === 'active';
        c.state = 'ended';
        c.endReason = reason;
        c.endedAt = now();
        const durationMs = c.answeredAt ? Math.max(0, c.endedAt - c.answeredAt) : 0;
        // 归档收尾必须先于 call.ended 下发：这样读取令牌能随结束帧一起返回，
        // 客户端把它写进聊天记录，之后任意时刻都能回看文本记录与回听原声。
        let readToken = '';
        if (typeof onCallEnded === 'function') {
            try {
                const ret = onCallEnded({
                    callId: c.callId,
                    caller: c.caller,
                    callee: c.callee,
                    answeredAt: c.answeredAt,
                    endedAt: c.endedAt,
                    durationMs,
                    reason,
                });
                if (ret && typeof ret.read === 'string') readToken = ret.read;
            } catch (e) {
                warn(`录音归档结束处理失败 callId=${c.callId}: ${e.message}`);
            }
        }
        const base = {
            callId: c.callId,
            reason,
            durationMs,
            wasActive,
            missed: reason === 'no_answer' || reason === 'offline',
            ...(readToken ? { read: readToken } : {}),
            ...(extra || {}),
        };
        send(c.caller, 'call.ended', { ...base, peer: c.callee, role: 'caller' });
        send(c.callee, 'call.ended', { ...base, peer: c.caller, role: 'callee' });
        if (activeByDevice.get(c.caller) === c.callId) activeByDevice.delete(c.caller);
        if (activeByDevice.get(c.callee) === c.callId) activeByDevice.delete(c.callee);
        calls.delete(c.callId);
        log(`结束 callId=${c.callId} reason=${reason} duration=${durationMs}ms caller=${c.caller.slice(-8)} callee=${c.callee.slice(-8)}`);
    }

    /** 邀请未通过校验：不建通话、不扣费，直接给发起方一个带 reason 的结束帧 */
    function rejectInvite(caller, callee, callId, reason, extra) {
        send(caller, 'call.ended', {
            callId,
            peer: callee,
            role: 'caller',
            reason,
            durationMs: 0,
            wasActive: false,
            missed: reason === 'offline' || reason === 'busy',
            ...(extra || {}),
        });
        log(`邀请被拒 callId=${callId} reason=${reason} caller=${caller && caller.slice(-8)}`);
    }

    function onInvite(deviceId, p) {
        const caller = deviceId;
        const callee = p.peer;
        const callId = (typeof p.callId === 'string' && p.callId) ? p.callId : genCallId();

        if (!callee || callee === caller) return rejectInvite(caller, callee, callId, 'invalid_peer');
        if (calls.has(callId)) return rejectInvite(caller, callee, callId, 'duplicate');
        if (liveCallOf(caller)) return rejectInvite(caller, callee, callId, 'busy');
        if (liveCallOf(callee)) return rejectInvite(caller, callee, callId, 'busy');
        // 与 trust.cmd 一致做信任校验；呼叫是双方行为，任一方已建立信任即允许。
        if (!isTrusted(caller, callee) && !isTrusted(callee, caller)) {
            return rejectInvite(caller, callee, callId, 'not_trusted');
        }
        // 管理设备身份由服务端 admins.json 判定，快照进会话：
        // 避免 60s 振铃期间升降权导致「发起时免费、接听时扣费」漂移；绝不采信客户端传参。
        const callerIsAdmin = typeof isAdmin === 'function' ? isAdmin(caller) : false;
        if (!callerIsAdmin) {
            // 发起阶段只做余额预检，不扣费：对方没接就不该扣。
            const points = getPoints(caller);
            const balance = points ? Number(points.balance) : 0;
            if (!Number.isFinite(balance) || balance < CALL_COST) {
                return rejectInvite(caller, callee, callId, 'insufficient_points', { balance });
            }
        }

        // 端点在 invite 阶段就生成并下发：双方振铃期即可在后台静音预热，
        // 接听后只需解除静音，无需再等 WHIP/WHEP 握手 + ICE（原来要 1~2s）。
        // 也顺带消除 WHEP 拉「对端尚未 publishing」的 404 竞态。
        const pathA = `call_${callId}_a`;
        const pathB = `call_${callId}_b`;
        const baseCaller = mtxBaseFor(caller);
        const baseCallee = mtxBaseFor(callee);
        const callerMedia = {
            callId, peer: callee, role: 'caller',
            whip: `${baseCaller}/${pathA}/whip`,
            whep: `${baseCaller}/${pathB}/whep`,
        };
        const calleeMedia = {
            callId, peer: caller, role: 'callee',
            whip: `${baseCallee}/${pathB}/whip`,
            whep: `${baseCallee}/${pathA}/whep`,
        };

        const c = {
            callId,
            caller,
            callee,
            state: 'ringing',
            createdAt: now(),
            answeredAt: 0,
            endedAt: 0,
            callerIsAdmin,
            charged: false,
            ringTimer: null,
            maxTimer: null,
            media: { pathA, pathB, callerMedia, calleeMedia },
        };
        calls.set(callId, c);
        activeByDevice.set(caller, callId);
        activeByDevice.set(callee, callId);
        log(`发起 callId=${callId} caller=${caller.slice(-8)} callee=${callee.slice(-8)} 计费=接听后${callerIsAdmin ? '豁免(管理设备)' : '扣' + CALL_COST}`);

        if (!isOnline(callee)) {
            queueMissed(callee, caller, callId, 'offline');
            finish(c, 'offline');
            return;
        }

        // 主叫立即开始后台静音预热（此时被叫还没接听，本地麦克风轨保持 disabled）。
        send(caller, 'call.preparing', c.media.callerMedia);

        const onUndelivered = () => {
            if (c.state !== 'ringing') return;
            // 6s 未收到应用层确认 = 僵尸在线/半开连接，按离线兜底。
            warn(`来电未确认 callId=${callId} callee=${callee.slice(-8)} 按离线处理`);
            queueMissed(callee, caller, callId, 'offline');
            finish(c, 'offline');
        };
        const delivered = relayWithDelivery(
            callee,
            { op: 'call.invite', payload: { ...c.media.calleeMedia, cost: callerIsAdmin ? 0 : CALL_COST } },
            onUndelivered
        );
        if (!delivered) {
            queueMissed(callee, caller, callId, 'offline');
            finish(c, 'offline');
            return;
        }

        c.ringTimer = setTimeout(() => {
            if (c.state !== 'ringing') return;
            queueMissed(callee, caller, callId, 'no_answer');
            finish(c, 'no_answer');
        }, RING_TIMEOUT_MS);
    }

    /** 被叫 UI 已弹出振铃，转告主叫 */
    function onRinging(deviceId, p) {
        const c = calls.get(p.callId);
        if (!c || c.callee !== deviceId || c.state !== 'ringing') return;
        send(c.caller, 'call.ringing', { callId: c.callId, peer: deviceId, state: 'ringing' });
    }

    function onAccept(deviceId, p) {
        const c = calls.get(p.callId);
        if (!c || c.callee !== deviceId || c.state !== 'ringing') return;
        if (c.ringTimer) { clearTimeout(c.ringTimer); c.ringTimer = null; }

        // 只有被叫真正接听才计费；管理设备发起的通话全程免费。
        // invite 已做过预检，这里再校验一次，防止 60s 振铃期间余额被其它消费消耗；
        // 失败时会话已建立，必须用 finish 双端下发，且不进入 active、不启动 maxTimer。
        if (!c.callerIsAdmin) {
            const points = getPoints(c.caller);
            const balance = points ? Number(points.balance) : 0;
            if (!Number.isFinite(balance) || balance < CALL_COST) {
                finish(c, 'insufficient_points', { balance });
                return;
            }
            deduct(c.caller, CALL_COST, 'call.accept');
            c.charged = true;
        }

        c.state = 'active';
        c.answeredAt = now();

        // 录音上传令牌在该时刻下发：只有真正接听后才可能产生归档
        let rec = null;
        if (typeof onCallActive === 'function') {
            try {
                rec = onCallActive({
                    callId: c.callId,
                    caller: c.caller,
                    callee: c.callee,
                    t0: c.answeredAt,
                    maxDurationMs: MAX_CALL_MS,
                });
            } catch (e) {
                warn(`录音归档初始化失败 callId=${c.callId}: ${e.message}`);
            }
        }

        // 端点已在 invite 阶段下发、双方振铃期已完成静音预热；
        // 这里只做「接听解锁」，客户端收到后解除静音即可通话，不再重新握手。
        const common = {
            callId: c.callId,
            t0: c.answeredAt,             // 统一时钟基准（客户端录制对齐用）
            maxDurationMs: MAX_CALL_MS,
            ...(rec ? { rec } : {}),
        };
        send(c.caller, 'call.active', { ...common, ...c.media.callerMedia });
        send(c.callee, 'call.active', { ...common, ...c.media.calleeMedia });
        c.maxTimer = setTimeout(() => finish(c, 'max_duration'), MAX_CALL_MS);
        log(`接听 callId=${c.callId} t0=${c.answeredAt} 扣费=${c.charged ? '-' + CALL_COST : '0(管理设备豁免)'} 双轨=${c.media.pathA}/${c.media.pathB} 预热已就绪，直接解锁`);
    }

    function onReject(deviceId, p) {
        const c = calls.get(p.callId);
        if (!c || c.callee !== deviceId || c.state !== 'ringing') return;
        finish(c, 'rejected');
    }

    function onCancel(deviceId, p) {
        const c = calls.get(p.callId);
        if (!c || c.caller !== deviceId || c.state !== 'ringing') return;
        finish(c, 'cancelled');
    }

    function onHangup(deviceId, p) {
        const c = calls.get(p.callId);
        if (!c || c.state !== 'active') return;
        if (c.caller !== deviceId && c.callee !== deviceId) return;
        finish(c, 'hangup', { by: deviceId });
    }

    /** 设备上线：补投离线期间的未接来电（不引入厂商推送） */
    function onDeviceOnline(deviceId) {
        const arr = pendingMissed.get(deviceId);
        if (!arr || arr.length === 0) return;
        pendingMissed.delete(deviceId);
        const fresh = arr.filter(x => now() - x.at < MISSED_RETENTION_MS);
        for (const item of fresh) {
            send(deviceId, 'call.missed', {
                callId: item.callId,
                peer: item.peer,
                at: item.at,
                reason: item.reason,
            });
        }
        log(`上线补投未接来电 device=${deviceId.slice(-8)} 共 ${fresh.length} 条`);
    }

    /** 设备真正离线（所有 ws 都已关闭）：结束其参与的通话 */
    function onDeviceOffline(deviceId) {
        const c = liveCallOf(deviceId);
        if (!c) return;
        if (c.state === 'active') {
            finish(c, 'peer_disconnected');
        } else if (c.state === 'ringing') {
            if (deviceId === c.callee) {
                queueMissed(c.callee, c.caller, c.callId, 'offline');
                finish(c, 'offline');
            } else {
                finish(c, 'cancelled');
            }
        }
    }

    function handle(ws, m) {
        const p = m.payload || {};
        switch (m.op) {
            case 'call.invite':  return onInvite(ws.deviceId, p);
            case 'call.ringing': return onRinging(ws.deviceId, p);
            case 'call.accept':  return onAccept(ws.deviceId, p);
            case 'call.reject':  return onReject(ws.deviceId, p);
            case 'call.cancel':  return onCancel(ws.deviceId, p);
            case 'call.hangup':  return onHangup(ws.deviceId, p);
            default: return false;
        }
    }

    function stats() {
        let ringing = 0;
        let active = 0;
        for (const c of calls.values()) {
            if (c.state === 'ringing') ringing++;
            else if (c.state === 'active') active++;
        }
        let pendingMissedCount = 0;
        for (const arr of pendingMissed.values()) pendingMissedCount += arr.length;
        return { ringing, active, pendingMissed: pendingMissedCount, cost: CALL_COST, chargeOn: 'accept' };
    }

    return { handle, onDeviceOnline, onDeviceOffline, stats };
}

module.exports = { createCallSignaling };
