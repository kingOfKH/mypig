# StarClick Web Server v2.0

应用使用记录云端存储服务 - 支持多设备数据同步

## 功能特性

✅ **设备管理**：自动注册设备，支持设备名称自定义  
✅ **数据隔离**：每个设备数据独立存储  
✅ **增量同步**：只传输变更数据，节省流量  
✅ **JSON存储**：无需数据库，实现简单高效  
✅ **文件锁机制**：防止并发写入冲突  
✅ **按日期存储**：每天一个JSON文件，便于管理  

## 快速开始

### 安装依赖
```bash
npm install
```

### 启动服务器
```bash
npm start
```
服务运行在 `http://localhost:10000`

### 开发模式
```bash
npm run dev
```

## API接口文档

### 1. 健康检查
```
GET /api/health
```
响应示例：
```json
{
  "success": true,
  "status": "healthy",
  "uptime": 123.456,
  "dataStats": {
    "devices": 3,
    "storageType": "JSON File System"
  }
}
```

### 2. 设备注册
```
POST /api/device/register
```
请求体：
```json
{
  "deviceId": "device_001",
  "deviceName": "我的手机"
}
```
响应示例：
```json
{
  "success": true,
  "message": "设备注册成功",
  "device": {
    "deviceId": "device_001",
    "deviceName": "我的手机",
    "createdAt": "2025-01-16T12:00:00.000Z",
    "lastActiveAt": "2025-01-16T12:00:00.000Z"
  },
  "isNew": true
}
```

### 3. 获取设备列表
```
GET /api/devices
```
响应示例：
```json
{
  "success": true,
  "devices": [
    {
      "deviceId": "device_001",
      "deviceName": "我的手机",
      "createdAt": "2025-01-16T12:00:00.000Z",
      "lastActiveAt": "2025-01-16T12:30:00.000Z"
    }
  ],
  "total": 1
}
```

### 4. 更新设备名称
```
PUT /api/device/:deviceId/name
```
请求体：
```json
{
  "deviceName": "新设备名称"
}
```

### 5. 增量同步使用记录
```
POST /api/usage/sync
```
请求体：
```json
{
  "deviceId": "device_001",
  "records": [
    {
      "recordId": "com.example.app_1234567890",
      "packageName": "com.example.app",
      "appName": "示例应用",
      "openTime": 1234567890000,
      "closeTime": 1234567920000,
      "durationMs": 30000,
      "isCompleted": true
    }
  ],
  "deletedIds": ["record_to_delete"]
}
```
响应示例：
```json
{
  "success": true,
  "message": "同步成功",
  "results": {
    "added": 1,
    "updated": 0,
    "deleted": 0
  },
  "syncedAt": "2025-01-16T12:00:00.000Z"
}
```

### 6. 获取指定日期数据
```
GET /api/usage/:deviceId/:date
```
示例：
```
GET /api/usage/device_001/2025-01-16
```
响应示例：
```json
{
  "success": true,
  "data": {
    "date": "2025-01-16",
    "records": [...],
    "lastSyncAt": "2025-01-16T12:30:00.000Z"
  }
}
```

### 7. 获取日期范围数据
```
GET /api/usage/:deviceId/range?startDate=2025-01-01&endDate=2025-01-16
```

## 数据存储结构

```
data/
├── devices/
│   └── registry.json          # 设备注册表
└── usage/
    ├── device_001/            # 设备1的数据
    │   ├── 2025-01-16.json    # 每日记录
    │   └── 2025-01-15.json
    └── device_002/            # 设备2的数据
        └── 2025-01-16.json
```

## 部署到 Render

### 方式一：Dashboard手动部署

1. 登录 [Render](https://dashboard.render.com/)
2. 创建新的 **Web Service**
3. 连接GitHub仓库：`kingOfKH/mypig`
4. 配置：
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node

### 方式二：render.yaml自动部署

项目已包含 `render.yaml` 配置文件，推送后Render会自动部署。

部署地址：`https://starclick-api.onrender.com`

## 环境变量

```env
PORT=10000                    # 服务端口（Render自动设置）
NODE_ENV=production          # 运行环境
```

## 同步策略建议

### 客户端实现要点

1. **入栈/出栈触发**：在应用使用记录入栈或出栈时触发同步检查
2. **最小间隔控制**：距离上次同步至少1分钟
3. **增量同步**：只上传新增或修改的记录
4. **离线支持**：网络不可用时暂存，恢复后自动同步
5. **WorkManager兜底**：每30分钟检查一次未同步数据

### 性能优化

- JSON文件Gzip压缩传输
- 文件锁防止并发冲突
- 按日期分片存储
- 只返回必要字段

## 技术栈

- **Node.js** - JavaScript运行时
- **Express** - Web框架
- **文件系统** - JSON数据存储
- **文件锁** - 并发控制

## License

MIT
