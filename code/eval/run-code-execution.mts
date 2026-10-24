/**
 * run_code 的编排检查：用可控的假 Pool、假 worker 和假文件仓库执行 DatabaseCodeExecution.run，
 * 验证真实代码路径上的查询契约、沙箱入参、产物发布与失败落日志。
 * 不连接 PostgreSQL、不启动容器；真实容器与事务竞态仍由 scripts/test-database-worker.mjs 在 WSL/Linux 验证。
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseCodeExecution } from '../packages/server/src/database/code-execution.js';
import { RunRepository } from '../packages/server/src/database/runs.js';
import type { FileRepository } from '../packages/server/src/database/files.js';

/** 只依赖 pg 客户端的最小形状，避免在 eval 目录解析 server 的依赖。 */
interface QueryClient { query: (text: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>; release: () => void }

let checks = 0;
async function check(label: string, run: () => Promise<void>): Promise<void> {
  try { await run(); checks += 1; console.log('ok', label); }
  catch (error) { console.error('FAIL', label, error instanceof Error ? error.message : error); throw error; }
}

/** 假 Pool：只回答 run() 实际使用的语句，出现未知语句立即失败，防止契约漂移。 */
function fakePool(state: { runId: string; fence: string; versionIds: string[]; executionMode?: 'auto' | 'manual'; inserts: Array<{ text: string; params: unknown[] }> }) {
  const client = {
    release: () => undefined,
    async query(text: string, params: unknown[] = []) {
      const value = text.replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(value)) return { rowCount: 0, rows: [] };
      if (value.startsWith('SELECT set_config') || value.startsWith('SELECT pg_advisory_xact_lock')) return { rowCount: 0, rows: [] };
      if (value.startsWith('SELECT id,fence FROM workpivot.task_runs')) return { rowCount: 1, rows: [{ id: state.runId, fence: state.fence }] };
      if (value.startsWith('SELECT resource_scope FROM workpivot.task_runs WHERE id=$1')) return { rowCount: 1, rows: [{ resource_scope: { versionIds: state.versionIds, memoryScopes: [], expert: false, epoch: 'e' } }] };
      if (value.startsWith('SELECT id FROM workpivot.tasks WHERE id=$1 FOR UPDATE')) return { rowCount: 1, rows: [{ id: 'task-1' }] };
      if (value.startsWith('SELECT id FROM workpivot.task_runs WHERE id=$1 AND fence=$2')) return { rowCount: 1, rows: [{ id: state.runId }] };
      if (value.startsWith('INSERT INTO workpivot.skill_executions')) { state.inserts.push({ text: value, params }); return { rowCount: 1, rows: [] }; }
      if (value.startsWith('SELECT id FROM workpivot.skill_executions')) return { rowCount: 1, rows: [{ id: params[0] }] };
      if (value.startsWith('SELECT v.id FROM workpivot.document_versions')) {
        const ids = Array.isArray(params[1]) ? params[1] as string[] : [];
        return { rowCount: ids.length, rows: ids.map((id) => ({ id })) };
      }
      if (value.startsWith('UPDATE workpivot.skill_executions')) { state.inserts.push({ text: value, params }); return { rowCount: 1, rows: [] }; }
      if (value.startsWith('INSERT INTO workpivot.execution_artifacts')) { state.inserts.push({ text: value, params }); return { rowCount: 1, rows: [] }; }
      // 授权登记（RunRepository.requestPermission）使用的语句。
      if (value.startsWith('SELECT id,status FROM workpivot.tasks')) return { rowCount: 1, rows: [{ id: params[0], status: 'running' }] };
      if (value.startsWith('SELECT value FROM workpivot.user_settings')) return { rowCount: state.executionMode ? 1 : 0, rows: state.executionMode ? [{ value: state.executionMode }] : [] };
      if (value.startsWith('SELECT status,context_revoked,lease_until')) return { rowCount: 1, rows: [{ status: 'running', context_revoked: false, live: true }] };
      if (value.startsWith('INSERT INTO workpivot.run_permissions')) { state.inserts.push({ text: value, params }); return { rowCount: 1, rows: [] }; }
      if (value.startsWith('UPDATE workpivot.tasks SET next_sequence')) return { rowCount: 1, rows: [{ sequence: '7' }] };
      if (value.startsWith('INSERT INTO workpivot.conversation_events')) { state.inserts.push({ text: value, params }); return { rowCount: 1, rows: [] }; }
      if (value.startsWith("UPDATE workpivot.tasks SET status='waiting'")) return { rowCount: 1, rows: [] };
      throw Error('未预期的查询：' + value);
    },
  } as unknown as QueryClient;
  return { pool: { connect: async () => client } as never, client };
}

