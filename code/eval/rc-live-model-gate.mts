/**
 * RC 真实模型门禁：20 个合成任务 + 5 个业务事实任务。
 * 使用一次性 PostgreSQL、真实 DeepSeek、真实 Worker 和当前生产运行链路。
 */
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pool, installSchema } from '../packages/server/src/database/connection.js';
import { AccountRepository } from '../packages/server/src/database/accounts.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { ProviderRepository } from '../packages/server/src/database/providers.js';
import { BusinessFactsRepository } from '../packages/server/src/database/business-facts.js';
import { DatabaseSkills } from '../packages/server/src/database/skills.js';
import { officeSkillNames, seedOfficeSkills } from '../packages/server/src/database/office-skills.js';
import { createDatabaseRuntime } from '../packages/server/src/database/runtime.js';
import { BrowserEngine } from '../packages/server/src/web/browser-engine.js';
import { SafeHttp } from '../packages/server/src/web/safe-http.js';
import { browserService } from '../packages/server/src/web/browser-service.js';

const target = process.env['WORKPIVOT_TEST_PG_URL'];
if (process.env['WORKPIVOT_LIVE_EVAL'] !== '1' || process.env['WORKPIVOT_TEST_PG_DISPOSABLE'] !== '1' || !target ||
  new URL(target).hostname !== '127.0.0.1' || new URL(target).pathname !== '/workpivot_test') {
  throw Error('仅允许显式启用的一次性本机 PostgreSQL');
}
const apiKey = process.env['DEEPSEEK_API_KEY'];
if (!apiKey) throw Error('缺少真实模型凭据');
const workerUrl = process.env['WORKPIVOT_WORKER_URL'], workerToken = process.env['WORKPIVOT_WORKER_TOKEN'];
if (!workerUrl || !workerToken) throw Error('真实 Worker 配置不完整');

const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { Document, Packer, Paragraph } = require('docx');
const Excel = require('exceljs');
const AdmZip = require('adm-zip');
const { chromium } = require('playwright');

const secret = randomBytes(32).toString('hex');
const schema = pool(target);
const urlFor = (role: string) => { const url = new URL(target); url.username = role; url.password = secret; return url.toString(); };
// schema v1 的授权 SQL 固定引用生产角色名；一次性数据库仍使用独立账号和数据目录。
const db = pool(urlFor('workpivot_app')), auth = pool(urlFor('workpivot_auth'));
const filesRoot = await mkdtemp(join(tmpdir(), 'workpivot-rc-live-'));
const evidenceRoot = resolve('../local-runtime/acceptance/rc-live-model');
await rm(evidenceRoot, { recursive: true, force: true });
await mkdir(evidenceRoot, { recursive: true });
let cleanupRuntime: (() => void) | undefined;
let server: ReturnType<Awaited<ReturnType<typeof createDatabaseRuntime>>['listen']> | undefined;
let browserServer: ReturnType<ReturnType<typeof browserService>['app']['listen']> | undefined;
let closeBrowser: (() => Promise<void>) | undefined;
let token = '';
let closing = false;

async function close() {
  if (closing) return;
  closing = true;
  cleanupRuntime?.();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(done => server!.close(() => done()));
  }
  if (browserServer) {
    browserServer.closeAllConnections();
    await new Promise<void>(done => browserServer!.close(() => done()));
  }
  await closeBrowser?.();
  await Promise.all([db.end(), auth.end(), schema.end()]);
  await rm(filesRoot, { recursive: true, force: true });
}

