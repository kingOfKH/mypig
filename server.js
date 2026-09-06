require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const remoteAssist = require('./remote-assist');

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
    
    const devicesFile = path.join(DEVICES_DIR, 'registry.json');
    
    await withFileLock(devicesFile, async () => {
        let devices = safeReadJSON(devicesFile, []);
        
        console.log(`当前已注册设备数: ${devices.length}, 设备列表: ${devices.map(d => d.deviceId).join(', ')}`);
        
        let existingDevice = devices.find(d => d.deviceId === deviceId);
        
        if (existingDevice) {
            console.log(`设备已存在: ${deviceId}`);
            res.json({
                success: true,
                message: '设备已存在',
                device: existingDevice,
                isNew: false
            });
        } else {
            const newDevice = {
                deviceId: deviceId || generateDeviceId(),
                deviceName: deviceName || `设备${devices.length + 1}`,
                createdAt: getChinaTime(),
                lastActiveAt: getChinaTime()
            };
            
            devices.push(newDevice);
            console.log(`新设备注册: ${newDevice.deviceId}, 总设备数: ${devices.length}`);
            safeWriteJSON(devicesFile, devices);
            
            const deviceUsageDir = path.join(USAGE_DIR, newDevice.deviceId);
            if (!fs.existsSync(deviceUsageDir)) {
                fs.mkdirSync(deviceUsageDir, { recursive: true });
            }
            
            res.json({
                success: true,
                message: '设备注册成功',
                device: newDevice,
                isNew: true
            });
        }
    });
});

apiRouter.get('/devices', (req, res) => {
    const devicesFile = path.join(DEVICES_DIR, 'registry.json');
    const devices = safeReadJSON(devicesFile, []);
    
    res.json({
        success: true,
        devices: devices.map(d => ({
            deviceId: d.deviceId,
            deviceName: d.deviceName,
            createdAt: d.createdAt,
            lastActiveAt: d.lastActiveAt
        })),
        total: devices.length
    });
});

// ---- 远程设备管理接口（管理人员页面使用）----
// 说明：admin 标记由【控制端】在指令（ActionJson.admin）内携带，服务端只转发不覆盖；
// 此处 admins.json 仅用于管理页查询与 admin.query，不参与指令判定。
function requireAdminToken(req, res, next) {
    const token = process.env.ADMIN_TOKEN;
    if (!token) {
        // 未配置令牌：仅允许本机/内网访问，避免公网裸奔被随意提权
        const ip = (req.headers && req.headers['x-forwarded-for']) || req.ip || '';
        const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('::ffff:127.');
        if (!local) return res.status(403).json({ success: false, error: 'ADMIN_TOKEN 未配置且非本机访问被拒绝' });
        return next();
    }
    const h = req.headers['x-admin-token'] || (req.query && req.query.token) || '';
    if (h !== token) return res.status(403).json({ success: false, error: '令牌无效' });
    next();
}

// 控制端查询自身是否为管理设备（无需令牌，供客户端进入页面时拉取默认身份）
apiRouter.get('/admin/status', (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ success: false, error: '缺少 deviceId' });
    res.json({ success: true, isAdmin: remoteAssist.isAdmin(deviceId) });
});

// 管理页：已注册设备列表（含 admin 标记），需 ADMIN_TOKEN
apiRouter.get('/admin/devices', requireAdminToken, (req, res) => {
    const devicesFile = path.join(DEVICES_DIR, 'registry.json');
    const devices = safeReadJSON(devicesFile, []);
    const list = devices.map(d => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName || '',
        createdAt: d.createdAt || '',
        lastActiveAt: d.lastActiveAt || '',
        isAdmin: remoteAssist.isAdmin(d.deviceId),
    }));
    res.json({ success: true, devices: list, total: list.length });
});

// 管理页：设置/取消管理设备，需 ADMIN_TOKEN
apiRouter.post('/admin/device', requireAdminToken, (req, res) => {
    const { deviceId, isAdmin } = req.body || {};
    if (!deviceId) return res.status(400).json({ success: false, error: '缺少 deviceId' });
    remoteAssist.setAdmin(deviceId, isAdmin === true || isAdmin === 'true', 'admin_page');
    res.json({ success: true, deviceId, isAdmin: remoteAssist.isAdmin(deviceId) });
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
    
    const devicesFile = path.join(DEVICES_DIR, 'registry.json');
    
    await withFileLock(devicesFile, async () => {
        let devices = safeReadJSON(devicesFile, []);
        
        if (!devices || devices.length === 0) {
            res.status(404).json({
                success: false,
                error: '设备不存在'
            });
            return;
        }
        
        const deviceIndex = devices.findIndex(d => d.deviceId === deviceId);
        
        if (deviceIndex === -1) {
            res.status(404).json({
                success: false,
                error: '设备不存在'
            });
            return;
        }
        
        devices[deviceIndex].deviceName = deviceName.trim();
        devices[deviceIndex].lastActiveAt = getChinaTime();
        
        safeWriteJSON(devicesFile, devices);
        
        res.json({
            success: true,
            message: '设备名称更新成功',
            device: devices[deviceIndex]
        });
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
    
    const devicesFile = path.join(DEVICES_DIR, 'registry.json');
    
    await withFileLock(devicesFile, async () => {
        let devices = safeReadJSON(devicesFile, []);
        
        let existingDevice = devices.find(d => d.deviceId === deviceId);
        if (!existingDevice) {
            console.log(`同步时发现新设备，自动注册: ${deviceId}`);
            const newDevice = {
                deviceId: deviceId,
                deviceName: deviceName || `设备${devices.length + 1}`,
                createdAt: getChinaTime(),
                lastActiveAt: getChinaTime()
            };
            devices.push(newDevice);
            safeWriteJSON(devicesFile, devices);
            
            const deviceUsageDir = path.join(USAGE_DIR, deviceId);
            if (!fs.existsSync(deviceUsageDir)) {
                fs.mkdirSync(deviceUsageDir, { recursive: true });
            }
        }
    });
    
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
    
    await withFileLock(devicesFile, async () => {
        let devices = safeReadJSON(devicesFile, []);
        if (devices && devices.length > 0) {
            const deviceIndex = devices.findIndex(d => d.deviceId === deviceId);
            if (deviceIndex !== -1) {
                devices[deviceIndex].lastActiveAt = getChinaTime();
                safeWriteJSON(devicesFile, devices);
            }
        }
    });
    
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

// 被控端上传快照（base64 JSON，零额外依赖）：{ deviceId, peerId, data, ext }
app.post('/api/remote/snapshot/upload', (req, res) => {
    try {
        const { deviceId, data, ext } = req.body || {};
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
        const fileName = `snap_${ts}.${extension}`;
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

// ---- APP 自动更新：发布页面与安装包下载 ----
// 发布页面（publish.html 等静态资源）
app.use('/public', express.static(path.join(__dirname, 'public'), {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
    }
}));
// 便捷路由：浏览器访问 /publish 直接打开发布页
app.get('/publish', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'publish.html'));
});
// 便捷路由：浏览器访问 /admin 直接打开管理人员页
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
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
app.get('/versions', (req, res) => {
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
    console.error('错误:', err);
    res.status(500).json({
        success: false,
        error: '服务器内部错误',
        message: err.message
    });
});

module.exports = app;
