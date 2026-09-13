import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
const root = mkdtempSync(join(tmpdir(), 'wp28-'));
process.env['WORKPIVOT_HOME'] = join(root, 'home');
process.env['WORKPIVOT_WORKSPACE'] = join(root, 'workspace');
process.env['WORKPIVOT_HOST'] = '127.0.0.1';
process.env['WORKPIVOT_INSECURE_SECRETS'] = '1';
process.env['WORKPIVOT_EXECUTION_MODE'] = 'disabled';
process.env['WORKPIVOT_MAX_PARALLEL'] = '1';
process.env['NODE_ENV'] = 'test';
const { withTenant, withAccount } = await import('../packages/server/src/tenants.js');
const auth = await import('../packages/server/src/auth.js');
const { createApp } = await import('../packages/server/src/app.js');
const { createTask, getTask, updateTaskStatus, markRunningTasksInterrupted } = await import('../packages/server/src/tasks.js');
const { beginArtifacts, finishArtifacts, listArtifacts } = await import('../packages/server/src/artifacts.js');
const { initializeSecretBox } = await import('../packages/server/src/secret.js');
const { saveProvider } = await import('../packages/server/src/providers.js');
const { downloadArtifact } = await import('../apps/desktop/src/artifact.js');
const admin = withTenant('default', () => auth.registerFirstAdmin('workflow-admin', 'fixture-password'));
const member = withTenant('default', () => { auth.createUser('workflow-member', 'fixture-password', 'member'); return auth.login('workflow-member', 'fixture-password'); });
initializeSecretBox();
let releaseHold: (() => void) | undefined;
const model = createServer((req, res) => {
  let body = ''; req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  req.on('end', () => {
    const input = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
    const last = input.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    if (last === 'fail') { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"fixture failure"}}'); return; }
    const reply = (): void => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = last === 'confirm' && !input.messages.some((m) => m.role === 'tool')
        ? { tool_calls: [{ index: 0, id: 'write', function: { name: 'write', arguments: '{"path":"approved.txt","content":"ok"}' } }] }
        : { content: 'finished' };
      res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
    };
    if (last === 'hold') releaseHold = reply; else reply();
  });
});
model.listen(0, '127.0.0.1'); await new Promise<void>((r) => model.once('listening', r));
const mp = model.address(); if (!mp || typeof mp === 'string') throw Error('model port');
await withTenant('default', () => saveProvider({ name: 'fixture', baseUrl: `http://127.0.0.1:${mp.port}/v1`, modelId: 'fixture', apiKey: 'fixture', verify: false }));
const server = createApp().listen(0, '127.0.0.1'); await new Promise<void>((r) => server.once('listening', r));
const address = server.address(); if (!address || typeof address === 'string') throw Error('port');
const url = `http://127.0.0.1:${address.port}`;
const request = (path: string, token = admin.token, method = 'GET', body?: unknown): Promise<Response> => fetch(url + '/api' + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const task = (name: string, user = admin.user) => withAccount(user, () => createTask({ name, directory: '', temp: true, ownerUserId: user.id }));
async function waitStatus(id: string, status: string): Promise<void> { for (let i = 0; i < 100; i++) { if ((await (await request('/tasks/' + id)).json()).task?.status === status) return; await new Promise((r) => setTimeout(r, 20)); } throw Error('status missing: ' + status); }
let count = 0;
function check(name: string, value: unknown): void { assert.ok(value, name); count++; console.log(`✅ ${name}`); }
try {
  const first = task('first'), second = task('second'), third = task('other account', member.user);
  const run = await request(`/tasks/${first.id}/messages`, admin.token, 'POST', { content: 'hold' });
  await waitStatus(first.id, 'running');
  const queued = await request(`/tasks/${second.id}/messages`, admin.token, 'POST', { content: 'quick' });
  await waitStatus(second.id, 'queued'); check('capacity queues second task', true);
  check('duplicate queued submission rejected', (await request(`/tasks/${second.id}/messages`, admin.token, 'POST', { content: 'quick' })).status === 409);
  const independent = await request(`/tasks/${third.id}/messages`, member.token, 'POST', { content: 'quick' });
  check('account queues independent', (await independent.text()).includes('finished'));
  check('queued task can stop', (await request(`/tasks/${second.id}/stop`, admin.token, 'POST')).status === 200);
  await queued.text(); await waitStatus(second.id, 'stopped');
  releaseHold?.(); await run.text(); await waitStatus(first.id, 'idle');
  const retry = await request(`/tasks/${second.id}/messages`, admin.token, 'POST', { content: 'quick' });
  check('stopped task can continue', (await retry.text()).includes('finished'));
  const failure = await request(`/tasks/${second.id}/messages`, admin.token, 'POST', { content: 'fail' });
  await failure.text(); await waitStatus(second.id, 'failed'); check('model failure is distinct', true);
  withTenant('default', () => auth.setUserTier(admin.user.id, 'ask'));
  const permission = await request(`/tasks/${second.id}/messages`, admin.token, 'POST', { content: 'confirm' });
  await waitStatus(second.id, 'waiting');
  const detail = await (await request('/tasks/' + second.id)).json();
  check('pending approval restored by detail API', detail.pending.length === 1);
  check('foreign user cannot inspect approval', (await request('/tasks/' + second.id, member.token)).status === 404);
  const decided = await request(`/tasks/${second.id}/permission`, admin.token, 'POST', { id: detail.pending[0].id, decision: 'deny' });
  check('restored approval can resolve', decided.status === 200);
  await permission.text(); await waitStatus(second.id, 'idle');
  check('resolved approval removed', (await (await request('/tasks/' + second.id)).json()).pending.length === 0);
  const product = task('versions');
  withAccount(admin.user, () => beginArtifacts(product));
  writeFileSync(join(product.directory, 'result.txt'), 'version one');
  withAccount(admin.user, () => finishArtifacts(product, 'completed'));
  const v1 = withAccount(admin.user, () => listArtifacts(product)[0]!.versions[0]!);
  withAccount(admin.user, () => beginArtifacts(product));
  writeFileSync(join(product.directory, 'result.txt'), 'version two');
  withAccount(admin.user, () => finishArtifacts(product, 'completed'));
  check('modified artifact creates revision', withAccount(admin.user, () => listArtifacts(product)[0]!.versions.length) === 2);
  withAccount(admin.user, () => finishArtifacts(product, 'completed'));
  check('unchanged artifact deduplicated', withAccount(admin.user, () => listArtifacts(product)[0]!.versions.length) === 2);
  const endpoint = `/tasks/${product.id}/artifact?name=result.txt&version=${v1.id}`;
  check('old revision content immutable', await (await request(endpoint)).text() === 'version one');
  check('old revision remains private', (await request(endpoint, member.token)).status === 404);
  check('forged revision denied', (await request(`/tasks/${product.id}/artifact?name=result.txt&version=../../users.json`)).status === 404);
  const local = await downloadArtifact(url, product.id, 'result.txt', admin.token, join(root, 'cache'), v1.id);
  check('desktop selects exact revision', readFileSync(local, 'utf8') === 'version one');
  withAccount(admin.user, () => finishArtifacts(product, 'error'));
  check('partial artifact marked failed', withAccount(admin.user, () => listArtifacts(product)[0]!.state) === 'failed');
  const interrupted = task('restart recovery');
  withAccount(admin.user, () => { updateTaskStatus(interrupted.id, 'queued'); markRunningTasksInterrupted(); });
  check('restart recovers queued state', withAccount(admin.user, () => getTask(interrupted.id)!.status) === 'interrupted');
  console.log(`W28 ${count}/${count} passed`);
} finally { releaseHold?.(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); model.closeAllConnections(); await new Promise<void>((r) => model.close(() => r())); }