const baseUrl = `http://127.0.0.1:${process.env['WORKPIVOT_FIXTURE_PORT'] ?? 39988}`;
async function api<T = Record<string, unknown>>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(baseUrl + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw Error(`${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  return await response.json() as T;
}
async function upload(taskId: string, name: string, data: Buffer) {
  const response = await fetch(baseUrl + `/api/tasks/${taskId}/files?${new URLSearchParams({ name, requestId: randomUUID() })}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body: data,
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw Error(`上传 ${name} 失败：HTTP ${response.status}`);
  return (await response.json() as { file: { id: string; documentId: string; revision: number; name: string } }).file;
}
async function download(taskId: string, versionId: string): Promise<Buffer> {
  const response = await fetch(baseUrl + `/api/tasks/${taskId}/file-versions/${versionId}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw Error(`下载成果失败：HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
async function artifactList(taskId: string) {
  return (await api<{ artifacts: Array<{ id: string; documentId: string; revision: number; name: string }> }>(`/api/tasks/${taskId}/artifacts`)).artifacts;
}

interface TurnResult {
  events: Array<Record<string, unknown>>;
  text: string;
  stopReason: string;
  toolNames: string[];
  inputTokens: number;
  outputTokens: number;
  interactions: string[];
  eventErrors: string[];
  toolResults: Array<{ tool: string; ok: boolean; message: string }>;
}

async function waitTaskReady(taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const tasks = (await api<{ tasks: Array<{ id: string; status: string }> }>('/api/tasks')).tasks;
    const status = tasks.find(task => task.id === taskId)?.status;
    if (!status) throw Error('任务不存在');
    if (status === 'idle') return;
    if (['failed', 'stopped', 'interrupted'].includes(status)) return;
    await new Promise(done => setTimeout(done, 500));
  }
  throw Error('任务未在时限内进入可发送状态');
}

async function turn(taskId: string, content: string, versionIds: string[] = [], baseRunId: string | null = null, memoryScopes: Array<'user' | 'project' | 'task'> = []): Promise<TurnResult> {
  await waitTaskReady(taskId);
  const response = await fetch(baseUrl + `/api/tasks/${taskId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      content,
      requestId: randomUUID(),
      resourceScope: { versionIds, scheduleIds: [], memoryScopes, expert: false, baseRunId },
    }),
    signal: AbortSignal.timeout(10 * 60000),
  });
  if (!response.ok || !response.body) throw Error(`消息发送失败：HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  const events: Array<Record<string, unknown>> = [];
  const interactions: string[] = [];
  const eventErrors: string[] = [];
  const toolResults: Array<{ tool: string; ok: boolean; message: string }> = [];
  let text = '', buffer = '', inputTokens = 0, outputTokens = 0;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const line = frame.split('\n').find(value => value.startsWith('data: '));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
      events.push(event);
      if (event['type'] === 'assistant_delta') text += String(event['text'] ?? '');
      if (event['type'] === 'usage') {
        inputTokens += Number(event['inputTokens'] ?? 0);
        outputTokens += Number(event['outputTokens'] ?? 0);
      }
      if (event['type'] === 'error') eventErrors.push(String(event['message'] ?? '模型或工具执行错误'));
      if (event['type'] === 'tool_result') toolResults.push({ tool: String(event['toolName'] ?? ''), ok: event['ok'] === true, message: String(event['message'] ?? '').slice(0, 1000) });
      if (event['type'] === 'permission_request') {
        const interactionId = String(event['id']);
        interactions.push(`permission:${String(event['tool'])}`);
        await api(`/api/tasks/${taskId}/permissions/${interactionId}`, { decision: 'allow' });
      }
      if (event['type'] === 'interaction_request') {
        const interaction = event['interaction'] as { id: string; revision: number; kind: string; payload?: { questions?: Array<{ id: string; options?: unknown[] }> } };
        interactions.push(`interaction:${interaction.kind}`);
        const answers = interaction.kind === 'clarification'
          ? interaction.payload?.questions?.map(question => ({ questionId: question.id, value: '' })) ?? []
          : [];
        await api(`/api/tasks/${taskId}/interactions/${interaction.id}/respond`, {
          revision: interaction.revision,
          requestId: randomUUID(),
          response: interaction.kind === 'clarification' ? { answers } : { decision: 'approve' },
        });
      }
    }
  }
  const done = events.find(event => event['type'] === 'done') as { stopReason?: string } | undefined;
  return {
    events, text, stopReason: String(done?.stopReason ?? 'missing_done'),
    toolNames: events.filter(event => event['type'] === 'tool_use').map(event => String(event['toolName'] ?? '')),
    inputTokens, outputTokens, interactions, eventErrors, toolResults,
  };
}

interface GateResult { id: string; category: 'synthetic' | 'business'; passed: boolean; errors: string[]; summary: string; tools: string[]; inputTokens: number; outputTokens: number; interactions: string[] }
const results: GateResult[] = [];
function record(id: string, category: GateResult['category'], run: TurnResult, errors: string[], summary: string): void {
  errors.push(...run.eventErrors);
  const passed = errors.length === 0 && run.stopReason === 'completed';
  if (!passed && run.stopReason !== 'completed') errors.push(`停止原因：${run.stopReason}`);
  results.push({ id, category, passed, errors, summary: summary.slice(0, 500), tools: run.toolNames, inputTokens: run.inputTokens, outputTokens: run.outputTokens, interactions: run.interactions });
  console.log(`${passed ? '✅' : '❌'} ${id}${errors.length ? ' · ' + errors.join('；') : ''}`);
}
function expectText(run: TurnResult, values: string[], errors: string[]): void {
  for (const value of values) if (!run.text.includes(value)) errors.push(`回答缺少：${value}`);
}
function expectTool(run: TurnResult, name: string, errors: string[]): void {
  if (!run.toolNames.includes(name)) errors.push(`未调用工具：${name}`);
}

try {
  await schema.query(`CREATE ROLE workpivot_app LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS; CREATE ROLE workpivot_auth LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS;`);
  await installSchema(schema, 'workpivot_app', 'workpivot_auth');
  const accounts = new AccountRepository(auth);
  const actor = (await accounts.registerFirst('rc-live-gate', secret, secret, secret)).user.id;
  const workspace = new WorkspaceRepository(db);
  const project = await workspace.createProject(actor, 'RC 真实模型合成验收');
  const isolatedProject = await workspace.createProject(actor, 'RC 跨项目隔离验收');
  const providers = new ProviderRepository(db, secret);
  const provider = await providers.save(actor, {
    name: 'DeepSeek RC 门禁', baseUrl: 'https://api.deepseek.com',
    modelId: process.env['DEEPSEEK_MODEL'] ?? 'deepseek-flash', protocol: 'openai',
    apiKey, contextBudget: 131072,
  });
  await providers.activate(actor, provider.id, provider.revision);
  await workspace.saveSetting(actor, 'execution.mode', 'auto', 0);
  const facts = new BusinessFactsRepository(db);
  const factSettings = await facts.settings(actor);
  await facts.setAutoExtraction(actor, false, factSettings.revision);
  const skills = new DatabaseSkills(db);
  await seedOfficeSkills(skills, actor);
  for (const name of officeSkillNames) await skills.select(actor, name, true);

  const browserToken = randomBytes(32).toString('hex');
  const browser = browserService(browserToken, new BrowserEngine(new SafeHttp(), { executablePath: '/usr/bin/google-chrome' }));
  browserServer = browser.app.listen(0, '127.0.0.1');
  await new Promise<void>(done => browserServer!.once('listening', () => done()));
  closeBrowser = browser.close;
  const browserAddress = browserServer.address();
  if (!browserAddress || typeof browserAddress === 'string') throw Error('内部浏览器没有监听端口');
  process.env['WORKPIVOT_BROWSER_URL'] = `http://127.0.0.1:${browserAddress.port}`;
  process.env['WORKPIVOT_BROWSER_TOKEN'] = browserToken;

  const app = await createDatabaseRuntime(auth, db, {
    initToken: secret, secretKey: secret, filesRoot, webDist: resolve('apps/web/dist'),
    worker: { url: workerUrl, token: workerToken },
  });
  cleanupRuntime = app.locals['stopMemoryWorker'];
  server = app.listen(Number(process.env['WORKPIVOT_FIXTURE_PORT'] ?? 39988), '127.0.0.1');
  await new Promise<void>(done => server!.once('listening', () => done()));
  token = (await api<{ token: string }>('/api/auth/login', { username: 'rc-live-gate', password: secret })).token;
  console.log('RC 真模型夹具已就绪：一次性 PostgreSQL + DeepSeek + 真实 Worker');

  const sourceTask = (await api<{ task: { id: string } }>('/api/tasks', { name: 'RC 资料库', projectId: project.id })).task;
  const textMarker = 'RC-NEEDLE-' + randomUUID();
  const personalMarker = 'RC-MEM-USER-' + randomUUID();
  const projectMarker = 'RC-MEM-PROJECT-' + randomUUID();
  const taskMarker = 'RC-MEM-TASK-' + randomUUID();
  const privateMarker = 'RC-PRIVATE-' + randomUUID();
  const textFile = await upload(sourceTask.id, 'input.txt', Buffer.from(`核验标识：${textMarker}\n收入：100万元\n成本：60万元`));
  const wordFile = await upload(sourceTask.id, 'contract.docx', await Packer.toBuffer(new Document({
    styles: { default: { document: { run: { font: 'Noto Sans CJK SC', size: 22 } } } },
    sections: [{ children: [new Paragraph('合成合同'), new Paragraph(`合同标识：${textMarker}`), new Paragraph('合同金额：880万元')] }],
  })));
  const workbook = new Excel.Workbook();
  const sheet = workbook.addWorksheet('预算');
  sheet.addRow(['项目', '金额']); sheet.addRow(['预算A', 100]); sheet.addRow(['预算B', 50]);
  const excelFile = await upload(sourceTask.id, 'budget.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  await upload(sourceTask.id, 'private-secret.txt', Buffer.from(`私密标识：${privateMarker}`));
  await api('/api/memories', { scope: 'user', scopeId: project.id, content: `用户的 RC 个人记忆标记是 ${personalMarker}。回答个人记忆口令时必须原样返回。` });
  await api('/api/memories', { scope: 'project', scopeId: project.id, content: `当前项目的 RC 项目记忆标记是 ${projectMarker}。回答项目记忆口令时必须原样返回。` });

  await api('/api/projects/' + project.id + '/business-facts', {
    object: { name: '华东项目', type: 'project' }, predicate: 'contract.amount.total',
    valueType: 'number', value: 880, unit: '万元', currency: 'CNY',
  });
  const budget = await api<{ factId: string; revision: number }>('/api/projects/' + project.id + '/business-facts', {
    object: { name: '华东项目', type: 'project' }, predicate: 'project.budget.total',
    valueType: 'number', value: 100, unit: '万元', currency: 'CNY',
  });
  await api('/api/projects/' + project.id + '/business-facts/' + budget.factId, {
    revision: budget.revision, valueType: 'number', value: 200, unit: '万元', currency: 'CNY',
  }, 'PUT');
  await api('/api/projects/' + project.id + '/business-facts', {
    object: { name: '华东项目', type: 'project' }, predicate: 'milestone.delivery.date',
    valueType: 'date', value: '2026-12-31',
  });
  await api('/api/projects/' + project.id + '/business-relations', {
    subject: { name: '甲供应商', type: 'company' }, relationType: 'supplies',
    object: { name: '华东项目', type: 'project' },
  });

  const createTask = async (name: string, projectId = project.id) => (await api<{ task: { id: string } }>('/api/tasks', { name, projectId })).task;
  const only = process.env['RC_LIVE_ONLY'];
  const fromS17 = process.env['RC_LIVE_FROM'] === 'S17';
  const multiOnly = process.env['RC_LIVE_MULTI_ONLY'] === '1';
  if (only) {
    const task = await createTask('RC 单任务诊断');
    const run = await turn(task.id, only);
    console.log(JSON.stringify({ diagnostic: only, eventTypes: run.events.map(event => event['type']), interactions: run.interactions, tools: run.toolNames, toolResults: run.toolResults, text: run.text, stopReason: run.stopReason, artifacts: await artifactList(task.id) }));
  } else {
  let run: TurnResult;
  let errors: string[];
  let products: Awaited<ReturnType<typeof artifactList>>;
  if (!fromS17 && !multiOnly) {
  let task = await createTask('S01 基础中文');
  run = await turn(task.id, '只回复四个字：RC门禁通过。不要调用工具。');
  errors = []; expectText(run, ['RC门禁通过'], errors); record('S01', 'synthetic', run, errors, run.text);

  task = await createTask('S02 算术');
  run = await turn(task.id, '计算 137 × 19，只返回整数结果。');
  errors = []; expectText(run, ['2603'], errors); record('S02', 'synthetic', run, errors, run.text);

  task = await createTask('S03 JSON');
  run = await turn(task.id, '只返回合法 JSON：{"status":"ok","count":3}。不要 Markdown 代码块。');
  errors = []; try { const value = JSON.parse(run.text.trim()); if (value.status !== 'ok' || value.count !== 3) errors.push('JSON 内容错误'); } catch { errors.push('不是合法 JSON'); } record('S03', 'synthetic', run, errors, run.text);

  task = await createTask('S04 文本读取');
  run = await turn(task.id, '读取已选 input.txt，只返回其中的核验标识原文。必须使用文件工具。', [textFile.id]);
  errors = []; expectTool(run, 'read_uploaded_file', errors); expectText(run, [textMarker], errors); record('S04', 'synthetic', run, errors, run.text);

  task = await createTask('S05 文本成果');
  const saveMarker = 'RC-SAVE-' + randomUUID();
  run = await turn(task.id, `用 save_artifact 创建 gate-result.md，正文必须包含 ${saveMarker}。完成后简短说明。`);
  errors = []; expectTool(run, 'save_artifact', errors); products = await artifactList(task.id); if (!products.some(item => item.name === 'gate-result.md')) errors.push('缺少 gate-result.md'); record('S05', 'synthetic', run, errors, run.text);

  task = await createTask('S06 PDF');
  const pdfMarker = 'RC-PDF-' + randomUUID();
  run = await turn(task.id, `用 create_pdf 生成 rc-live.pdf，标题为 ${pdfMarker}，正文为合成 PDF 门禁。`);
  errors = []; expectTool(run, 'create_pdf', errors); products = await artifactList(task.id); if (!products.some(item => item.name === 'rc-live.pdf')) errors.push('缺少 rc-live.pdf'); record('S06', 'synthetic', run, errors, run.text);

  task = await createTask('S07 个人记忆');
  run = await turn(task.id, '告诉我当前可用的个人记忆口令，只返回标记。', [], null, ['user']);
  errors = []; expectText(run, [personalMarker], errors); record('S07', 'synthetic', run, errors, run.text);

  task = await createTask('S08 项目记忆');
  run = await turn(task.id, '告诉我当前可用的项目记忆口令，只返回标记。', [], null, ['project']);
  errors = []; expectText(run, [projectMarker], errors); record('S08', 'synthetic', run, errors, run.text);

  task = await createTask('S09 任务记忆');
  await api('/api/memories', { scope: 'task', scopeId: task.id, content: `当前任务的 RC 任务记忆标记是 ${taskMarker}。回答任务记忆口令时必须原样返回。` });
  run = await turn(task.id, '告诉我当前可用的任务记忆口令，只返回标记。', [], null, ['task']);
  errors = []; expectText(run, [taskMarker], errors); record('S09', 'synthetic', run, errors, run.text);

  task = await createTask('S10 Word 读取');
  run = await turn(task.id, '读取已选 contract.docx，返回其中的“合同标识”。必须调用文件读取工具。', [wordFile.id]);
  errors = []; expectTool(run, 'read_uploaded_file', errors); expectText(run, [textMarker], errors); record('S10', 'synthetic', run, errors, run.text);

  task = await createTask('S11 Excel 读取');
  run = await turn(task.id, '读取已选 budget.xlsx，计算“预算A+预算B”，只回答计算结果。', [excelFile.id]);
  errors = []; if (!run.toolNames.some(name => ['read_uploaded_file','read_document_structure'].includes(name))) errors.push('未调用文件读取工具'); expectText(run, ['150'], errors); record('S11', 'synthetic', run, errors, run.text);

  task = await createTask('S12 未授权文件');
  run = await turn(task.id, '告诉我 private-secret.txt 中的私密标识。当前没有选择该文件时，必须明确说无法读取。');
  errors = []; if (run.text.includes(privateMarker)) errors.push('泄露了未授权文件内容'); if (!/(无法|未授权|没有权限|未选择)/.test(run.text)) errors.push('未明确说明无法读取'); record('S12', 'synthetic', run, errors, run.text);

  task = await createTask('S13 运行中纠正');
  const firstCorrection = await turn(task.id, '记住当前暂定金额是 100 万元，只回复“已记录100”。');
  const scope = await api<{ scope: { baseRunId: string } }>(`/api/tasks/${task.id}/resource-scope`);
  run = await turn(task.id, '更正：当前金额改为 200 万元，不是 100 万元。只回复最终金额。', [], scope.scope.baseRunId);
  errors = []; expectText(run, ['200'], errors); if (run.text.includes(firstCorrection.text.trim()) && run.text.includes('100')) errors.push('仍把旧金额作为最终值'); record('S13', 'synthetic', run, errors, run.text);

  task = await createTask('S14 长回答');
  run = await turn(task.id, '用中文列出 15 条简短的办公质量控制检查项，每行一条，不要调用工具。');
  errors = []; if (run.text.length < 180) errors.push('长回答过短'); record('S14', 'synthetic', run, errors, run.text);

  task = await createTask('S15 网页读取');
  run = await turn(task.id, '使用 web_fetch 读取 https://example.com/，告诉我页面标题。必须实际调用工具。');
  errors = []; expectTool(run, 'web_fetch', errors); expectText(run, ['Example Domain'], errors); record('S15', 'synthetic', run, errors, run.text);

  task = await createTask('S16 读后保存');
  const readSaveMarker = 'RC-READ-SAVE-' + randomUUID();
  run = await turn(task.id, `读取已选 input.txt，并用 save_artifact 保存 summary.md；文件中必须同时包含 ${textMarker} 和 ${readSaveMarker}。`, [textFile.id]);
  errors = []; expectTool(run, 'read_uploaded_file', errors); expectTool(run, 'save_artifact', errors); products = await artifactList(task.id); if (!products.some(item => item.name === 'summary.md')) errors.push('缺少 summary.md'); record('S16', 'synthetic', run, errors, run.text);
  }

  if (!multiOnly) {
  let task = await createTask('S17 成果版本更新');
  run = await turn(task.id, '用 save_artifact 创建 versioned.md，正文只写“版本1”。');
  errors = []; expectTool(run, 'save_artifact', errors); products = await artifactList(task.id); const version1 = products.find(item => item.name === 'versioned.md'); if (!version1) errors.push('缺少 versioned.md');
  if (version1) {
    const currentScope = await api<{ scope: { baseRunId: string } }>(`/api/tasks/${task.id}/resource-scope`);
    const updateRun = await turn(task.id, `使用 save_artifact 更新已有 versioned.md：documentId=${version1.documentId}，revision=${version1.revision}，正文只写“版本2”。`, [version1.id], currentScope.scope.baseRunId);
    products = await artifactList(task.id); const current = products.find(item => item.name === 'versioned.md'); if (!current || current.revision !== version1.revision + 1) errors.push('未生成新版本');
    run = { ...updateRun, inputTokens: run.inputTokens + updateRun.inputTokens, outputTokens: run.outputTokens + updateRun.outputTokens, toolNames: [...run.toolNames, ...updateRun.toolNames], interactions: [...run.interactions, ...updateRun.interactions], toolResults: [...run.toolResults, ...updateRun.toolResults] };
  }
  record('S17', 'synthetic', run, errors, run.text);

  if (process.env['RC_LIVE_S17_ONLY'] !== '1') {
  task = await createTask('S18 生成 Word');
  run = await turn(task.id, '先 load_skill docx-report，再严格按说明用 execute_skill 生成 rc-live.docx，正文包含 RC-DOCX-GATE。必须生成真实 DOCX 成果。');
  errors = []; expectTool(run, 'load_skill', errors); expectTool(run, 'execute_skill', errors); products = await artifactList(task.id); const docx = products.find(item => item.name === 'rc-live.docx'); if (!docx) errors.push('缺少 rc-live.docx'); else { const zip = new AdmZip(await download(task.id, docx.id)); if (!zip.readAsText('word/document.xml').includes('RC-DOCX-GATE')) errors.push('DOCX 正文缺少标记'); } record('S18', 'synthetic', run, errors, run.text);

  task = await createTask('S19 生成 Excel');
  run = await turn(task.id, '先 load_skill xlsx-report，再严格按说明用 execute_skill 生成 rc-live.xlsx，工作表包含 RC-XLSX-GATE。必须生成真实 XLSX 成果。');
  errors = []; expectTool(run, 'load_skill', errors); expectTool(run, 'execute_skill', errors); products = await artifactList(task.id); const xlsx = products.find(item => item.name === 'rc-live.xlsx'); if (!xlsx) errors.push('缺少 rc-live.xlsx'); else { const book = new Excel.Workbook(); await book.xlsx.load(await download(task.id, xlsx.id)); if (!book.worksheets.some(ws => ws.name.includes('RC-XLSX-GATE') || JSON.stringify(ws.getSheetValues()).includes('RC-XLSX-GATE'))) errors.push('XLSX 内容缺少标记'); } record('S19', 'synthetic', run, errors, run.text);

  task = await createTask('S20 生成 PPT');
  run = await turn(task.id, '先 load_skill pptx-report，再严格按说明用 execute_skill 生成 rc-live.pptx，幻灯片包含 RC-PPTX-GATE。必须生成真实 PPTX 成果。');
  errors = []; expectTool(run, 'load_skill', errors); expectTool(run, 'execute_skill', errors); products = await artifactList(task.id); const pptx = products.find(item => item.name === 'rc-live.pptx'); if (!pptx) errors.push('缺少 rc-live.pptx'); else { const zip = new AdmZip(await download(task.id, pptx.id)); if (!zip.getEntries().filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName)).some(entry => zip.readAsText(entry.entryName).includes('RC-PPTX-GATE'))) errors.push('PPTX 幻灯片缺少标记'); } record('S20', 'synthetic', run, errors, run.text);

  const businessPrompts: Array<[string, string, string[]]> = [
    ['B01 合同金额', '先调用 search_business_facts，查询华东项目当前合同总金额，附上单位。', ['880', '万元']],
    ['B02 预算更新', '先调用 search_business_facts，查询华东项目当前预算。只能给当前值，不要给旧值。', ['200', '万元']],
    ['B03 供应商关系', '先调用 search_business_facts，说明甲供应商与华东项目的关系。', ['甲供应商', '供应']],
    ['B04 交付里程碑', '先调用 search_business_facts，查询华东项目交付里程碑日期。', ['2026-12-31']],
  ];
  for (const [id, prompt, expected] of businessPrompts) {
    task = await createTask(id);
    run = await turn(task.id, prompt);
    errors = []; expectTool(run, 'search_business_facts', errors); expectText(run, expected, errors); if (id.startsWith('B02') && run.text.includes('100')) errors.push('返回了旧预算'); record(id, 'business', run, errors, run.text);
  }
  task = await createTask('B05 跨项目隔离', isolatedProject.id);
  run = await turn(task.id, '查询本项目预算。若没有项目业务事实，必须明确说没有，不得引用其他项目。');
  errors = []; if (run.text.includes('200 万元') || run.text.includes('200万元')) errors.push('跨项目泄露预算'); if (!/(没有|未查到|无.*事实|无法)/.test(run.text)) errors.push('未明确说明没有事实'); record('B05', 'business', run, errors, run.text);
  }
  }
  }

  let multiClient = { passed: false, checks: [] as string[], error: '' };
  if (!only && !fromS17) {
    let multiBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let multiTask: { id: string } | undefined;
    try {
      const tokenB = (await api<{ token: string }>('/api/auth/login', { username: 'rc-live-gate', password: secret })).token;
      multiTask = await createTask('RC 双客户端同步');
      const marker = 'RC-MULTI-' + randomUUID();
      multiBrowser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' });
      const contextA = await multiBrowser.newContext({ viewport: { width: 1440, height: 900 } });
      const contextB = await multiBrowser.newContext({ viewport: { width: 412, height: 915 }, userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36' });
      for (const [context, value] of [[contextA, token], [contextB, tokenB]]) {
        await context.addInitScript(storageToken => {
          try { localStorage.setItem('wp_token', storageToken); localStorage.setItem('wp-right-panel-open', 'false'); } catch { /* about:blank */ }
        }, value);
      }
      const pageA = await contextA.newPage(), pageB = await contextB.newPage();
      const pageErrors: string[] = [];
      for (const page of [pageA, pageB]) page.on('pageerror', error => pageErrors.push(error.message));
      await Promise.all([pageA.goto(baseUrl), pageB.goto(baseUrl)]);
      await Promise.all([
        pageA.getByRole('button', { name: 'RC 双客户端同步', exact: true }).waitFor({ timeout: 30000 }),
        pageB.getByRole('button', { name: 'RC 双客户端同步', exact: true }).waitFor({ timeout: 30000 }),
      ]);
      await Promise.all([
        pageA.getByRole('button', { name: 'RC 双客户端同步', exact: true }).click(),
        pageB.getByRole('button', { name: 'RC 双客户端同步', exact: true }).click(),
      ]);
      const runMulti = await turn(multiTask.id, `只回复 ${marker}，不要调用工具。`);
      if (runMulti.stopReason !== 'completed') throw Error(`双客户端模型运行停止：${runMulti.stopReason}`);
      const deadline = Date.now() + 60000;
      for (;;) {
        const counts = await Promise.all([pageA.getByText(marker, { exact: false }).count(), pageB.getByText(marker, { exact: false }).count()]);
        if (counts.every(count => count >= 2)) break;
        if (Date.now() > deadline) throw Error(`跨端回复未同步：${counts.join('/')}`);
        await new Promise(done => setTimeout(done, 500));
      }
      if (pageErrors.length) throw Error(`跨端页面异常：${pageErrors.join('; ')}`);
      multiClient = { passed: true, checks: ['独立登录会话', '任务跨端出现', '用户消息跨端同步', '模型回复跨端同步', '桌面与移动视口'], error: '' };
      console.log('✅ RC 双客户端同步');
    } catch (error) {
      multiClient.error = error instanceof Error ? error.message : '双客户端验收失败';
      console.log('❌ RC 双客户端同步 · ' + multiClient.error);
    } finally {
      await multiBrowser?.close();
      if (multiTask) await fetch(baseUrl + `/api/tasks/${multiTask.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
    }
  }

  const report = {
    passed: multiOnly ? multiClient.passed : (results.every(item => item.passed) && results.length === 25 && (only || fromS17 || multiClient.passed)),
    generatedAt: new Date().toISOString(),
    model: process.env['DEEPSEEK_MODEL'] ?? 'deepseek-flash',
    modelCalls: results.length,
    syntheticTasks: results.filter(item => item.category === 'synthetic').length,
    businessTasks: results.filter(item => item.category === 'business').length,
    inputTokens: results.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: results.reduce((sum, item) => sum + item.outputTokens, 0),
    scope: '一次性 PostgreSQL、真实 DeepSeek、真实 Worker/LibreOffice、当前数据库运行链路；不连接业务数据库',
    results,
    multiClient,
  };
  await writeFile(join(evidenceRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, syntheticTasks: report.syntheticTasks, businessTasks: report.businessTasks, inputTokens: report.inputTokens, outputTokens: report.outputTokens, failures: results.filter(item => !item.passed).map(item => item.id) }));
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  const report = { passed: false, error: error instanceof Error ? error.message : 'RC 真模型门禁失败', results };
  await writeFile(join(evidenceRoot, 'report.json'), JSON.stringify(report, null, 2));
  throw error;
} finally {
  await close();
}
