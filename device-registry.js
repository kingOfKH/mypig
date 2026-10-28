'use strict';
/**
 * 设备档案（Device Registry）—— 全服务唯一的「设备名」权威存储。
 *
 * 背景：此前存在两套并行的设备名体系，互不通信：
 *   1) 使用记录体系：server.js 直读直写 data/devices/registry.json（HTTP 注册 / 改名）
 *   2) 远程设备体系：remote-assist.js 的内存 deviceInfo（WS dname 上报，进程重启即丢）
 *      + data/remote/trust.json 每条信任边里各自冗余一份 name / deviceName
 * 冗余必然产生不一致（已出现过"改本机名结果把对端全改名"的严重 bug）。
 *
 * 方案 A（不迁移历史文件）：直接把既有的 registry.json 扶正为唯一档案，
 * 两体系的所有读写都收口到本模块；trust.json 里历史遗留的名称字段保持原样不再采信。
 *
 * 兼容性：本模块只新增 updatedAt 字段，不删除/不改语义任何既有字段；
 * 旧版客户端依赖的 HTTP 接口与 WS 字段由调用方继续按原格式返回。
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DEVICES_DIR = path.join(DATA_DIR, 'devices');
const REGISTRY_FILE = path.join(DEVICES_DIR, 'registry.json');

function ensureDirs() {
    [DATA_DIR, DEVICES_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
}

/** 与 server.js getChinaTime() 同格式，避免时间字段风格分裂 */
function getChinaTime() {
    const now = new Date();
    const chinaTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    return chinaTime.toISOString().replace('Z', '+08:00');
}

function readAll() {
    try {
        if (!fs.existsSync(REGISTRY_FILE)) return [];
        const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
        if (!raw || !raw.trim()) return [];
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (e) {
        // 解析失败（如旧版本非原子写残留的半截文件）：先备份留证再按空档处理，
        // 绝不静默丢弃——万一需人工恢复还有原件，同时新写入也已改为原子写。
        console.error('[device-registry] 读取失败:', e && e.message);
        try {
            const bak = `${REGISTRY_FILE}.corrupt.${Date.now()}`;
            fs.copyFileSync(REGISTRY_FILE, bak);
            console.error(`[device-registry] 已备份损坏档案: ${bak}`);
        } catch (_) { /* 备份失败不影响主流程 */ }
        return [];
    }
}

/** 原子写：先写临时文件再 rename，避免写一半进程退出导致档案损坏 */
function writeAll(list) {
    ensureDirs();
    const tmp = REGISTRY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, REGISTRY_FILE);
}

// 进程内互斥锁（与 server.js withFileLock 同思路，单实例部署足够）
const locks = new Map();
async function withLock(key, op) {
    while (locks.has(key)) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    locks.set(key, true);
    try {
        return await op();
    } finally {
        locks.delete(key);
    }
}

/**
 * 名称索引：启动时加载，每次写操作同步刷新。
 * 目的：让 getTrustList() 这类同步读取路径拿到统一名称，且名称持久化、进程重启不丢。
 */
let nameIndex = new Map();
function refreshIndex(list) {
    const m = new Map();
    for (const d of list) {
        if (d && d.deviceId) m.set(d.deviceId, d.deviceName || '');
    }
    nameIndex = m;
}
refreshIndex(readAll());

/** 兜底展示名：与客户端「设备XXXXXX」风格一致 */
function fallbackName(deviceId) {
    return `设备${String(deviceId || '').replace(/^device_/, '').slice(-6)}`;
}

// ==================== 对外 API ====================

/** 同步读取某设备的权威名称（无档案时返回空串，由调用方决定兜底） */
function getName(deviceId) {
    return nameIndex.get(deviceId) || '';
}

/** 同步读取：带兜底的名字（无档案时返回「设备XXXXXX」） */
function getDisplayName(deviceId) {
    return getName(deviceId) || fallbackName(deviceId);
}

/** 读取头像版本（无档案返回 0）；客户端据此判断是否需要重新拉取 */
function getAvatarVersion(deviceId) {
    const dev = readAll().find(d => d.deviceId === deviceId);
    return dev ? (dev.avatarVersion || 0) : 0;
}

/**
 * 上传新头像：版本号 +1 并落盘（同时建档，保证头像与设备档案一致）。
 * 与 setName 同理——"设备自身上报即权威 + 后写覆盖"，最终一定收敛到最新头像。
 */
