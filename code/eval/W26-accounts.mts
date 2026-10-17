import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
const root = mkdtempSync(join(tmpdir(), 'wp26-'));
process.env['NODE_ENV'] = 'test';
process.env['WORKPIVOT_HOME'] = join(root, 'home');
process.env['WORKPIVOT_WORKSPACE'] = join(root, 'workspace');
process.env['WORKPIVOT_HOST'] = '127.0.0.1';
process.env['WORKPIVOT_INSECURE_SECRETS'] = '1';
process.env['WORKPIVOT_EXECUTION_MODE'] = 'disabled';
const { withTenant, withAccount, tenantPathAllowed } = await import('../packages/server/src/tenants.js');
const { currentTenant } = await import('../packages/shared/src/tenant-scope.js');
const auth = await import('../packages/server/src/auth.js');
const { createTask, listTasks, appendTranscript } = await import('../packages/server/src/tasks.js');
const { createProject, ensureDefaultProject, listProjects } = await import('../packages/server/src/projects.js');
const { migrateAccountData } = await import('../packages/server/src/account-migration.js');
const { migrateTenantData } = await import('../packages/server/src/tenant-migration.js');
const { createApp } = await import('../packages/server/src/app.js');
const { TenantMap } = await import('../packages/server/src/tenant-map.js');
const { writeHandbook } = await import('../packages/server/src/memory.js');
const { initializeSecretBox } = await import('../packages/server/src/secret.js');
const { runScheduleNow } = await import('../packages/server/src/schedules.js');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试夹具的 HTTP 请求体结构不一致
type Body = Record<string, any>;
let checks = 0;
function check(name: string, condition: unknown): void { assert.ok(condition, name); checks++; console.log(`✅ ${name}`); }
const password = 'account-fixture-password';
const admin = withTenant('default', () => auth.registerFirstAdmin('admin-one', password));
const member = withTenant('default', () => auth.createUser('member-one', password, 'member'));
const secondAdmin = withTenant('default', () => auth.createUser('admin-two', password, 'admin'));
// 重建 preview.13 存储：没有账号标记，任务与项目归属明确。
for (const user of [admin.user, member, secondAdmin]) unlinkSync(join(root, 'home/accounts', user.id, 'account-migration.json'));
const legacy = withTenant('default', () => {
  ensureDefaultProject();
  const project = createProject('member private', join(root, 'workspace/legacy-member'), member.id);
  const task = createTask({ name: 'member legacy', directory: project.directory, projectId: project.id, ownerUserId: member.id });
  writeFileSync(join(project.directory, 'private.txt'), 'MEMBER-ONLY');
  appendTranscript(task.id, { kind: 'user', text: 'private history' });
  const a = createTask({ name: 'admin legacy', directory: join(root, 'workspace/legacy-admin'), temp: true, ownerUserId: admin.user.id });
  writeFileSync(join(a.directory, 'admin.txt'), 'ADMIN-ONLY');
  writeHandbook(member.id, 'personal memory');
  const unknown = createTask({ name: 'unclaimed', directory: join(root, 'workspace/unclaimed'), temp: true });
  for (const owner of [admin.user.id, member.id]) createTask({ name: 'shared legacy', directory: join(root, 'workspace/shared'), temp: true, ownerUserId: owner });
  writeFileSync(join(root, 'workspace/shared/shared.txt'), 'ambiguous ownership');
  return { project, task, unknown };
});
migrateTenantData(); migrateAccountData();
const memberTask = withAccount(member, () => listTasks().find((t) => t.id === legacy.task.id)!);
check('migration assigns member task', memberTask.ownerUserId === member.id && memberTask.id === legacy.task.id);
check('migration copies private files', readFileSync(join(memberTask.directory, 'private.txt'), 'utf8') === 'MEMBER-ONLY');
check('migration preserves originals', existsSync(join(legacy.project.directory, 'private.txt')));
check('shared files are not assigned arbitrarily', withAccount(member, () => listTasks().filter((t) => t.name === 'shared legacy').every((t) => !existsSync(join(t.directory, 'shared.txt')))));
check('shared originals retained', existsSync(join(root, 'workspace/shared/shared.txt')));
check('admin cannot list member or unknown tasks', withAccount(admin.user, () => listTasks().every((t) => t.ownerUserId === admin.user.id)));
check('default projects are personal', withAccount(secondAdmin, () => listProjects()[0]?.ownerUserId === secondAdmin.id));
const mtime = readFileSync(join(root, 'home/accounts', member.id, 'account-migration.json'), 'utf8');
migrateAccountData();
check('migration idempotent', mtime === readFileSync(join(root, 'home/accounts', member.id, 'account-migration.json'), 'utf8'));
initializeSecretBox();
const http = createApp().listen(0, '127.0.0.1');
await new Promise<void>((resolve) => http.once('listening', resolve));
const address = http.address(); if (!address || typeof address === 'string') throw Error('port unavailable');
const url = `http://127.0.0.1:${address.port}`;
async function request(path: string, token = '', method = 'GET', body?: unknown): Promise<{ status: number; body: Body }> {
  const r = await fetch(url + '/api' + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() as Body };
}
const model = createServer((req, res) => { req.resume(); req.on('end', () => {
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"account reply"}}]}\n\ndata: [DONE]\n\n');
}); });
model.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => model.once('listening', resolve));
try {
  const a = (await request('/auth/login', '', 'POST', { username: 'admin-one', password })).body.token as string;
  const m = (await request('/auth/login', '', 'POST', { username: 'member-one', password, tenantId: 'forged' })).body.token as string;
  const b = (await request('/auth/login', '', 'POST', { username: 'admin-two', password })).body.token as string;
  check('username-only login ignores namespace selector', Boolean(a && m && b));
  check('old sessions retained', (await request('/tasks', admin.token)).status === 200);
  check('tenant management removed', (await request('/tenants', a)).status === 410);
  check('member can create project', (await request('/projects', m, 'POST', { name: 'new personal project' })).status === 200);
  check('admin cannot list member project', !(await request('/projects', a)).body.projects.some((p: Body) => p.id === legacy.project.id));
  for (const token of [a, b]) {
    for (const suffix of ['', '/files', '/transcript', '/plan']) check('admin denies private task ' + suffix, (await request('/tasks/' + memberTask.id + suffix, token)).status === 404);
    for (const [suffix, method, body] of [['/stop', 'POST', {}], ['/messages', 'POST', { content: 'steal' }], ['/permission', 'POST', {}], ['', 'DELETE', {}]] as const)
      check('admin cannot mutate private task ' + suffix, (await request('/tasks/' + memberTask.id + suffix, token, method, body)).status === 404);
    check('admin cannot rename private project', (await request('/projects/' + legacy.project.id, token, 'PUT', { name: 'take over' })).status === 404);
    check('admin cannot read project memory', (await request('/projects/' + legacy.project.id + '/memory', token)).status === 404);
    check('admin cannot assign ownership', (await request('/projects/' + legacy.project.id + '/access', token, 'PUT', { ownerUserId: admin.user.id, memberUserIds: [] })).status === 403);
    check('admin cannot target foreign directory', (await request('/projects', token, 'POST', { name: 'escape', directory: memberTask.directory })).status === 400);
    const upload = await fetch(url + '/api/tasks/' + memberTask.id + '/attachments?name=bad.txt', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: 'forbidden' });
    check('admin cannot upload to private task', upload.status === 404);
  }
  const upload = await fetch(url + '/api/tasks/' + memberTask.id + '/attachments?name=ok.txt', { method: 'POST', headers: { authorization: `Bearer ${m}`, 'content-type': 'application/octet-stream' }, body: 'own file' });
  check('owner upload works', upload.status === 200 && readFileSync(join(memberTask.directory, 'attachments/ok.txt'), 'utf8') === 'own file');
  check('owner sees migrated history', JSON.stringify((await request('/tasks/' + memberTask.id + '/transcript', m)).body).includes('private history'));
  check('owner sees migrated memory', JSON.stringify((await request('/memory', m)).body).includes('personal memory'));
  check('member controls personal memory', (await request('/memory/toggle', m, 'POST', { enabled: false })).status === 200);
  check('personal memory toggle does not change admin', (await request('/memory', a)).body.enabled !== false);
  check('admin cannot see member memory', !JSON.stringify((await request('/memory', a)).body).includes('personal memory'));
  const map = new TenantMap<string, string>();
  withAccount(member, () => map.set('same', 'member'));
  withAccount(admin.user, () => map.set('same', 'admin'));
  check('runtime maps account scoped', withAccount(member, () => map.get('same')) === 'member');
  check('foreign file boundary denies admins', withAccount(admin.user, () => !tenantPathAllowed(memberTask.directory)));
  check('identity store inaccessible', withAccount(admin.user, () => !tenantPathAllowed(join(root, 'home/data/users.json'))));
  const ownScope = withAccount(member, () => currentTenant()!);
  check('personal workspace root excludes siblings', ownScope.workspace.endsWith(member.id));
  if (process.platform !== 'win32') {
    symlinkSync(memberTask.directory, withAccount(admin.user, () => join(currentTenant()!.workspace, 'escape')));
    check('symlink cannot cross accounts', withAccount(admin.user, () => !tenantPathAllowed(join(currentTenant()!.workspace, 'escape/private.txt'))));
  }
  const modelAddress = model.address(); if (!modelAddress || typeof modelAddress === 'string') throw Error('model port');
  check('admin can configure shared model', (await request('/providers', a, 'POST', { name: 'shared fixture', baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`, modelId: 'fixture', apiKey: 'test', verify: false })).status === 200);
  check('member can use configured model', (await request('/providers', m)).body.providers.length === 1);
  const secondTask = (await request('/tasks', b, 'POST', { name: 'admin two new', temp: true })).body.task as Body;
  check('second admin creates own task', secondTask.ownerUserId === secondAdmin.id);
  const replies = await Promise.all([[m, memberTask.id], [b, secondTask.id]].map(async ([token, id]) => {
    const r = await fetch(url + '/api/tasks/' + id + '/messages', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello' }) }); return r.status === 200 && (await r.text()).includes('account reply');
  }));
  check('concurrent personal streams succeed', replies.every(Boolean));
  const schedule = (await request('/schedules', b, 'POST', { name: 'private schedule', cron: '0 0 * * *', content: 'scheduled hello', taskName: 'scheduled personal' })).body.schedule as Body;
  check('schedules isolated from other admin', (await request('/schedules', a)).body.schedules.length === 0);
  await withAccount(secondAdmin, () => runScheduleNow(schedule.id as string, address.port));
  check('scheduler authenticates as owner', (await request('/tasks', b)).body.tasks.some((t: Body) => t.name === 'scheduled personal'));
  check('admin cannot see scheduled task', !(await request('/tasks', a)).body.tasks.some((t: Body) => t.name === 'scheduled personal'));
  check('account management remains available', (await request('/users', a)).body.users.length === 3);
  check('member cannot manage accounts', (await request('/users', m)).status === 403);
  check('duplicate trimmed username rejected', (await request('/users', a, 'POST', { username: ' member-one ', password, role: 'member' })).status === 400);
  check('revoke another account sessions', (await request('/users/' + member.id + '/sessions', a, 'DELETE')).status === 200 && (await request('/tasks', m)).status === 401);
  console.log(`W26: ${checks}/${checks} passed; temporary fixture ${root}`);
} finally { await new Promise<void>((resolve) => http.close(() => resolve())); await new Promise<void>((resolve) => model.close(() => resolve())); }
