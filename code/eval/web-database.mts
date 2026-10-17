/** 隔离 PostgreSQL + 可控网页/模型，验证真实授权、计划快照和撤销。 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelClient, StreamEvent } from '../packages/core/src/index.js';
import { pool, installSchema } from '../packages/server/src/database/connection.js';
import { AccountRepository } from '../packages/server/src/database/accounts.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { FileRepository } from '../packages/server/src/database/files.js';
import { DatabaseSkills } from '../packages/server/src/database/skills.js';
import { DatabaseExecution } from '../packages/server/src/database/execution.js';
import { Automations } from '../packages/server/src/database/automations.js';
import { AutomationWorker } from '../packages/server/src/database/automation-worker.js';
import { newAutomationConfig } from '../packages/shared/src/index.js';
import { SafeHttp, webUrl, type WebPolicy } from '../packages/server/src/web/safe-http.js';
import { WebTools } from '../packages/server/src/web/tools.js';
import { BrowserWorkspace } from '../packages/server/src/web/browser-workspace.js';

const url = process.env.WORKPIVOT_TEST_PG_URL;
if (!url || process.env.WORKPIVOT_TEST_PG_DISPOSABLE !== '1' || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/workpivot_test') throw Error('只允许隔离测试数据库');
const secret = randomBytes(32).toString('hex'), admin = pool(url);
const role = (name: string) => { const u = new URL(url); u.username = name; u.password = secret; return u.href; };
const db = pool(role('web_app')), auth = pool(role('web_auth')), root = await mkdtemp(join(tmpdir(), 'wp-web-'));
let count = 0, requests = 0, hold: (() => void) | undefined, entered: (() => void) | undefined;
const check = (value: unknown, name: string) => { assert(value, name); count++; console.log('PASS', name); };
class Fixture extends SafeHttp {
  override async get(url: string, policy: WebPolicy = {}) {
    webUrl(url, policy.origins); policy.signal?.throwIfAborted(); requests++;
    if (entered) { entered(); await new Promise<void>(resolve => { hold = resolve; }); }
    return { url, status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html><head><title>公告</title></head><body>网页合成正文42</body></html>') };
  }
}
const web = new WebTools(undefined, new Fixture());
const call = (name: string, args: unknown): StreamEvent => ({ type: 'tool_calls', tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
let scheduler: AutomationWorker | undefined;
try {
  await admin.query(`CREATE ROLE web_app LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;CREATE ROLE web_auth LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  await installSchema(admin, 'web_app', 'web_auth');
  const accounts = new AccountRepository(auth), user = await accounts.registerFirst('owner', 'synthetic-password', secret, secret), actor = user.user.id;
  const other = (await accounts.createUser(user.token, 'other', 'synthetic-password', 'member')).id;
  const workspace = new WorkspaceRepository(db), project = await workspace.createProject(actor, '网页采集'), files = new FileRepository(db, root);
  const ownedTask=await workspace.createTask(actor,'共享浏览器隔离',project.id);
  const broker=new BrowserWorkspace(db,{url:'http://127.0.0.1:1',token:secret});
  check(broker.key(actor,ownedTask.id)!==broker.key(other,ownedTask.id),'共享浏览器会话按账号和任务隔离');
  assert.deepEqual(await new BrowserWorkspace(db).request(actor,ownedTask.id),{available:false,open:false});
  await assert.rejects(new BrowserWorkspace(db).request(other,ownedTask.id));check(true,'其他用户不能读取或操作该对话浏览器');
  const model: ModelClient = { providerId: 'fixture', model: 'fixture', async *streamChat(messages) {
    if (!messages.some(m => m.role === 'tool')) yield call('web_fetch', { url: 'https://fixture.example' });
    else yield { type: 'delta', text: '已完成。' };
  } };
  const execution = new DatabaseExecution(db, async () => ({ client: model, tools: web.tools(async () => undefined), taskDir: '.', filePolicy: () => false }));
  for (const decision of ['deny', 'allow'] as const) {
    const task = await workspace.createTask(actor, '读取网页' + decision, project.id);
    const before = requests, begun = await execution.begin(actor, task.id, '读取网页', randomUUID());
    const running = begun.execute!(event => {
      if (event.type === 'permission_request') void execution.runs.decidePermission(actor, task.id, event.id, decision);
    });
    check(await running === 'completed', '对话授权决定后正常结束：' + decision);
    check(requests === before + (decision === 'allow' ? 1 : 0), '拒绝零请求，允许才抓取：' + decision);
  }
  const skills = new DatabaseSkills(db); let skill = await skills.create(actor, 'web-collect');
  skill = await skills.save(actor, skill.name, 'SKILL.md', Buffer.from('---\nname: web-collect\ndescription: 读取公开网页并保存结果\n---\n先读取网页，再将符合要求的正文保存为result.txt。'), skill.revision);
  await skills.publish(actor, skill.name, skill.revision); await skills.select(actor, skill.name, true);
  const release = (await skills.market(actor))[0]!.version, plans = new Automations(db, true);
  let mode: 'normal' | 'foreign' = 'normal';
  const automaticModel: ModelClient = { providerId: 'fixture', model: 'automatic', async *streamChat(messages) {
    const results = messages.filter(m => m.role === 'tool');
    if (!results.length) yield call('load_skill', { name: skill.name });
    else if (results.length === 1) yield call('web_fetch', { url: mode === 'foreign' ? 'https://other.example' : 'https://fixture.example' });
    else if (results.length === 2) yield call('save_artifact', { name: 'result.txt', content: results.at(-1)!.content });
    else yield { type: 'delta', text: '已保存。' };
  } };
  scheduler = new AutomationWorker(auth, plans, files, { url: 'http://127.0.0.1:1', token: secret }, async () => automaticModel, web);
  const config = { ...newAutomationConfig(), name: '公开网页采集', skill: skill.name, releaseId: release, projectId: project.id, requirements: '读取公开网页正文并保存', webOrigins: ['https://fixture.example'] };
  const run = async (origins: string[]) => {
    let plan = await plans.draft(actor, { ...config, webOrigins: origins }, randomUUID()); plan = await plans.confirm(actor, plan.id, plan.revision, true);
    const job = await plans.manual(actor, plan.id, plan.revision, randomUUID());
    await scheduler!.tick(); return { plan, detail: await plans.detail(actor, plan.id), job };
  };
  const before = requests, success = await run(config.webOrigins);
  check(success.detail.runs[0]?.status === 'completed' && requests === before + 1, '授权来源自动化可抓取并完成');
  const artifacts = await files.list(actor, success.detail.runs[0]!.taskId!, 'artifact');
  check(artifacts.length === 1 && (await files.download(actor, success.detail.runs[0]!.taskId!, artifacts[0]!.id)).data.toString().includes('网页合成正文42'), '网页结果通过真实文件仓库发布');
  assert.equal((await plans.list(other)).length, 0); check(true, '其他账号不能查看采集计划');
  const noPermissionBefore = requests, offline = await run([]);
  check(offline.detail.runs[0]?.status === 'failed' && requests === noPermissionBefore, '旧计划无来源时不提供网页工具且不发请求');
  mode = 'foreign'; const foreign = await run(config.webOrigins); mode = 'normal';
  check(foreign.detail.runs[0]?.status === 'failed' && requests === noPermissionBefore, '未授权来源拒绝并不伪报成功');
  check(!(await files.list(actor, foreign.detail.runs[0]!.taskId!, 'artifact')).length, '网页失败不发布暂存成果');
  let cancelPlan = await plans.draft(actor, config, randomUUID()); cancelPlan = await plans.confirm(actor, cancelPlan.id, cancelPlan.revision, true);
  const cancelJob = await plans.manual(actor, cancelPlan.id, cancelPlan.revision, randomUUID());
  const waiting = new Promise<void>(resolve => { entered = resolve; }); const running = scheduler.tick(); await waiting;
  await plans.stopRun(actor, cancelPlan.id, cancelJob.id); entered = undefined; hold!(); await running;
  const cancelled = await plans.detail(actor, cancelPlan.id);
  check(cancelled.runs[0]?.status !== 'completed' && !(await files.list(actor, cancelled.runs[0]!.taskId!, 'artifact')).length, '抓取期间停止后拒绝迟到完成和成果');
  console.log(`Web database: ${count} checks passed`);
} finally { hold?.(); await scheduler?.stop(); await Promise.all([db.end(), auth.end(), admin.end()]); await rm(root, { recursive: true, force: true }); }
