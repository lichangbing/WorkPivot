// 合成用户管理页验证注册模式单行布局、精简文案和停用操作。
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
    const file = resolve(root, path === '/admin' ? 'admin.html' : '.' + path);
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('wp_token', 'synthetic-admin-token'));
  const users = [
    { id: '11111111-1111-4111-8111-111111111111', username: 'admin', role: 'admin', platformAdmin: true, disabled: false, activeSessions: 1 },
    { id: '22222222-2222-4222-8222-222222222222', username: 'trial-user', email: 'trial@example.test', role: 'member', platformAdmin: false, disabled: false, activeSessions: 1 },
  ];
  const policy = { registrationMode: 'open', defaultMessageQuota: 10, defaultTokenQuota: 200000, defaultUploadQuotaBytes: 52428800, defaultConcurrentTaskLimit: 1, revision: 4 };
  let disabledBody;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data = {};
    if (path === '/api/health') data = { ok: true, storage: 'postgresql' };
    else if (path === '/api/auth/state') data = { authenticated: true, needsSetup: false, user: users[0] };
    else if (path === '/api/users') data = { users };
    else if (path === '/api/admin/access-policy') data = { policy };
    else if (path === '/api/users/22222222-2222-4222-8222-222222222222' && request.method() === 'PATCH') {
      disabledBody = request.postDataJSON();
      data = { user: { ...users[1], disabled: true } };
    }
    await route.fulfill({ json: data });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/admin`);
  await page.getByRole('heading', { name: '用户与访问安全', exact: true }).waitFor();
  assert.equal(await page.getByText(/管理账户、登录状态/).count(), 0, '标题下说明文字应移除');
  assert.equal(await page.getByText('未填写邮箱', { exact: true }).count(), 0, '未填写邮箱提示应移除');
  assert.equal(await page.getByRole('button', { name: '撤销登录', exact: true }).count(), 0, '撤销登录按钮应移除');
  await page.getByRole('heading', { name: '注册模式', exact: true }).waitFor();
  const selectBox = await page.getByRole('combobox', { name: '注册方式', exact: true }).boundingBox();
  const saveBox = await page.getByRole('button', { name: '保存访问策略', exact: true }).boundingBox();
  assert.ok(selectBox && saveBox && Math.abs(selectBox.y - saveBox.y) < 8, '注册方式与保存按钮应在同一行');

  page.once('dialog', dialog => void dialog.accept());
  const request = page.waitForRequest(req => req.url().endsWith('/api/users/22222222-2222-4222-8222-222222222222') && req.method() === 'PATCH');
  await page.getByRole('button', { name: '停用', exact: true }).click();
  await request;
  assert.deepEqual(disabledBody, { disabled: true });
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/workpivot-users-panel.png', fullPage: true });
  console.log('用户管理页检查通过：文案精简、注册模式单行、停用操作提交正确。');
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
