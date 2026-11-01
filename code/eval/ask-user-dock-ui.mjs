// 合成持久化澄清交互，验证统一确认区、批量回答和跨接口提交。
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
  const interactionId = '6241bf67-d647-4f49-9e36-04b06f100bb5';
  const event = (id, sequence, kind, content) => ({ id, sequence: String(sequence), turnId: 'turn-a', runId: 'run-a', kind, content });
  let responseBody;
  let scopeRequests = 0;
  const interaction = {
    id: interactionId,
    kind: 'clarification',
    userId: 'owner',
    taskId: 'task-a',
    runId: 'run-a',
    revision: 1,
    state: 'pending',
    blocking: true,
    risk: 'low',
    reason: '报告需要包含哪些内容？',
    payload: {
      questions: [{
        id: questionId,
        question: '报告需要包含哪些内容？',
        options: [
          { label: '核心结论', description: '只保留结论与关键数据', recommended: true },
          { label: '完整分析', description: '包含数据、过程和风险提示' },
        ],
        allowFreeText: true,
        multiSelect: false,
      }],
    },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };

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
        events: [event('initial', 1, 'assistant', '请确认报告内容。')],
        hasMoreEvents: false,
        nextEventSequence: null,
      }],
      nextCursor: null,
      snapshotSequence: '1',
    };
    else if (path === '/api/tasks/task-a/conversation-changes') data = { events: [], nextSequence: '1', snapshotSequence: '1', hasMore: false };
    else if (path === '/api/tasks/task-a/permissions') data = { pending: [] };
    else if (path === '/api/tasks/task-a/interactions') data = { interactions: [interaction], blocking: 1, queued: 0 };
    else if (path === '/api/tasks/task-a/resource-scope') {
      scopeRequests++;
      await new Promise(done => setTimeout(done, 800));
      data = { scope: { versionIds: [], memoryScopes: [], expert: false, scheduleIds: [], baseRunId: null } };
    } else if (path === `/api/tasks/task-a/interactions/${interactionId}/respond` && request.method() === 'POST') {
      responseBody = request.postDataJSON();
      await route.fulfill({ json: { ok: true, interaction: { ...interaction, state: 'answered' } } });
      return;
    }
    await route.fulfill({ json: data });
  });

  await page.goto(`http://127.0.0.1:${staticServer.address().port}/`);
  await page.getByRole('complementary', { name: '项目与任务', exact: true }).getByRole('button', { name: '合成任务', exact: true }).click();
  const dock = page.getByRole('region', { name: '需求澄清', exact: true });
  await dock.waitFor();
  const composer = page.locator('form.workspace-composer');
  const dockBox = await dock.boundingBox();
  const composerBox = await composer.boundingBox();
  assert.ok(dockBox && composerBox && dockBox.y + dockBox.height <= composerBox.y + 1, '确认列表应位于输入框上方');
  assert.equal(await dock.getByRole('button', { name: /核心结论/ }).count(), 1);
  assert.equal(await dock.getByRole('button', { name: /核心结论/ }).isDisabled(), false);

  const answerRequest = page.waitForRequest(`**/api/tasks/task-a/interactions/${interactionId}/respond`);
  await dock.getByRole('button', { name: /核心结论/ }).click();
  await dock.getByRole('button', { name: '提交回答' }).click();
  const submitted = await answerRequest;
  responseBody = submitted.postDataJSON();
  assert.equal(responseBody.revision, 1);
  assert.deepEqual(responseBody.response.answers, [{ questionId, value: ['核心结论'] }]);
  assert.ok(Array.isArray(responseBody.resourceScope.memoryScopes));
  assert.ok(scopeRequests >= 1);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/workpivot-ask-user-dock.png' });
  console.log('统一澄清区通过：位于输入框上方、推荐项可识别、批量答案和读取范围可一次提交。');
} finally {
  await browser?.close();
  await new Promise(resolveClose => staticServer.close(resolveClose));
}
