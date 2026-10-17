import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
const root = mkdtempSync(join(tmpdir(), 'wp25-'));
process.env['WORKPIVOT_HOME'] = join(root, 'home');
process.env['WORKPIVOT_WORKSPACE'] = join(root, 'workspace');
process.env['WORKPIVOT_HOST'] = '127.0.0.1';
process.env['WORKPIVOT_INSECURE_SECRETS'] = '1';
process.env['WORKPIVOT_EXECUTION_MODE'] = 'disabled';
const { startServer } = await import('../packages/server/src/index.js');
const { withTenant, tenantPathAllowed } = await import('../packages/server/src/tenants.js');
const { workspaceRoot, getTask } = await import('../packages/server/src/tasks.js');
const { taskFilePolicy } = await import('../packages/server/src/file-policy.js');
const { TenantMap } = await import('../packages/server/src/tenant-map.js');
const { issueTokenForUser } = await import('../packages/server/src/auth.js');
const { migrateTenantData } = await import('../packages/server/src/tenant-migration.js');
const { readTool } = await import('../packages/core/src/tools.js');
const { ensureWorkpivotDir } = await import('../packages/server/src/store.js');
const server = await startServer({ port: 0 });
// 本项目 port=0 返回请求值；直接使用应用绑定操作系统分配的端口。
await server.close();
const { createApp } = await import('../packages/server/src/app.js');
const app = createApp();
const http = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => http.once('listening', resolve));
const address = http.address(); if (!address || typeof address === 'string') throw Error('No test port');
const url = `http://127.0.0.1:${address.port}`;
const model = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  req.on('end', () => {
    const input = JSON.parse(body) as { model: string; messages: Array<{ role: string }> };
    const delta = input.messages.some((message) => message.role === 'tool') ? { content: `REPLY-${input.model}` } : { tool_calls: [{ index: 0, id: 'write-own', function: { name: 'write', arguments: JSON.stringify({ path: 'own.txt', content: input.model }) } }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
  });
});
model.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => model.once('listening', resolve));
const modelAddress = model.address(); if (!modelAddress || typeof modelAddress === 'string') throw Error('No model port');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试夹具的 JSON 结构不一致
type Body = Record<string, any>; // JSON 测试夹具响应。
async function request(path: string, token = '', method = 'GET', body?: unknown): Promise<{ status: number; body: Body }> {
  const response = await fetch(url + '/api' + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as Body };
}
let count = 0;
function check(name: string, value: unknown): void { assert.ok(value, name); count++; console.log(`✅ 租户 ${name}`); }
try {
  const initial = await request('/auth/register', '', 'POST', { username: 'platform', password: 'tenant-test-password' });
  let platform = initial.body.token as string;
  check('默认首管理员具备平台管理身份', initial.body.user.platformAdmin && initial.body.user.tenantId === 'default');
  const legacyUsersPath = join(process.env['WORKPIVOT_HOME'], 'data', 'users.json');
  const legacyUsers = JSON.parse(readFileSync(legacyUsersPath, 'utf8')) as Body;
  for (const user of legacyUsers.users) { delete user.tenantId; delete user.platformAdmin; }
  writeFileSync(legacyUsersPath, JSON.stringify(legacyUsers));
  const sessionsPath = join(process.env['WORKPIVOT_HOME'], 'data', 'sessions.json');
  const sessions = JSON.parse(readFileSync(sessionsPath, 'utf8')) as Body;
  for (const entry of sessions.tokens) entry.token = entry.token.replace('default.', '');
  writeFileSync(sessionsPath, JSON.stringify(sessions));
  platform = platform.replace('default.', '');
  migrateTenantData();
  const migratedUser = (await request('/auth/state', platform)).body.user;
  check('旧账号和旧会话迁入默认租户后仍可登录', migratedUser.tenantId === 'default' && migratedUser.platformAdmin);
  for (const id of ['alpha', 'beta']) check(`创建 ${id}`, (await request('/tenants', platform, 'POST', { id, name: id, username: 'admin', password: 'tenant-test-password' })).status === 200);
  const a = (await request('/auth/login', '', 'POST', { tenantId: 'alpha', username: 'admin', password: 'tenant-test-password' })).body;
  const b = (await request('/auth/login', '', 'POST', { tenantId: 'beta', username: 'admin', password: 'tenant-test-password' })).body;
  check('相同用户名可属于不同租户', a.user.id !== b.user.id && a.user.tenantId === 'alpha' && b.user.tenantId === 'beta');
  check('租户管理员没有平台权限', !a.user.platformAdmin && (await request('/tenants', a.token)).status === 403);
  check('租户管理员不能创建租户', (await request('/tenants', a.token, 'POST', { id: 'escape', name: 'escape', username: 'admin', password: 'password' })).status === 403);
  check('错误租户不能登录', (await request('/auth/login', '', 'POST', { tenantId: 'missing', username: 'admin', password: 'tenant-test-password' })).status === 401);
  const pa = (await request('/projects', a.token, 'POST', { name: '项目A' })).body.project;
  const pb = (await request('/projects', b.token, 'POST', { name: '项目B' })).body.project;
  check('项目记录明确租户', pa.tenantId === 'alpha' && pb.tenantId === 'beta');
  check('工作目录各自独立', pa.directory !== pb.directory && pa.directory.includes('alpha') && pb.directory.includes('beta'));
  const ta = (await request('/tasks', a.token, 'POST', { name: '任务A', projectId: pa.id })).body.task;
  const tb = (await request('/tasks', b.token, 'POST', { name: '任务B', projectId: pb.id })).body.task;
  check('任务记录明确租户', ta.tenantId === 'alpha' && tb.tenantId === 'beta');
  for (const suffix of ['', '/files', '/transcript', '/plan']) check(`跨租户任务${suffix || '详情'}不可见`, (await request(`/tasks/${tb.id}${suffix}`, a.token)).status === 404);
  check('不能停止其他租户任务', (await request(`/tasks/${tb.id}/stop`, a.token, 'POST')).status === 404);
  check('不能删除其他租户项目', (await request(`/projects/${pb.id}`, a.token, 'DELETE')).status === 404);
  check('不能借其他租户项目创建任务', (await request('/tasks', a.token, 'POST', { name: 'bad', projectId: pb.id })).status === 404);
  check('不能借绝对目录越界创建项目', (await request('/projects', a.token, 'POST', { name: 'bad', directory: pb.directory })).status === 400);
  check('平台管理员不会自动看到其他租户项目', !(await request('/projects', platform)).body.projects.some((p: Body) => p.id === pb.id));
  check('租户管理员不能操作其他租户账户', (await request(`/users/${b.user.id}/role`, a.token, 'PUT', { role: 'member' })).status === 400);
  const member = (await request('/users', a.token, 'POST', { username: 'member', password: 'test-password', role: 'member' })).body.user;
  check('创建用户继承当前租户', member.tenantId === 'alpha');
  const ml = (await request('/auth/login', '', 'POST', { tenantId: 'alpha', username: 'member', password: 'test-password' })).body;
  check('同租户私有项目也受成员限制', !(await request('/projects', ml.token)).body.projects.some((p: Body) => p.id === pa.id));
  await request('/memory/toggle', a.token, 'POST', { enabled: false });
  check('记忆配置互不影响', (await request('/memory', b.token)).body.enabled !== false);
  await request('/skills/toggle', a.token, 'POST', { name: 'docx-report', disabled: true });
  check('Skill开关互不影响', !(await request('/skills', b.token)).body.skills.find((s: Body) => s.name === 'docx-report')?.disabled);
  withTenant('alpha', () => writeFileSync(join(ensureWorkpivotDir('config'), 'providers.json'), JSON.stringify({ version: 1, providers: [{ id: 'a-provider', name: 'A模型', modelId: 'test', baseUrl: 'http://localhost' }] })));
  check('模型配置隔离', (await request('/providers', b.token)).body.providers.length === 0 && (await request('/providers', a.token)).body.providers.length === 1);
  for (const id of ['alpha', 'beta']) withTenant(id, () => writeFileSync(join(ensureWorkpivotDir('config'), 'providers.json'), JSON.stringify({ version: 1, providers: [{ id: 'provider', name: id, modelId: id, baseUrl: `http://127.0.0.1:${modelAddress.port}` }] })));
  await Promise.all([[a, ta], [b, tb]].map(async ([account, task]) => {
    const response = await fetch(url + `/api/tasks/${task.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` }, body: JSON.stringify({ content: 'write own file' }) });
    const stream = await response.text();
    check(`并发回复使用 ${account.user.tenantId} 模型配置`, stream.includes(`REPLY-${account.user.tenantId}`));
    check(`工具只写入 ${account.user.tenantId} 工作目录`, readFileSync(join(task.directory, 'own.txt'), 'utf8') === account.user.tenantId);
  }));
  const upload = await fetch(url + `/api/tasks/${ta.id}/attachments?name=local.txt`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${a.token}` }, body: 'A-UPLOAD' });
  check('上传回调保持租户上下文', upload.status === 200 && readFileSync(join(ta.directory, 'attachments', 'local.txt'), 'utf8') === 'A-UPLOAD');
  const auditA = (await request('/audit', a.token)).body.rows as Body[];
  const auditB = (await request('/audit', b.token)).body.rows as Body[];
  check('审计记录按租户保存', auditA.some((row) => row.taskId === ta.id) && !auditB.some((row) => row.taskId === ta.id));
  check('查询参数中的路径穿越被拒绝', (await request('/memory?taskId=..%2F..%2Ftasks%2F' + tb.id, a.token)).status === 404);
  writeFileSync(join(tb.directory, 'private.txt'), 'B-PRIVATE');
  await withTenant('alpha', async () => {
    const task = getTask(ta.id)!;
    const policy = taskFilePolicy(task, a.user.id);
    check('文件权限不能越出租户根', !policy(join(tb.directory, 'private.txt'), 'read'));
    await assert.rejects(() => readTool.run({ path: join(tb.directory, 'private.txt') }, { taskDir: task.directory, filePolicy: policy, extraAllowedDirs: [tb.directory] }));
    check('即使显式授权也不能读取其他租户文件', true);
  });
  withTenant('default', () => check('默认根目录不能进入其他租户目录', !tenantPathAllowed(tb.directory)));
  const defaultTask = (await request('/tasks', platform, 'POST', { name: 'root' })).body.task;
  check('默认租户文件列表不暴露租户子目录', !(await request(`/tasks/${defaultTask.id}/files`, platform)).body.files.includes('.tenants'));
  const pending = new TenantMap<string, string>();
  withTenant('alpha', () => pending.set('same-id', 'A'));
  withTenant('beta', () => { check('相同审批ID不能跨租户命中', !pending.has('same-id')); pending.set('same-id', 'B'); });
  withTenant('alpha', () => check('审批状态各自保留', pending.get('same-id') === 'A'));
  const scheduledToken = withTenant('beta', () => issueTokenForUser(b.user.id));
  check('定时任务令牌绑定租户', (await request('/auth/state', scheduledToken!)).body.user.tenantId === 'beta');
  await Promise.all(['alpha', 'beta'].map((id) => withTenant(id, async () => {
    const before = workspaceRoot(); await new Promise((resolve) => setTimeout(resolve, 15));
    check(`并发异步上下文保持 ${id}`, workspaceRoot() === before && workspaceRoot().endsWith(id));
  })));
  migrateTenantData();
  const userFile = join(process.env['WORKPIVOT_HOME'], 'data', 'users.json');
  const before = readFileSync(userFile, 'utf8'); migrateTenantData();
  check('迁移可重复且保留已有身份', readFileSync(userFile, 'utf8') === before);
  check('伪造令牌租户前缀无效', (await request('/projects', a.token.replace('alpha.', 'beta.'))).status === 401);
  console.log(`Tenant isolation: ${count} checks passed`);
} finally {
  await new Promise<void>((resolve) => model.close(() => resolve()));
  await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  rmSync(root, { recursive: true, force: true });
}
