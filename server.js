require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const AdmZip = require('adm-zip');
// 头像压缩：纯 JS 实现，零原生编译，跨平台必装得上（已锁定 0.22.x 稳定 API）
const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const remoteAssist = require('./remote-assist');
// 超级表情静态缩略图渲染（rlottie wasm，与 APP 同引擎，可渲染 lottie-web 渲染为空白的 v5.12.x 文件）
const { renderLottieThumb } = require('./lottieThumb.cjs');
// 统一设备档案：全服务唯一的设备名权威存储（HTTP 体系与 WS 体系共用）
const deviceRegistry = require('./device-registry');

// 全局兜底：任何未捕获异常/未处理的 Promise rejection 都不应直接杀死进程。
// （历史崩溃：audit.log 的 WriteStream 在 fd 失效时抛出未捕获 'error' 事件导致 EBADF 进程退出）
// 此处记录后不退出，配合 pm2/nodemon 等进程管理器自动重启策略。
process.on('uncaughtException', (e) => {
    console.error('[uncaughtException]', e.code, e.message, '\n', e.stack);
});
process.on('unhandledRejection', (r) => {
    console.error('[unhandledRejection]', r);
});

const app = express();
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// ===================== 后台页面登录保护 =====================
// 目标：/admin、/publish、/versions 三个后台 HTML 页面以及 /public/* 静态资源必须登录后访问。
// 边界（重要）：APP 使用的 /api/*（除管理接口）、/ws/remote、/snapshots/*、/clipboards/*
// 必须保持开放，否则 Android 客户端无法工作。
// 实现：不引入 session 依赖，使用「签名 Cookie（无状态）」。
//   Cookie 内直接携带 {u:用户名, exp:过期时间戳} 并用 HMAC-SHA256 签名，服务端不保存会话。
//   因此【重启服务后已登录用户无需重新登录】（只要未超过有效期）。
//   签名密钥持久化在 data/.session-secret（首次运行自动生成、重启不变）；也可用环境变量
//   SESSION_SECRET 覆盖。注意：若更换签名密钥，所有已登录 Cookie 会立即失效（需重新登录）。
const crypto = require('crypto');
const PAGE_AUTH_USER = process.env.PAGE_AUTH_USER || 'admin';
const PAGE_AUTH_PASS = process.env.PAGE_AUTH_PASS || '111111';
const PAGE_AUTH_COOKIE = 'sc_sid';
const PAGE_AUTH_TTL_MS = 12 * 60 * 60 * 1000; // 登录有效期 12 小时

// 稳定的签名密钥：优先环境变量 SESSION_SECRET；否则使用 data/.session-secret 文件（首次运行自动生成并持久化）。
const SESSION_SECRET_FILE = path.join(__dirname, 'data', '.session-secret');
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return String(process.env.SESSION_SECRET);
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      const s = fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
      if (s) return s;
    }
  } catch (e) { /* 忽略，走下方生成 */ }
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    if (!fs.existsSync(path.dirname(SESSION_SECRET_FILE))) {
      fs.mkdirSync(path.dirname(SESSION_SECRET_FILE), { recursive: true });
    }
    fs.writeFileSync(SESSION_SECRET_FILE, generated, { mode: 0o600 });
  } catch (e) {
    console.error('[session] 无法持久化签名密钥，重启后已登录用户需重新登录：', e.message);
  }
  return generated;
}
const SESSION_SECRET = loadSessionSecret();

function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// 签发登录 Cookie 值：payload.signature（均为 base64url）
function signSession(payloadObj) {
  const payload = base64urlEncode(Buffer.from(JSON.stringify(payloadObj), 'utf8'));
  const sig = base64urlEncode(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}
// 校验签名并返回 {u, exp}，失败（篡改/过期/格式错）返回 null
function verifySession(cookieValue) {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const dot = cookieValue.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expected = base64urlEncode(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
  // 定长比较，防时序侧信道
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const obj = JSON.parse(base64urlDecode(payload).toString('utf8'));
    if (!obj || typeof obj.u !== 'string' || typeof obj.exp !== 'number') return null;
    if (Date.now() > obj.exp) return null; // 已过期
    return obj;
  } catch (e) { return null; }
}

function parseCookieHeader(header) {
    const out = {};
    if (!header) return out;
    header.split(';').forEach((part) => {
        const idx = part.indexOf('=');
        if (idx < 0) return;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) { try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; } }
    });
    return out;
}

// 返回已登录用户名，未登录返回 null
function pageAuthUser(req) {
    const cookie = parseCookieHeader(req.headers.cookie)[PAGE_AUTH_COOKIE];
    const s = verifySession(cookie);
    return s ? s.u : null;
}
function isPageAuthed(req) { return !!pageAuthUser(req); }

/** 页面用：未登录跳转登录页（携带回跳地址） */
function requirePageAuth(req, res, next) {
    if (isPageAuthed(req)) return next();
    const redirect = encodeURIComponent(req.originalUrl || '/admin');
    return res.redirect(`/login?redirect=${redirect}`);
}

/** 接口用：未登录返回 401 JSON（避免页面 fetch 被重定向成 HTML 导致解析失败） */
function requirePageAuthJson(req, res, next) {
    if (isPageAuthed(req)) return next();
    return res.status(401).json({ success: false, error: '未登录或登录已过期' });
}

// 登录页
app.get('/login', (req, res) => {
    if (isPageAuthed(req)) return res.redirect('/admin');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// 登录提交
app.post('/api/page-login', (req, res) => {
    const { username, password } = req.body || {};
    if (username !== PAGE_AUTH_USER || String(password) !== String(PAGE_AUTH_PASS)) {
        return res.json({ success: false, message: '用户名或密码错误' });
    }
    const token = signSession({ u: username, exp: Date.now() + PAGE_AUTH_TTL_MS });
    res.setHeader('Set-Cookie',
        `${PAGE_AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(PAGE_AUTH_TTL_MS / 1000)}`);
    res.json({ success: true });
});

// 退出登录
app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${PAGE_AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return res.redirect('/login');
});

// 健康检查端点（供 App "测试连接" 功能使用）
app.get('/api/health', (req, res) => {
    res.json({ ok: true, ts: Date.now() });
});

const DATA_DIR = path.join(__dirname, 'data');
const DEVICES_DIR = path.join(DATA_DIR, 'devices');
const USAGE_DIR = path.join(DATA_DIR, 'usage');
const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots');
const CLIPBOARD_DIR = path.join(DATA_DIR, 'clipboards');
// 已发布 APK 与版本元数据存放目录（APP 自动更新功能）
const UPDATES_DIR = path.join(__dirname, 'updates');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const LATEST_JSON = path.join(UPDATES_DIR, 'latest.json');

function ensureDirectories() {
    [DATA_DIR, DEVICES_DIR, USAGE_DIR, SNAPSHOT_DIR, CLIPBOARD_DIR, UPDATES_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}
ensureDirectories();

function safeReadJSON(filePath, defaultValue = null) {
    try {
        if (!fs.existsSync(filePath)) {
            console.log(`文件不存在: ${filePath}, 返回默认值`);
            return defaultValue;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        if (!content || !content.trim()) {
            console.log(`文件为空: ${filePath}, 返回默认值`);
            return defaultValue;
        }
        const data = JSON.parse(content);
        console.log(`成功读取文件: ${filePath}, 数据: ${JSON.stringify(data).substring(0, 100)}`);
        return data;
    } catch (e) {
        console.error(`读取JSON文件失败 ${filePath}:`, e);
        return defaultValue;
    }
}

function safeWriteJSON(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`创建目录: ${dir}`);
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`成功写入文件: ${filePath}, 数据: ${JSON.stringify(data).substring(0, 100)}`);
        return true;
    } catch (e) {
        console.error(`写入JSON文件失败 ${filePath}:`, e);
        return false;
    }
}
/**
 * 解析 APK 安装包内的二进制 AndroidManifest.xml，提取 versionName / versionCode。
 * 纯 Node 实现，不依赖 Android SDK / aapt。
 *
 * APK 是 ZIP：AndroidManifest.xml 为 Android 二进制 XML 格式。
 * - 文件由若干 chunk 组成，chunk 头：type(u16 LE) + headerSize(u16 LE) + size(u32 LE)。
 * - 根元素 RES_XML_START_ELEMENT = 0x0102，其 name 以框架资源 ID 0x01010000 表示 <manifest>。
 * - 元素属性区：每个属性 20 字节 = namespace(4)+nameResId(4)+rawValue(4)+typedValue(8)；
 *   typedValue = size(2)+res0(1)+type(1)+data(4)。
 * - android:versionCode 资源 ID = 0x0101021b（属性值类型 TYPE_INT（0x10）或 TYPE_FIRSTINT（0x08），data 即整数）。
 * - android:versionName 资源 ID = 0x0101021c（TYPE_STRING（0x03），data 是字符串池索引）。
 * - 字符串池 RES_STRING_POOL = 0x0001，含 UTF-8 / UTF-16 字符串数组；可能整体被 deflate 压缩（flag 位 1<<15）。
 *
 * 返回 { versionName, versionCode }；解析失败返回空串（由调用方回退手填值）。
 */
/**
 * 解析 APK 安装包内的二进制 AndroidManifest.xml，提取 versionName / versionCode。
 * 纯 Node 实现，不依赖 Android SDK / aapt。
 *
 * 布局要点（经验证）：
 * - APK 是 ZIP。用 findZipEntry 在 EOCD 中定位 AndroidManifest.xml 本地数据。
 * - 二进制 XML 由 chunk 组成：chunk 头 = type(u16)+headerSize(u16)+size(u32)。
 * - StringPool(0x0001)：字符串用「偏移表 + UTF-16」布局。
 *     - 偏移表紧跟 header 之后，u32[count]，每项 = 相对字符串数据区的字节偏移；
 *     - 字符串数据区起点 = chunkOff + stringsStart；
 *     - 每条字符串 = u16 字符数 + 字符数*2 的 UTF-16LE 字节。
 * - StartElement(0x0102)：ns(4)@16 + name(4)@20 + attrStart(2)@24 + attrSize(2)@26 + attrCount(2)@28 … 属性区
 *     - 属性记录 20 字节 = ns(4)+name(4)@4+rawValue(4)@12+typedValue(8)@16（size2+res0+type1@14+data4@16）
 * - android:versionCode 框架 ID = 0x0101021b，android:versionName = 0x0101021c（标准 APK 走此路径）。
 * - 部分 aapt2 产物属性名编码异常（非标准），故加启发式兜底：从根 <manifest> 属性值里挑
 *   纯整数(→versionCode) / 带点版本串(→versionName)。
 *
 * 返回 { versionName, versionCode }；解析失败返回空串（由调用方回退手填值）。
 */
