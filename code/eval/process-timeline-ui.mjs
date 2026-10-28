// 合成运行中的两个步骤，验证当前步骤展开、已完成步骤合并、结束后整体收起。
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
  const runningTask = { id: 'task-a', projectId: 'project-a', name: '长任务', status: 'running', revision: 2 };
  const completedTask = { ...runningTask, status: 'idle', revision: 3 };
  const event = (id, sequence, kind, content) => ({ id, sequence: String(sequence), turnId: 'turn-a', runId: 'run-a', kind, content, truncated: false });
  const events = [
    event('think-1', 2, 'thinking', '第一轮思路：先确认数据范围。'),
    event('call-1', 3, 'tool_use', JSON.stringify({ type: 'tool_use', toolName: 'web_search', displayName: '联网搜索', status: 'running' })),
    event('result-1', 4, 'tool_result', JSON.stringify({ type: 'tool_result', toolName: 'web_search', displayName: '联网搜索', ok: true, status: 'ok', durationMs: 120, message: '第一轮工具结果' })),
    event('think-2', 5, 'thinking', '第二轮思路：整理来源并继续分析。'),
    event('call-2', 6, 'tool_use', JSON.stringify({ type: 'tool_use', toolName: 'web_fetch', displayName: '读取网页', status: 'running' })),
  ];
  let stateSent = false;
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data = { experts: [], suggestions: [], plans: [], checkpoints: [], files: [], executions: [], builds: [], entries: [] };
    if (path === '/api/health') data = { ok: true, name: 'workpivot', apiProtocol: 1, storage: 'postgresql', chatEnabled: true };
    else if (path === '/api/auth/state') data = { authenticated: true, user: { id: 'owner', username: '合成用户', role: 'member' }, quota: { used: 1, limit: 10, remaining: 9 } };
    else if (path === '/api/tasks') data = { tasks: [stateSent ? completedTask : runningTask] };
    else if (path === '/api/projects') data = { projects: [{ id: 'project-a', name: '合成项目', revision: 1 }] };
    else if (path === '/api/tasks/task-a/conversation') data = { turns: [{ id: 'turn-a', events, hasMoreEvents: false, nextEventSequence: null }], nextCursor: null, snapshotSequence: '6' };
    else if (path === '/api/tasks/task-a/conversation-changes') data = { events: [], nextSequence: '6', snapshotSequence: '6', hasMore: false };
    else if (path === '/api/tasks/task-a/permissions') data = { pending: [] };
    else if (path === '/api/tasks/task-a/resource-scope') data = { scope: { versionIds: [], memoryScopes: [], expert: false, scheduleIds: [], baseRunId: null } };
    else if (path === '/api/tasks/task-a/stream') {
      await new Promise(done => setTimeout(done, 2000));
      stateSent = true;
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'state', value: { tasks: [completedTask], pending: [] } })}\n\n` });
      return;
    }
    await route.fulfill({ json: data });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('complementary', { name: '项目与任务', exact: true }).getByRole('button', { name: '长任务', exact: true }).click();
  const toggle = page.getByRole('button', { name: /思考与执行过程/ });
  const process = page.getByRole('region', { name: '思考与执行过程', exact: true });
  await process.getByText('第二轮思路：整理来源并继续分析。', { exact: false }).waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await process.getByRole('button', { name: /步骤 1/ }).getAttribute('aria-expanded'), 'false', '已完成步骤默认合并收起');
  assert.equal(await process.getByRole('button', { name: /步骤 2/ }).getAttribute('aria-expanded'), 'true', '当前步骤自动展开');
  assert.ok(await process.getByText('读取网页', { exact: true }).first().isVisible(), '当前工具步骤应展开');
  await page.screenshot({ path: '/tmp/workpivot-process-live.png' });
  await page.waitForFunction(() => document.querySelector('[aria-label="思考与执行过程"]')?.parentElement?.querySelector('button')?.getAttribute('aria-expanded') === 'false');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(errors, []);
  console.log('过程时间线检查通过：当前步骤展开、历史步骤合并、运行结束后收起。');
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
