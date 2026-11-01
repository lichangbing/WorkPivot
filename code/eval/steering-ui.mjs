// 验证任务运行时输入仍可用，新要求进入安全点队列并可撤销。
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
  } catch { res.writeHead(404); res.end(); }
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
  const task = { id: 'task-a', projectId: 'project-a', name: '运行中任务', status: 'running', revision: 3 };
  let steering = null;
  let submitted;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data = { experts: [], suggestions: [], plans: [], checkpoints: [], files: [], executions: [], builds: [], entries: [] };
    if (path === '/api/health') data = { ok: true, name: 'workpivot', apiProtocol: 1, storage: 'postgresql', chatEnabled: true };
    else if (path === '/api/auth/state') data = { authenticated: true, user: { id: 'owner', username: '合成用户', role: 'member' }, quota: { used: 10, limit: 10, remaining: 0 } };
    else if (path === '/api/tasks') data = { tasks: [task] };
    else if (path === '/api/projects') data = { projects: [{ id: 'project-a', name: '合成项目', revision: 1 }] };
    else if (path === '/api/tasks/task-a/conversation') data = { turns: [], nextCursor: null, snapshotSequence: '0' };
    else if (path === '/api/tasks/task-a/conversation-changes') data = { events: [], nextSequence: '0', snapshotSequence: '0', hasMore: false };
    else if (path === '/api/tasks/task-a/interactions') data = { interactions: [], blocking: 0, queued: 0 };
    else if (path === '/api/tasks/task-a/steering' && request.method() === 'GET') data = { steering: steering ? [steering] : [] };
    else if (path === '/api/tasks/task-a/steering' && request.method() === 'POST') {
      submitted = request.postDataJSON();
      steering = {
        id: 'steering-a', taskId: 'task-a', runId: 'run-a', requestId: submitted.requestId,
        content: submitted.content, mode: 'safe', status: 'pending', relation: 'unknown', createdAt: new Date().toISOString(),
      };
      await route.fulfill({ status: 202, json: { steering } }); return;
    } else if (path === '/api/tasks/task-a/steering/steering-a' && request.method() === 'DELETE') {
      steering = null; await route.fulfill({ json: { ok: true } }); return;
    } else if (path === '/api/tasks/task-a/resource-scope') data = { scope: { versionIds: [], memoryScopes: ['project'], expert: false, scheduleIds: [], baseRunId: null } };
    await route.fulfill({ json: data });
  });

  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('complementary', { name: '项目与任务', exact: true }).getByRole('button', { name: '运行中任务', exact: true }).click();
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.waitFor();
  assert.equal(await input.isDisabled(), false, '任务运行时文本输入必须可用');
  await input.fill('金额改成200万，继续完成但不要沿用100万');
  const request = page.waitForRequest(req => req.url().endsWith('/api/tasks/task-a/steering') && req.method() === 'POST');
  await page.getByRole('button', { name: '发送补充要求', exact: true }).click();
  submitted = (await request).postDataJSON();
  assert.equal(submitted.content, '金额改成200万，继续完成但不要沿用100万');
  const queue = page.getByRole('region', { name: '待应用的运行中补充', exact: true });
  await queue.waitFor();
  await queue.getByText('等待当前步骤结束后判断关联', { exact: false }).waitFor();
  assert.equal(await input.inputValue(), '');
  await queue.getByRole('button', { name: '撤销', exact: true }).click();
  await queue.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/workpivot-steering.png' });
  console.log('运行中补充通过：输入可用、持久排队、下一步生效提示、撤销和安全点协议可见。');
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