function parseApkVersion(apkBuffer) {
    try {
        // 用 adm-zip 解 APK（标准 ZIP 解析，处理 extra/comment/ZIP64 等边界），取出二进制 AndroidManifest.xml
        const zip = new AdmZip(apkBuffer);
        const entry = zip.getEntry('AndroidManifest.xml');
        if (!entry) return { versionName: '', versionCode: '' };
        const manifest = entry.getData();

        const dv = new DataView(manifest.buffer, manifest.byteOffset, manifest.byteLength);
        const u16 = (o) => dv.getUint16(o, true);
        const u32 = (o) => dv.getUint32(o, true);
        const u8 = (o) => dv.getUint8(o);

        const stringPools = [];
        let off = 8;
        while (off + 8 <= manifest.length) {
            const type = u16(off);
            const size = u32(off + 4);
            if (size < 8 || off + size > manifest.length) break;
            if (type === 0x0001) stringPools.push(parseStringPool(manifest, off, size));
            off += size;
        }
        const pool = stringPools[0] || [];
        const getStr = (idx) => (idx >= 0 && idx < pool.length) ? pool[idx] : '';

        off = 8;
        while (off + 8 <= manifest.length) {
            const type = u16(off);
            const size = u32(off + 4);
            if (size < 8 || off + size > manifest.length) break;
            if (type === 0x0102) {
                const name = u32(off + 20);
                const elemName = (name < pool.length) ? pool[name] : '';
                if (elemName === 'manifest') {
                    const attrStart = u16(off + 24);
                    const attrSize = u16(off + 26);
                    const attrCount = u16(off + 28);
                    // 属性数组起点：元素头 = ResChunk_header(8) + lineNumber/comment(8) = 16，再加 attributeStart
                    const attrBase = off + 16 + attrStart;
                    let versionCode = '', versionName = '';
                    // aapt2 编译后 versionCode/versionName 的资源 ID 高 16 位会被置 0，裸 ID 不稳定
                    // （debug 包里 versionCode=0x1b，release 包里却变成 0x1a；裸 0x1b 在两包中含义相反），
                    // 因此不能单纯依赖低字节匹配。策略：完整 ID 直接命中；否则对裸 ID 用「值语义」消歧
                    // —— versionName 必为点分版本串（如 1.0.2），versionCode 必为纯整数。
                    const isDotVersion = (s) => typeof s === 'string' && /^\d+\.\d+/.test(s.trim());
                    const isPlainInt = (s) => typeof s === 'string' && /^\d+$/.test(s.trim());
                    let codeCand = null, nameCand = null;
                    for (let i = 0; i < attrCount; i++) {
                        const aOff = attrBase + i * attrSize;
                        const aName = u32(aOff + 4);    // 完整属性 ID（32 位）
                        const aType = u8(aOff + 15);    // typedValue.type（1 字节）
                        const aData = u32(aOff + 16);    // typedValue.data
                        // 取出属性值（TYPE_STRING=0x03 时去字符串池，否则当作整数）
                        const val = (aType === 0x03) ? getStr(aData)
                                    : String(aData >>> 0);
                        if (aName === 0x0101021b) {        // 标准 android:versionCode
                            codeCand = val;
                        } else if (aName === 0x0101021c) { // 标准 android:versionName
                            nameCand = val;
                        } else if (aName === 0x0000001a || aName === 0x0000001b || aName === 0x0000001c) {
                            // aapt2 裸 ID：用值语义消歧（裸 0x1b 在 debug=code、release=name，必须靠值判断）
                            if (isDotVersion(val)) {
                                nameCand = nameCand || val;
                            } else if (isPlainInt(val)) {
                                codeCand = codeCand || val;
                            }
                        }
                    }
                    versionCode = codeCand || '';
                    versionName = nameCand || '';
                    return { versionCode, versionName };
                }
            }
            off += size;
        }
        return { versionName: '', versionCode: '' };
    } catch (e) {
        console.error('[parseApkVersion] 解析失败:', e.message);
        return { versionName: '', versionCode: '' };
    }
}

/**
 * 解析 StringPool chunk（偏移表 + UTF-16 布局；支持 UTF-8 flag 与 deflate 压缩 flag）。
 */
function parseStringPool(buf, chunkOff, chunkSize) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const u16 = (o) => dv.getUint16(o, true);
    const u32 = (o) => dv.getUint32(o, true);
    const headerSize = u16(chunkOff + 2);
    const stringCount = u32(chunkOff + 8);
    const flags = u32(chunkOff + 16);
    const stringsStart = u32(chunkOff + 20);
    const isUtf8 = (flags & (1 << 8)) !== 0;
    const ds = chunkOff + stringsStart;                 // 字符串数据区绝对起点
    const offsetTableStart = chunkOff + headerSize;      // 偏移表（u32[count]）起点
    const strings = [];
    for (let i = 0; i < stringCount; i++) {
        const strAbs = ds + u32(offsetTableStart + i * 4); // 字符串 i 绝对位置
        if (isUtf8) {
            // aapt2 UTF-8 字符串格式：[utf16Len(u16 或 uleb128)][utf8Len(uleb128)][utf8 字节]
            let pos = strAbs;
            let b0 = buf[pos];
            let utf16Len;
            if ((b0 & 0x80) === 0) { utf16Len = b0; pos += 1; }
            else if ((b0 & 0xc0) === 0x80) { utf16Len = ((b0 & 0x3f) << 8) | buf[pos + 1]; pos += 2; }
            else {
                // 大长度：3 字节 uleb128（aapt2 编码：0x81,0x80,0x04 形式）
                utf16Len = ((b0 & 0x0f) << 16) | (buf[pos + 1] << 8) | buf[pos + 2];
                pos += 3;
            }
            // 读 utf8 字节长度（uleb128）
            let utf8Len = 0, shift = 0;
            while (true) {
                const b = buf[pos++];
                utf8Len |= (b & 0x7f) << shift;
                if ((b & 0x80) === 0) break;
                shift += 7;
            }
            const bytes = buf.subarray(pos, pos + utf8Len);
            strings.push(Buffer.from(bytes).toString('utf8'));
        } else {
            const len = u16(strAbs);                          // u16 字符数
            const strBytes = buf.subarray(strAbs + 2, strAbs + 2 + len * 2);
            strings.push(Buffer.from(strBytes).toString('utf16le'));
        }
    }
    return strings;
}

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

app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'StarClick Web Server - 应用使用记录云端存储',
        version: '2.0.0',
        timestamp: getChinaTime(),
        endpoints: {
            'GET /': '服务器信息',
            'GET /api/health': '健康检查',
            'POST /api/device/register': '注册设备',
            'GET /api/devices': '获取所有设备列表',
            'POST /api/usage/sync': '增量同步使用记录',
            'GET /api/usage/:deviceId/:date': '获取指定设备日期数据',
            'GET /api/usage/:deviceId/range': '获取日期范围数据',
            'PUT /api/device/:deviceId/name': '更新设备名称',
            'WS  /ws/remote': '远程协助信令通道 (?deviceId=&token=)',
            'POST /api/remote/subscription': '设置/查询远程协助订阅套餐'
        }
    });
});

const apiRouter = express.Router();

apiRouter.get('/health', (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: getChinaTime(),
        dataStats: {
            devices: fs.existsSync(DEVICES_DIR) ? fs.readdirSync(DEVICES_DIR).length : 0,
            storageType: 'JSON File System'
        }
    });
});

apiRouter.post('/device/register', async (req, res) => {
    const { deviceId, deviceName } = req.body;

    console.log(`设备注册请求: deviceId=${deviceId}, deviceName=${deviceName}`);

    // 统一设备档案（唯一权威）：内部已加锁，不再直接读写 registry.json
    const id = deviceId || generateDeviceId();
    const { device, isNew } = await deviceRegistry.upsertDevice(id, deviceName);
    const newDevice = device || { deviceId: id, deviceName: deviceName || deviceRegistry.fallbackName(id) };

    console.log(`${isNew ? '新设备注册' : '设备已存在'}: ${newDevice.deviceId}`);

    if (isNew) {
        const deviceUsageDir = path.join(USAGE_DIR, newDevice.deviceId);
        if (!fs.existsSync(deviceUsageDir)) {
            fs.mkdirSync(deviceUsageDir, { recursive: true });
        }
    }

    res.json({
        success: true,
        message: isNew ? '设备注册成功' : '设备已存在',
        device: newDevice,
        isNew
    });
});

apiRouter.get('/devices', (req, res) => {
    const devices = deviceRegistry.listAll();

    res.json({
        success: true,
        devices,
        total: devices.length
    });
});

// ---- 远程设备管理接口（管理人员页面使用）----
// 说明：admin 标记由【控制端】在指令（ActionJson.admin）内携带，服务端只转发不覆盖；
// 此处 admins.json 仅用于管理页查询与 admin.query，不参与指令判定。
function requireAdminToken(req, res, next) {
    // 个人自用：取消令牌与来源限制，管理页直接可访问。
    next();
}

// 控制端查询自身是否为管理设备（无需令牌，供客户端进入页面时拉取默认身份）
apiRouter.get('/admin/status', (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ success: false, error: '缺少 deviceId' });
    res.json({ success: true, isAdmin: remoteAssist.isAdmin(deviceId) });
});

// 管理页：已注册设备列表（含 admin 标记），需后台页面登录
apiRouter.get('/admin/devices', requireAdminToken, requirePageAuthJson, (req, res) => {
    const devices = deviceRegistry.listAll();
    const admins = remoteAssist.getAllAdmins();
    const list = devices.map(d => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName || '',
        createdAt: d.createdAt || '',
        lastActiveAt: d.lastActiveAt || '',
        isAdmin: remoteAssist.isAdmin(d.deviceId),
        // 「允许 APP 内自切换」：开启后该设备可长按远程设备标题直接修改自己的管理标记
        allowSelfSwitch: !!(admins[d.deviceId] && admins[d.deviceId].allowSelfSwitch),
        points: remoteAssist.getPoints(d.deviceId).balance,
    }));
    res.json({ success: true, devices: list, total: list.length });
});

// 管理页：设置/取消管理设备，需后台页面登录
apiRouter.post('/admin/device', requireAdminToken, requirePageAuthJson, (req, res) => {
    const { deviceId, isAdmin } = req.body || {};
    if (!deviceId) return res.status(400).json({ success: false, error: '缺少 deviceId' });
    remoteAssist.setAdmin(deviceId, isAdmin === true || isAdmin === 'true', 'admin_page');
    res.json({ success: true, deviceId, isAdmin: remoteAssist.isAdmin(deviceId) });
});

// 管理页：开启/关闭设备的「允许 APP 内自切换」，需后台页面登录
apiRouter.post('/admin/device/self-switch', requireAdminToken, requirePageAuthJson, (req, res) => {
    const { deviceId, allow } = req.body || {};
    if (!deviceId) return res.status(400).json({ success: false, error: '缺少 deviceId' });
    remoteAssist.setSelfSwitchAllowed(deviceId, allow === true || allow === 'true');
    res.json({ success: true, deviceId, allowSelfSwitch: remoteAssist.isSelfSwitchAllowed(deviceId) });
});

// 管理页：查询指定设备的积分余额与变动明细（含后台调整备注），需后台页面登录
apiRouter.get('/admin/points', requireAdminToken, requirePageAuthJson, (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ success: false, error: '缺少 deviceId' });
    const p = remoteAssist.getPoints(deviceId);
    res.json({ success: true, deviceId, balance: p.balance, history: p.history || [] });
});

// 管理页：手动为设备增减积分（正=奖励 / 负=扣除），支持备注，需后台页面登录
apiRouter.post('/admin/points/adjust', requireAdminToken, requirePageAuthJson, (req, res) => {
    const { deviceId, delta, note } = req.body || {};
    if (!deviceId) return res.status(400).json({ success: false, error: '缺少 deviceId' });
    const d = Number(delta);
    if (!Number.isFinite(d) || d === 0) {
        return res.status(400).json({ success: false, error: '积分数量必须为非零数字' });
    }
    const p = remoteAssist.adjustPoints(deviceId, d, note);
    if (!p) return res.status(400).json({ success: false, error: '设备不存在' });
    res.json({ success: true, deviceId, balance: p.balance });
});

apiRouter.put('/device/:deviceId/name', async (req, res) => {
    const { deviceId } = req.params;
    const { deviceName } = req.body;
    
    if (!deviceName || deviceName.trim().length === 0) {
        res.status(400).json({
            success: false,
            error: '设备名称不能为空'
        });
        return;
    }
    
    // 统一设备档案：这是「设备名」的唯一权威写入口（改名）
    await deviceRegistry.setName(deviceId, deviceName.trim());

    // 改名后主动通知在线对端刷新信任列表。
    // 旧实现只写文件不推送，对端只能等对方重连 WS 上报 dname 才看到新名（表现为"改名对方不生效"）。
    try {
        if (typeof remoteAssist.notifyDeviceNameChanged === 'function') {
            remoteAssist.notifyDeviceNameChanged(deviceId);
        }
    } catch (e) {
        console.error('[改名] 通知对端失败:', e && e.message);
    }

    res.json({
        success: true,
        message: '设备名称更新成功',
        device: { deviceId, deviceName: deviceName.trim() }
    });
});

