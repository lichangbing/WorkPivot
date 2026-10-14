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
  const worker = new MemoryWorker(db, async () => client);
  const project = await workspace.createProject(actor, '虚构记忆验收项目');
  const task = await workspace.createTask(actor, '三层记忆验收', project.id);
  async function extract(text: string) {
    const run = await runs.start(actor, task.id, randomUUID(), text);
    await runs.finish(actor, run, 'completed', []);
    await worker.enqueue(actor, task.id, run.id);
    for (let attempt = 0; attempt < 3; attempt++) {
      await worker.process(actor);
      const status = await transaction(db, async c => (await c.query('SELECT status FROM workpivot.memory_jobs WHERE run_id=$1', [run.id])).rows[0].status, actor);
      if (status !== 'pending') break;
      console.log('Retrying interrupted extraction within the normal three-attempt budget');
    }
    const job = await transaction(db, async c => (await c.query('SELECT status,error FROM workpivot.memory_jobs WHERE run_id=$1', [run.id])).rows[0], actor);
    assert.equal(job.status, 'completed', job.error);
    return suggestions.list(actor);
  }

  assert.equal((await extract('您好')).length,0,'Greeting should not become memory');
  for (const [scope,text] of [
    ['user','我长期负责机械行业研究，报告语言固定使用中文。'],
    ['project','当前项目的研究目标是比较全球工程机械厂商，整个项目的结论用于内部分析。'],
    ['task','这次报告标题是北辰观察，交付格式为Word。']
  ] as const) {
    const rows=await extract(text), candidate=rows.find(s=>s.scope===scope);
    assert(candidate,'Missing intent-based '+scope+' suggestion');
    assert(candidate.evidence&&text.includes(candidate.evidence));
    const before=(await workspace.listMemories(actor,scope,scope==='user'?undefined:scope==='project'?project.id:task.id)).memories;
    assert(!before.some(m=>m.content===candidate.content),'Unconfirmed candidate leaked');
    const accepted=await suggestions.decide(actor,candidate.id,true,candidate.content+'（已人工核对）');
    assert((await workspace.readMemory(actor,accepted.memoryId!))?.content.endsWith('（已人工核对）'));
    for(const other of await suggestions.list(actor))await suggestions.decide(actor,other.id,scope === 'task' && other.scope === 'task');
    console.log('PASS intent '+scope+': exact evidence, no write before confirmation, edited confirmation');
  }
  const originalFormat = (await workspace.listMemories(actor, 'task', task.id)).memories.find(m => /Word/i.test(m.content));
  assert(originalFormat, 'Missing confirmed original delivery format');
  const correction = '刚才说的交付格式改为PDF，其他要求不变。';
  const corrected = await extract(correction);
  const candidate = corrected.find(s => s.scope === 'task' && /PDF/i.test(s.content));
  assert(candidate, 'Missing cross-turn correction');
  assert.equal(candidate.targetId, originalFormat.id, 'Correction must update the existing format');
  assert(candidate.sourceContext.length > 0, 'Missing previous-turn provenance');
  assert(correction.includes(candidate.evidence), 'Correction must quote current turn');
  const result = await suggestions.decide(actor, candidate.id, true);
  assert(/PDF/i.test((await workspace.readMemory(actor, result.memoryId!))!.content));
  for (const other of await suggestions.list(actor)) await suggestions.decide(actor, other.id, false);
  assert.equal((await extract('好的，继续吧')).length, 0, 'Acknowledgement must not replay old facts');
  console.log('PASS real multi-turn correction, provenance, confirmation and no-op acknowledgement');
} finally { await Promise.all([schema.end(),db.end(),auth.end(),liveDb.end(),liveAuth.end()]); }
