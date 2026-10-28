// 合成结构化提问，验证确认列表固定在输入区上方且资料范围未加载时仍可作答。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { chromium } = require('playwright');
const root = resolve('apps/web/dist');
const staticServer = createServer(async (req, res) => {
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
await new Promise(resolveListen => staticServer.listen(0, '127.0.0.1', resolveListen));

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

  const task = { id: 'task-a', projectId: 'project-a', name: '合成任务', status: 'completed', revision: 1 };
  const questionId = '31546d88-7896-43c5-af51-b4f189a238eb';
  const event = (id, sequence, kind, content) => ({ id, sequence: String(sequence), turnId: 'turn-a', runId: 'run-a', kind, content });
  let messageBody;
  let scopeRequests = 0;

  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data = { experts: [], suggestions: [], plans: [], checkpoints: [], files: [], executions: [], builds: [], entries: [] };
    if (path === '/api/health') data = { ok: true, name: 'workpivot', apiProtocol: 1, storage: 'postgresql', chatEnabled: true };
    else if (path === '/api/auth/state') data = { authenticated: true, user: { id: 'owner', username: '合成用户', role: 'member' }, quota: { used: 1, limit: 10, remaining: 9 } };
    else if (path === '/api/tasks') data = { tasks: [task] };
    else if (path === '/api/projects') data = { projects: [{ id: 'project-a', name: '合成项目', revision: 1 }] };
    else if (path === '/api/tasks/task-a/conversation') data = {
      turns: [{
        id: 'turn-a',
        events: [
          event('ask-user', 1, 'meta', JSON.stringify({
            type: 'ask_user',
            questionId,
            question: '报告需要包含哪些内容？',
            options: [
              { label: '核心结论', description: '只保留结论与关键数据' },
              { label: '完整分析', description: '包含数据、过程和风险提示' },
            ],
            allowFreeText: true,
          })),
        ],
        hasMoreEvents: false,
        nextEventSequence: null,
      }],
      nextCursor: null,
      snapshotSequence: '1',
    };
    else if (path === '/api/tasks/task-a/conversation-changes') data = { events: [], nextSequence: '1', snapshotSequence: '1', hasMore: false };
    else if (path === '/api/tasks/task-a/permissions') data = { pending: [] };
    else if (path === '/api/tasks/task-a/resource-scope') {
      scopeRequests++;
      await new Promise(done => setTimeout(done, 800));
      data = { scope: { versionIds: [], memoryScopes: [], expert: false, scheduleIds: [], baseRunId: null } };
    } else if (path === '/api/tasks/task-a/messages' && request.method() === 'POST') {
      messageBody = request.postDataJSON();
      data = {};
      await route.fulfill({ status: 202, json: data });
      return;
    }
    await route.fulfill({ json: data });
  });

  await page.goto(`http://127.0.0.1:${staticServer.address().port}/`);
  await page.getByRole('complementary', { name: '项目与任务', exact: true }).getByRole('button', { name: '合成任务', exact: true }).click();
  const dock = page.getByRole('region', { name: '待确认问题', exact: true });
  await dock.waitFor();
  const composer = page.locator('form.workspace-composer');
  const dockBox = await dock.boundingBox();
  const composerBox = await composer.boundingBox();
  assert.ok(dockBox && composerBox && dockBox.y + dockBox.height <= composerBox.y + 1, '确认列表应位于输入框上方');
  assert.equal(await dock.getByRole('listitem').count(), 2);
  assert.equal(await dock.getByRole('button', { name: /核心结论/ }).isDisabled(), false);

  const answerRequest = page.waitForRequest('**/api/tasks/task-a/messages');
  await dock.getByRole('button', { name: /核心结论/ }).click();
  const submitted = await answerRequest;
  messageBody = submitted.postDataJSON();
  assert.ok(messageBody, '资料范围尚未加载时点击选项也必须提交答案');
  assert.equal(messageBody.content, `[回答提问 ${questionId}] 核心结论`);
  assert.deepEqual(messageBody.attachments, []);
  assert.ok(Array.isArray(messageBody.resourceScope.memoryScopes));
  assert.ok(scopeRequests >= 1);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/workpivot-ask-user-dock.png' });
  console.log('确认列表检查通过：位于输入框上方、列表展示、资料范围未就绪时可点击并提交。');
} finally {
  await browser?.close();
  await new Promise(resolveClose => staticServer.close(resolveClose));
}