apiRouter.post('/usage/sync', async (req, res) => {
    const { deviceId, deviceName, records, deletedIds } = req.body;
    
    if (!deviceId) {
        res.status(400).json({
            success: false,
            error: '缺少设备ID'
        });
        return;
    }
    
    // 统一设备档案：同步使用记录时若发现未建档设备则自动建档（幂等，不覆盖已有名称）
    const { isNew } = await deviceRegistry.upsertDevice(deviceId, deviceName);
    if (isNew) {
        console.log(`同步时发现新设备，自动注册: ${deviceId}`);
        const deviceUsageDir = path.join(USAGE_DIR, deviceId);
        if (!fs.existsSync(deviceUsageDir)) {
            fs.mkdirSync(deviceUsageDir, { recursive: true });
        }
    }
    
    if (!records || !Array.isArray(records) || records.length === 0) {
        res.json({
            success: true,
            message: '无数据需要同步',
            syncedCount: 0
        });
        return;
    }
    
    const deviceUsageDir = path.join(USAGE_DIR, deviceId);
    if (!fs.existsSync(deviceUsageDir)) {
        fs.mkdirSync(deviceUsageDir, { recursive: true });
    }
    
    const results = {
        added: 0,
        updated: 0,
        deleted: 0
    };
    
    const recordsByDate = {};
    records.forEach(record => {
        const date = formatDate(record.openTime);
        if (!recordsByDate[date]) {
            recordsByDate[date] = [];
        }
        recordsByDate[date].push(record);
    });
    
    for (const [date, dateRecords] of Object.entries(recordsByDate)) {
        const usageFile = path.join(deviceUsageDir, `${date}.json`);
        
        await withFileLock(usageFile, async () => {
            let dailyData = {
                date: date,
                records: [],
                lastSyncAt: getChinaTime()
            };
            
            const existingData = safeReadJSON(usageFile, null);
            if (existingData) {
                dailyData = existingData;
            }
            
            dateRecords.forEach(newRecord => {
                const existingIndex = dailyData.records.findIndex(
                    r => r.recordId === newRecord.recordId
                );
                
                if (existingIndex === -1) {
                    dailyData.records.push(newRecord);
                    results.added++;
                } else {
                    dailyData.records[existingIndex] = newRecord;
                    results.updated++;
                }
            });
            
            if (deletedIds && Array.isArray(deletedIds)) {
                dailyData.records = dailyData.records.filter(
                    r => !deletedIds.includes(r.recordId)
                );
                results.deleted += deletedIds.length;
            }
            
            dailyData.lastSyncAt = getChinaTime();
            safeWriteJSON(usageFile, dailyData);
        });
    }
    
    // 统一设备档案：仅刷新活跃时间
    await deviceRegistry.touch(deviceId);
    
    res.json({
        success: true,
        message: '同步成功',
        results: results,
        syncedAt: getChinaTime()
    });
});

apiRouter.get('/usage/:deviceId/:date', (req, res) => {
    const { deviceId, date } = req.params;
    
    const usageFile = path.join(USAGE_DIR, deviceId, `${date}.json`);
    
    if (!fs.existsSync(usageFile)) {
        res.json({
            success: true,
            data: {
                date: date,
                records: [],
                isEmpty: true
            }
        });
        return;
    }
    
    const data = safeReadJSON(usageFile, { date: date, records: [], isEmpty: true });
    
    res.json({
        success: true,
        data: data
    });
});

apiRouter.get('/usage/:deviceId/range', (req, res) => {
    const { deviceId } = req.params;
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
        res.status(400).json({
            success: false,
            error: '需要提供startDate和endDate参数'
        });
        return;
    }
    
    const deviceUsageDir = path.join(USAGE_DIR, deviceId);
    
    if (!fs.existsSync(deviceUsageDir)) {
        res.json({
            success: true,
            deviceId: deviceId,
            data: [],
            total: 0
        });
        return;
    }
    
    const allData = [];
    const files = fs.readdirSync(deviceUsageDir);
    
    files.forEach(file => {
        if (file.endsWith('.json')) {
            const fileDate = file.replace('.json', '');
            if (fileDate >= startDate && fileDate <= endDate) {
                const filePath = path.join(deviceUsageDir, file);
                const data = safeReadJSON(filePath, null);
                if (data) {
                    allData.push(data);
                }
            }
        }
    });
    
    allData.sort((a, b) => a.date.localeCompare(b.date));
    
    res.json({
        success: true,
        deviceId: deviceId,
        data: allData,
        total: allData.length
    });
});

// ---- 远程协助：订阅套餐设置/查询 ----
apiRouter.post('/remote/subscription', (req, res) => {
    const { deviceId, plan } = req.body || {};
    if (!deviceId) {
        res.status(400).json({ success: false, error: '缺少 deviceId' });
        return;
    }
    if (plan) {
        const allowed = ['free', 'pro', 'flag'];
        if (!allowed.includes(plan)) {
            res.status(400).json({ success: false, error: '非法套餐' });
            return;
        }
        remoteAssist.setSubscription(deviceId, plan);
        res.json({ success: true, message: '套餐已更新', plan });
    } else {
        res.json({ success: true, plan: remoteAssist.getPlan(deviceId) });
    }
});

app.use('/api', apiRouter);

// ---- 远程快照：图片静态托管 + 上传接口 ----
// 静态托管：/snapshots/<deviceId>/<file> 可直接访问
app.use('/snapshots', (req, res, next) => {
    console.log(`[snapshot.get] ${req.method} ${req.originalUrl}`);
    next();
});
app.use('/snapshots', express.static(SNAPSHOT_DIR, {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
    }
}));

// 被控端上传快照（base64 JSON，零额外依赖）：{ deviceId, peerId, data, ext, prefix }
// prefix：snap=截图快照（默认）/ cam=拍照照片，用于资产管理页分类展示
app.post('/api/remote/snapshot/upload', (req, res) => {
    try {
        const { deviceId, data, ext, prefix } = req.body || {};
        if (!deviceId || !data) {
            res.status(400).json({ ok: false, reason: '缺少 deviceId 或 data' });
            return;
        }
        const base64 = String(data).replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(base64, 'base64');
        if (!buf || buf.length === 0) {
            res.status(400).json({ ok: false, reason: '图片数据为空' });
            return;
        }
        const safeDevice = String(deviceId).replace(/[^a-zA-Z0-9_-]/g, '_');
        const deviceDir = path.join(SNAPSHOT_DIR, safeDevice);
        if (!fs.existsSync(deviceDir)) fs.mkdirSync(deviceDir, { recursive: true });
        const ts = Date.now();
        const extension = (ext === 'png') ? 'png' : 'jpg';
        const safePrefix = (prefix === 'cam') ? 'cam' : 'snap';
        const fileName = `${safePrefix}_${ts}.${extension}`;
        const filePath = path.join(deviceDir, fileName);
        fs.writeFileSync(filePath, buf);
        // 返回相对路径，由客户端用其 baseUrl 拼接完整访问地址
        const url = `/snapshots/${safeDevice}/${fileName}`;
        console.log(`[snapshot] 收到快照 device=${safeDevice} size=${buf.length} url=${url}`);
        res.json({ ok: true, url });
    } catch (e) {
        console.error('[snapshot] 上传失败:', e);
        res.status(500).json({ ok: false, reason: '服务端保存失败: ' + e.message });
    }
});

// ==================== 聊天图片：上传 / 静态托管 / 闪照回收站 ====================
// 设计要点：
// - 只传 URL 不传二进制（WS 通道的离线互动消息是内存暂存，不适合承载大图）；
// - 客户端负责压缩（或按用户选择发原图），服务端**只做校验不重压缩**：
//   既避免 jimp 处理大图时的内存/耗时尖峰，也让「原图」语义真正成立；
// - 闪照不做物理删除：查看方查看完毕后调用 /api/chat/image/recycle 把文件**移动到回收站目录**，
//   使其在 /chat_images 静态路由下再也取不到（用户层面不可再查看），服务端仍保留源文件备用。
const CHAT_IMAGE_DIR = path.join(DATA_DIR, 'chat_images');
const CHAT_IMAGE_RECYCLE_DIR = path.join(DATA_DIR, 'chat_images_recycle');
fs.mkdirSync(CHAT_IMAGE_DIR, { recursive: true });
fs.mkdirSync(CHAT_IMAGE_RECYCLE_DIR, { recursive: true });

// 单图上限：略高于客户端「原图阈值 10MB」，给 EXIF/封装差异留余量
const CHAT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const chatImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: CHAT_IMAGE_MAX_BYTES, files: 1 }
});
// 轻量滥用防护（同 IP 频率）
const CHAT_IMAGE_RATE_WINDOW = 60 * 1000;
const CHAT_IMAGE_RATE_MAX = 30;
const chatImageHits = new Map();
function chatImageUploadAllowed(ip) {
    const now = Date.now();
    const arr = (chatImageHits.get(ip) || []).filter(t => now - t < CHAT_IMAGE_RATE_WINDOW);
    arr.push(now);
    chatImageHits.set(ip, arr);
    if (chatImageHits.size > 5000) chatImageHits.clear();
    return arr.length <= CHAT_IMAGE_RATE_MAX;
}

// 静态托管：/chat_images/<deviceId>/<file>
app.use('/chat_images', express.static(CHAT_IMAGE_DIR, {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
    }
}));

function safeChatRelative(rel) {
    // 仅允许 chat_images 目录下的相对路径，杜绝 ../ 目录穿越
    const abs = path.resolve(CHAT_IMAGE_DIR, rel);
    if (abs !== CHAT_IMAGE_DIR && !abs.startsWith(CHAT_IMAGE_DIR + path.sep)) return null;
    return abs;
}

app.post('/api/chat/image/upload', chatImageUpload.single('image'), async (req, res) => {
    try {
        if (!chatImageUploadAllowed(req.ip || req.connection?.remoteAddress || 'unknown')) {
            return res.status(429).json({ ok: false, reason: '上传过于频繁，请稍后再试' });
        }
        if (!req.file) return res.status(400).json({ ok: false, reason: '未收到图片' });
        const mime = req.file.mimetype || '';
        if (!mime.startsWith('image/')) return res.status(400).json({ ok: false, reason: '仅支持图片文件' });

        const deviceId = String(req.body?.deviceId || req.query?.deviceId || 'unknown')
            .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'unknown';
        const buf = req.file.buffer;
        if (!buf || buf.length === 0) return res.status(400).json({ ok: false, reason: '图片数据为空' });

        // 动图（GIF / APNG）原样落盘，保持动画；静态图与 JPEG 同样原样落盘（客户端已完成压缩决策）
        const ext = mime === 'image/gif' ? 'gif'
            : mime === 'image/png' ? 'png'
                : mime === 'image/webp' ? 'webp' : 'jpg';
        const dir = path.join(CHAT_IMAGE_DIR, deviceId);
        fs.mkdirSync(dir, { recursive: true });
        const fileName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        fs.writeFileSync(path.join(dir, fileName), buf);
        const url = `/chat_images/${deviceId}/${fileName}`;
        console.log(`[chat.image] 上传 device=${deviceId} size=${buf.length} mime=${mime} url=${url}`);
        res.json({ ok: true, url, size: buf.length });
    } catch (e) {
        console.error('[chat.image] 上传失败:', e);
        res.status(500).json({ ok: false, reason: '服务端保存失败: ' + e.message });
    }
});