async function bumpAvatar(deviceId) {
    if (!deviceId) return 0;
    return withLock(REGISTRY_FILE, async () => {
        const list = readAll();
        let dev = list.find(d => d.deviceId === deviceId);
        const ts = getChinaTime();
        if (!dev) {
            dev = { deviceId, deviceName: fallbackName(deviceId), createdAt: ts, updatedAt: ts, lastActiveAt: ts };
            list.push(dev);
        }
        dev.avatarVersion = (dev.avatarVersion || 0) + 1;
        dev.lastActiveAt = ts;
        writeAll(list);
        refreshIndex(list);
        return dev.avatarVersion;
    });
}

/**
 * 注册设备（幂等）。语义与旧接口一致：
 * - 新设备：以传入名称（或兜底名）建档
 * - 已存在：仅刷新 lastActiveAt，**不覆盖已有名称**（避免启动/心跳用本地值把服务端更新的名字改回去）
 */
async function upsertDevice(deviceId, deviceName) {
    if (!deviceId) return { device: null, isNew: false };
    return withLock(REGISTRY_FILE, async () => {
        const list = readAll();
        let dev = list.find(d => d.deviceId === deviceId);
        if (dev) {
            dev.lastActiveAt = getChinaTime();
            writeAll(list);
            refreshIndex(list);
            return { device: dev, isNew: false };
        }
        dev = {
            deviceId,
            deviceName: deviceName || fallbackName(deviceId),
            createdAt: getChinaTime(),
            updatedAt: getChinaTime(),
            lastActiveAt: getChinaTime()
        };
        list.push(dev);
        writeAll(list);
        refreshIndex(list);
        return { device: dev, isNew: true };
    });
}

/**
 * 设置设备名称（权威写入）：HTTP 改名 与 WS 的 dname / device.name 都走这里。
 * 采用「设备自身上报即权威 + 后写覆盖」，最终一定收敛到该设备自己的最新名称。
 */
async function setName(deviceId, deviceName) {
    if (!deviceId || !deviceName) return false;
    const name = String(deviceName).trim();
    if (!name) return false;
    return withLock(REGISTRY_FILE, async () => {
        const list = readAll();
        let dev = list.find(d => d.deviceId === deviceId);
        const ts = getChinaTime();
        if (dev) {
            if (dev.deviceName === name) {
                dev.lastActiveAt = ts;
            } else {
                dev.deviceName = name;
                dev.updatedAt = ts;
                dev.lastActiveAt = ts;
            }
        } else {
            dev = {
                deviceId,
                deviceName: name,
                createdAt: ts,
                updatedAt: ts,
                lastActiveAt: ts
            };
            list.push(dev);
        }
        writeAll(list);
        refreshIndex(list);
        return true;
    });
}

/** 仅刷新活跃时间（上传使用记录等场景） */
async function touch(deviceId) {
    if (!deviceId) return false;
    return withLock(REGISTRY_FILE, async () => {
        const list = readAll();
        const dev = list.find(d => d.deviceId === deviceId);
        if (!dev) return false;
        dev.lastActiveAt = getChinaTime();
        writeAll(list);
        refreshIndex(list);
        return true;
    });
}

/** 列出全部设备档案（/api/devices、管理页使用） */
function listAll() {
    return readAll().map(d => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName || '',
        avatarVersion: d.avatarVersion || 0,
        createdAt: d.createdAt,
        lastActiveAt: d.lastActiveAt
    }));
}

/**
 * 签发/补发设备密钥（幂等）：每台设备稳定持有一个 48 字符十六进制密钥，
 * 用于 WS/API 的强身份校验（remote-assist.js 的 verifyToken 据此比对），杜绝冒充设备。
 * 复用 withLock 保证与 upsertDevice 互斥，避免并发写 registry.json 丢字段。
 */
async function getOrCreateSecret(deviceId) {
    return withLock(REGISTRY_FILE, async () => {
        const list = readAll();
        let dev = list.find(d => d.deviceId === deviceId);
        if (dev && dev.secret) return dev.secret;
        const secret = crypto.randomBytes(24).toString('hex');
        if (dev) {
            dev.secret = secret;
        } else {
            list.push({
                deviceId,
                deviceName: fallbackName(deviceId),
                secret,
                createdAt: getChinaTime(),
                lastActiveAt: getChinaTime()
            });
        }
        writeAll(list);
        refreshIndex(list);
        return secret;
    });
}

/** 同步读设备密钥（verifyToken 热路径用，避免 async）：无则返回 null（老设备向后兼容）。 */
function getDeviceSecretSync(deviceId) {
    const list = readAll();
    const dev = list.find(d => d.deviceId === deviceId);
    return (dev && dev.secret) ? dev.secret : null;
}

module.exports = {
    REGISTRY_FILE,
    getName,
    getDisplayName,
    getAvatarVersion,
    bumpAvatar,
    upsertDevice,
    setName,
    touch,
    listAll,
    fallbackName,
    getChinaTime,
    getOrCreateSecret,
    getDeviceSecretSync,
};
