// 合成权限请求验证确认区位于输入框上方且允许操作可见、可提交。
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
    const file = resolve(root, path === '/' ? 'index.html' : '.' + path);
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('wp_token', 'synthetic-ui-token');
    localStorage.setItem('wp-right-panel-open', 'false');
  });
  const task = { id: 'task-a', projectId: 'project-a', name: '网页分析', status: 'waiting', revision: 2 };
  const permission = {
    id: 'permission-a',
    request: { tool: 'web_fetch', reason: '本次读取网页需要确认', effects: ['read'], command: '读取公开网页' },
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  let decisionBody;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data = { experts: [], suggestions: [], plans: [], checkpoints: [], files: [], executions: [], builds: [], entries: [] };
    if (path === '/api/health') data = { ok: true, name: 'workpivot', apiProtocol: 1, storage: 'postgresql', chatEnabled: true };
    else if (path === '/api/auth/state') data = { authenticated: true, user: { id: 'owner', username: '合成用户', role: 'member' }, quota: { used: 1, limit: 10, remaining: 9 } };
    else if (path === '/api/tasks') data = { tasks: [task] };
    else if (path === '/api/projects') data = { projects: [{ id: 'project-a', name: '合成项目', revision: 1 }] };
    else if (path === '/api/tasks/task-a/conversation') data = { turns: [], nextCursor: null, snapshotSequence: '1' };
    else if (path === '/api/tasks/task-a/conversation-changes') data = { events: [], nextSequence: '1', snapshotSequence: '1', hasMore: false };
    else if (path === '/api/tasks/task-a/permissions' && request.method() === 'GET') data = { pending: [permission] };
    else if (path === '/api/tasks/task-a/permissions/permission-a' && request.method() === 'POST') {
      decisionBody = request.postDataJSON();
      data = { ok: true };
    } else if (path === '/api/tasks/task-a/resource-scope') data = { scope: { versionIds: [], memoryScopes: [], expert: false, scheduleIds: [], baseRunId: null } };
    await route.fulfill({ json: data });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('complementary', { name: '项目与任务', exact: true }).getByRole('button', { name: '网页分析', exact: true }).click();
  const dock = page.getByRole('region', { name: '待确认操作', exact: true });
  await dock.waitFor();
  const dockBox = await dock.boundingBox(), composerBox = await page.locator('form.workspace-composer').boundingBox();
  assert.ok(dockBox && composerBox && dockBox.y + dockBox.height <= composerBox.y + 1, '权限确认区应位于输入框上方');
  await dock.getByText('本次读取网页需要确认', { exact: true }).waitFor();
  assert.equal(await dock.getByRole('button', { name: /允许本次/ }).isDisabled(), false);
  await page.screenshot({ path: '/tmp/workpivot-permission-dock.png' });
  const submitted = page.waitForRequest(req => req.url().endsWith('/api/tasks/task-a/permissions/permission-a') && req.method() === 'POST');
  await dock.getByRole('button', { name: /允许本次/ }).click();
  await submitted;
  assert.deepEqual(decisionBody, { decision: 'allow', scope: 'once' });
  assert.deepEqual(errors, []);
  console.log('权限确认区检查通过：底部固定、操作可点击、允许本次请求正确。');
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