// 闪照回收：把已查看的闪照从 chat_images 移到 chat_images_recycle（保留目录结构）。
// 语义：用户层面不可再查看（静态路由下 404），服务端仍保留源文件，便于后续功能复用。
app.post('/api/chat/image/recycle', express.json({ limit: '1mb' }), (req, res) => {
    try {
        const rawUrl = String(req.body?.url || '');
        const marker = '/chat_images/';
        const idx = rawUrl.indexOf(marker);
        if (idx < 0) return res.status(400).json({ ok: false, reason: '非聊天图片地址' });
        const rel = rawUrl.substring(idx + marker.length).split('?')[0];
        const abs = safeChatRelative(rel);
        if (!abs) return res.status(400).json({ ok: false, reason: '非法图片地址' });
        if (!fs.existsSync(abs)) {
            // 已被回收过（或已清理）：视为成功，保证客户端状态机可收敛
            return res.json({ ok: true, recycled: false, reason: '文件已不存在' });
        }
        const relDir = path.dirname(rel);
        const destDir = path.join(CHAT_IMAGE_RECYCLE_DIR, relDir === '.' ? '' : relDir);
        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, path.basename(rel));
        fs.renameSync(abs, dest);
        console.log(`[chat.image] 闪照回收 ${rel}`);
        res.json({ ok: true, recycled: true });
    } catch (e) {
        console.error('[chat.image] 回收失败:', e);
        res.status(500).json({ ok: false, reason: '回收失败: ' + e.message });
    }
});

// 过期清理：普通聊天图 30 天、回收站 90 天（回收站保留更久，便于追溯/恢复）
const CHAT_IMAGE_TTL_MS = 30 * 24 * 3600 * 1000;
const CHAT_IMAGE_RECYCLE_TTL_MS = 90 * 24 * 3600 * 1000;
function cleanupOldFiles(dir, ttlMs) {
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    const walk = (d) => {
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of entries) {
            const p = path.join(d, ent.name);
            if (ent.isDirectory()) { walk(p); continue; }
            try {
                const st = fs.statSync(p);
                if (now - st.mtimeMs > ttlMs) fs.unlinkSync(p);
            } catch (e) { /* 忽略单个文件清理失败 */ }
        }
    };
    walk(dir);
}
const chatImageCleanupTimer = setInterval(() => {
    cleanupOldFiles(CHAT_IMAGE_DIR, CHAT_IMAGE_TTL_MS);
    cleanupOldFiles(CHAT_IMAGE_RECYCLE_DIR, CHAT_IMAGE_RECYCLE_TTL_MS);
}, 6 * 3600 * 1000);
if (chatImageCleanupTimer.unref) chatImageCleanupTimer.unref();
setTimeout(() => {
    cleanupOldFiles(CHAT_IMAGE_DIR, CHAT_IMAGE_TTL_MS);
    cleanupOldFiles(CHAT_IMAGE_RECYCLE_DIR, CHAT_IMAGE_RECYCLE_TTL_MS);
}, 30 * 1000);

// 静态托管：/clipboards/<deviceId>/<file> 可直接访问（远程协助-获取实时剪切板内容）
app.use('/clipboards', (req, res, next) => {
    console.log(`[clipboard.get] ${req.method} ${req.originalUrl}`);
    next();
});
app.use('/clipboards', express.static(CLIPBOARD_DIR, {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
    }
}));

// 静态托管：/avatars/<deviceId>.jpg 可直接访问（远程协助-设备头像）
app.use('/avatars', express.static(AVATAR_DIR, {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
    }
}));

// ---- 表情 Lottie 矢量动画：静态托管（APP 首次渲染时按需下载到沙盒，不打包进 APK）----
// 资源位于 public/qqface-lottie/，由 scripts/build-lottie.js 从 QFace 仓库生成：
//   /lottie/manifest.json  列出所有可用表情 id（数字串数组）
//   /lottie/{id}.json      对应表情的 Lottie 矢量动画
//   /lottie/{id}.tgs       Telegram 动图贴纸（= gzip 压缩的 Lottie JSON），与 .json 等价，客户端下载后就地解压
// 免鉴权（与 /snapshots、/avatars 一致），并对客户端开放。
const LOTTIE_DIR = path.join(__dirname, 'public', 'qqface-lottie');
app.use('/lottie', express.static(LOTTIE_DIR, {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
    }
}));

// ---- APP 自动更新：发布页面与安装包下载 ----
// 发布页面（publish.html 等静态资源）
app.use('/public', requirePageAuth, express.static(path.join(__dirname, 'public'), {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
    }
}));
// 便捷路由：浏览器访问 /publish 直接打开发布页
app.get('/publish', requirePageAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'publish.html'));
});
// 便捷路由：浏览器访问 /admin 直接打开管理人员页
app.get('/admin', requirePageAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
// 便捷路由：浏览器访问 /assets-admin 直接打开服务端资产管理页（快照/拍照/聊天图片）
app.get('/assets-admin', requirePageAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'assets-admin.html'));
});

// ==================== 服务端资产内容管理（assets-admin.html 使用） ====================
// 分类：snapshot(截图快照 snap_*) / photo(拍照照片 cam_*) / chat(聊天图片) / chat_recycle(闪照回收站)
// 说明：快照与拍照共用 snapshots 目录，靠文件名前缀区分（历史无 cam_ 前缀的文件归入截图快照）；
//      聊天图片/闪照回收站有 TTL 自动清理，但管理页仍提供即时清理入口。
// 鉴权：requirePageAuthJson（与 /admin、/emoji-admin 一致，需登录后台）。
const ASSET_KIND_ROOTS = {
    snapshot: SNAPSHOT_DIR,
    photo: SNAPSHOT_DIR,
    chat: CHAT_IMAGE_DIR,
    chat_recycle: CHAT_IMAGE_RECYCLE_DIR,
};

/** kind + 相对路径 → 绝对路径；严格防目录穿越（resolve 后必须仍在该类目根目录内） */
function assetAbsPath(kind, relPath) {
    const root = ASSET_KIND_ROOTS[kind];
    if (!root || !relPath) return null;
    const abs = path.resolve(root, String(relPath));
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return abs;
}

/** 扫描全部类目资产文件（含设备子目录两级结构），按修改时间倒序 */
function listAssetItems() {
    const items = [];
    // 快照目录：<设备>/<文件>，按文件名前缀分类（cam_=拍照照片，其余=截图快照）
    if (fs.existsSync(SNAPSHOT_DIR)) {
        for (const dev of fs.readdirSync(SNAPSHOT_DIR)) {
            const devDir = path.join(SNAPSHOT_DIR, dev);
            let st; try { st = fs.statSync(devDir); } catch (_) { continue; }
            if (!st.isDirectory()) continue;
            for (const f of fs.readdirSync(devDir)) {
                let st2; try { st2 = fs.statSync(path.join(devDir, f)); } catch (_) { continue; }
                if (!st2.isFile()) continue;
                items.push({
                    kind: f.startsWith('cam_') ? 'photo' : 'snapshot',
                    device: dev, name: f, relPath: `${dev}/${f}`,
                    url: `/snapshots/${encodeURIComponent(dev)}/${encodeURIComponent(f)}`,
                    size: st2.size, mtime: st2.mtimeMs,
                });
            }
        }
    }
    // 聊天图片 / 闪照回收站：<设备>/<文件>，结构一致；回收站无静态路由（已回收不可查看），仅清理
    for (const [kind, root] of [['chat', CHAT_IMAGE_DIR], ['chat_recycle', CHAT_IMAGE_RECYCLE_DIR]]) {
        if (!fs.existsSync(root)) continue;
        for (const dev of fs.readdirSync(root)) {
            const devDir = path.join(root, dev);
            let st; try { st = fs.statSync(devDir); } catch (_) { continue; }
            if (!st.isDirectory()) continue;
            for (const f of fs.readdirSync(devDir)) {
                let st2; try { st2 = fs.statSync(path.join(devDir, f)); } catch (_) { continue; }
                if (!st2.isFile()) continue;
                items.push({
                    kind, device: dev, name: f, relPath: `${dev}/${f}`,
                    url: kind === 'chat' ? `/chat_images/${encodeURIComponent(dev)}/${encodeURIComponent(f)}` : '',
                    size: st2.size, mtime: st2.mtimeMs,
                });
            }
        }
    }
    return items.sort((a, b) => b.mtime - a.mtime);
}

// 资产列表 + 分类统计
app.get('/api/admin/assets/list', requirePageAuthJson, (req, res) => {
    try {
        const items = listAssetItems();
        const stats = { total: { count: items.length, size: 0 }, byKind: {} };
        for (const it of items) {
            stats.total.size += it.size;
            const k = stats.byKind[it.kind] || (stats.byKind[it.kind] = { count: 0, size: 0 });
            k.count++; k.size += it.size;
        }
        res.json({ success: true, items, stats });
    } catch (e) {
        res.status(500).json({ success: false, error: '扫描资产失败: ' + e.message });
    }
});

// 资产删除（多选）：items = [{ kind, relPath }]；返回成功数与失败清单
app.post('/api/admin/assets/delete', requirePageAuthJson, (req, res) => {
    try {
        const list = Array.isArray(req.body && req.body.items) ? req.body.items : [];
        if (list.length === 0) return res.status(400).json({ success: false, error: '缺少删除项' });
        let deleted = 0;
        const failed = [];
        for (const it of list) {
            const abs = assetAbsPath(it.kind, it.relPath);
            if (!abs || !fs.existsSync(abs)) { failed.push(String(it.relPath || '?')); continue; }
            try { fs.unlinkSync(abs); deleted++; }
            catch (e) { failed.push(String(it.relPath || '?')); }
        }
        console.log(`[assets] 删除 ${deleted} 个资产文件（失败 ${failed.length}）`);
        res.json({ success: true, deleted, failed });
    } catch (e) {
        res.status(500).json({ success: false, error: '删除失败: ' + e.message });
    }
});

// 资产单文件下载
app.get('/api/admin/assets/download', requirePageAuthJson, (req, res) => {
    const abs = assetAbsPath(req.query.kind, req.query.path || '');
    if (!abs || !fs.existsSync(abs)) return res.status(404).json({ success: false, error: '文件不存在' });
    res.download(abs, path.basename(abs));
});

