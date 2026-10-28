// 合成限额数据验证独立管理页，不连接真实账户或业务数据库。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { chromium } = require('playwright');
const root = resolve('apps/web/dist');
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = resolve(root, path === '/' ? 'index.html' : path === '/admin' ? 'admin.html' : '.' + path);
    if (!file.startsWith(root + '/')) throw Error('invalid path');
    res.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] ?? 'application/octet-stream');
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('wp_token', 'synthetic-admin-token'));
  const limits = {
    defaults: { messageQuota: 10, tokenQuota: 200000, uploadQuotaBytes: 52428800, concurrentTaskLimit: 1, revision: 3 },
    users: [
      {
        id: '11111111-1111-4111-8111-111111111111', username: 'admin', role: 'admin', platformAdmin: true, disabled: false,
        provisioningSource: 'first_admin', revision: 1, resetsAt: new Date(Date.now() + 86400000).toISOString(),
        limits: { messageQuota: 0, tokenQuota: 0, uploadQuotaBytes: 0, concurrentTaskLimit: 0 },
        usage: { messages: 20, tokens: 34120, uploadBytes: 4194304, concurrentTasks: 0 },
      },
      {
        id: '22222222-2222-4222-8222-222222222222', username: 'trial-user', role: 'member', platformAdmin: false, disabled: false,
        provisioningSource: 'self', revision: 2, resetsAt: new Date(Date.now() + 86400000).toISOString(),
        limits: { messageQuota: 10, tokenQuota: 200000, uploadQuotaBytes: 52428800, concurrentTaskLimit: 1 },
        usage: { messages: 3, tokens: 4820, uploadBytes: 1048576, concurrentTasks: 1 },
      },
      {
        id: '33333333-3333-4333-8333-333333333333', username: 'managed-user', role: 'member', platformAdmin: false, disabled: false,
        provisioningSource: 'admin', revision: 1, resetsAt: null,
        limits: { messageQuota: 0, tokenQuota: 0, uploadQuotaBytes: 0, concurrentTaskLimit: 0 },
        usage: { messages: 0, tokens: 0, uploadBytes: 0, concurrentTasks: 0 },
      },
    ],
    notice: '0 表示不限；每日额度按北京时间 12:00 刷新。管理员创建的账户默认四项全部不限，平台管理员始终不限。',
  };
  const policy = { registrationMode: 'open', defaultMessageQuota: 10, defaultTokenQuota: 200000, defaultUploadQuotaBytes: 52428800, defaultConcurrentTaskLimit: 1, revision: 3 };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data = {};
    if (path === '/api/health') data = { ok: true, storage: 'postgresql', chatEnabled: true };
    else if (path === '/api/auth/state') data = { authenticated: true, needsSetup: false, user: { id: limits.users[0].id, username: 'admin', role: 'admin' } };
    else if (path === '/api/users') data = { users: limits.users.map(user => ({ id: user.id, username: user.username, role: user.role, platformAdmin: user.platformAdmin, disabled: false })) };
    else if (path === '/api/admin/limits') data = limits;
    else if (path === '/api/admin/access-policy') data = { policy };
    await route.fulfill({ json: data });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/admin`);
  await page.getByRole('button', { name: '限额管理', exact: true }).click();
  await page.getByRole('heading', { name: '限额管理', exact: true }).waitFor();
  await page.getByText(/管理员创建的账户默认不限，平台管理员始终不受限/).waitFor();
  assert.equal(await page.getByLabel('每日 Token', { exact: true }).count(), 3);
  await page.getByText('managed-user', { exact: true }).waitFor();
  await page.getByText('管理员创建', { exact: true }).waitFor();
  await page.getByText('平台管理员始终不限额度。', { exact: true }).waitFor();
  assert.equal(await page.getByText('trial-user', { exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/workpivot-limits-panel.png', fullPage: true });
  console.log('限额管理页面检查通过：独立导航、四维默认限额、平台管理员保护、管理员创建用户不限。');
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
