/** 使用真实数据库、接口和界面的工作流验收；模型回复固定，不使用真实服务凭据。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelClient, Tool } from '@workpivot/core';
import { pool, installSchema } from '../packages/server/src/database/connection.js';
import { AccountRepository } from '../packages/server/src/database/accounts.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { DatabaseExecution } from '../packages/server/src/database/execution.js';
import { DatabaseMemoryTools } from '../packages/server/src/database/memory-tools.js';
import { MemoryWorker } from '../packages/server/src/database/memory-worker.js';
import { ProviderRepository } from '../packages/server/src/database/providers.js';
import { FileRepository } from '../packages/server/src/database/files.js';
import { DatabaseArtifactTools } from '../packages/server/src/database/artifact-tools.js';
import { createDatabaseApp } from '../packages/server/src/database/app.js';

const target = process.env.WORKPIVOT_TEST_PG_URL;
if (process.env.WORKPIVOT_TEST_PG_DISPOSABLE !== '1' || !target || new URL(target).pathname !== '/workpivot_test' || new URL(target).hostname !== '127.0.0.1') throw Error('Local disposable database required');
const secret = randomBytes(32).toString('hex'), schema = pool(target);
const roleUrl = (role: string) => { const u = new URL(target); u.username = role; u.password = secret; return u.toString(); };
const db = pool(roleUrl('workflow_app')), auth = pool(roleUrl('workflow_auth'));
const root = await mkdtemp(join(tmpdir(), 'workpivot-browser-workflow-'));
await schema.query(`CREATE ROLE workflow_app LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS; CREATE ROLE workflow_auth LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS;`);
await installSchema(schema, 'workflow_app', 'workflow_auth');
const actor = (await new AccountRepository(auth).registerFirst('workflow-test', 'Workflow-Test-2026!', secret, secret)).user.id;
const workspace = new WorkspaceRepository(db), memories = new DatabaseMemoryTools(db), files = new FileRepository(db, root);
const project = await workspace.createProject(actor, '浏览器工作流验收（可控模型）');
await workspace.createTask(actor, '办公流程与记忆', project.id);
await workspace.createTask(actor, '新会话复用记忆', project.id);
const providers = new ProviderRepository(db, secret);
const provider = await providers.save(actor, { name: '可控验收模型（不连接外部服务）', baseUrl: 'http://127.0.0.1:1', modelId: 'browser-workflow-fixture', protocol: 'openai' });
await providers.activate(actor, provider.id, provider.revision);
const stats = { activeStreams: 0, cancelledStreams: 0, approvedOperations: 0 };
const call = (name: string, args: unknown) => ({ type: 'tool_calls' as const, tool_calls: [{ id: randomUUID(), type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] });
const model: ModelClient = { providerId: provider.id, model: provider.modelId, async *streamChat(messages, _tools, signal) {
  stats.activeStreams++;
  try {
    signal?.throwIfAborted();
    const index = messages.findLastIndex(m => m.role === 'user');
    const input = messages[index]?.content ?? '';
    const responses = messages.slice(index + 1).filter(m => m.role === 'tool');
    if (input.includes('慢速')) {
      yield { type: 'delta', text: '慢速验收已开始，等待停止；尚未产生任何成果。' };
      await delay(90000, undefined, { signal });
      yield { type: 'delta', text: '慢速验收自然结束。' }; return;
    }
    if (input.includes('生成')) {
      if (!responses.length) { yield call('approve_report', {}); return; }
      if (responses.length === 1) {
        if (responses[0]?.content?.includes('未获授权')) { yield { type: 'delta', text: '操作未获授权，没有生成成果。' }; return; }
        yield call('save_artifact', { name: '浏览器验收报告.md', content: '# 浏览器验收报告\n\n这是隔离测试数据。审批、持久化和成果下载使用当前实现。\n' }); return;
      }
      yield { type: 'delta', text: '已保存浏览器验收报告.md，请在成果列表下载核对。' }; return;
    }
    if (input.includes('记住') || input.includes('更正')) { yield { type: 'delta', text: '已收到偏好；后台将整理建议，请明确确认后再作为已保存记忆使用。' }; return; }
    if (input.includes('语言')) {
      if (!responses.length) { yield call('search_memory', { query: '报告语言' }); return; }
      const found = JSON.parse(responses[0]?.content ?? '{}') as { memories?: { id: string }[] };
      if (found.memories?.length && responses.length === 1) { yield call('read_memory', { id: found.memories[0]!.id }); return; }
      const saved = responses[1]?.content ? (JSON.parse(responses[1].content) as { content?: string }).content : undefined;
      yield { type: 'delta', text: saved ? '工具读取的已确认记忆：' + saved : '当前没有已确认的报告语言记忆。' }; return;
    }
    yield { type: 'delta', text: '可控验收支持：生成报告、慢速响应、请记住报告语言使用中文、更正报告语言使用英文、报告语言是什么。' };
  } finally { stats.activeStreams--; if (signal?.aborted) stats.cancelledStreams++; }
} };
const extraction: ModelClient = { providerId: 'fixture-memory', model: 'fixture-memory', async *streamChat(messages) {
  const data = JSON.parse(messages[1]!.content!) as { source: string; candidate?: { content: string }; existing?: { id: string; revision: number }[]; rejected?: { key: string }[] };
  const value = data.source.includes('英文') ? '英文' : '中文';
  const content = '报告语言使用' + value + '。';
  if (!data.candidate) {
    yield { type: 'delta', text: JSON.stringify(/记住|更正/.test(data.source) && data.source.includes('语言') ? [{ scope: 'user', content, evidence: data.source, query: '报告语言' }] : []) }; return;
  }
  const key = '报告|语言|' + value;
  const old = data.existing?.[0];
  yield { type: 'delta', text: JSON.stringify(data.rejected?.some(r => r.key === key) ? { action: 'skip' } : { action: old ? 'update' : 'add', content, dedupeKey: key, ...(old ? { targetId: old.id, targetRevision: old.revision } : {}) }) };
} };
const worker = new MemoryWorker(db, async () => extraction);
const approval: Tool = { name: 'approve_report', displayName: '验收报告操作', kind: 'write', description: '仅增加本次临时验收计数，不连接任何外部服务。', parameters: { type: 'object', properties: {}, additionalProperties: false },
  access: () => ({ tool: 'approve_report', external: true, kind: 'write', paths: [], command: '生成隔离验收报告（只修改临时测试数据）' }),
  run: async (_args, ctx) => { ctx.signal?.throwIfAborted(); stats.approvedOperations++; return '授权完成'; } };
const execution = new DatabaseExecution(db, async (_actor, taskId) => ({ client: model, tools: [approval, ...memories.tools(actor, taskId), ...new DatabaseArtifactTools(files).tools(actor, taskId)], system: '隔离浏览器验收，使用可控模型响应。', taskDir: '.', maxSteps: 8 }),
  async (_actor, taskId, runId) => { await worker.enqueue(actor, taskId, runId); await worker.process(actor); });
const app = await createDatabaseApp(auth, db, secret, execution, providers, undefined, resolve('apps/web/dist'), files);
app.get('/fixture/status', (_req, res) => res.json(stats));
app.post('/fixture/stop', (_req, res) => { res.json({ ok: true }); setTimeout(() => void close(), 100).unref(); });
const server = app.listen(39987, '127.0.0.1', () => console.log('Disposable database browser workflow http://127.0.0.1:39987 ; workflow-test / Workflow-Test-2026! ; model responses are controlled fixtures'));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  for (const task of await workspace.listTasks(actor)) await execution.stop(actor, task.id);
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  await Promise.all([db.end(), auth.end(), schema.end()]);
  // 此目录由 mkdtemp 创建；清理范围不包含用户指定目录和业务目录。
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('workpivot-browser-workflow-')) throw Error('Refusing unexpected fixture cleanup path');
  await rm(root, { recursive: true, force: true });
}
setTimeout(() => void close(), 900000).unref();
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
