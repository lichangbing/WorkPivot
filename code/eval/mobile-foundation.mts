import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { Request, Response } from '../packages/server/node_modules/@types/express/index.js';
import { normalizeServerAddress } from '../apps/mobile/src/server-address.js';
import { mobileCors } from '../packages/server/src/database/mobile-cors.js';

let passed = 0;
const express = createRequire(new URL('../packages/server/package.json', import.meta.url))('express');
function check(name: string, run: () => void) { run(); passed++; console.log(`PASS ${name}`); }
check('HTTPS 地址标准化', () => assert.equal(normalizeServerAddress(' https://EXAMPLE.com:443/ '), 'https://example.com'));
for (const address of ['http://example.com', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com?token=x', 'https://example.com#x', '//example.com', 'javascript:alert(1)', '']) {
  check(`拒绝非服务根地址 ${address.split('?')[0]}`, () => assert.throws(() => normalizeServerAddress(address)));
}
check('开发环境仅允许回环 HTTP', () => {
  assert.equal(normalizeServerAddress('http://127.0.0.1:39987', true), 'http://127.0.0.1:39987');
  assert.throws(() => normalizeServerAddress('http://192.168.1.158', true));
});
check('发布版不允许回环明文', () => assert.throws(() => normalizeServerAddress('http://localhost')));
for (const value of ['*', 'null', 'https://localhost/path', 'https://user:password@localhost']) {
  check('拒绝不明确的来源配置', () => assert.throws(() => mobileCors(value)));
}
const app = express();
app.use('/api', mobileCors('https://localhost,capacitor://localhost'));
app.get('/api/private', (req: Request, res: Response) => { if (req.headers.authorization !== 'Bearer test-only') res.sendStatus(401); else res.json({ ok: true }); });
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
try {
  for (const origin of ['https://localhost', 'capacitor://localhost']) {
    const response = await fetch(base + '/api/private', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    check('允许原生来源预检和偏好/技能 PUT', () => { assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), origin); assert.equal(response.headers.get('access-control-allow-credentials'), null); assert(response.headers.get('access-control-allow-methods')?.split(',').includes('PUT')); });
  }
  const unknown = await fetch(base + '/api/private', { headers: { Origin: 'https://unknown.example', Authorization: 'Bearer test-only' } });
  check('未知网页不获得跨域读取许可', () => assert.equal(unknown.headers.get('access-control-allow-origin'), null));
  const unauthorized = await fetch(base + '/api/private', { headers: { Origin: 'https://localhost' } });
  check('允许来源不绕过登录鉴权', () => assert.equal(unauthorized.status, 401));
  const desktop = await fetch(base + '/api/private', { headers: { Authorization: 'Bearer test-only' } });
  check('原有无 Origin 客户端行为不变', () => { assert.equal(desktop.status, 200); assert.equal(desktop.headers.get('access-control-allow-origin'), null); });
} finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
console.log(`Mobile foundation: ${passed}/${passed}`);
