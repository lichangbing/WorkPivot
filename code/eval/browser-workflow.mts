/** 使用真实数据库、接口和界面的工作流验收；模型回复固定，不使用真实服务凭据。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
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
import { CompactionService } from '../packages/server/src/database/compaction.js';
import { McpRepository } from '../packages/server/src/database/mcp.js';
import { DatabaseSkills } from '../packages/server/src/database/skills.js';
import { Experts } from '../packages/server/src/database/experts.js';
import { ExpertWorker } from '../packages/server/src/database/expert-worker.js';
import { ProviderRepository } from '../packages/server/src/database/providers.js';
import { FileRepository } from '../packages/server/src/database/files.js';
import { DatabaseArtifactTools } from '../packages/server/src/database/artifact-tools.js';
import { createDatabaseApp } from '../packages/server/src/database/app.js';

import {BrowserWorkspace} from '../packages/server/src/web/browser-workspace.js';
import {browserService} from '../packages/server/src/web/browser-service.js';
import {BrowserEngine} from '../packages/server/src/web/browser-engine.js';
import {SafeHttp,type WebResponse} from '../packages/server/src/web/safe-http.js';

const target = process.env.WORKPIVOT_TEST_PG_URL;
if (process.env.WORKPIVOT_TEST_PG_DISPOSABLE !== '1' || !target || new URL(target).pathname !== '/workpivot_test' || new URL(target).hostname !== '127.0.0.1') throw Error('Local disposable database required');
const secret = randomBytes(32).toString('hex'), schema = pool(target);
const roleUrl = (role: string) => { const u = new URL(target); u.username = role; u.password = secret; return u.toString(); };
const db = pool(roleUrl('workflow_app')), auth = pool(roleUrl('workflow_auth'));
const root = await mkdtemp(join(tmpdir(), 'workpivot-browser-workflow-'));
await schema.query(`CREATE ROLE workflow_app LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS; CREATE ROLE workflow_auth LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS;`);
await installSchema(schema, 'workflow_app', 'workflow_auth');
const actor = (await new AccountRepository(auth).registerFirst('workflow-test', 'Workflow-Test-2026!', secret, secret)).user.id;
const workspace = new WorkspaceRepository(db), files = new FileRepository(db, root);
const project = await workspace.createProject(actor, '浏览器工作流验收（可控模型）');
const mainTask = await workspace.createTask(actor, '办公流程与记忆', project.id);
await workspace.createTask(actor, '新会话复用记忆', project.id);
const providers = new ProviderRepository(db, secret);
const provider = await providers.save(actor, { name: '可控验收模型（不连接外部服务）', baseUrl: 'http://127.0.0.1:1', modelId: 'browser-workflow-fixture', protocol: 'openai' });
await providers.activate(actor, provider.id, provider.revision);
const stats = { activeStreams: 0, cancelledStreams: 0, approvedOperations: 0, mcpCalls: 0 };
const skills = new DatabaseSkills(db), mcp = new McpRepository(db, secret);
const skill = await skills.create(actor, 'mobile-fixture');
const written = await skills.save(actor, 'mobile-fixture', 'SKILL.md', Buffer.from('---\nname: mobile-fixture\ndescription: 手机联调合成技能\n---\n\n核对来源，再整理报告。\n'), skill.revision);
await skills.publish(actor, 'mobile-fixture', written.revision);
await new Experts(db).create(actor, '手机验收专家', { role: '合成研究员', startup: '核对来源', skills: [] });
await files.upload(actor, mainTask.id, '手机验收产物.csv', Buffer.from('name,value\nfixture,42\n'), randomUUID(), undefined, undefined, 'artifact');
// 真实 MCP 协议和授权链路，只返回合成数据，不连接任何外部服务。
const mcpServer = createServer(async (req, res) => {
  if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  try {
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 20000) throw Error('too large'); }
    const packet = JSON.parse(body);
    if (packet.id === undefined) { res.writeHead(202).end(); return; }
    let result: unknown = {};
    if (packet.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mobile-fixture', version: '1' } };
    else if (packet.method === 'tools/list') result = { tools: [{ name: 'echo', description: '手机验收工具', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };
    else if (packet.method === 'tools/call') { stats.mcpCalls++; result = { content: [{ type: 'text', text: 'MCP 合成返回：' + String(packet.params?.arguments?.text ?? '') }] }; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: packet.id, result }));
  } catch { res.writeHead(400).end(); }
});
await new Promise<void>(resolve => mcpServer.listen(0, '127.0.0.1', resolve));
const mcpAddress = mcpServer.address(); if (!mcpAddress || typeof mcpAddress === 'string') throw Error('MCP fixture address');
const connection = await mcp.save(actor, { name: '手机联调 MCP', url: `http://127.0.0.1:${mcpAddress.port}/mcp` });
await mcp.discover(actor, connection.id, connection.revision);
const call = (name: string, args: unknown) => ({ type: 'tool_calls' as const, tool_calls: [{ id: randomUUID(), type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] });
const model: ModelClient = { providerId: provider.id, model: provider.modelId, async *streamChat(messages, _tools, signal) {
  stats.activeStreams++;
  try {
    signal?.throwIfAborted();
    const index = messages.findLastIndex(m => m.role === 'user');
    const input = messages[index]?.content ?? '';
    const responses = messages.slice(index + 1).filter(m => m.role === 'tool');
    if (input.includes('验证技能')) {
      if (!responses.length) { yield call('load_skill', { name: 'mobile-fixture' }); return; }
      yield { type: 'delta', text: '技能读取结果：' + responses[0]!.content }; return;
    }
    if (input.includes('验证MCP')) {
      const tool = _tools?.find(tool => tool.name.startsWith('mcp_'));
      if (!tool) { yield { type: 'delta', text: 'MCP 未启用或工具已停用。' }; return; }
      if (!responses.length) { yield call(tool.name, { text: '手机闭环测试' }); return; }
      yield { type: 'delta', text: 'MCP 调用结果：' + responses[0]!.content }; return;
    }
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
    // 逐轮整理现在仅负责任务层；长期个人/项目记忆由十轮分析负责。
    yield { type: 'delta', text: JSON.stringify(/记住|更正/.test(data.source) && data.source.includes('语言') && data.source.includes('本次任务') ? [{ scope: 'task', content, evidence: data.source, query: '报告语言' }] : []) }; return;
  }
  const key = '报告|语言|' + value;
  const old = data.existing?.[0];
  yield { type: 'delta', text: JSON.stringify(data.rejected?.some(r => r.key === key) ? { action: 'skip' } : { action: old ? 'update' : 'add', content, dedupeKey: key, ...(old ? { targetId: old.id, targetRevision: old.revision } : {}) }) };
} };
const worker = new MemoryWorker(db, async () => extraction);
const expertWorker = new ExpertWorker(db, async () => ({
  providerId: 'fixture-expert', model: 'fixture-expert',
  async *streamChat(messages) {
    const input = JSON.parse(messages[1]!.content!) as { content: string };
    yield { type: 'delta', text: JSON.stringify(input.content.includes('专家记住') ? [{ content: '先核对原始来源，再形成结论。', conditions: '研究报告', evidence: input.content, targets: [] }] : []) };
  },
}));
const summaries = new CompactionService(db, async () => ({
  providerId: 'fixture-summary', model: 'fixture-summary',
  async *streamChat(messages) {
    const id = /\[来源:([0-9a-f-]+)\]/.exec(messages[1]?.content ?? '')?.[1];
    yield { type: 'delta', text: `隔离验收：保留早期任务要求。${id ? `[来源:${id}]` : ''}` };
  },
}));
const approval: Tool = { name: 'approve_report', displayName: '验收报告操作', kind: 'write', description: '仅增加本次临时验收计数，不连接任何外部服务。', parameters: { type: 'object', properties: {}, additionalProperties: false },
  access: () => ({ tool: 'approve_report', external: true, kind: 'write', paths: [], command: '生成隔离验收报告（只修改临时测试数据）' }),
  run: async (_args, ctx) => { ctx.signal?.throwIfAborted(); stats.approvedOperations++; return '授权完成'; } };
const execution = new DatabaseExecution(db, async (_actor, taskId, context) => ({ client: model, tools: [approval, ...skills.tools(actor), ...await mcp.tools(actor), ...new DatabaseMemoryTools(db,'load',context.resources!.memoryScopes).tools(actor, taskId), ...new DatabaseArtifactTools(files,context.resources!.versionIds).tools(actor, taskId)], system: '隔离浏览器验收，使用可控模型响应。', taskDir: '.', maxSteps: 8 }),
  async (_actor, taskId, runId) => { await worker.enqueue(actor, taskId, runId); await worker.process(actor); await expertWorker.recover(actor); await expertWorker.process(actor); }, summaries);
// 仅隔离验收启用：所有网页资源由内存替身提供，不访问真实站点。
class BrowserFixtureHttp extends SafeHttp {
  override async get(url:string):Promise<WebResponse>{
    if(new URL(url).pathname==='/pixel')return {url,status:200,headers:{'content-type':'image/png'},body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a52kAAAAASUVORK5CYII=','base64')};
    return {url,status:200,headers:{'content-type':'text/html;charset=utf-8'},body:Buffer.from('<html><title>严格地址验收</title><body><h1>合成公开网页</h1><p>图片须追加完整地址授权</p><img src="/pixel?fixture=1"></body></html>')};
  }
}
const browserFixture=process.env['WORKPIVOT_STRICT_BROWSER_FIXTURE']==='1'?browserService(secret,new BrowserEngine(new BrowserFixtureHttp(),{executablePath:'/usr/bin/google-chrome'})):undefined;
const browserServer=browserFixture?.app.listen(0,'127.0.0.1');
if(browserServer)await new Promise<void>(resolve=>browserServer.once('listening',resolve));
const browserAddress=browserServer?.address();
const browserWorkspace=browserAddress&&typeof browserAddress!=='string'?new BrowserWorkspace(db,{url:`http://127.0.0.1:${browserAddress.port}`,token:secret}):undefined;
const app = await createDatabaseApp(auth, db, secret, execution, providers, mcp, resolve('apps/web/dist'), files,undefined,undefined,undefined,browserWorkspace);
app.get('/fixture/status', (_req, res) => res.json(stats));
app.post('/fixture/stop', (_req, res) => { res.json({ ok: true }); setTimeout(() => void close(), 100).unref(); });
const port=Number(process.env['WORKPIVOT_BROWSER_TEST_PORT']??39987);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('浏览器验收端口无效');
const server = app.listen(port, '127.0.0.1');
await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
console.log(`Disposable database browser workflow http://127.0.0.1:${port} ; workflow-test / Workflow-Test-2026! ; model responses are controlled fixtures`);
let closing = false;
async function close() {
  if (closing) return; closing = true;
  for (const task of await workspace.listTasks(actor)) await execution.stop(actor, task.id);
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  await browserFixture?.close();if(browserServer){browserServer.closeAllConnections();await new Promise<void>(resolve=>browserServer.close(()=>resolve()));}
  mcpServer.closeAllConnections(); await new Promise<void>(resolve => mcpServer.close(() => resolve()));
  await Promise.all([db.end(), auth.end(), schema.end()]);
  // 此目录由 mkdtemp 创建；清理范围不包含用户指定目录和业务目录。
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('workpivot-browser-workflow-')) throw Error('Refusing unexpected fixture cleanup path');
  await rm(root, { recursive: true, force: true });
}
setTimeout(() => void close(), 900000).unref();
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
