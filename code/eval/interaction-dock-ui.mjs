// 验证计划审批、动作拒绝反馈、成果验收和单阻塞队列的 Web 交互。
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
await new Promise(done => staticServer.listen(0, '127.0.0.1', done));

const now = new Date();
const expiry = new Date(now.getTime() + 600_000);
const base = { userId: 'owner', taskId: 'task-a', runId: 'run-a', revision: 1, state: 'pending', createdAt: now.toISOString(), expiresAt: expiry.toISOString() };
const plan = {
  ...base, id: 'plan-interaction', kind: 'plan_approval', blocking: true, risk: 'medium', reason: '请核对执行计划',
  payload: { plan: {
    id: 'plan-a', revision: 2, hash: 'a'.repeat(64), status: 'draft', goal: '生成季度经营分析报告',
    assumptions: ['数据截至本季度末'], dataScope: ['预算.xlsx 第3版', '项目周报.md'], businessRules: ['金额统一为人民币'],
    steps: [{ step: '核对经营数据', status: 'in_progress' }, { step: '生成 PDF 报告', status: 'pending' }],
    externalActions: [], outputs: ['季度经营分析.pdf'], risks: ['预算数字需与业务事实交叉核对'], verification: ['检查金额、日期和引用来源'],
    updatedAt: now.toISOString(),
  } },
};
const action = {
  ...base, id: 'action-interaction', kind: 'action_permission', blocking: true, risk: 'high', reason: '本次外部发送需要确认',
  payload: { tool: 'mcp__mail__send', effects: ['external'], risk: 'high', summary: '向项目成员发送季度报告', arguments: { recipients: 3 }, feedbackAllowed: true },
};
const artifact = {
  ...base, id: 'artifact-interaction', kind: 'artifact_review', blocking: false, risk: 'low', reason: '成果已生成，请核对内容与验收要求',
  payload: { artifacts: [{ id: 'artifact-a', name: '季度经营分析.pdf' }], machineVerified: true, verificationNotes: ['文件已登记为当前任务成果'] },
};

let phase = 0;
let actionResponse;
const responses = [];
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
  const task = { id: 'task-a', projectId: 'project-a', name: '合成任务', status: 'running', revision: 1 };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data = { experts: [], suggestions: [], plans: [], checkpoints: [], files: [], executions: [], builds: [], entries: [] };
    if (path === '/api/health') data = { ok: true, name: 'workpivot', apiProtocol: 1, storage: 'postgresql', chatEnabled: true };
    else if (path === '/api/auth/state') data = { authenticated: true, user: { id: 'owner', username: '合成用户', role: 'member' }, quota: { used: 1, limit: 10, remaining: 9 } };
    else if (path === '/api/tasks') data = { tasks: [task] };
    else if (path === '/api/projects') data = { projects: [{ id: 'project-a', name: '合成项目', revision: 1 }] };
    else if (path === '/api/tasks/task-a/conversation') data = { turns: [{ id: 'turn-a', events: [], hasMoreEvents: false, nextEventSequence: null }], nextCursor: null, snapshotSequence: '0' };
    else if (path === '/api/tasks/task-a/conversation-changes') data = { events: [], nextSequence: '0', snapshotSequence: '0', hasMore: false };
    else if (path === '/api/tasks/task-a/interactions') {
      const interactions = phase === 0 ? [plan, action] : phase === 1 ? [action] : phase === 2 ? [artifact] : [];
      data = { interactions, blocking: interactions.filter(item => item.blocking).length, queued: Math.max(0, interactions.filter(item => item.blocking).length - 1) };
    } else if (path.endsWith('/interactions/plan-interaction/respond')) {
      responses.push(request.postDataJSON()); phase = 1;
      await route.fulfill({ json: { ok: true } }); return;
    } else if (path.endsWith('/interactions/action-interaction/respond')) {
      actionResponse = request.postDataJSON(); responses.push(actionResponse); phase = 2;
      await route.fulfill({ json: { ok: true } }); return;
    } else if (path.endsWith('/interactions/artifact-interaction/respond')) {
      responses.push(request.postDataJSON()); phase = 3;
      await route.fulfill({ json: { ok: true } }); return;
    } else if (path === '/api/tasks/task-a/resource-scope') {
      data = { scope: { versionIds: [], memoryScopes: ['project'], expert: false, scheduleIds: [], baseRunId: null } };
    }
    await route.fulfill({ json: data });
  });

  await page.goto(`http://127.0.0.1:${staticServer.address().port}/`);
  await page.getByRole('complementary', { name: '项目与任务', exact: true }).getByRole('button', { name: '合成任务', exact: true }).click();
  const planDock = page.getByRole('region', { name: '计划审批', exact: true });
  await planDock.waitFor();
  await planDock.getByText('生成季度经营分析报告', { exact: true }).waitFor();
  await planDock.getByText('后面还有 1 项', { exact: true }).waitFor();
  await planDock.getByText('核对经营数据', { exact: false }).waitFor();
  await page.screenshot({ path: '/tmp/workpivot-interaction-plan.png' });
  await planDock.getByRole('button', { name: '修改计划', exact: true }).click();
  await planDock.getByLabel('目标').fill('生成季度经营分析报告并向管理层汇报');
  const planRequest = page.waitForRequest('**/interactions/plan-interaction/respond');
  await planDock.getByRole('button', { name: '保存计划修改', exact: true }).click();
  const planResponse = (await planRequest).postDataJSON();
  assert.equal(planResponse.response.plan.goal, '生成季度经营分析报告并向管理层汇报');
  assert.equal(planResponse.response.decision, 'deny');
  const actionDock = page.getByRole('region', { name: '动作授权', exact: true });
  await actionDock.waitFor();
  await actionDock.getByText('高风险', { exact: true }).first().waitFor();
  await actionDock.getByRole('button', { name: '填写反馈', exact: true }).click();
  await actionDock.getByLabel('反馈原因').fill('收件人范围不对，应先发给我确认');
  const actionRequest = page.waitForRequest('**/interactions/action-interaction/respond');
  await actionDock.getByRole('button', { name: '拒绝', exact: true }).click();
  actionResponse = (await actionRequest).postDataJSON();
  assert.equal(actionResponse.response.feedback, '收件人范围不对，应先发给我确认');
  const artifactDock = page.getByRole('region', { name: '成果验收', exact: true });
  await artifactDock.waitFor();
  await artifactDock.getByText('季度经营分析.pdf', { exact: true }).waitFor();
  const artifactRequest = page.waitForRequest('**/interactions/artifact-interaction/respond');
  await artifactDock.getByRole('button', { name: '验收通过', exact: true }).click();
  await artifactRequest;
  await page.getByRole('region', { name: '成果验收', exact: true }).waitFor({ state: 'detached' });
  assert.ok(responses.length >= 2);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/workpivot-interaction-dock.png' });
  console.log('统一交互区通过：计划可修改、阻塞队列、高风险动作反馈、拒绝改路和成果验收。');
} finally {
  await browser?.close();
  await new Promise(done => staticServer.close(done));
}
