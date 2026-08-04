/**
 * TURN 连通性自检脚本
 * 用法: 先设置环境变量（与服务器 .env / 平台变量一致），然后 `node test-turn.js`
 *
 * 例:
 *   TURN_URL="turn:global.relay.metered.ca:3478?transport=udp|turn:global.relay.metered.ca:3478?transport=tcp|turns:global.relay.metered.ca:5349?transport=tcp" \
 *   TURN_USERNAME="你的username" \
 *   TURN_CREDENTIAL="你的credential" \
 *   node test-turn.js
 */
const dns = require('dns');
const { EventEmitter } = require('events');

// 极简 TURN 分配测试：用 UDP 向 TURN 服务器发送一个 Binding/Allocate 请求太复杂，
// 这里改用更实用的方式：直接解析 TURN 主机名 + 测试端口 TCP 连通性。
const turnUrl = process.env.TURN_URL;
const user = process.env.TURN_USERNAME;
const cred = process.env.TURN_CREDENTIAL;

if (!turnUrl) {
  console.error('❌ 未设置 TURN_URL 环境变量');
  process.exit(1);
}

console.log('TURN_USERNAME 已配置:', !!user);
console.log('TURN_CREDENTIAL 已配置:', !!cred);
console.log('解析到的 TURN 地址:');

const hosts = new Set();
for (const raw of turnUrl.split('|')) {
  const u = raw.trim();
  if (!u) continue;
  // 解析 turn[s]:host:port?transport=xxx
  const m = u.match(/^turns?:(.+?):(\d+)(\?transport=(\w+))?$/);
  if (!m) {
    console.log('  ⚠️ 无法解析:', u);
    continue;
  }
  const host = m[1];
  const port = parseInt(m[2], 10);
  const proto = m[4] || 'udp';
  hosts.add(JSON.stringify({ host, port, proto, raw: u }));
}

const net = require('net');
const list = [...hosts].map(s => JSON.parse(s));

let pending = list.length;
if (pending === 0) {
  console.error('❌ 没有可测试的 TURN 地址');
  process.exit(1);
}

list.forEach(({ host, port, proto, raw }) => {
  console.log(`\n→ 测试 ${raw}`);
  // DNS 解析
  dns.lookup(host, (err, addr) => {
    if (err) {
      console.log(`  ❌ DNS 解析失败: ${err.message}`);
      return finish();
    }
    console.log(`  ✓ DNS 解析: ${host} -> ${addr}`);
    // TCP 端口连通性（turns/tcp/默认都走 TCP；udp 这里仅测 DNS + 提示）
    if (proto === 'tcp' || raw.startsWith('turns:')) {
      const sock = net.connect(port, addr, () => {
        console.log(`  ✓ TCP 端口 ${port} 可连通 ✅`);
        sock.destroy();
        finish();
      });
      sock.setTimeout(5000);
      sock.on('timeout', () => {
        console.log(`  ❌ TCP 端口 ${port} 连接超时`);
        sock.destroy();
        finish();
      });
      sock.on('error', (e) => {
        console.log(`  ❌ TCP 端口 ${port} 连接失败: ${e.message}`);
        finish();
      });
    } else {
      console.log(`  ℹ️ UDP 端口 ${port} 无法用 TCP 测，需实际 TURN allocation（见下方提示）`);
      finish();
    }
  });
});

function finish() {
  if (--pending === 0) {
    console.log('\n--- 结论 ---');
    console.log('如果所有 TURN 地址 DNS 解析成功且 TCP 端口可连通，说明网络层可达。');
    console.log('但真正能否分配 relay 还需 WebRTC 端验证（看日志里是否有 typ relay 候选）。');
    console.log('Metered.ca 标准端口: TURN=3478(udp/tcp), TURNS=5349(tcp/tls)。');
    console.log('若你配的是 :80 / :443，那不是 TURN 媒体端口，必然无 relay 候选。');
  }
}
