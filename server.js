require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const http = require('http');
const remoteAssist = require('./remote-assist');

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

function ensureDirectories() {
    [DATA_DIR, DEVICES_DIR, USAGE_DIR, SNAPSHOT_DIR, CLIPBOARD_DIR].forEach(dir => {
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

app.use((req, res) => {
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

module.exports = app;
