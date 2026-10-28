import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AccountRepository } from '../packages/server/src/database/accounts.js';
import { createDatabaseApp } from '../packages/server/src/database/app.js';
import { installSchema, pool } from '../packages/server/src/database/connection.js';

const url = process.env['WORKPIVOT_TEST_PG_URL'];
if (!url || process.env['WORKPIVOT_TEST_PG_DISPOSABLE'] !== '1') throw Error('Requires an explicitly disposable PostgreSQL instance');
const password = randomBytes(24).toString('hex');
const admin = pool(url);
await admin.query(`CREATE ROLE workspace_sync_app LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE workspace_sync_auth LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE workpivot_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE workpivot_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
const appUrl = new URL(url); appUrl.username = 'workspace_sync_app'; appUrl.password = password;
const authUrl = new URL(url); authUrl.username = 'workspace_sync_auth'; authUrl.password = password;
const business = pool(appUrl.toString(), { max: 2 }), identity = pool(authUrl.toString(), { max: 2 });
let server: ReturnType<Awaited<ReturnType<typeof createDatabaseApp>>['listen']> | undefined;
try {
  await installSchema(admin, 'workspace_sync_app', 'workspace_sync_auth');
  const accounts = new AccountRepository(identity);
  const owner = await accounts.registerFirst('workspace-sync', password);
  const app = await createDatabaseApp(identity, business, password);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No server port');
  const base = `http://127.0.0.1:${address.port}/api`;
  const headers = { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/workspace/stream?after=0`)).status, 401, 'workspace stream requires authentication');

  const controller = new AbortController();
  const response = await fetch(`${base}/workspace/stream?after=0`, { headers, signal: controller.signal });
  assert.equal(response.status, 200, 'workspace stream opens');
  assert(response.headers.get('content-type')?.includes('text/event-stream'));
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = '';
  async function nextWorkspace(timeoutMs = 5000) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (;;) {
        const lineEnd = buffer.indexOf('\n');
        if (lineEnd >= 0) {
          const line = buffer.slice(0, lineEnd).trimEnd(); buffer = buffer.slice(lineEnd + 1);
          if (!line.startsWith('data:')) continue;
          const event = JSON.parse(line.slice(5).trim()) as { type: string; value?: { revision: string; tasks: { id: string; name: string }[] } };
          if (event.type === 'workspace') return event.value!;
        }
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('workspace stream timeout')), timeoutMs); }),
        ]).finally(() => clearTimeout(timer));
        if (chunk.done) throw Error('workspace stream closed early');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    } finally { clearTimeout(timer); }
  }

  const initial = await nextWorkspace();
  assert.equal(initial.revision, '0');
  assert.deepEqual(initial.tasks, []);
  const projectResponse = await fetch(`${base}/projects`, { method: 'POST', headers, body: JSON.stringify({ name: '跨端项目' }) });
  assert(projectResponse.ok);
  const project = (await projectResponse.json() as { project: { id: string } }).project;
  const taskResponse = await fetch(`${base}/tasks`, { method: 'POST', headers, body: JSON.stringify({ name: '手机发起的任务', projectId: project.id }) });
  assert(taskResponse.ok);
  let changed = await nextWorkspace();
  while (!changed.tasks.some(task => task.name === '手机发起的任务')) changed = await nextWorkspace();
  assert(BigInt(changed.revision) > 0n, 'workspace revision advances');
  controller.abort();
  console.log('Workspace sync: 6/6 passed');
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
  }
  await Promise.all([business.end(), identity.end(), admin.end()]);
}
