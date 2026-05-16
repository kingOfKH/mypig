# StarClick Web Server

基于 Node.js + Express 的简单后端服务，用于测试和演示。

## 快速开始

### 安装依赖

```bash
npm install
```

### 启动服务器

```bash
npm start
```

服务器将在 `http://localhost:10000` 启动。

> **注意**：默认端口为 10000，这是 Render 平台的默认端口。

### 开发模式（自动重启）

```bash
npm run dev
```

### 运行测试

```bash
npm test
```

## 可用接口

### 基础接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 服务器信息和接口列表 |
| GET | `/api/health` | 健康检查，返回运行时间和内存使用 |
| GET | `/api/test` | 测试接口，返回随机数和时间 |
| POST | `/api/echo` | 回显测试，返回发送的数据 |
| GET | `/api/time` | 获取服务器时间（多种格式） |

### 点击记录接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/click` | 记录点击坐标 |
| GET | `/api/clicks` | 获取点击记录列表（支持分页） |
| DELETE | `/api/clicks` | 清空所有点击记录 |

### 设备接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/device/register` | 设备注册 |
| GET | `/api/config` | 获取配置信息 |

## 接口示例

### 1. 健康检查

```bash
curl http://localhost:3000/api/health
```

响应：
```json
{
  "success": true,
  "status": "healthy",
  "uptime": 123.456,
  "memory": {...},
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

### 2. 测试接口

```bash
curl http://localhost:3000/api/test
```

响应：
```json
{
  "success": true,
  "message": "测试接口正常工作",
  "data": {
    "randomNumber": 0.123,
    "timestamp": 1234567890,
    "date": "2024-01-01 20:00:00"
  }
}
```

### 3. 回显测试

```bash
curl -X POST http://localhost:3000/api/echo \
  -H "Content-Type: application/json" \
  -d '{"message":"测试消息","data":{"key":"value"}}'
```

响应：
```json
{
  "success": true,
  "message": "回显成功",
  "echo": {
    "message": "测试消息",
    "data": {"key": "value"},
    "receivedAt": "2024-01-01T12:00:00.000Z"
  }
}
```

### 4. 记录点击

```bash
curl -X POST http://localhost:3000/api/click \
  -H "Content-Type: application/json" \
  -d '{"x":100,"y":200,"packageName":"com.example.app"}'
```

响应：
```json
{
  "success": true,
  "message": "点击记录已保存",
  "record": {
    "id": 1,
    "x": 100,
    "y": 200,
    "packageName": "com.example.app",
    "action": "click",
    "timestamp": "2024-01-01T12:00:00.000Z",
    "serverTime": 1234567890
  }
}
```

### 5. 获取点击记录

```bash
curl "http://localhost:3000/api/clicks?limit=20&offset=0"
```

响应：
```json
{
  "success": true,
  "total": 5,
  "limit": 20,
  "offset": 0,
  "records": [...],
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

### 6. 设备注册

```bash
curl -X POST http://localhost:3000/api/device/register \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"device-001","deviceName":"测试设备","appVersion":"1.0.0"}'
```

### 7. 获取配置

```bash
curl http://localhost:3000/api/config
```

响应：
```json
{
  "success": true,
  "config": {
    "clickInterval": 500,
    "maxRecords": 100,
    "serverTime": 1234567890,
    "features": {
      "autoClick": true,
      "recording": true,
      "playback": true
    }
  }
}
```

## 环境变量

在 `.env` 文件中配置：

```env
PORT=3000              # 服务器端口
HOST=0.0.0.0          # 监听地址
NODE_ENV=development  # 运行环境
```

## 部署到 Render

Render 平台要求：
- **必须绑定到 `0.0.0.0`**（不能是 localhost）
- **默认端口是 `10000`**（通过 `process.env.PORT` 获取）
- Render 会自动设置 `PORT` 环境变量

### 方式一：Render Dashboard

1. 登录 [Render](https://render.com/)
2. 创建新的 Web Service
3. 连接 Git 仓库
4. 设置：
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node
   - 端口会自动使用环境变量 `PORT`（默认10000）

### 方式二：render.yaml（推荐）

在项目根目录创建 `render.yaml`：

```yaml
services:
  - type: web
    name: starclick-api
    env: node
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: NODE_ENV
        value: production
```

部署后，服务将可通过 `https://starclick-api.onrender.com` 访问。

## 项目结构

```
web-server/
├── server.js       # 主服务器文件
├── test.js         # 测试脚本
├── package.json    # 项目配置
├── .env           # 环境变量
└── README.md      # 说明文档
```

## 技术栈

- **Node.js** - JavaScript 运行时
- **Express** - Web 框架
- **CORS** - 跨域支持
- **dotenv** - 环境变量管理
- **nodemon** - 开发时自动重启

## 注意事项

- 点击记录存储在内存中，服务器重启后会清空
- 最大保留 100 条点击记录
- 所有接口返回统一的 JSON 格式
- 错误处理包含适当的 HTTP 状态码

## License

MIT