// 资产预览（管理页 <img>/灯箱使用）：闪照回收站类目无公开静态路由（回收后 APP 端不可查看是产品语义），
// 经此接口走后台会话鉴权输出图片字节——管理页可预览，但不为回收站开放公开访问。
const ASSET_PREVIEW_MIME = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
};
/** 文件头魔法数嗅探（兜底）：扩展名缺失/异常时按字节特征判图片类型 */
function sniffImageMime(buf) {
    if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
    if (buf.length >= 6 && buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
    if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return null;
}
app.get('/api/admin/assets/preview', requirePageAuthJson, (req, res) => {
    const abs = assetAbsPath(req.query.kind, req.query.path || '');
    if (!abs || !fs.existsSync(abs)) return res.status(404).json({ success: false, error: '文件不存在' });
    const buf = fs.readFileSync(abs);
    // 优先按扩展名判 MIME，失败则按文件头魔法数嗅探（保证无扩展名文件也可预览）
    const mime = ASSET_PREVIEW_MIME[path.extname(abs).toLowerCase()] || sniffImageMime(buf);
    if (!mime) return res.status(415).json({ success: false, error: '不支持的图片格式' });
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(buf);
});

// 资产批量下载（zip 打包；AdmZip 纯 JS 实现零原生依赖）
app.post('/api/admin/assets/download-zip', requirePageAuthJson, (req, res) => {
    try {
        const list = Array.isArray(req.body && req.body.items) ? req.body.items : [];
        if (list.length === 0) return res.status(400).json({ success: false, error: '缺少下载项' });
        const zip = new AdmZip();
        const used = new Set();
        for (const it of list) {
            const abs = assetAbsPath(it.kind, it.relPath);
            if (!abs || !fs.existsSync(abs)) continue;
            let entry = `${it.kind}/${it.relPath}`;
            if (used.has(entry)) entry = `${it.kind}/${Date.now()}_${it.relPath}`;
            used.add(entry);
            zip.addLocalFile(abs, path.dirname(entry), path.basename(entry));
        }
        if (zip.getEntries().length === 0) return res.status(400).json({ success: false, error: '没有可下载的文件' });
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="starclick_assets_${Date.now()}.zip"`);
        res.send(zip.toBuffer());
    } catch (e) {
        res.status(500).json({ success: false, error: '打包失败: ' + e.message });
    }
});
// 最新安装包不再单独放在根目录 starclick.apk，统一由 /updates 目录承载，
// 通过 /api/app/download/:versionCode 路由下载（见下方接口）。

// 被控端上传剪切板文本（base64 JSON，零额外依赖）：{ deviceId, data }
app.post('/api/remote/clipboard/upload', (req, res) => {
    try {
        const { deviceId, data } = req.body || {};
        if (!deviceId || !data) {
            res.status(400).json({ ok: false, reason: '缺少 deviceId 或 data' });
            return;
        }
        const base64 = String(data).replace(/^data:text\/plain;base64,/, '');
        const buf = Buffer.from(base64, 'base64');
        if (!buf || buf.length === 0) {
            res.status(400).json({ ok: false, reason: '剪切板数据为空' });
            return;
        }
        const safeDevice = String(deviceId).replace(/[^a-zA-Z0-9_-]/g, '_');
        const deviceDir = path.join(CLIPBOARD_DIR, safeDevice);
        if (!fs.existsSync(deviceDir)) fs.mkdirSync(deviceDir, { recursive: true });
        const ts = Date.now();
        const fileName = `clip_${ts}.txt`;
        const filePath = path.join(deviceDir, fileName);
        fs.writeFileSync(filePath, buf);
        // 返回相对路径，由客户端用其 baseUrl 拼接完整访问地址
        const url = `/clipboards/${safeDevice}/${fileName}`;
        console.log(`[clipboard] 收到剪切板 device=${safeDevice} size=${buf.length} url=${url}`);
        res.json({ ok: true, url });
    } catch (e) {
        console.error('[clipboard] 上传失败:', e);
        res.status(500).json({ ok: false, reason: '服务端保存失败: ' + e.message });
    }
});

// ICE 配置下发（含 TURN 中继），供客户端在建立 WebRTC 前拉取，避免 TURN 凭证硬编码到客户端
// 注意：必须放在 404 兜底中间件（app.use((req,res)=>...)）之前，否则会被拦截返回"未找到该接口"
app.get('/api/ice-config', (req, res) => {
    res.json(remoteAssist.getIceConfig());
});

// 临时诊断接口：用于确认服务端是否正确读到了 TURN 环境变量（部署排查用，上线后可删除）
app.get('/api/ice-debug', (req, res) => {
    const turnUrl = process.env.TURN_URL;
    const hasUser = !!process.env.TURN_USERNAME;
    const hasCred = !!process.env.TURN_CREDENTIAL;
    res.json({
        turnUrlConfigured: !!turnUrl,
        turnUrlValue: turnUrl ? turnUrl.replace(/:(.*)@/, ':***@') : null, // 脱敏：隐藏可能内嵌的凭证
        turnUsernameConfigured: hasUser,
        turnCredentialConfigured: hasCred,
        allThreeOk: !!(turnUrl && hasUser && hasCred),
    });
});

function generateDeviceId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `device_${timestamp}_${random}`;
}

function formatDate(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getChinaTime() {
    const now = new Date();
    const chinaTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const iso = chinaTime.toISOString();
    return iso.replace('Z', '+08:00');
}

// ==================== APP 自动更新：版本发布 / 查询 ====================
// multer 内存存储：APK 先放内存，解析 manifest 后再落盘（避免临时文件）
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// ==================== 表情包（统一服务端托管）：普通(png) / 超级(lottie) / 自定义(上传) ====================
// 普通表情：public/emoji/regular/*.png（低分辨率 png，由客户端从 assets 迁移而来，不再打包进 APK）
// 超级表情：复用 public/qqface-lottie/*.json（Lottie 矢量动画）
// 自定义表情：public/emoji/custom/*.png（用户上传，所有用户共享，元数据持久化到 data/emoji/custom.json）
// 客户端启动静默拉取 /emoji/catalog，按 hash 增量下载到本地沙盒，进入聊天前加载完成。
const EMOJI_DIR = path.join(__dirname, 'public', 'emoji');
const EMOJI_REGULAR_DIR = path.join(EMOJI_DIR, 'regular');
const EMOJI_CUSTOM_DIR = path.join(EMOJI_DIR, 'custom');
const EMOJI_CUSTOM_JSON = path.join(__dirname, 'data', 'emoji', 'custom.json');
const EMOJI_ORDER_JSON = path.join(__dirname, 'data', 'emoji', 'order.json');
const EMOJI_RECYCLE_JSON = path.join(__dirname, 'data', 'emoji', 'recycle.json');
fs.mkdirSync(EMOJI_REGULAR_DIR, { recursive: true });
fs.mkdirSync(EMOJI_CUSTOM_DIR, { recursive: true });
fs.mkdirSync(path.join(__dirname, 'data', 'emoji'), { recursive: true });

// 自定义表情上传**独立的 multer 实例**：不能复用 APK 上传那个 200MB 限制的 upload，
// 否则一张超大图就能把内存（memoryStorage）打爆。这里单独限 10MB。
const EMOJI_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const MAX_EMOJI_BATCH = 50; // 单次批量上传文件数上限（与下方 emojiUpload.array 保持一致）
const emojiUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: EMOJI_UPLOAD_MAX_BYTES, files: MAX_EMOJI_BATCH }
});

// 自定义表情总条数上限（全员共享，防止无限增长撑爆磁盘并拖慢 catalog）
const EMOJI_CUSTOM_MAX = 200;

// 轻量滥用防护：同 IP 上传频率限制（不引入 token 鉴权，避免打断 APP 正常上传）
const EMOJI_UPLOAD_RATE_WINDOW = 60 * 1000;
const EMOJI_UPLOAD_RATE_MAX = 20;
const emojiUploadHits = new Map();
function emojiUploadAllowed(ip) {
    const now = Date.now();
    const arr = (emojiUploadHits.get(ip) || []).filter(t => now - t < EMOJI_UPLOAD_RATE_WINDOW);
    arr.push(now);
    emojiUploadHits.set(ip, arr);
    if (emojiUploadHits.size > 5000) emojiUploadHits.clear(); // 防止 Map 自身无限增长
    return arr.length <= EMOJI_UPLOAD_RATE_MAX;
}

app.use('/emoji/regular', express.static(EMOJI_REGULAR_DIR, {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
    }
}));
app.use('/emoji/custom', express.static(EMOJI_CUSTOM_DIR, {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
    }
}));

function emojiFileHash(buf) {
    return crypto.createHash('md5').update(buf).digest('hex');
}

// 内存缓存 catalog（自定义上传后失效），避免每次请求都扫盘
let emojiCatalogCache = null;
let emojiCatalogCacheAt = 0;
const EMOJI_CATALOG_TTL = 30 * 1000;

/**
 * 单文件 hash 缓存：仅在 mtime/size 变化时才真正读文件算 md5。
 *
 * 旧实现每 30s 重建 catalog 就对 ~300 个文件做 **同步** readFileSync + md5，
 * 直接阻塞事件循环（所有客户端请求一起卡）。现在常规重建只剩 stat 开销；
 * 且 hash 语义完全不变（仍是内容 md5），客户端按 hash 增量下载不会误触发全量重下。
 */
const emojiFileMetaCache = new Map(); // filePath -> { mtimeMs, size, hash }

async function buildFileEntry(dirPath, publicPrefix, id, fileName) {
    const p = path.join(dirPath, fileName);
    const st = await fs.promises.stat(p);
    const cached = emojiFileMetaCache.get(p);
    let hash = (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) ? cached.hash : null;
    if (!hash) {
        const buf = await fs.promises.readFile(p);
        hash = emojiFileHash(buf);
        emojiFileMetaCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, hash });
    }
    return { id, file: `${publicPrefix}/${fileName}`, hash, size: st.size };
}

/**
 * 超级表情条目构造：同时支持 .json（Lottie 矢量）与 .tgs（Telegram 动图 = gzip 压缩的 Lottie JSON）。
 * 关键约定：无论源是 .json 还是 .tgs，catalog 返回的 `hash`/`size` 一律基于「解压后的 Lottie JSON」，
 * 这样客户端无需感知格式——下载后把 .tgs 就地 gunzip 成 {id}.json 落盘，增量比对（hash+size）逻辑完全不变。
 * `file` 字段如实返回 /lottie/{id}.json 或 /lottie/{id}.tgs，客户端据此决定是否解压。
 */
async function buildSuperEntry(id) {
    const jsonPath = path.join(LOTTIE_DIR, `${id}.json`);
    const tgsPath = path.join(LOTTIE_DIR, `${id}.tgs`);
    let absPath, publicFile, isTgs = false;
    if (fs.existsSync(jsonPath)) {
        absPath = jsonPath; publicFile = `${id}.json`;
    } else if (fs.existsSync(tgsPath)) {
        absPath = tgsPath; publicFile = `${id}.tgs`; isTgs = true;
    } else {
        return null;
    }
    const st = await fs.promises.stat(absPath);
    const cached = emojiFileMetaCache.get(absPath);
    let hash = (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) ? cached.hash : null;
    const raw = await fs.promises.readFile(absPath);
    const logicalBuf = isTgs ? zlib.gunzipSync(raw) : raw; // tgs 解压得到 Lottie JSON 字节
    if (!hash) {
        hash = emojiFileHash(logicalBuf);
        // 缓存同时记 logicalSize（解压后大小），命中缓存时免二次解压；size 字段仍用物理大小做失效判定
        emojiFileMetaCache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, hash, logicalSize: logicalBuf.length });
    }
    const logicalSize = cached?.logicalSize ?? logicalBuf.length;
    // size 返回「解压后 Lottie JSON」大小，与 hash 语义一致（客户端据此做落盘校验/增量比对）
    return { id: `s${id}`, file: `/lottie/${publicFile}`, hash, size: logicalSize, format: isTgs ? 'tgs' : 'json' };
}

async function buildEmojiCatalog() {
    const now = Date.now();
    if (emojiCatalogCache && (now - emojiCatalogCacheAt) < EMOJI_CATALOG_TTL) {
        return emojiCatalogCache;
    }
    let regular = [];
    try {
        const files = (await fs.promises.readdir(EMOJI_REGULAR_DIR)).filter(f => f.toLowerCase().endsWith('.png'));
        for (const f of files) {
            regular.push(await buildFileEntry(EMOJI_REGULAR_DIR, '/emoji/regular', f.replace(/\.png$/i, ''), f));
        }
    } catch (e) { console.warn('[emoji] 扫描 regular 失败:', e.message); }

    let superList = [];
    try {
        const manifestPath = path.join(LOTTIE_DIR, 'manifest.json');
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        for (const rawId of manifest) {
            // 白名单：manifest 若被污染（含 ../ 等）会导致路径穿越，这里先规范化
            const id = String(rawId).replace(/[^0-9a-zA-Z_-]/g, '');
            if (!id) continue;
            const entry = await buildSuperEntry(id);
            if (entry) superList.push(entry);
        }
    } catch (e) { console.warn('[emoji] 扫描 super 失败:', e.message); }

    let custom = [];
    try {
        custom = JSON.parse(await fs.promises.readFile(EMOJI_CUSTOM_JSON, 'utf8') || '[]');
    } catch (e) { custom = []; }

    // 应用管理页排序：order.json 存储每个 category 的显式 id 顺序
    let order = {};
    try { order = JSON.parse(await fs.promises.readFile(EMOJI_ORDER_JSON, 'utf8') || '{}'); } catch (e) {}
    // 读取回收站：过滤掉已删除的表情（文件仍在磁盘，但不应出现在 catalog 中）
    let recycleIds = { regular: new Set(), super: new Set(), custom: new Set() };
    try {
        const recycle = JSON.parse(await fs.promises.readFile(EMOJI_RECYCLE_JSON, 'utf8') || '{}');
        for (const cat of ['regular', 'super', 'custom']) {
            if (Array.isArray(recycle[cat])) recycleIds[cat] = new Set(recycle[cat].map(e => e.id));
        }
    } catch (e) {}
    // 先过滤回收站，再排序
    const filterRecycle = (entries, cat) => entries.filter(e => !recycleIds[cat].has(e.id));
    const applyOrder = (entries, orderedIds) => {
        if (!Array.isArray(orderedIds) || orderedIds.length === 0) return entries;
        const map = new Map(entries.map(e => [e.id, e]));
        const result = [];
        for (const id of orderedIds) { const e = map.get(id); if (e) { result.push(e); map.delete(id); } }
        for (const e of map.values()) result.push(e); // order.json 未覆盖的追加到末尾
        return result;
    };
    regular = filterRecycle(regular, 'regular');
    superList = filterRecycle(superList, 'super');
    custom = filterRecycle(custom, 'custom');
    if (order.regular) regular = applyOrder(regular, order.regular);
    if (order['super']) superList = applyOrder(superList, order['super']);
    if (order.custom) custom = applyOrder(custom, order.custom);

    const catalog = { regular, super: superList, custom };
    emojiCatalogCache = catalog;
    emojiCatalogCacheAt = now;
    return catalog;
}

app.get('/emoji/catalog', async (req, res) => {
    try {
        const catalog = await buildEmojiCatalog();
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
        res.json(catalog);
    } catch (e) {
        console.error('[emoji] catalog 构建失败:', e.message, e.stack);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 自定义表情上传：multer 内存 → jimp 归一化(cover 240×240) → 落盘 + 追加到 data/emoji/custom.json（所有用户共享）
app.post('/api/emoji/custom/upload', emojiUpload.single('emoji'), async (req, res) => {
    try {
        if (!emojiUploadAllowed(req.ip || req.connection?.remoteAddress || 'unknown')) {
            return res.status(429).json({ success: false, error: '上传过于频繁，请稍后再试' });
        }
        if (!req.file) return res.status(400).json({ success: false, error: '未收到图片' });
        // 仅允许图片类型
        const mime = req.file.mimetype || '';
        if (!mime.startsWith('image/')) return res.status(400).json({ success: false, error: '仅支持图片文件' });

        const raw = sanitizeImageBuffer(req.file.buffer);
        // ⚠️ 只有 **APNG（PNG + acTL）** 与 **GIF（GIF87a/89a）** 能原样保留动画：
        // - APNG：客户端 ApngDecoder 逐帧播放，本地按 `${id}.png` 落盘；
        // - GIF：客户端 EmojiView 内置 Movie 解码播放（零依赖），本地按 `${id}.gif` 落盘；
        // Jimp 只保留首帧，会把动画压成静态图，动图一律绕过 Jimp 原样落盘。体积已由 10MB 上限约束。
        const isGif = raw.length >= 3 && raw[0] === 0x47 && raw[1] === 0x49 && raw[2] === 0x46;
        const animated = isGif || isAnimatedImageBuffer(raw);
        const id = 'c_' + crypto.randomBytes(6).toString('hex');
        const fileName = isGif ? `${id}.gif` : `${id}.png`;
        const destPath = path.join(EMOJI_CUSTOM_DIR, fileName);
        fs.mkdirSync(EMOJI_CUSTOM_DIR, { recursive: true });

        if (animated) {
            // 动图（APNG/GIF）：绝不能走 Jimp——Jimp 只保留首帧，会把动画压成静态图。
            // 原样落盘保留全部帧，客户端据此播放动画。
            fs.writeFileSync(destPath, raw);
        } else {
            // 静态图：按原逻辑归一化到 240×240（体积与显示一致）
            const img = await Jimp.read(raw);
            img.cover(240, 240);
            await img.writeAsync(destPath);
        }

        const fileBuf = fs.readFileSync(destPath);
        // 内容去重：同一张图重复上传直接复用已有条目，避免表情面板出现重复项
        const contentHash = emojiFileHash(fileBuf);
        const uploader = String(req.body?.deviceId || req.query?.deviceId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

        let entry = null;
        let deduped = false;
        await withFileLock(EMOJI_CUSTOM_JSON, async () => {
            let list = [];
            try { list = JSON.parse(fs.readFileSync(EMOJI_CUSTOM_JSON, 'utf8') || '[]'); } catch (e) { list = []; }
            const exist = list.find(x => x && x.hash === contentHash && x.size === fileBuf.length);
            if (exist) {
                // 已存在完全相同的内容：删除刚写入的重复文件，复用原条目
                try { fs.unlinkSync(destPath); } catch (e) { /* 忽略清理失败 */ }
                entry = exist;
                deduped = true;
                return;
            }
            // 条数上限：防止无限增长撑爆磁盘/拖慢 catalog（超出则拒绝并清理本次文件）
            if (list.length >= EMOJI_CUSTOM_MAX) {
                try { fs.unlinkSync(destPath); } catch (e) { /* 忽略清理失败 */ }
                entry = null;
                return;
            }
            entry = {
                id,
                file: `/emoji/custom/${fileName}`,
                hash: contentHash,
                size: fileBuf.length,
                animated: animated || undefined,
                uploader: uploader || undefined,
                ts: Date.now()
            };
            list.push(entry);
            safeWriteJSON(EMOJI_CUSTOM_JSON, list);
        });

        if (!entry) {
            return res.status(400).json({ success: false, error: `自定义表情已达上限（${EMOJI_CUSTOM_MAX} 个）` });
        }
        emojiCatalogCache = null; // 失效缓存
        res.json({ success: true, entry, deduped });
    } catch (e) {
        console.error('[emoji] 自定义上传失败:', e);
        res.status(500).json({ success: false, error: '服务端处理失败: ' + e.message });
    }
});

// ==================== 表情包管理后台 API（/emoji/admin/*） ====================
// 管理页 emoji-admin.html 使用，支持排序、删除（移入回收站）、恢复、上传新增、保存并通知客户端。
// 鉴权：复用 requirePageAuthJson（与 /admin 设备管理页一致，需登录后台）。

/** 读取回收站数据 { regular: [...], super: [...], custom: [...] } */
async function readRecycleBin() {
    try { return JSON.parse(await fs.promises.readFile(EMOJI_RECYCLE_JSON, 'utf8') || '{}'); }
    catch (e) { return {}; }
}

/** 读取排序配置 { regular: [...ids], super: [...ids], custom: [...ids] } */
async function readEmojiOrder() {
    try { return JSON.parse(await fs.promises.readFile(EMOJI_ORDER_JSON, 'utf8') || '{}'); }
    catch (e) { return {}; }
}

/** 超级表情 manifest 路径 */
const LOTTIE_MANIFEST_PATH = path.join(LOTTIE_DIR, 'manifest.json');

/** 获取管理状态：当前 catalog（含排序）+ 回收站 + 排序配置 */
app.get('/emoji/admin/state', requirePageAuthJson, async (req, res) => {
    try {
        emojiCatalogCache = null; // 管理页强制刷新，跳过缓存
        const catalog = await buildEmojiCatalog();
        const recycle = await readRecycleBin();
        const order = await readEmojiOrder();
        res.json({ success: true, catalog, recycle, order });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * 保存表情管理变更（批量操作）。
 * Body: {
 *   order: { regular: [...ids], super: [...ids], custom: [...ids] },  // 新排序
 *   deleted: { regular: [...ids], super: [...ids], custom: [...ids] }, // 移入回收站
 *   restored: { regular: [...ids], super: [...ids], custom: [...ids] } // 从回收站恢复
 * }
 * 保存后失效 catalog 缓存，广播 WebSocket 通知所有在线客户端增量更新。
 */
app.post('/emoji/admin/save', requirePageAuthJson, async (req, res) => {
    try {
        const { order, deleted, restored } = req.body || {};
        const cats = ['regular', 'super', 'custom'];

        // 1. 写排序配置
        if (order && typeof order === 'object') {
            const curOrder = await readEmojiOrder();
            for (const cat of cats) {
                if (Array.isArray(order[cat])) curOrder[cat] = order[cat].filter(id => typeof id === 'string');
            }
            safeWriteJSON(EMOJI_ORDER_JSON, curOrder);
        }

        // 2. 处理删除（移入回收站）和恢复（从回收站移回）
        const recycle = await readRecycleBin();
        for (const cat of cats) { if (!recycle[cat]) recycle[cat] = []; }

        // 删除：从 active 集合移入回收站
        if (deleted && typeof deleted === 'object') {
            for (const cat of cats) {
                const ids = Array.isArray(deleted[cat]) ? deleted[cat] : [];
                if (ids.length === 0) continue;
                // 获取当前 active 条目
                emojiCatalogCache = null;
                const catalog = await buildEmojiCatalog();
                const activeMap = new Map(catalog[cat].map(e => [e.id, e]));
                for (const id of ids) {
                    const entry = activeMap.get(id);
                    if (!entry) continue;
                    recycle[cat].push({ ...entry, deletedAt: Date.now() });
                    // 从物理文件层面：不删除文件，仅从 catalog 排序中排除
                    // 对于 super：从 manifest 移除 id（去掉 s 前缀）
                    // 对于 regular/custom：从 order 中排除即可（文件保留，回收站可恢复）
                }
                // super 需同步更新 manifest
                if (cat === 'super') {
                    try {
                        const manifest = JSON.parse(await fs.promises.readFile(LOTTIE_MANIFEST_PATH, 'utf8'));
                        const delNums = new Set(ids.map(id => String(id).replace(/^s/, '')));
                        const newManifest = manifest.filter(x => !delNums.has(String(x)));
                        safeWriteJSON(LOTTIE_MANIFEST_PATH, newManifest);
                    } catch (e) { console.warn('[emoji-admin] 更新 manifest 失败:', e.message); }
                }
            }
        }

        // 恢复：从回收站移回 active 集合
        if (restored && typeof restored === 'object') {
            for (const cat of cats) {
                const ids = Array.isArray(restored[cat]) ? restored[cat] : [];
                if (ids.length === 0) continue;
                const restoreSet = new Set(ids);
                recycle[cat] = recycle[cat].filter(e => {
                    if (!restoreSet.has(e.id)) return true;
                    // 恢复到 active：super 需重新加入 manifest
                    if (cat === 'super') {
                        try {
                            const manifest = JSON.parse(fs.readFileSync(LOTTIE_MANIFEST_PATH, 'utf8'));
                            const num = String(e.id).replace(/^s/, '');
                            if (!manifest.includes(num)) { manifest.push(num); manifest.sort((a, b) => Number(a) - Number(b)); }
                            safeWriteJSON(LOTTIE_MANIFEST_PATH, manifest);
                        } catch (err) { console.warn('[emoji-admin] 恢复 manifest 失败:', err.message); }
                    }
                    return false; // 从回收站移除
                });
            }
        }

        safeWriteJSON(EMOJI_RECYCLE_JSON, recycle);
        emojiCatalogCache = null; // 失效缓存

        // 3. 广播通知所有在线客户端增量更新
        try {
            if (typeof remoteAssist.broadcastEmojiCatalogUpdate === 'function') {
                remoteAssist.broadcastEmojiCatalogUpdate();
            }
        } catch (e) { console.warn('[emoji-admin] 广播失败:', e.message); }

        res.json({ success: true });
    } catch (e) {
        console.error('[emoji-admin] 保存失败:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * 上传新增表情（普通 PNG 或超级 Lottie JSON）。
 * multipart: field "emoji" = 文件, field "category" = "regular" | "super", field "emojiId" = 自定义ID(可选)
 * 自定义表情仍走 /api/emoji/custom/upload。
 */
app.post('/emoji/admin/upload', requirePageAuthJson, emojiUpload.array('emoji', MAX_EMOJI_BATCH), async (req, res) => {
    try {
        const files = req.files;
        if (!files || files.length === 0) return res.status(400).json({ success: false, error: '未收到文件' });
        const category = req.body?.category || '';
        if (category !== 'regular' && category !== 'super') {
            return res.status(400).json({ success: false, error: 'category 必须为 regular 或 super' });
        }
        const entries = [];
        const errors = [];

        if (category === 'regular') {
            const existing = (await fs.promises.readdir(EMOJI_REGULAR_DIR)).filter(f => f.match(/^s(\d+)\.(png|gif)$/i));
            let maxNum = existing.reduce((m, f) => Math.max(m, parseInt(f.match(/^s(\d+)/)[1])), 0);
            for (const file of files) {
                const mime = file.mimetype || '';
                if (!mime.startsWith('image/')) { errors.push({ name: file.originalname, error: '仅支持图片文件' }); continue; }
                const raw = sanitizeImageBuffer(file.buffer);
                const isGif = raw.length >= 3 && raw[0] === 0x47 && raw[1] === 0x49 && raw[2] === 0x46;
                const isPng = raw.length >= 4 && raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4E && raw[3] === 0x47;
                if (!isPng && !isGif) { errors.push({ name: file.originalname, error: '仅支持 PNG/GIF' }); continue; }
                maxNum += 1;
                const id = `s${maxNum}`;
                const ext = isGif ? '.gif' : '.png';
                const destPath = path.join(EMOJI_REGULAR_DIR, `${id}${ext}`);
                if (isGif) {
                    fs.writeFileSync(destPath, raw);
                } else {
                    const img = await Jimp.read(raw);
                    img.cover(240, 240);
                    await img.writeAsync(destPath);
                }
                const fileBuf = fs.readFileSync(destPath);
                entries.push({ id, file: `/emoji/regular/${id}${ext}`, hash: emojiFileHash(fileBuf), size: fileBuf.length });
            }
        } else if (category === 'super') {
            // 支持 .tgs（Telegram 动图 = gzip 压缩的 Lottie JSON）：解压后按 Lottie JSON 校验并落盘。
            let manifest = [];
            try { manifest = JSON.parse(await fs.promises.readFile(LOTTIE_MANIFEST_PATH, 'utf8')); } catch (e) { manifest = []; }
            let maxNum = manifest.reduce((m, x) => Math.max(m, Number(x) || 0), 0);
            for (const file of files) {
                const mime = file.mimetype || '';
                const lowerName = (file.originalname || '').toLowerCase();
                const isTgs = lowerName.endsWith('.tgs') || (file.buffer[0] === 0x1f && file.buffer[1] === 0x8b);
                let jsonStr;
                try {
                    jsonStr = isTgs ? zlib.gunzipSync(file.buffer).toString('utf8') : file.buffer.toString('utf8');
                } catch (e) { const tgsTrunc = /unexpected end|end of file|not a gzip|incorrect header/i.test(e.message); errors.push({ name: file.originalname, error: '无效的 TGS 文件（gzip 解压失败，需为 gzip 压缩的 Lottie JSON' + (tgsTrunc ? '，文件可能被截断/不完整' : '') + '）' }); continue; }
                if (!isTgs && !mime.includes('json') && !mime.includes('text')) { errors.push({ name: file.originalname, error: '超级表情仅支持 Lottie JSON / TGS 文件' }); continue; }
                try {
                    JSON.parse(jsonStr);
                } catch (e) {
                    const truncated = /end of (json|input)/i.test(e.message);
                    const kind = isTgs ? 'TGS 解压后的 Lottie JSON' : 'Lottie JSON';
                    const hint = truncated ? '（文件可能被截断或不完整）' : '（不是合法 JSON）';
                    errors.push({ name: file.originalname, error: `无效的 ${kind}${hint}` });
                    continue;
                }
                maxNum += 1;
                const num = String(maxNum);
                const id = `s${num}`;
                // 统一以 .tgs 落盘：tgs 上传保留原始 gzip 字节；json 上传自动 gzip 压缩后保存，减小传输体积
                // （与 buildSuperEntry 的探测逻辑一致：catalog 只认 .tgs，客户端下载后再解压渲染）。
                const destPath = path.join(LOTTIE_DIR, `${num}.tgs`);
                const outBytes = isTgs ? file.buffer : zlib.gzipSync(Buffer.from(jsonStr, 'utf8'));
                fs.writeFileSync(destPath, outBytes);
                if (!manifest.includes(num)) manifest.push(num);
                // 返回解压后 Lottie JSON 的 hash/size（与 buildSuperEntry 语义一致），前端即时显示无需等下次预拉取
                const logicalBuf = Buffer.from(jsonStr, 'utf8');
                entries.push({ id, file: `/lottie/${num}.tgs`, hash: emojiFileHash(logicalBuf), size: logicalBuf.length, format: 'tgs' });
            }
            manifest.sort((a, b) => Number(a) - Number(b));
            safeWriteJSON(LOTTIE_MANIFEST_PATH, manifest);
        }
        emojiCatalogCache = null;
        // 批量上传：返回 entries（成功列表）与 errors（失败明细），前端据此报告「成功 N / 失败 M」
        res.json({
            success: entries.length > 0,
            entries,
            errors,
            count: entries.length,
            failCount: errors.length,
            entry: entries[0] || null,
            error: entries.length === 0 && errors.length ? (errors[0].error || '全部上传失败') : undefined
        });
    } catch (e) {
        console.error('[emoji-admin] 上传失败:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/** 从回收站永久删除（物理删除文件） */
app.post('/emoji/admin/destroy', requirePageAuthJson, async (req, res) => {
    try {
        const { category, ids } = req.body || {};
        if (!['regular', 'super', 'custom'].includes(category) || !Array.isArray(ids)) {
            return res.status(400).json({ success: false, error: '参数错误' });
        }
        const recycle = await readRecycleBin();
        if (!recycle[category]) recycle[category] = [];
        const destroySet = new Set(ids);
        recycle[category] = recycle[category].filter(e => {
            if (!destroySet.has(e.id)) return true;
            // 物理删除文件：super 按编号解析（历史数据 file 可能是 .json，磁盘实为 .tgs），regular/custom 用 file 文件名
            try {
                if (category === 'super') {
                    const num = String(e.id).replace(/^s/i, '');
                    for (const ext of ['tgs', 'json']) {
                        const fp = path.join(LOTTIE_DIR, `${num}.${ext}`);
                        if (fs.existsSync(fp)) fs.unlinkSync(fp);
                    }
                } else {
                    const base = path.basename(e.file || '');
                    const dir = category === 'custom' ? EMOJI_CUSTOM_DIR : EMOJI_REGULAR_DIR;
                    const fp = path.join(dir, base);
                    if (fs.existsSync(fp)) fs.unlinkSync(fp);
                }
            } catch (err) { console.warn('[emoji-admin] 物理删除失败:', err.message); }
            return false;
        });
        safeWriteJSON(EMOJI_RECYCLE_JSON, recycle);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 超级表情 Lottie JSON 代理：统一解压 .tgs 后返回 JSON，避免前端依赖 DecompressionStream
// （该 API 仅限安全上下文，内网 http 访问时可能不可用，导致 .tgs 缩略图部分/全部渲染失败）。普通 .json 亦兼容。
// 按编号解析并兼容历史数据：磁盘统一以 .tgs 存储，回收站里可能存在 .json 旧路径，两种扩展名都尝试。
app.get('/emoji/lottie', (req, res) => {
    try {
        const file = String(req.query.file || '');
        const m = file.match(/\/(\d+)\.(tgs|json)$/i);
        if (!m) return res.status(400).json({ success: false, error: '非法的表情文件' });
        const num = m[1];
        const candidates = [`${num}.tgs`, `${num}.json`];
        let abs = null;
        for (const c of candidates) { const p = path.join(LOTTIE_DIR, c); if (fs.existsSync(p)) { abs = p; break; } }
        if (!abs) return res.status(404).json({ success: false, error: '未找到表情文件' });
        let buf = fs.readFileSync(abs);
        if (abs.endsWith('.tgs')) {
            try { buf = zlib.gunzipSync(buf); } catch (e) { return res.status(500).json({ success: false, error: 'TGS 解压失败' }); }
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.send(buf);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 超级表情静态缩略图：服务端用 rlottie（wasm，与 APP 同引擎）渲染一帧为 PNG。
// 彻底绕开 lottie-web 在浏览器中对部分 v5.12.x 文件渲染空白的问题。
// 失败（文件缺失 / 解析失败 / 渲染为空）返回 404，前端据此显示编号兜底。
app.get('/emoji/thumb', async (req, res) => {
    try {
        const file = String(req.query.file || '');
        const m = file.match(/\/(\d+)\.(tgs|json)$/i);
        if (!m) return res.status(400).end();
        const num = m[1];
        const size = Math.min(512, Math.max(64, parseInt(req.query.size || '256', 10) || 256));
        const png = await renderLottieThumb(num, size);
        if (!png) return res.status(404).end();
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.end(png);
    } catch (e) {
        res.status(500).end();
    }
});

// 表情管理页面路由
app.get('/emoji-admin', requirePageAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'emoji-admin.html'));
});

/**
 * 判定图片是否为动态图：
 * - GIF：按动图处理（自定义表情里的 GIF 基本都是动图）；
 * - PNG/APNG：扫描 chunk，出现 `acTL`（动画控制块，必在 IDAT 之前）即为动图。
 * 只读文件头与前几个 chunk，不解码整图，开销极小。
 * 必须放在服务端：客户端据此决定「全屏弹幕（动图）还是横幅（静态）」的展示策略。
 */
function isAnimatedImageBuffer(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 8) return false;
    // GIF: "GIF87a" / "GIF89a"
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
    // PNG 签名: 89 50 4E 47 0D 0A 1A 0A
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) return false;
    let pos = 8;
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const chunkEnd = pos + 8 + len + 4;
        if (chunkEnd > buf.length) break;
        if (type === 'acTL') return true;                      // 动画控制块 → 动图
        if (type === 'IDAT' || type === 'IEND') return false;  // 已到图像数据/结尾 → 静态
        pos = chunkEnd;
    }
    return false;
}

// 部分客户端/图库产出的 PNG 在 IEND 之后携带多余字节（缩略图、元数据等），
// 会让 Jimp 内置的旧版 pngjs 解析报 "unrecognised content at end of stream"。
// 这里按 PNG 规范扫描到 IEND 块（含 4 字节 CRC）即截断，丢弃尾部垃圾字节（对合法 PNG 无损）。
function sanitizeImageBuffer(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 8) return buf;
    // PNG 签名: 89 50 4E 47 0D 0A 1A 0A
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) return buf;
    let pos = 8;
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const chunkEnd = pos + 8 + len + 4; // 4(长度)+4(类型)+len(数据)+4(CRC)
        if (chunkEnd > buf.length) break;
        if (type === 'IEND') return buf.subarray(0, chunkEnd);
        pos = chunkEnd;
    }
    return buf;
}

// ==================== 设备头像：上传（服务端压缩优化后存储） ====================
// 上传：multer 收内存 → jimp 压缩为 256×256 JPEG（quality 82，体积降 95%+）→ 落盘 data/avatars/<id>.jpg
// 成功后 deviceRegistry.bumpAvatar 版本号 +1，并通知信任对端重新拉取（未变更则对端用本地缓存，不重复下载）。
app.put('/api/device/:deviceId/avatar', upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: '未收到图片' });
        const deviceId = String(req.params.deviceId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
        if (!deviceId) return res.status(400).json({ success: false, error: '非法 deviceId' });
        const img = await Jimp.read(sanitizeImageBuffer(req.file.buffer));
        img.cover(256, 256).quality(82);
        fs.mkdirSync(AVATAR_DIR, { recursive: true });
        await img.writeAsync(path.join(AVATAR_DIR, `${deviceId}.jpg`));
        const avatarVersion = await deviceRegistry.bumpAvatar(deviceId);
        try {
            if (typeof remoteAssist.notifyAvatarChanged === 'function') remoteAssist.notifyAvatarChanged(deviceId, avatarVersion);
        } catch (e) { console.warn('[avatar] notifyAvatarChanged 失败:', e && e.message); }
        res.json({ success: true, avatarVersion, url: `/avatars/${deviceId}.jpg` });
    } catch (e) {
        console.error('[avatar] 上传失败:', e);
        res.status(500).json({ success: false, error: '服务端处理失败: ' + e.message });
    }
});

/**
 * 发布新版本：上传 APK，服务端从二进制 AndroidManifest.xml 自动解析 versionName/versionCode，
 * 解析成功以解析值为准（覆盖手填，防止手填错），失败则使用手填值。
 * 落盘：覆盖根目录 starclick.apk（已被静态托管），并写 updates/latest.json。
 */
app.post('/api/app/publish', upload.single('apk'), (req, res) => {
    try {
        if (!req.file) {
            return res.json({ success: false, message: '未收到 APK 文件' });
        }
        const apkBuf = req.file.buffer;
        const parsed = parseApkVersion(apkBuf);

        // 手填值优先用于兜底，但若解析成功则以解析为准
        let versionName = (req.body.versionName || '').trim();
        let versionCode = parseInt(req.body.versionCode || '', 10);
        const autoName = parsed.versionName || '';
        const autoCode = parsed.versionCode || '';

        if (autoCode) {
            versionCode = parseInt(autoCode, 10);
        }
        if (autoName) {
            versionName = autoName;
        }

        if (!versionName || !versionCode || isNaN(versionCode)) {
            return res.json({
                success: false,
                message: '无法识别版本号。APK 解析失败，请手动填写版本号与版本代码后重试。'
            });
        }

        // 落盘 APK：统一存放到 updates/ 目录（不再在根目录保留 starclick.apk）
        fs.writeFileSync(path.join(UPDATES_DIR, `starclick-${versionCode}.apk`), apkBuf);

        const publishedAt = new Date().toISOString();

        // 写 latest.json
        const latest = {
            versionName,
            versionCode,
            apkUrl: `/api/app/download/${versionCode}`,
            size: apkBuf.length,
            note: (req.body.note || '').toString().trim(),
            parsedFromApk: !!(autoName || autoCode),
            publishedAt
        };
        safeWriteJSON(LATEST_JSON, latest);

        // 写每个版本独立的元数据文件（历史版本页 / 单版本下载使用）
        safeWriteJSON(path.join(UPDATES_DIR, `starclick-${versionCode}.json`), latest);

        console.log(`[app/publish] 发布成功 v${versionName} (code ${versionCode}), 自动解析=${latest.parsedFromApk}, 大小=${(apkBuf.length / 1024 / 1024).toFixed(1)}MB`);
        res.json({ success: true, message: '发布成功', data: latest });
    } catch (e) {
        console.error('[app/publish] 失败:', e);
        res.json({ success: false, message: '发布异常：' + e.message });
    }
});

/**
 * 仅解析 APK 版本号（不落盘、不发布），用于发布页面选文件后自动回填。
 */
app.post('/api/app/parse', upload.single('apk'), (req, res) => {
    try {
        if (!req.file) {
            return res.json({ success: false, message: '未收到 APK 文件' });
        }
        const parsed = parseApkVersion(req.file.buffer);
        const versionName = (req.body.versionName || '').trim() || parsed.versionName;
        const versionCode = parsed.versionCode || (req.body.versionCode || '').trim();
        res.json({
            success: true,
            data: {
                versionName,
                versionCode,
                parsedFromApk: !!(parsed.versionName || parsed.versionCode),
                fileName: req.file.originalname,
                size: req.file.buffer.length
            }
        });
    } catch (e) {
        console.error('[app/parse] 失败:', e);
        res.json({ success: false, message: '解析异常：' + e.message });
    }
});

/**
 * 查询最新版本信息（APP 检查更新调用）。
 */
app.get('/api/app/latest', (req, res) => {
    const latest = safeReadJSON(LATEST_JSON, null);
    if (latest) {
        res.json({ success: true, data: latest });
    } else {
        res.json({ success: false, message: '暂无已发布版本', data: null });
    }
});

/**
 * 查询历史所有已发布版本（历史版本页调用）。
 * 扫描 updates/ 下的 starclick-<code>.json 与对应 .apk，按 versionCode 倒序返回。
 * 每个版本含独立下载地址 /api/app/download/<versionCode>。
 */
app.get('/api/app/history', (req, res) => {
    try {
        if (!fs.existsSync(UPDATES_DIR)) {
            return res.json({ success: true, versions: [], total: 0 });
        }
        // 先收集每个 versionCode 的元数据（优先读 .json，缺失则由文件名兜底）
        const metas = new Map();
        const files = fs.readdirSync(UPDATES_DIR);
        // 1) 读元数据 json
        files.filter(f => /^starclick-(\d+)\.json$/.test(f)).forEach(f => {
            const code = parseInt(f.match(/^starclick-(\d+)\.json$/)[1], 10);
            const meta = safeReadJSON(path.join(UPDATES_DIR, f), null);
            if (meta) metas.set(code, meta);
        });
        // 2) 补齐只有 .apk 没有 .json 的历史文件（兼容旧发布流程）
        files.filter(f => /^starclick-(\d+)\.apk$/.test(f)).forEach(f => {
            const code = parseInt(f.match(/^starclick-(\d+)\.apk$/)[1], 10);
            const apkPath = path.join(UPDATES_DIR, f);
            if (!metas.has(code)) {
                metas.set(code, {
                    versionName: String(code),
                    versionCode: code,
                    size: fs.statSync(apkPath).size,
                    note: '',
                    publishedAt: null
                });
            }
        });
        const versions = Array.from(metas.values())
            .map(v => ({
                versionName: v.versionName,
                versionCode: v.versionCode,
                size: v.size,
                note: v.note || '',
                parsedFromApk: !!v.parsedFromApk,
                publishedAt: v.publishedAt || null,
                apkUrl: `/api/app/download/${v.versionCode}`,
                isLatest: (metas.size > 0 && v.versionCode === Math.max(...Array.from(metas.keys())))
            }))
            .sort((a, b) => Number(b.versionCode) - Number(a.versionCode));
        res.json({ success: true, versions, total: versions.length });
    } catch (e) {
        console.error('[app/history] 失败:', e);
        res.json({ success: false, message: '读取历史版本失败：' + e.message, versions: [], total: 0 });
    }
});

/**
 * 单版本 APK 下载（历史版本页「下载」按钮调用）。
 * 文件不存在返回 404。
 */
app.get('/api/app/download/:versionCode', (req, res) => {
    const code = parseInt(req.params.versionCode, 10);
    if (!code || code <= 0) {
        return res.status(400).json({ success: false, message: '非法的版本代码' });
    }
    const apkPath = path.join(UPDATES_DIR, `starclick-${code}.apk`);
    if (!fs.existsSync(apkPath)) {
        return res.status(404).json({ success: false, message: `版本 ${code} 的安装包不存在` });
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="starclick-v${code}.apk"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(apkPath);
});

/**
 * 删除单个历史版本（同时删除 .apk 与 .json 实际文件，并维护 latest.json）。
 * 若删除的是当前线上最新版，则把 latest.json 指向剩余版本中 versionCode 最大者，没有则置空。
 */
app.delete('/api/app/version/:versionCode', (req, res) => {
    const code = parseInt(req.params.versionCode, 10);
    if (!code || code <= 0) {
        return res.status(400).json({ success: false, message: '非法的版本代码' });
    }
    const apkPath = path.join(UPDATES_DIR, `starclick-${code}.apk`);
    const jsonPath = path.join(UPDATES_DIR, `starclick-${code}.json`);
    if (!fs.existsSync(apkPath) && !fs.existsSync(jsonPath)) {
        return res.status(404).json({ success: false, message: `版本 ${code} 不存在` });
    }
    try {
        if (fs.existsSync(apkPath)) fs.unlinkSync(apkPath);
        if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);

        // 维护 latest.json：若被删的是当前最新，则刷新为剩余最大版本
        const latest = safeReadJSON(LATEST_JSON, null);
        if (latest && Number(latest.versionCode) === code) {
            // 重新扫描剩余版本，取 versionCode 最大者
            let maxCode = -1;
            if (fs.existsSync(UPDATES_DIR)) {
                fs.readdirSync(UPDATES_DIR)
                    .filter(f => /^starclick-(\d+)\.json$/.test(f))
                    .forEach(f => {
                        const c = parseInt(f.match(/^starclick-(\d+)\.json$/)[1], 10);
                        if (c > maxCode) maxCode = c;
                    });
            }
            if (maxCode > 0) {
                const newLatest = safeReadJSON(path.join(UPDATES_DIR, `starclick-${maxCode}.json`), null);
                safeWriteJSON(LATEST_JSON, newLatest || {
                    versionName: String(maxCode), versionCode: maxCode,
                    apkUrl: `/api/app/download/${maxCode}`, size: 0, note: '', publishedAt: null
                });
            } else {
                // 没有剩余版本，清空 latest
                if (fs.existsSync(LATEST_JSON)) fs.unlinkSync(LATEST_JSON);
            }
        }
        res.json({ success: true, message: `版本 ${code} 已删除` });
    } catch (e) {
        console.error('[app/version delete] 失败:', e);
        res.status(500).json({ success: false, message: '删除失败：' + e.message });
    }
});

// 便捷路由：浏览器访问 /versions 直接打开历史版本页
app.get('/versions', requirePageAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

const server = app.listen(PORT, HOST, () => {
    console.log('=================================');
    console.log('  StarClick Web Server v2.0');
    console.log('  应用使用记录云端存储');
    console.log('=================================');
    console.log(`服务运行在: http://${HOST}:${PORT}`);
    console.log(`环境: ${process.env.NODE_ENV || 'development'}`);
    console.log(`启动时间: ${new Date().toLocaleString('zh-CN')}`);
    console.log('=================================');
    console.log('可用的API接口:');
    console.log(`  GET  /                          服务器信息`);
    console.log(`  GET  /api/health                健康检查`);
    console.log(`  POST /api/device/register       注册设备`);
    console.log(`  GET  /api/devices               获取设备列表`);
    console.log(`  PUT  /api/device/:id/name       更新设备名称`);
    console.log(`  POST /api/usage/sync            增量同步记录`);
    console.log(`  GET  /api/usage/:id/:date       获取日期数据`);
    console.log(`  GET  /api/usage/:id/range       获取范围数据`);
    console.log(`  POST /api/remote/subscription   远程协助套餐`);
    console.log(`  WS   /ws/remote                 远程协助信令通道`);
    console.log('=================================');
});

// 挂载远程协助 WebSocket 信令通道（复用同一 HTTP 服务，不另起端口）
remoteAssist.attach(server);
remoteAssist.startTimeoutWatchdog();
console.log('[remote] 远程协助信令模块已挂载: /ws/remote');

// 404 兜底与错误处理中间件必须放在所有路由之后，否则会拦截后续注册的路由
app.use((req, res) => {
    console.log('[404] 未匹配路由:', req.method, req.originalUrl || req.url, 'path=', req.path);
    res.status(404).json({
        success: false,
        error: '未找到该接口',
        path: req.path,
        method: req.method
    });
});

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    // multer 限制类错误：换算成中文可读原因，避免前端只收到「服务器内部错误」
    let status = err.status || 500;
    let reason = err.message || '未知错误';
    if (err.code === 'LIMIT_FILE_SIZE') {
        reason = `单个文件过大（上限 ${Math.round(EMOJI_UPLOAD_MAX_BYTES / 1024 / 1024)}MB）`;
    } else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        reason = `单次上传文件数量过多（最多 ${MAX_EMOJI_BATCH} 个）`;
    }
    console.error(`[server-error] ${req.method} ${req.originalUrl} -> ${reason}`);
    if (err.stack) console.error(err.stack);
    res.status(status).json({
        success: false,
        error: reason,
        message: err.message || reason
    });
});

module.exports = app;
