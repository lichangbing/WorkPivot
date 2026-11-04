// 验证运行中资源范围面板：不新增新运行，只提交受控增量并刷新当前范围。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { chromium } = require('playwright');
const root = resolve('apps/web/dist');
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(root, path === '/' ? 'index.html' : '.' + path);
    if (!file.startsWith(root + '/')) throw Error('invalid path');
    response.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('wp_token', 'synthetic-token');
    localStorage.setItem('wp-right-panel-open', 'false');
  });
  const task = { id: 'task-runtime', projectId: 'project-runtime', name: '运行中范围测试', status: 'running', revision: 1 };
  const currentScope = { versionIds: ['version-old'], scheduleIds: [], memoryScopes: ['project'], expert: false, version: 1, epoch: '11111111-1111-4111-8111-111111111111', baseRunId: 'run-before' };
  const files = [
    { id: 'version-old', name: '已选资料.docx', revision: 1 },
    { id: 'version-new', name: '新增资料.pdf', revision: 1 },
  ];
  let submitted;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data = { experts: [], suggestions: [], plans: [], checkpoints: [], files: [], executions: [], builds: [] };
    if (path === '/api/health') data = { ok: true, chatEnabled: true, storage: 'postgresql', apiProtocol: 1 };
    else if (path === '/api/auth/state') data = { authenticated: true, user: { id: 'owner', username: '合成用户', role: 'member' } };
    else if (path === '/api/tasks') data = { tasks: [task] };
    else if (path === '/api/projects') data = { projects: [{ id: 'project-runtime', name: '范围项目', revision: 1 }] };
    else if (path === '/api/tasks/task-runtime/resource-scope') data = {
      scope: currentScope,
      activeRun: { runId: 'run-active', turnId: 'turn-active', scope: currentScope },
      files,
      schedules: [],
    };
    else if (path === '/api/tasks/task-runtime/scope-changes') {
      submitted = route.request().postDataJSON();
      data = {
        change: {
          id: 'change-1', taskId: task.id, runId: 'run-active', requestId: submitted.requestId,
          baseEpoch: currentScope.epoch, addedVersionIds: ['version-new'], addedMemoryScopes: ['user'], createdAt: new Date().toISOString(),
        },
        scope: { ...currentScope, versionIds: ['version-new', 'version-old'], memoryScopes: ['project', 'user'], epoch: '22222222-2222-4222-8222-222222222222' },
      };
    }
    else if (path === '/api/tasks/task-runtime/conversation') data = { turns: [], nextCursor: null, snapshotSequence: '0' };
    else if (path === '/api/tasks/task-runtime/conversation-changes') data = { events: [], nextSequence: '0', snapshotSequence: '0', hasMore: false };
    else if (path === '/api/tasks/task-runtime/interactions') data = { interactions: [], blocking: 0, queued: 0 };
    else if (path === '/api/tasks/task-runtime/steering') data = { steering: [] };
    else if (path === '/api/tasks/task-runtime/deliveries') data = { deliveries: [] };
    else if (path === '/api/tasks/task-runtime/stream') {
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `data: ${JSON.stringify({ type: 'state', value: { tasks: [task], interactions: [], steering: [], deliveries: [] } })}\n\n` });
      return;
    }
    await route.fulfill({ json: data });
  });

  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('button', { name: '运行中范围测试', exact: true }).click();
  const message = page.getByRole('textbox', { name: '消息', exact: true });
  await message.waitFor();
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="消息"]')?.disabled);
  await page.getByRole('button', { name: /运行中资料范围/ }).click();
  await page.getByText('新增资料.pdf', { exact: false }).click();
  await page.getByText('个人记忆', { exact: true }).click();
  await page.getByRole('button', { name: '确认加入当前运行', exact: true }).click();
  await page.getByText(/已加入.*下一个安全步骤应用/).waitFor();
  assert.deepEqual(submitted.addVersionIds, ['version-new']);
  assert.deepEqual(submitted.addMemoryScopes, ['user']);
  assert.equal('enableExpert' in submitted, false);
  assert.equal(submitted.baseRunId, 'run-active');
  assert.equal(submitted.baseEpoch, currentScope.epoch);
  assert.match(submitted.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(errors, []);
  console.log('✅ 运行中资源范围异步读取当前运行');
  console.log('✅ 文件和记忆层增量只提交实际新增项');
  console.log('✅ 资源范围提交复用幂等请求标识');
  console.log('✅ 页面显示下一个安全步骤应用提示');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