interface Captured { command?: string; files?: Array<[string, string]>; skills?: Array<[string, string]> }
async function worker(response: () => { status: number; body: unknown }, captured: Captured) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    Object.assign(captured, JSON.parse(Buffer.concat(chunks).toString()));
    const { status, body } = response();
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('测试服务未取得端口');
  return { config: { url: `http://127.0.0.1:${address.port}`, token: 'test' }, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

async function main(): Promise<void> {
  const inputId = randomUUID();
  const artifactId = randomUUID();
  const actor = randomUUID(), task = randomUUID();
  const fileBytes = Buffer.from('OPC-ppt-bytes');
  const downloadCalls: Array<{ id: string; allowed?: readonly string[] }> = [];
  const published: Array<{ name: string; data: Buffer }> = [];
  const workspace = new Map<string, { name: string; size: number; purpose: 'upload' | 'artifact' }>([
    [inputId, { name: 'source.pptx', size: fileBytes.length, purpose: 'upload' }],
    [artifactId, { name: 'previous.docx', size: 64, purpose: 'artifact' }],
  ]);
  const files = {
    async list(_actor: string, _taskId: string, purpose: 'upload' | 'artifact', allowed?: readonly string[]) {
      return [...workspace.entries()]
        .filter(([id, entry]) => entry.purpose === purpose && (!allowed || allowed.includes(id)))
        .map(([id, entry]) => ({ id, documentId: 'doc', revision: 1, name: entry.name, size: entry.size, sha256: 'hash' }));
    },
    async download(_actor: string, _taskId: string, id: string, allowed?: readonly string[]) {
      downloadCalls.push({ id, allowed });
      if (!allowed || !allowed.includes(id)) throw Error('输入不在本轮授权范围');
      const entry = workspace.get(id);
      return { version: { id, name: entry?.name ?? 'source.pptx' }, data: fileBytes };
    },
    async uploadArtifacts(_actor: string, _taskId: string, entries: Array<{ name: string; data: Buffer }>, _signal: AbortSignal | undefined, guard: ((c: unknown) => Promise<void>) | undefined, onPublished: ((c: unknown, versions: Array<{ id: string; name: string }>) => Promise<void>) | undefined) {
      const versions = entries.map((entry) => { published.push(entry); return { id: randomUUID(), name: entry.name }; });
      await guard?.(clientProxy);
      await onPublished?.(clientProxy, versions);
      return versions;
    },
  } as unknown as FileRepository;
  // uploadArtifacts 的回调需要真实客户端；在每次用例里指向当前假 Pool。
  let clientProxy: QueryClient = {} as QueryClient;
  const state = { runId: randomUUID(), fence: 'fence-1', versionIds: [inputId, artifactId], executionMode: undefined as 'auto' | 'manual' | undefined, inserts: [] as Array<{ text: string; params: unknown[] }> };
  const fake = fakePool(state);
  clientProxy = fake.client;

  const base = { language: 'python', code: 'print(1)' } as Record<string, unknown>;
  const setup = (response: () => { status: number; body: unknown }) => { const captured: Captured = {}; return worker(response, captured).then((handle) => ({ handle, captured })); };

  await check('无授权文件时只返回输出且不发布文件', async () => {
    published.length = 0; state.inserts.length = 0; state.versionIds = [];
    const { handle, captured } = await setup(() => ({ status: 200, body: { files: [['main.py', 'x']], output: 'hello' } }));
    try {
      const execution = new DatabaseCodeExecution(fake.pool, files, handle.config);
      const result = await execution.run(actor, task, { ...base });
      assert.deepEqual(result, { output: 'hello', artifacts: [] });
      assert.equal(captured.command, 'python3 main.py');
      assert.deepEqual(captured.files?.map(([name]) => name), ['main.py']);
      assert.equal(Buffer.from(captured.files![0]![1]!, 'base64').toString(), 'print(1)');
      assert.equal(published.length, 0);
      const completed = state.inserts.filter((entry) => entry.text.startsWith("UPDATE workpivot.skill_executions SET status='completed',finished_at"));
      assert.equal(completed.length, 1, '无产物也应把执行日志标记完成');
    } finally { state.versionIds = [inputId, artifactId]; await handle.close(); }
  });

  await check('省略 inputs 时挂载本轮全部授权文件并生成清单', async () => {
    published.length = 0; state.inserts.length = 0; downloadCalls.length = 0;
    const { handle, captured } = await setup(() => ({ status: 200, body: { files: [], output: 'ok' } }));
    try {
      const execution = new DatabaseCodeExecution(fake.pool, files, handle.config);
      await execution.run(actor, task, { ...base });
      assert.deepEqual(captured.files?.map(([name]) => name), ['main.py', `inputs/${inputId}/source.pptx`, `inputs/${artifactId}/previous.docx`, 'manifest.json']);
      const manifest = JSON.parse(Buffer.from(captured.files!.find(([name]) => name === 'manifest.json')![1]!, 'base64').toString());
      assert.deepEqual(manifest.files.map((file: { name: string }) => file.name).sort(), ['previous.docx', 'source.pptx']);
      assert.deepEqual(downloadCalls.map((call) => call.id).sort(), [inputId, artifactId].sort());
    } finally { await handle.close(); }
  });

  await check('授权文件合计超限时拒绝，且不调用沙箱', async () => {
    state.inserts.length = 0; downloadCalls.length = 0;
    const { handle, captured } = await setup(() => ({ status: 200, body: { files: [], output: '' } }));
    try {
      const before = workspace.get(inputId)!.size;
      workspace.get(inputId)!.size = 17 * 1024 * 1024;
      try {
        const execution = new DatabaseCodeExecution(fake.pool, files, handle.config);
        await assert.rejects(() => execution.run(actor, task, { ...base }), /超过单次执行16MB上限/);
      } finally { workspace.get(inputId)!.size = before; }
      assert.equal(captured.command, undefined, '超限时不能启动容器');
      assert.equal(downloadCalls.length, 0, '超限时不应下载任何文件');
    } finally { await handle.close(); }
  });

  await check('带输入时按授权版本挂载并参与发布', async () => {
    published.length = 0; state.inserts.length = 0; downloadCalls.length = 0;
    const { handle, captured } = await setup(() => ({ status: 200, body: { files: [['report.docx', Buffer.from('PK').toString('base64')]], output: 'ok' } }));
    try {
      const execution = new DatabaseCodeExecution(fake.pool, files, handle.config);
      const result = await execution.run(actor, task, { ...base, language: 'node', code: 'console.log(1)', inputs: [inputId], outputs: [{ name: 'report.docx' }] });
      assert.deepEqual(downloadCalls, [{ id: inputId, allowed: [inputId, artifactId] }]);
      assert.deepEqual(captured.files?.map(([name]) => name), ['main.cjs', `inputs/${inputId}/source.pptx`, 'manifest.json']);
      assert.equal(captured.command, 'node main.cjs');
      assert.equal(published.length, 1);
      assert.equal(published[0]!.name, 'report.docx');
      assert.equal(published[0]!.data.toString('base64'), Buffer.from('PK').toString('base64'));
      assert.equal((result as { artifacts: Array<{ name: string }> }).artifacts[0]!.name, 'report.docx');
      assert.ok(state.inserts.some((entry) => entry.text.startsWith('INSERT INTO workpivot.execution_artifacts')));
    } finally { await handle.close(); }
  });

  await check('产物缺失时整体失败并落失败日志', async () => {
    published.length = 0; state.inserts.length = 0;
    const { handle } = await setup(() => ({ status: 200, body: { files: [], output: 'no file' } }));
    try {
      const execution = new DatabaseCodeExecution(fake.pool, files, handle.config);
      await assert.rejects(() => execution.run(actor, task, { ...base, outputs: [{ name: 'report.docx' }] }), /没有生成全部指定产物/);
      assert.equal(published.length, 0);
      assert.ok(state.inserts.some((entry) => entry.text.startsWith("UPDATE workpivot.skill_executions SET status=$2,error=$3")), '失败必须落执行日志');
    } finally { await handle.close(); }
  });

  await check('输入不在授权范围时拒绝，且不调用沙箱', async () => {
    state.inserts.length = 0; downloadCalls.length = 0;
    const { handle, captured } = await setup(() => ({ status: 200, body: { files: [], output: '' } }));
    try {
      state.versionIds = [];
      const execution = new DatabaseCodeExecution(fake.pool, files, handle.config);
      await assert.rejects(() => execution.run(actor, task, { ...base, inputs: [inputId] }), /输入不在本轮授权范围/);
      assert.equal(captured.command, undefined, '越界输入不能进入沙箱');
      assert.equal(state.inserts.length, 0, '越界输入不应登记执行日志');
    } finally { state.versionIds = [inputId]; await handle.close(); }
  });

  await check('worker 报错时透传原因并落失败日志', async () => {
    state.inserts.length = 0;
    const { handle } = await setup(() => ({ status: 400, body: { error: 'python not found' } }));
    try {
      const execution = new DatabaseCodeExecution(fake.pool, files, handle.config);
      await assert.rejects(() => execution.run(actor, task, { ...base }), /python not found/);
      assert.ok(state.inserts.some((entry) => entry.text.startsWith("UPDATE workpivot.skill_executions SET status=$2,error=$3")));
    } finally { await handle.close(); }
  });

  // 静默授权：只对 run_code 白名单直接登记已消费的许可，且可以用环境变量退回逐次确认。
  const runs = new RunRepository(fake.pool);
  const permissionRun = { id: state.runId, taskId: task, turnId: randomUUID(), fence: state.fence, duplicate: false };
  const invocation = { id: randomUUID(), definition: 'definition', arguments: { language: 'python', code: 'print(1)' }, digest: 'digest' };
  const autoRequest = { auto: true, external: true, tool: 'run_code', kind: 'write' as const, paths: [] as Array<{ path: string; mode: 'read' | 'write' }>, command: 'python 代码 1 行', invocation };

  await check('run_code 静默放行并登记已消费许可', async () => {
    state.inserts.length = 0;
    const permission = await runs.requestPermission(actor, permissionRun, autoRequest);
    assert.equal(permission.automatic, true);
    const insert = state.inserts.find((entry) => entry.text.startsWith('INSERT INTO workpivot.run_permissions'));
    assert.ok(insert, '必须登记许可记录');
    assert.match(insert.text, /'consumed','allow'/);
    assert.match(String(insert.params[4]), /"tool":"run_code"/);
  });

  await check('其他工具不会因 auto 声明被放行', async () => {
    state.inserts.length = 0;
    const permission = await runs.requestPermission(actor, permissionRun, { ...autoRequest, tool: 'execute_skill' });
    assert.equal(permission.automatic, false);
    const insert = state.inserts.find((entry) => entry.text.startsWith('INSERT INTO workpivot.run_permissions'));
    assert.ok(insert && !/'consumed'/.test(insert.text), '非白名单工具必须走待审批');
    assert.ok(state.inserts.some((entry) => entry.text.startsWith('INSERT INTO workpivot.conversation_events')), '待审批需要发出授权卡事件');
  });

  await check('WORKPIVOT_CODE_APPROVAL=confirm 可恢复逐次确认', async () => {
    state.inserts.length = 0;
    process.env['WORKPIVOT_CODE_APPROVAL'] = 'confirm';
    try {
      const permission = await runs.requestPermission(actor, permissionRun, autoRequest);
      assert.equal(permission.automatic, false);
      assert.ok(state.inserts.some((entry) => entry.text.startsWith('INSERT INTO workpivot.conversation_events')));
    } finally { delete process.env['WORKPIVOT_CODE_APPROVAL']; }
  });

  await check('执行模式为确认模式时 run_code 也要逐次确认', async () => {
    state.inserts.length = 0;
    state.executionMode = 'manual';
    try {
      const permission = await runs.requestPermission(actor, permissionRun, autoRequest);
      assert.equal(permission.automatic, false);
      const insert = state.inserts.find((entry) => entry.text.startsWith('INSERT INTO workpivot.run_permissions'));
      assert.ok(insert && !/'consumed'/.test(insert.text), '确认模式必须走待审批');
      assert.ok(state.inserts.some((entry) => entry.text.startsWith('INSERT INTO workpivot.conversation_events')));
    } finally { delete state.executionMode; }
  });

  await check('自动模式与未设置时 run_code 静默放行', async () => {
    for (const mode of ['auto', undefined] as const) {
      state.inserts.length = 0;
      if (mode) state.executionMode = mode;
      try {
        const permission = await runs.requestPermission(actor, permissionRun, autoRequest);
        assert.equal(permission.automatic, true, `模式 ${mode ?? '未设置'} 应静默`);
      } finally { delete state.executionMode; }
    }
  });

  console.log(`run_code execution checks passed: ${checks}`);
}

await main().then(() => { process.exitCode = 0; }, (error) => { console.error(error); process.exitCode = 1; });
