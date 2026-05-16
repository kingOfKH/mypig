require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const DATA_DIR = path.join(__dirname, 'data');
const DEVICES_DIR = path.join(DATA_DIR, 'devices');
const USAGE_DIR = path.join(DATA_DIR, 'usage');

function ensureDirectories() {
    [DATA_DIR, DEVICES_DIR, USAGE_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}
ensureDirectories();

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
        timestamp: new Date().toISOString(),
        endpoints: {
            'GET /': '服务器信息',
            'GET /api/health': '健康检查',
            'POST /api/device/register': '注册设备',
            'GET /api/devices': '获取所有设备列表',
            'POST /api/usage/sync': '增量同步使用记录',
            'GET /api/usage/:deviceId/:date': '获取指定设备日期数据',
            'GET /api/usage/:deviceId/range': '获取日期范围数据',
            'PUT /api/device/:deviceId/name': '更新设备名称'
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
        timestamp: new Date().toISOString(),
        dataStats: {
            devices: fs.existsSync(DEVICES_DIR) ? fs.readdirSync(DEVICES_DIR).length : 0,
            storageType: 'JSON File System'
        }
    });
});

apiRouter.post('/device/register', async (req, res) => {
    const { deviceId, deviceName } = req.body;
    
    await withFileLock(DEVICES_DIR, async () => {
        let devices = [];
        const devicesFile = path.join(DEVICES_DIR, 'registry.json');
        
        if (fs.existsSync(devicesFile)) {
            devices = JSON.parse(fs.readFileSync(devicesFile, 'utf8'));
        }
        
        let existingDevice = devices.find(d => d.deviceId === deviceId);
        
        if (existingDevice) {
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
                createdAt: new Date().toISOString(),
                lastActiveAt: new Date().toISOString()
            };
            
            devices.push(newDevice);
            fs.writeFileSync(devicesFile, JSON.stringify(devices, null, 2));
            
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
    
    if (!fs.existsSync(devicesFile)) {
        res.json({
            success: true,
            devices: [],
            total: 0
        });
        return;
    }
    
    const devices = JSON.parse(fs.readFileSync(devicesFile, 'utf8'));
    
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
    
    await withFileLock(DEVICES_DIR, async () => {
        const devicesFile = path.join(DEVICES_DIR, 'registry.json');
        
        if (!fs.existsSync(devicesFile)) {
            res.status(404).json({
                success: false,
                error: '设备不存在'
            });
            return;
        }
        
        let devices = JSON.parse(fs.readFileSync(devicesFile, 'utf8'));
        const deviceIndex = devices.findIndex(d => d.deviceId === deviceId);
        
        if (deviceIndex === -1) {
            res.status(404).json({
                success: false,
                error: '设备不存在'
            });
            return;
        }
        
        devices[deviceIndex].deviceName = deviceName.trim();
        devices[deviceIndex].lastActiveAt = new Date().toISOString();
        
        fs.writeFileSync(devicesFile, JSON.stringify(devices, null, 2));
        
        res.json({
            success: true,
            message: '设备名称更新成功',
            device: devices[deviceIndex]
        });
    });
});

apiRouter.post('/usage/sync', async (req, res) => {
    const { deviceId, records, deletedIds } = req.body;
    
    if (!deviceId) {
        res.status(400).json({
            success: false,
            error: '缺少设备ID'
        });
        return;
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
                lastSyncAt: new Date().toISOString()
            };
            
            if (fs.existsSync(usageFile)) {
                dailyData = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
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
            
            dailyData.lastSyncAt = new Date().toISOString();
            fs.writeFileSync(usageFile, JSON.stringify(dailyData, null, 2));
        });
    }
    
    await withFileLock(DEVICES_DIR, async () => {
        const devicesFile = path.join(DEVICES_DIR, 'registry.json');
        if (fs.existsSync(devicesFile)) {
            let devices = JSON.parse(fs.readFileSync(devicesFile, 'utf8'));
            const deviceIndex = devices.findIndex(d => d.deviceId === deviceId);
            if (deviceIndex !== -1) {
                devices[deviceIndex].lastActiveAt = new Date().toISOString();
                fs.writeFileSync(devicesFile, JSON.stringify(devices, null, 2));
            }
        }
    });
    
    res.json({
        success: true,
        message: '同步成功',
        results: results,
        syncedAt: new Date().toISOString()
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
    
    const data = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
    
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
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                allData.push(data);
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

app.use('/api', apiRouter);

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

app.listen(PORT, HOST, () => {
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
    console.log('=================================');
});

module.exports = app;
