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

  const initial = (await extract('本次报告必须使用中文撰写。')).find(s => s.scope === 'task');
  assert(initial, 'Missing original pending language proposal');
  const corrected = (await extract('把本次报告改成英文撰写。')).filter(s => s.scope === 'task');
  assert.equal(corrected.length, 1, 'Correction must leave only one pending language proposal');
  assert.equal(corrected[0].replacedCount, 1, 'Correction must explicitly replace the old proposal');
  assert.notEqual(corrected[0].id, initial.id);
  assert.equal((await workspace.listMemories(actor, 'task', task.id)).memories.length, 0);
  await suggestions.decide(actor, corrected[0].id, false);
  assert.equal((await extract('本次报告的语言要求是英语。')).length, 0, 'Rejected paraphrase must not reappear');
  console.log('PASS real pending correction, no automatic publication, rejected paraphrase suppression');
} finally { await Promise.all([schema.end(),db.end(),auth.end(),liveDb.end(),liveAuth.end()]); }
