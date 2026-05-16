require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'StarClick Web Server',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        endpoints: {
            'GET /': '服务器信息',
            'GET /api/health': '健康检查',
            'GET /api/test': '测试接口',
            'POST /api/echo': '回显测试',
            'GET /api/time': '获取服务器时间',
            'POST /api/click': '模拟点击记录',
            'GET /api/clicks': '获取点击记录列表'
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
        timestamp: new Date().toISOString()
    });
});

apiRouter.get('/test', (req, res) => {
    res.json({
        success: true,
        message: '测试接口正常工作',
        data: {
            randomNumber: Math.random(),
            timestamp: Date.now(),
            date: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        }
    });
});

apiRouter.post('/echo', (req, res) => {
    const { message, data } = req.body;
    res.json({
        success: true,
        message: '回显成功',
        echo: {
            message: message || '无消息',
            data: data || null,
            receivedAt: new Date().toISOString()
        }
    });
});

apiRouter.get('/time', (req, res) => {
    const now = new Date();
    res.json({
        success: true,
        time: {
            timestamp: now.getTime(),
            iso: now.toISOString(),
            local: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
            utc: now.toUTCString(),
            timezone: 'Asia/Shanghai'
        }
    });
});

let clickRecords = [];
let clickIdCounter = 1;

apiRouter.post('/click', (req, res) => {
    const { x, y, packageName, action } = req.body;
    
    if (x === undefined || y === undefined) {
        return res.status(400).json({
            success: false,
            error: '缺少必要参数：x, y'
        });
    }
    
    const record = {
        id: clickIdCounter++,
        x: parseFloat(x),
        y: parseFloat(y),
        packageName: packageName || 'unknown',
        action: action || 'click',
        timestamp: new Date().toISOString(),
        serverTime: Date.now()
    };
    
    clickRecords.push(record);
    
    if (clickRecords.length > 100) {
        clickRecords = clickRecords.slice(-100);
    }
    
    res.json({
        success: true,
        message: '点击记录已保存',
        record: record
    });
});

apiRouter.get('/clicks', (req, res) => {
    const { limit = 20, offset = 0 } = req.query;
    const limitNum = parseInt(limit);
    const offsetNum = parseInt(offset);
    
    const paginatedRecords = clickRecords
        .slice(offsetNum, offsetNum + limitNum);
    
    res.json({
        success: true,
        total: clickRecords.length,
        limit: limitNum,
        offset: offsetNum,
        records: paginatedRecords,
        timestamp: new Date().toISOString()
    });
});

apiRouter.delete('/clicks', (req, res) => {
    const count = clickRecords.length;
    clickRecords = [];
    clickIdCounter = 1;
    
    res.json({
        success: true,
        message: '所有点击记录已清空',
        deletedCount: count
    });
});

apiRouter.post('/device/register', (req, res) => {
    const { deviceId, deviceName, appVersion } = req.body;
    
    res.json({
        success: true,
        message: '设备注册成功',
        device: {
            deviceId: deviceId || 'unknown',
            deviceName: deviceName || 'unknown',
            appVersion: appVersion || '1.0.0',
            registeredAt: new Date().toISOString(),
            serverTime: Date.now()
        }
    });
});

apiRouter.get('/config', (req, res) => {
    res.json({
        success: true,
        config: {
            clickInterval: 500,
            maxRecords: 100,
            serverTime: Date.now(),
            features: {
                autoClick: true,
                recording: true,
                playback: true
            }
        }
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

app.listen(PORT, HOST, () => {
    console.log('=================================');
    console.log('  StarClick Web Server');
    console.log('=================================');
    console.log(`服务运行在: http://${HOST}:${PORT}`);
    console.log(`环境: ${process.env.NODE_ENV || 'development'}`);
    console.log(`启动时间: ${new Date().toLocaleString('zh-CN')}`);
    console.log('=================================');
    console.log('可用的测试接口:');
    console.log(`  GET  http://localhost:${PORT}/`);
    console.log(`  GET  http://localhost:${PORT}/api/health`);
    console.log(`  GET  http://localhost:${PORT}/api/test`);
    console.log(`  POST http://localhost:${PORT}/api/echo`);
    console.log(`  GET  http://localhost:${PORT}/api/time`);
    console.log(`  POST http://localhost:${PORT}/api/click`);
    console.log(`  GET  http://localhost:${PORT}/api/clicks`);
    console.log('=================================');
});

module.exports = app;
