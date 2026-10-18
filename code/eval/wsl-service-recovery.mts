/** 一次性的完整运行环境夹具；禁止连接业务数据库。 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool, installSchema, transaction } from '../packages/server/src/database/connection.js';
import { AccountRepository } from '../packages/server/src/database/accounts.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { RunRepository } from '../packages/server/src/database/runs.js';
import { createDatabaseRuntime } from '../packages/server/src/database/runtime.js';
import { McpRepository } from '../packages/server/src/database/mcp.js';

if (process.env.WORKPIVOT_SERVICE_RECOVERY_FIXTURE !== '1') throw Error('Disposable fixture only');
for (const key of ['WORKPIVOT_DATABASE_URL', 'WORKPIVOT_AUTH_DATABASE_URL', 'WORKPIVOT_DATABASE_ADMIN_URL']) {
  const url = new URL(process.env[key] ?? '');
  if (!/^workpivot-recovery-test-\d+-db$/.test(url.hostname) || url.pathname !== '/recovery') throw Error('Expected isolated recovery database');
}
const fixturePath = '/tmp/workpivot-service-recovery.json';
interface Fixture { actor: string; token: string; task: string; run: Awaited<ReturnType<RunRepository['start']>>; permission: string; cursor: string; secret: string; mcpRun: Awaited<ReturnType<RunRepository['start']>> }
const db = pool(process.env.WORKPIVOT_DATABASE_URL!), auth = pool(process.env.WORKPIVOT_AUTH_DATABASE_URL!);
const init = 'disposable-service-recovery-initialization';
const mcpUrl = process.env.WORKPIVOT_RECOVERY_MCP_URL!;
if (!/^http:\/\/workpivot-recovery-test-\d+-mcp:39801$/.test(mcpUrl)) throw Error('Expected isolated MCP fixture');
let checks = 0;
const check = (value: unknown, name: string) => { assert.ok(value, name); checks++; console.log('PASS ' + name); };

async function verify(mode: string) {
  const f: Fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const request = (path: string, options: RequestInit = {}) => fetch('http://127.0.0.1:39800/api' + path, {
    ...options, headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
  });
  check((await request('/health')).ok, 'full runtime is reachable');
  const taskPath = `/tasks/${f.task}`;
  const permission = await (await request(taskPath + '/permissions')).json();
  if (mode === 'before') {
    check(permission.pending.some((p: { id: string }) => p.id === f.permission), 'live confirmation visible before crash');
    const audit = await (await fetch(mcpUrl + '/audit', { signal: AbortSignal.timeout(5000) })).json();
    check(audit.calls === 1 && !audit.released, 'MCP persisted one real side effect before responding');
    return;
  }
  const state = await transaction(db, async c => ({
    run: (await c.query('SELECT status FROM workpivot.task_runs WHERE id=$1', [f.run.id])).rows[0],
    permission: (await c.query('SELECT state FROM workpivot.run_permissions WHERE id=$1', [f.permission])).rows[0],
    skill: (await c.query('SELECT status,error FROM workpivot.skill_executions WHERE run_id=$1', [f.run.id])).rows[0],
    counts: (await c.query('SELECT (SELECT count(*)::int FROM workpivot.task_runs WHERE task_id=$1) AS runs,(SELECT count(*)::int FROM workpivot.skill_executions WHERE task_id=$1) AS skills', [f.task])).rows[0],
  }), f.actor);
  check(state.run.status === 'interrupted', 'runtime timer recovers expired run after entire server restarts');
  check(state.permission.state === 'cancelled' && permission.pending.length === 0, 'orphaned confirmation cancelled');
  check(state.skill.status === 'interrupted' && state.skill.error.includes('结果未确认'), 'uncertain skill result is not silently completed');
  check(state.counts.runs === 1 && state.counts.skills === 1, 'restart creates no replacement task or skill execution');
  const external = await transaction(db, async c => (await c.query('SELECT status FROM workpivot.task_runs WHERE id=$1', [f.mcpRun.id])).rows[0], f.actor);
  check(external.status === 'interrupted', 'in-flight MCP run recovered as interrupted');
  assert.ok((await fetch(mcpUrl + '/release', { method: 'POST', signal: AbortSignal.timeout(5000) })).ok);
  const audit = await (await fetch(mcpUrl + '/audit', { signal: AbortSignal.timeout(5000) })).json();
  check(audit.calls === 1, 'restart never dispatches the external side effect again');
  const mcpChanges = await (await request(`/tasks/${f.mcpRun.taskId}/conversation-changes?after=0`)).json();
  check(mcpChanges.events.every((e: { kind: string; content: string }) => e.kind !== 'tool_result' && !e.content.includes('side effect persisted')), 'unacknowledged external result is not claimed as received');
  check((await request(taskPath + `/permissions/${f.permission}`, { method: 'POST', body: JSON.stringify({ decision: 'allow' }) })).status === 409, 'stale approval rejected after restart');
  const changes = await (await request(taskPath + '/conversation-changes?after=0')).json();
  check(changes.events.filter((e: { content: string }) => e.content === 'durable partial answer').length === 1, 'partial response persists exactly once');
  const done = changes.events.filter((e: { kind: string; content: string }) => e.kind === 'meta' && e.content.includes('"stopReason":"interrupted"'));
  check(done.length === 1, 'recovery emits exactly one interrupted event across restarts');
  await assert.rejects(new RunRepository(db).append(f.actor, f.run, { type: 'assistant_delta', text: 'stale output' }));
  check(true, 'old executor cannot append after recovery');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`http://127.0.0.1:39800/api${taskPath}/stream?after=${f.cursor}`, { headers: { Authorization: `Bearer ${f.token}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let buffer = '', sawChanges = false, sawState = false;
    while (!sawChanges || !sawState) {
      const next = await reader.read(); assert.ok(!next.done, 'SSE unexpectedly closed');
      buffer += decoder.decode(next.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        if (event.type === 'changes') {
          assert.ok(event.events.every((e: { sequence: string }) => BigInt(e.sequence) > BigInt(f.cursor)));
          sawChanges ||= event.events.some((e: { content: string }) => e.content.includes('"stopReason":"interrupted"'));
        }
        if (event.type === 'state') { assert.equal(event.value.pending.length, 0); sawState = true; }
      }
    }
    check(true, 'SSE reconnect replays recovery after saved cursor with no pending confirmation');
  } finally { clearTimeout(timeout); controller.abort(); }
  if(mode==='soak'){
    const body=Buffer.from('稳定性合成文件：'+f.run.id);
    const upload=await fetch(`http://127.0.0.1:39800/api${taskPath}/files?name=soak.txt&requestId=${f.run.id}`,{
      method:'POST',headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/octet-stream'},body,signal:AbortSignal.timeout(5000),
    });
    check(upload.ok,'重复上传幂等请求成功');
    const {file}=await upload.json();
    const listed=await (await request(taskPath+'/files')).json();
    check(listed.files.length===1&&listed.files[0].id===file.id,'重复请求没有新增文件或版本');
    const download=await request(taskPath+'/file-versions/'+file.id);
    check(download.ok&&Buffer.from(await download.arrayBuffer()).equals(body),'持续运行后下载内容与上传字节一致');
    const connections=await auth.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename IN ('wp_recovery_app','wp_recovery_auth')");
    check(connections.rows[0].n<=40,'数据库连接数量未超过API和夹具连接池上限');
  }

}

async function serve() {
  let fixture: Fixture | undefined;
  try { fixture = JSON.parse(await readFile(fixturePath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const first = !fixture;
  if (!fixture) {
    const admin = pool(process.env.WORKPIVOT_DATABASE_ADMIN_URL!);
    try {
      for (const url of [process.env.WORKPIVOT_DATABASE_URL!, process.env.WORKPIVOT_AUTH_DATABASE_URL!]) {
        const parsed = new URL(url);
        assert.match(parsed.username, /^wp_recovery_(app|auth)$/); assert.match(parsed.password, /^[a-f0-9]+$/);
        await admin.query(`CREATE ROLE ${parsed.username} LOGIN PASSWORD '${parsed.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
      }
      await installSchema(admin, 'wp_recovery_app', 'wp_recovery_auth');
    } finally { await admin.end(); }
    const owner = await new AccountRepository(auth).registerFirst('recovery-fixture', randomBytes(24).toString('hex'), init, init);
    const task = await new WorkspaceRepository(db).createTask(owner.user.id, 'full service interruption');
    const runs = new RunRepository(db), run = await runs.start(owner.user.id, task.id, randomUUID(), 'durable question');
    await runs.append(owner.user.id, run, { type: 'assistant_delta', text: 'durable partial answer' });
    const permission = await runs.requestPermission(owner.user.id, run, { tool: 'fixture', command: 'no actual external operation', external: true, paths: [], kind: 'write' });
    await transaction(db, c => c.query('INSERT INTO workpivot.skill_executions(id,owner_user_id,run_id,task_id) VALUES($1,$2,$3,$4)', [randomUUID(), owner.user.id, run.id, task.id]), owner.user.id);
    const cursor = await transaction(db, async c => (await c.query('SELECT (next_sequence-1)::text AS cursor FROM workpivot.tasks WHERE id=$1', [task.id])).rows[0].cursor as string, owner.user.id);
    const mcpTask = await new WorkspaceRepository(db).createTask(owner.user.id, 'MCP uncertain result');
    const mcpRun = await runs.start(owner.user.id, mcpTask.id, randomUUID(), 'persist a test marker');
    fixture = { actor: owner.user.id, token: owner.token, task: task.id, run, permission: permission.id, cursor, secret: randomBytes(32).toString('hex'), mcpRun };
    await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600, flag: 'wx' });
  }
  const app = await createDatabaseRuntime(auth, db, { initToken: init, secretKey: fixture.secret, filesRoot: '/tmp/recovery-files', webDist: '/app/apps/web/dist' });
  // 预置执行器心跳位于 API 进程中，随 SIGKILL 一并终止。
  if (first) {
    const f = fixture;
    const runs = new RunRepository(db);
    setInterval(() => { for (const run of [f.run, f.mcpRun]) void runs.heartbeat(f.actor, run).catch(() => undefined); }, 1000);
    const mcp = new McpRepository(db, f.secret);
    let connection = await mcp.save(f.actor, { name: 'Crash recovery MCP', url: mcpUrl + '/mcp' });
    connection = await mcp.discover(f.actor, connection.id, connection.revision);
    await mcp.toggle(f.actor, connection.id, connection.revision, true);
    const tool = (await mcp.tools(f.actor))[0]!;
    void (async () => {
      const result = await tool.run({}, { taskDir: '.', requestAccess: async request => {
        const p = await runs.requestPermission(f.actor, f.mcpRun, request);
        await runs.decidePermission(f.actor, f.mcpRun.taskId, p.id, 'allow');
        return await runs.consumePermission(f.actor, f.mcpRun, p.id) === 'allow';
      } });
      await runs.append(f.actor, f.mcpRun, { type: 'assistant_delta', text: result });
    })().catch(() => console.error('MCP fixture call ended before server termination'));
  }
  app.listen(39800, '0.0.0.0', () => console.log('RECOVERY_FIXTURE_READY'));
}

if (process.argv[2] === 'serve') await serve();
else {
  try { await verify(process.argv[2] ?? 'after'); console.log(`Service recovery: ${checks} checks passed`); }
  finally { await Promise.all([db.end(), auth.end()]); }
}
