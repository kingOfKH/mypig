const http = require('http');

const BASE_URL = 'http://localhost:10000';

function makeRequest(method, path, data = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    resolve({
                        status: res.statusCode,
                        data: JSON.parse(body)
                    });
                } catch (e) {
                    resolve({
                        status: res.statusCode,
                        data: body
                    });
                }
            });
        });

        req.on('error', reject);
        
        if (data) {
            req.write(JSON.stringify(data));
        }
        
        req.end();
    });
}

async function runTests() {
    console.log('开始测试 StarClick Web Server...\n');
    
    try {
        console.log('1. 测试首页 GET /');
        let result = await makeRequest('GET', '/');
        console.log('状态:', result.status);
        console.log('响应:', JSON.stringify(result.data, null, 2));
        console.log();
        
        console.log('2. 测试健康检查 GET /api/health');
        result = await makeRequest('GET', '/api/health');
        console.log('状态:', result.status);
        console.log('运行时间:', Math.floor(result.data.uptime), '秒');
        console.log();
        
        console.log('3. 测试测试接口 GET /api/test');
        result = await makeRequest('GET', '/api/test');
        console.log('状态:', result.status);
        console.log('响应:', JSON.stringify(result.data, null, 2));
        console.log();
        
        console.log('4. 测试回显接口 POST /api/echo');
        result = await makeRequest('POST', '/api/echo', {
            message: '测试消息',
            data: { key: 'value', number: 123 }
        });
        console.log('状态:', result.status);
        console.log('响应:', JSON.stringify(result.data, null, 2));
        console.log();
        
        console.log('5. 测试时间接口 GET /api/time');
        result = await makeRequest('GET', '/api/time');
        console.log('状态:', result.status);
        console.log('服务器时间:', result.data.time.local);
        console.log();
        
        console.log('6. 测试点击记录 POST /api/click');
        result = await makeRequest('POST', '/api/click', {
            x: 100.5,
            y: 200.3,
            packageName: 'com.example.app',
            action: 'tap'
        });
        console.log('状态:', result.status);
        console.log('响应:', JSON.stringify(result.data, null, 2));
        console.log();
        
        console.log('7. 测试获取点击记录 GET /api/clicks');
        result = await makeRequest('GET', '/api/clicks?limit=5');
        console.log('状态:', result.status);
        console.log('记录数:', result.data.total);
        console.log();
        
        console.log('8. 测试配置接口 GET /api/config');
        result = await makeRequest('GET', '/api/config');
        console.log('状态:', result.status);
        console.log('响应:', JSON.stringify(result.data, null, 2));
        console.log();
        
        console.log('✅ 所有测试通过！');
        
    } catch (error) {
        console.error('❌ 测试失败:', error.message);
        console.log('\n请确保服务器正在运行: npm start');
    }
}

runTests();
