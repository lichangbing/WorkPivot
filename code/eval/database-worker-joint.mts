/** 使用一次性 PostgreSQL、真实执行器和固定模型回复进行联调。 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ModelClient } from '@workpivot/core';
import { pool, installSchema, transaction } from '../packages/server/src/database/connection.js';
import { AccountRepository } from '../packages/server/src/database/accounts.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { DatabaseExecution } from '../packages/server/src/database/execution.js';
import { DatabaseSkills } from '../packages/server/src/database/skills.js';
import { DatabaseSkillExecution } from '../packages/server/src/database/skill-execution.js';
import { FileRepository } from '../packages/server/src/database/files.js';
import { createDatabaseApp } from '../packages/server/src/database/app.js';

if (process.env.WORKPIVOT_JOINT_FIXTURE !== '1') throw Error('Disposable test only');
const adminUrl = new URL(process.env.WORKPIVOT_TEST_PG_URL!);
if (adminUrl.hostname !== '127.0.0.1' || adminUrl.pathname !== '/workpivot_joint') throw Error('Invalid fixture database');
const admin = pool(adminUrl.toString());
const password = randomBytes(24).toString('hex');
const appUrl = new URL(adminUrl); appUrl.username = 'joint_app'; appUrl.password = password;
const authUrl = new URL(appUrl); authUrl.username = 'joint_auth';
const db = pool(appUrl.toString()), auth = pool(authUrl.toString());
let server: ReturnType<Awaited<ReturnType<typeof createDatabaseApp>>['listen']> | undefined;
let checks = 0;
const check = (v: unknown, name: string) => { assert.ok(v, name); checks++; console.log('PASS ' + name); };
try {
  await admin.query(`CREATE ROLE joint_app LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; CREATE ROLE joint_auth LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  await installSchema(admin, 'joint_app', 'joint_auth');
  const init = randomBytes(24).toString('hex');
  const owner = await new AccountRepository(auth).registerFirst('joint-test', randomBytes(24).toString('hex'), init, init);
  const actor = owner.user.id, workspace = new WorkspaceRepository(db), skills = new DatabaseSkills(db);
  const files = new FileRepository(db, '/tmp/joint-artifacts');
  let skill = await skills.create(actor, 'joint-test');
  skill = await skills.publish(actor, skill.name, skill.revision); await skills.select(actor, skill.name, true);
  await workspace.saveSetting(actor, 'execution.mode', 'auto', 0);
  const task = await workspace.createTask(actor, 'joint execution');
  let args: Record<string, unknown> = {};
  const client: ModelClient = { providerId: 'fixture', model: 'fixture', async *streamChat(messages) {
    if (messages.at(-1)?.role === 'tool') { yield { type: 'delta', text: '工具调用已结束，请核对执行结果。' }; return; }
    yield { type: 'tool_calls', tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'execute_skill', arguments: JSON.stringify(args) } }] };
  } };
  const execution = new DatabaseExecution(db, async (user, taskId, context) => ({
    client, system: 'Controlled tool invocation fixture', taskDir: '.', filePolicy: () => false,
    tools: [new DatabaseSkillExecution(db, files, skills, { url: process.env.WORKPIVOT_WORKER_URL!, token: process.env.WORKPIVOT_WORKER_TOKEN! }, () => context.run).tool(user, taskId, new Map([[skill.name, skill.published!]]))],
  }));
  const app = await createDatabaseApp(auth, db, init, execution, undefined, undefined, undefined, files);
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server!.once('listening', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${address.port}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000),
  });
  const root = `/tasks/${task.id}`;
  const run = async (command: string, output: Record<string, unknown>, fault?: string) => {
    args = { skill: skill.name, command, inputs: [], ...output };
    const response = await request(root + '/messages', { content: 'controlled execution', requestId: randomUUID() }); assert.equal(response.status, 200);
    const stream = response.text();
    if (fault) {
      const control = await fetch(process.env.WORKPIVOT_JOINT_CONTROL_URL! + '/' + fault, { method: 'POST', headers: { authorization: `Bearer ${process.env.WORKPIVOT_WORKER_TOKEN}` }, signal: AbortSignal.timeout(15000) });
      assert.equal(control.status, 200);
      if (fault === 'started') assert.equal((await request(root + '/stop', {})).status, 202);
    }
    const text = await stream;
    const idle = await fetch(process.env.WORKPIVOT_JOINT_CONTROL_URL! + '/idle', { method: 'POST', headers: { authorization: `Bearer ${process.env.WORKPIVOT_WORKER_TOKEN}` }, signal: AbortSignal.timeout(15000) });
    assert.equal(idle.status, 200);
    return text;
  };
  const artifacts = async () => (await (await request(root + '/artifacts')).json()).artifacts;
  const jobs = () => transaction(db, async c => (await c.query('SELECT status,artifact_id FROM workpivot.skill_executions WHERE task_id=$1', [task.id])).rows, actor);
  const good = await run('echo original > report.txt', { output: 'report.txt' });
  check(good.includes('"stopReason":"completed"'), 'successful HTTP execution finishes normally');
  const original = (await artifacts())[0]; assert.ok(original);
  check((await jobs()).length === 1 && (await jobs())[0].artifact_id === original.id, 'worker output and completed job commit together');
  const bytes = () => files.download(actor, task.id, original.id);
  check((await bytes()).data.toString() === 'original\n', 'published artifact bytes match actual sandbox output');

  const update = { output: 'report.txt', documentId: original.documentId, revision: 1 };
  const cancelled = await run('echo partial > report.txt; touch started; sleep 30', update, 'started');
  check(cancelled.includes('"stopReason":"aborted"'), 'HTTP stop produces durable aborted event');
  check((await workspace.listTasks(actor)).find(t => t.id === task.id)?.status === 'stopped', 'task status agrees with cancellation');
  check((await jobs()).filter(j => j.status === 'interrupted').length === 1, 'cancelled real worker job is recorded as interrupted');
  check((await files.versions(actor, task.id, original.documentId)).length === 1 && (await bytes()).data.toString() === 'original\n', 'cancelled update preserves committed artifact and version');

  await run('echo crashed > report.txt; touch started; sleep 30', update, 'kill');
  check((await jobs()).filter(j => j.status === 'failed').length === 1, 'actual sandbox kill is recorded as failed execution');
  check((await artifacts()).length === 1 && (await files.versions(actor, task.id, original.documentId)).length === 1, 'sandbox crash publishes no partial version');

  await run('echo incomplete > report.txt', { outputs: [{ name: 'report.txt', documentId: original.documentId, revision: 1 }, { name: 'missing.txt' }] });
  check((await jobs()).filter(j => j.status === 'failed').length === 2 && (await artifacts()).length === 1 && (await files.versions(actor, task.id, original.documentId)).length === 1, 'missing second real output rolls back entire publication');

  await run('echo recovered > report.txt', update);
  const current = (await artifacts())[0];
  check(current.revision === 2 && (await files.download(actor, task.id, current.id)).data.toString() === 'recovered\n', 'explicit retry publishes exactly one new revision');
  check((await bytes()).data.toString() === 'original\n', 'successful retry retains original version bytes');
  const records = await jobs();
  check(records.length === 5 && records.filter(j => j.status === 'completed').length === 2 && records.every(j => j.status !== 'running'), 'all five requests have one terminal job without hidden retries');
  check((await execution.runs.pendingPermissions(actor, task.id)).length === 0, 'automatic one-time approvals leave no pending request');
  console.log(`Database worker joint: ${checks}/${checks} passed`);
} finally {
  server?.closeAllConnections(); if (server) await new Promise<void>(r => server!.close(() => r()));
  await Promise.all([admin.end(), auth.end(), db.end()]);
}
