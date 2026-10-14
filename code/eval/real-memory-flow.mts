import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pool, installSchema, transaction } from '../packages/server/src/database/connection.js';
import { AccountRepository } from '../packages/server/src/database/accounts.js';
import { ProviderRepository } from '../packages/server/src/database/providers.js';
import { DatabaseModelService } from '../packages/server/src/database/model-service.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { RunRepository } from '../packages/server/src/database/runs.js';
import { MemoryWorker } from '../packages/server/src/database/memory-worker.js';
import { MemorySuggestions } from '../packages/server/src/database/memory-suggestions.js';
import { DatabaseMemoryTools } from '../packages/server/src/database/memory-tools.js';
import { DatabaseExecution } from '../packages/server/src/database/execution.js';
import { MemoryControls } from '../packages/server/src/database/memory-controls.js';
import { CompactionService } from '../packages/server/src/database/compaction.js';

const target = process.env.WORKPIVOT_MEMORY_TEST_URL;
if (!target || new URL(target).pathname !== '/workpivot_memory_test' || process.env.WORKPIVOT_MEMORY_TEST_DISPOSABLE !== '1') throw Error('Disposable database required');
const schema = pool(target), liveDb = pool(process.env.WORKPIVOT_DATABASE_URL!), liveAuth = pool(process.env.WORKPIVOT_AUTH_DATABASE_URL!);
const secret = randomBytes(32).toString('hex');
const roleUrl = (role: string) => { const url = new URL(target); url.username = role; url.password = secret; return url.toString(); };
const db = pool(roleUrl('memory_app')), auth = pool(roleUrl('memory_auth'));
try {
  const owner = (await liveAuth.query("SELECT id FROM identity.users WHERE role='admin' AND NOT disabled ORDER BY username LIMIT 1")).rows[0]?.id;
  assert(owner, 'No active administrator');
  const key = (await readFile('/data/workpivot/database-secret.key', 'utf8')).trim();
  const configured = await new DatabaseModelService(liveAuth, liveDb, new ProviderRepository(liveDb, key)).client(owner);
  const client: typeof configured = { providerId: configured.providerId, model: configured.model, async *streamChat(...args) {
    const start = Date.now(); let result = '';
    try { for await (const event of configured.streamChat(...args)) { if (event.type === 'delta') result += event.text; yield event; } }
    finally { console.log(JSON.stringify({ modelCallMs: Date.now() - start, output: result })); }
  } };
  await schema.query(`CREATE ROLE memory_app LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS; CREATE ROLE memory_auth LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS;`);
  await installSchema(schema, 'memory_app', 'memory_auth');
  const actor = (await new AccountRepository(auth).registerFirst('memory-test', secret, secret, secret)).user.id;
  const workspace = new WorkspaceRepository(db), runs = new RunRepository(db), suggestions = new MemorySuggestions(db);
  const worker = new MemoryWorker(db, async () => client), tools = new DatabaseMemoryTools(db);
  const project = await workspace.createProject(actor, '虚构记忆验收项目');
  const task = await workspace.createTask(actor, '三层记忆验收', project.id);
  async function extract(text: string) {
    const run = await runs.start(actor, task.id, randomUUID(), text);
    await runs.finish(actor, run, 'completed', []);
    await worker.enqueue(actor, task.id, run.id);
    await worker.process(actor);
    const job = await transaction(db, async c => (await c.query('SELECT status,error FROM workpivot.memory_jobs WHERE run_id=$1', [run.id])).rows[0], actor);
    assert.equal(job.status, 'completed', job.error);
    return suggestions.list(actor);
  }
  if(process.env.WORKPIVOT_SUMMARY_ONLY!=='1'){
  for (const [scope, text] of [
    ['user', '请长期记住我的个人报告偏好：报告语言固定使用中文。'],
    ['project', '请记住当前项目的长期研究标准：每周跟踪库存周转天数。'],
    ['task', '仅对当前任务记住：最终交付的标题固定为北辰观察，不应用到其他任务。'],
  ] as const) {
    const rows = await extract(text);
    const candidate = rows.find(s => s.scope === scope);
    assert(candidate, `Missing ${scope} candidate`);
    assert(candidate.evidence && text.includes(candidate.evidence));
    assert(!(await tools.search(actor, task.id, '')).memories.some(m => m.preview === candidate.content), 'Unconfirmed memory leaked');
    await suggestions.decide(actor, candidate.id, true);
    for (const other of rows.filter(s => s.id !== candidate.id)) await suggestions.decide(actor, other.id, false);
    console.log(`PASS ${scope}: real extraction, evidence, confirmation`);
  }
  const personal = (await tools.search(actor, task.id, '')).memories.find(m => m.scope === 'user')!;
  const updated = await extract('更正我的个人报告语言偏好：今后报告语言固定使用英文，替代原先的中文要求。');
  const update = updated.find(s => s.targetId === personal.id);
  assert(update, 'Correction created duplicate instead of update');
  assert((await tools.read(actor, task.id, personal.id)).content.includes('中文'));
  await suggestions.decide(actor, update.id, true, '我的个人报告语言固定使用英文。');
  assert.equal((await tools.read(actor, task.id, personal.id)).revision, 2);
  console.log('PASS correction: same identity, user edited confirmation, new revision');
  const rejected = await extract('请长期记住我的个人排版偏好：报告标题使用紫色。');
  assert(rejected.length);
  for (const item of rejected) await suggestions.decide(actor, item.id, false);
  assert.equal((await tools.search(actor, task.id, '紫色')).memories.length, 0);
  console.log('PASS rejection: no active memory');
  const sibling = await workspace.createTask(actor, '新会话读取记忆', project.id);
  assert.equal((await tools.search(actor, sibling.id, '')).memories.length, 2, 'Task memory leaked into sibling');
  const outside = await workspace.createTask(actor, '项目外会话');
  assert.equal((await tools.search(actor, outside.id, '')).memories.length, 1, 'Project memory leaked');
  const execution = new DatabaseExecution(db, async () => ({ client, tools: tools.tools(actor, sibling.id), taskDir: '.', maxSteps: 8, maxDurationMs: 120000, system: '回答前必须查找并读取已保存记忆。仅使用工具读取的事实回答，不猜测。' }));
  const started = await execution.begin(actor, sibling.id, '我要求报告使用哪种语言？这个项目每周跟踪什么指标？用中文简短回答。', randomUUID());
  let answer = '', calls = 0;
  assert.equal(await started.execute!(event => { if (event.type === 'assistant_delta') answer += event.text; if (event.type === 'tool_use') calls++; }), 'completed');
  assert(calls > 0 && answer.includes('英文') && answer.includes('库存'), 'Real model did not recall confirmed memories');
  console.log('PASS fresh conversation: actual model retrieves confirmed personal/project memory');
  const first = await workspace.createMemory(actor, '个人研究偏好：重点关注新能源行业。', 'user');
  const second = await workspace.createMemory(actor, '个人研究偏好：研究新能源行业时必须注明数据来源。', 'user');
  const merges = await extract('请将我已有的两条新能源行业研究偏好合并为一条长期个人记忆：重点关注新能源行业，研究时必须注明数据来源。保留这两个要求。');
  const merge = merges.find(s => s.mergeTargets?.some((m: { id: string }) => m.id === first.id) && s.mergeTargets.some((m: { id: string }) => m.id === second.id));
  assert(merge, 'Real model did not propose complementary memory merge');
  assert.equal(merge.mergeOriginals.length, 2);
  assert(await workspace.readMemory(actor, first.id));
  assert(await workspace.readMemory(actor, second.id));
  const accepted = await suggestions.decide(actor, merge.id, true, '重点研究新能源行业，并标注数据来源。');
  assert.equal(await workspace.readMemory(actor, first.id), null);
  assert.equal(await workspace.readMemory(actor, second.id), null);
  assert.equal((await workspace.readMemory(actor, accepted.memoryId!))?.content, '重点研究新能源行业，并标注数据来源。');
  for (const other of await suggestions.list(actor)) await suggestions.decide(actor, other.id, false);
  console.log('PASS real merge: originals preserved until edited confirmation');
  const controls = new MemoryControls(db);
  await controls.lock(actor, accepted.memoryId!, true, 1);
  const lockedProposals = await extract('更正我之前的新能源行业研究偏好：改为研究消费行业。');
  assert(!lockedProposals.some(s => s.targetId === accepted.memoryId || s.mergeTargets?.some((m: { id: string }) => m.id === accepted.memoryId)));
  assert.equal((await tools.read(actor, task.id, accepted.memoryId!)).content, '重点研究新能源行业，并标注数据来源。');
  for (const proposal of lockedProposals) await suggestions.decide(actor, proposal.id, false);
  console.log('PASS lock: actual extraction cannot modify or merge locked original');
  await controls.save(actor, 'user', true, false, 0);
  const disabled = await extract('请长期记住我的个人偏好：每份报告都使用橙色封面。');
  assert(!disabled.some(s => s.scope === 'user'));
  assert((await tools.search(actor, task.id, '')).memories.some(m => m.id === accepted.memoryId));
  console.log('PASS update disabled: no user proposals; existing memories remain readable');
  console.log('PASS real memory acceptance');
  }
  const longTask=await workspace.createTask(actor,'真实摘要验收');
  for(const text of ['本任务报告标题定为海棠周报，所有金额单位使用万元。','更正：报告标题改为松柏周报，替代海棠周报。金额单位仍是万元。','未完成事项：核对库存数据，不要声称已经完成。',...Array.from({length:5},(_,i)=>`继续第${i+1}项常规排版讨论。`)]){
    const r=await runs.start(actor,longTask.id,randomUUID(),text+(text.startsWith('继续')?'':'\n排版占位，无新增事实：'+'layout '.repeat(260)));await runs.finish(actor,r,'completed',[{role:'assistant',content:'收到该要求。'}]);
  }
  const compact=new CompactionService(db,async()=>client,16000);
  await compact.request(actor,longTask.id);
  let summary;for(let i=0;i<300;i++){summary=(await compact.list(actor,longTask.id))[0];if(summary.status!=='generating')break;await new Promise(r=>setTimeout(r,500));}
  assert.equal(summary?.status,'pending');assert(summary.total>1,'Real summary must exercise multiple batches');assert(summary.content.includes('松柏')&&summary.content.includes('万元')&&summary.content.includes('库存'));
  await compact.decide(actor,longTask.id,summary.id,summary.revision,true);
  const resume=new DatabaseExecution(db,async()=>({client,tools:[],taskDir:'.',maxSteps:3,maxDurationMs:120000,system:'仅根据对话历史回答，不猜测。'}));
  const resumed=await resume.begin(actor,longTask.id,'最终标题、金额单位和未完成事项分别是什么？',randomUUID());let recalled='';
  assert.equal(await resumed.execute!(e=>{if(e.type==='assistant_delta')recalled+=e.text;}),'completed');
  assert(recalled.includes('松柏')&&recalled.includes('万元')&&recalled.includes('库存'));
  console.log('PASS actual summary and continuation retain early correction, units and unfinished work');
} finally { await Promise.all([schema.end(), db.end(), auth.end(), liveDb.end(), liveAuth.end()]); }
