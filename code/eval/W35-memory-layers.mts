import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
const root = mkdtempSync(join(tmpdir(), 'wp35-'));
Object.assign(process.env, { WORKPIVOT_HOME: join(root, 'home'), WORKPIVOT_WORKSPACE: join(root, 'workspace'), WORKPIVOT_HOST: '127.0.0.1', WORKPIVOT_SECRET_KEY: '12'.repeat(32), WORKPIVOT_EXECUTION_MODE: 'disabled', NODE_ENV: 'test' });
const { withTenant, withAccount } = await import('../packages/server/src/tenants.js');
const auth = await import('../packages/server/src/auth.js');
const { createApp } = await import('../packages/server/src/app.js');
const { createTask } = await import('../packages/server/src/tasks.js');
const { ensureDefaultProject } = await import('../packages/server/src/projects.js');
const { saveProvider } = await import('../packages/server/src/providers.js');
const { buildMemoryTools, pendingMemory } = await import('../packages/server/src/memory-tools.js');
const { readHandbook, listEntries } = await import('../packages/server/src/memory.js');
const admin = withTenant('default', () => auth.registerFirstAdmin('memory-admin', 'fixture-password'));
const member = withTenant('default', () => { auth.createUser('memory-member', 'fixture-password', 'member'); return auth.login('memory-member', 'fixture-password'); });
const other = withTenant('default', () => { auth.createUser('other-admin', 'fixture-password', 'admin'); return auth.login('other-admin', 'fixture-password'); });
const tasks = withAccount(member.user, () => { const p = ensureDefaultProject(); return ['first', 'second'].map(name => createTask({ name, directory: p.directory, projectId: p.id, ownerUserId: member.user.id })); });
const otherTask = withAccount(other.user, () => createTask({ name: 'other', directory: '', temp: true, ownerUserId: other.user.id }));
let captured = '';
const model = createServer((req, res) => { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
  captured = JSON.parse(body).messages.filter((m: { role: string }) => m.role === 'system').map((m: { content: string }) => m.content).join('\n');
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"memory fixture reply"}}]}\n\ndata: [DONE]\n\n');
}); });
model.listen(0, '127.0.0.1'); await new Promise<void>(r => model.once('listening', r));
const mp = model.address(); if (!mp || typeof mp === 'string') throw Error('port');
await withTenant('default', () => saveProvider({ name: 'fixture', baseUrl: `http://127.0.0.1:${mp.port}/v1`, modelId: 'fixture', apiKey: 'fixture', verify: false }));
const server = createApp().listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
const address = server.address(); if (!address || typeof address === 'string') throw Error('port');
const request = (path: string, method = 'GET', body?: unknown, token = member.token) => fetch(`http://127.0.0.1:${address.port}/api` + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
const view = async (taskId = tasks[0]!.id, token = member.token) => (await request('/memory-layers/' + (taskId ? '?taskId=' + taskId : ''), 'GET', undefined, token)).json();
const choose = async (roleId: string, autoLoad = true, token = member.token) => { const v = await view('', token); return request('/memory-layers/selection', 'POST', { ...v.selection, roleId, autoLoad }, token); };
const turn = async (taskId = tasks[0]!.id, token = member.token) => { captured = ''; const r = await request('/tasks/' + taskId + '/messages', 'POST', { content: 'inspect memory' }, token); assert.equal(r.status, 200); const text = await r.text(); assert.ok(text.includes('memory fixture reply'), text); return captured; };
let count = 0; function check(name: string, value: unknown) { assert.ok(value, name); count++; console.log('✅ ' + name); }
try {
  let v = await view('');
  check('three layers and seeded public roles', v.layers.length === 3 && v.catalog.templates.length === 3 && v.catalog.defaultId === null);
  check('no task scope cannot edit task/project', v.layers.filter((l: { editable: boolean }) => l.editable).length === 1 && v.selection.autoLoad);
  check('member cannot manage templates', (await request('/memory-layers/templates')).status === 403);
  check('member cannot publish templates', (await request('/memory-layers/templates', 'POST', v.catalog)).status === 403);
  const layerPath = (id: string) => '/memory-layers/' + id + '?taskId=' + tasks[0]!.id;
  for (const id of ['personal', 'project', 'task']) {
    v = await view(); const layer = v.layers.find((l: { id: string }) => l.id === id);
    const r = await request(layerPath(id), 'PUT', { revision: layer.revision, content: 'PRIVATE-' + id });
    check(id + ' save works', r.status === 200);
    const stale = await request(layerPath(id), 'PUT', { revision: layer.revision, content: 'overwrite' });
    check(id + ' stale save rejected with JSON', stale.status === 409 && Boolean((await stale.json()).error));
  }
  v = await view(tasks[1]!.id);
  check('same project shares project but not task notes', v.layers.find((l: { id: string }) => l.id === 'project').content === 'PRIVATE-project' && v.layers.find((l: { id: string }) => l.id === 'task').content === '');
  for (const token of [admin.token, other.token]) {
    check('admin cannot read foreign task memories', (await request('/memory-layers/?taskId=' + tasks[0]!.id, 'GET', undefined, token)).status === 404);
    check('admin cannot edit foreign task memories', (await request(layerPath('task'), 'PUT', { revision: '', content: 'bad' }, token)).status === 404);
    check('private memory absent from other account view', !JSON.stringify(await view('', token)).includes('PRIVATE-'));
  }
  check('oversized note rejected', (await request(layerPath('personal'), 'PUT', { revision: (await view()).layers[2].revision, content: 'x'.repeat(20001) })).status === 400);
  let catalog = (await view()).catalog;
  check('reserved role ID rejected', (await request('/memory-layers/templates', 'POST', { ...catalog, templates: [{ id: 'default', name: 'bad', content: '', enabled: true }] }, admin.token)).status === 400);
  catalog.defaultId = 'researcher'; catalog.templates[0].content = 'PUBLIC-ROLE';
  const saved = await request('/memory-layers/templates', 'POST', catalog, admin.token); check('admin saves default role', saved.status === 200); catalog = await saved.json();
  check('catalog stale update rejected', (await request('/memory-layers/templates', 'POST', { ...catalog, revision: 'initial' }, admin.token)).status === 409);
  check('public default available to member', (await view()).selection.effectiveRole.content === 'PUBLIC-ROLE');
  let prompt = await turn();
  check('actual model receives all three scopes and public role', ['PRIVATE-personal', 'PRIVATE-project', 'PRIVATE-task', 'PUBLIC-ROLE'].every(s => prompt.includes(s)));
  prompt = await turn(tasks[1]!.id); check('sibling task excludes first task memory', prompt.includes('PRIVATE-project') && !prompt.includes('PRIVATE-task'));
  prompt = await turn(otherTask.id, other.token); check('other account receives public role only', prompt.includes('PUBLIC-ROLE') && !prompt.includes('PRIVATE-'));
  check('user can opt out of role', (await choose('')).status === 200); prompt = await turn(); check('opt out retains personal/project/task', !prompt.includes('PUBLIC-ROLE') && prompt.includes('PRIVATE-task'));
  await choose('researcher'); check('explicit role selection works', (await view()).selection.roleId === 'researcher');
  catalog.templates[0].enabled = false; catalog.defaultId = null;
  catalog = await (await request('/memory-layers/templates', 'POST', catalog, admin.token)).json();
  check('disabled template not loaded', !(await turn()).includes('PUBLIC-ROLE'));
  catalog.templates = catalog.templates.filter((t: { id: string }) => t.id !== 'researcher');
  await request('/memory-layers/templates', 'POST', catalog, admin.token);
  check('deleted selected role still permits disabling memory', (await choose('researcher', false)).status === 200);
  check('memory off suppresses all injection', !/(PRIVATE-|PUBLIC-ROLE)/.test(await turn()));
  check('invalid role rejected', (await choose('missing', true)).status === 400);
  const events: unknown[] = [];
  const tools = withAccount(member.user, () => buildMemoryTools(member.user.id, tasks[0]!.id, e => events.push(e)));
  for (const name of ['remember', 'promote_memory']) {
    const result = await withAccount(member.user, () => tools.find(t => t.name === name)!.run({ content: 'SHOULD-NOT-WRITE' }, { taskDir: tasks[0]!.directory }));
    check(name + ' respects disabled memory', result.includes('关闭'));
  }
  check('off produces no confirmation and preserves personal notes', events.length === 0 && withAccount(member.user, () => readHandbook(member.user.id)) === 'PRIVATE-personal');
  await choose('default', true);
  const pending = withAccount(member.user, () => tools.find(t => t.name === 'promote_memory')!.run({ content: 'PENDING-NO-WRITE' }, { taskDir: tasks[0]!.directory }));
  check('promotion waiting for user confirmation', withAccount(member.user, () => pendingMemory(tasks[0]!.id, member.user.id).length) === 1);
  await choose('default', false, other.token);
  check('other account disable does not cancel pending write', withAccount(member.user, () => pendingMemory(tasks[0]!.id, member.user.id).length) === 1);
  await request('/memory/toggle', 'POST', { enabled: false }); await pending;
  check('legacy toggle cancels pending write', withAccount(member.user, () => pendingMemory(tasks[0]!.id, member.user.id).length) === 0);
  check('canceled write does not modify handbook or entries', withAccount(member.user, () => readHandbook(member.user.id) === 'PRIVATE-personal' && listEntries(member.user.id).length === 0));
  await choose('default', true);
  const pending2 = withAccount(member.user, () => tools.find(t => t.name === 'promote_memory')!.run({ content: 'PENDING-NO-WRITE-2' }, { taskDir: tasks[0]!.directory }));
  await choose('default', false); await pending2;
  check('new auto load switch cancels pending write', withAccount(member.user, () => pendingMemory(tasks[0]!.id, member.user.id).length === 0 && readHandbook(member.user.id) === 'PRIVATE-personal'));
  check('selection stale revision rejected', (await request('/memory-layers/selection', 'POST', { roleId: '', autoLoad: true, revision: 'stale' })).status === 409);
} finally {
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  model.closeAllConnections(); await new Promise<void>(r => model.close(() => r()));
  rmSync(root, { recursive: true, force: true });
}
console.log(`W35 ${count}/${count} passed`);
