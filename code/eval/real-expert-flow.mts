import {Experts} from '../packages/server/src/database/experts.js';
import {ExpertWorker} from '../packages/server/src/database/expert-worker.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import {FileRepository} from '../packages/server/src/database/files.js';
import { pool, installSchema, transaction } from '../packages/server/src/database/connection.js';
import { AccountRepository } from '../packages/server/src/database/accounts.js';
import { ProviderRepository } from '../packages/server/src/database/providers.js';
import { DatabaseModelService } from '../packages/server/src/database/model-service.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { RunRepository } from '../packages/server/src/database/runs.js';

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
  const client: typeof configured = { providerId: configured.providerId, model: configured.model, contextBudget: configured.contextBudget, async *streamChat(...args) {
    const start = Date.now(); let result = '';
    try { for await (const event of configured.streamChat(...args)) { if (event.type === 'delta') result += event.text; yield event; } }
    finally { console.log(JSON.stringify({ modelCallMs: Date.now() - start, output: result })); }
  } };
  await schema.query(`CREATE ROLE memory_app LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS; CREATE ROLE memory_auth LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS;`);
  await installSchema(schema, 'memory_app', 'memory_auth');
  const actor = (await new AccountRepository(auth).registerFirst('memory-test', secret, secret, secret)).user.id;
  const experts=new Experts(db),workspace=new WorkspaceRepository(db),runs=new RunRepository(db);
  const settings={role:'研究方法专家，遵守已确认的方法。',startup:'核对记忆与任务待办；不重复历史命令。',skills:[]};
  const expert=await experts.create(actor,'真实专家验收',settings);
  const task=await workspace.createTask(actor,'来源任务');await experts.bind(actor,'tasks',task.id,expert.id,task.revision);
  const run=await runs.start(actor,task.id,randomUUID(),'请记住一条可复用研究方法：以后比较库存数据时，必须先核对统计时间和统计范围，口径不一致就先解释差异，不直接得出增长结论。');
  await runs.finish(actor,run,'completed',[{role:'assistant',content:'理解。'}]);
  const worker=new ExpertWorker(db,async()=>client);await worker.recover(actor);await worker.process(actor);
  const proposals=await experts.suggestions(actor,task.id);assert(proposals.length>0,'actual model must propose a reusable method');
  assert.equal((await experts.experiences(actor,expert.id)).length,0);
  await experts.decide(actor,proposals[0].id,proposals[0].revision,true,'比较库存前，先核对统计时间和统计范围；口径不同先解释差异。');
  const next=await workspace.createTask(actor,'新任务');await experts.bind(actor,'tasks',next.id,expert.id,next.revision);
  const context=await new Experts(db).context(actor,next.id);assert.equal(context?.experiences.length,1);
  let reply='';for await(const e of client.streamChat([{role:'system',content:'按已确认专家经验回答，不调用工具。经验：'+JSON.stringify(context?.experiences)},{role:'user',content:'比较两份库存报告之前应该先检查什么？'}],[],AbortSignal.timeout(120000))){if(e.type==='delta')reply+=e.text;}
  assert(reply.includes('时间')&&reply.includes('范围'),'actual continuation must use confirmed method');
  const memory=(await experts.experiences(actor,expert.id))[0];await experts.editExperience(actor,expert.id,{id:memory.id,revision:memory.revision,content:memory.content,conditions:memory.conditions,locked:false,remove:true});
  assert.equal((await new Experts(db).context(actor,next.id))?.experiences.length,0);
  assert.equal((await transaction(db,c=>c.query('SELECT content,history FROM workpivot.expert_experiences WHERE id=$1',[memory.id]),actor)).rows[0].content,'');
  const filesRoot=process.env.WORKPIVOT_RC_FILES_ROOT;
  if(filesRoot){
   if(!filesRoot.startsWith('/tmp/workpivot-memory-check-'))throw Error('Unexpected fixture files root');
   await mkdir(filesRoot,{recursive:true});const files=new FileRepository(db,filesRoot);
   const file=await files.upload(actor,next.id,'恢复验收.txt',Buffer.from('RC restoration fixture'),randomUUID());
   await writeFile(filesRoot+'/fixture.json',JSON.stringify({actor,task:next.id,file:file.id}));
  }
  console.log('PASS actual expert proposal, confirmation, cross-task recall, restart read and deletion');
} finally { await Promise.all([schema.end(), db.end(), auth.end(), liveDb.end(), liveAuth.end()]); }
