import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {CompactionService,compactedHistory} from '../packages/server/src/database/compaction.js';
import {WorkspaceRepository} from '../packages/server/src/database/workspace.js';
import {RunRepository} from '../packages/server/src/database/runs.js';
import {transaction} from '../packages/server/src/database/connection.js';
import {summaryBatches} from '../packages/server/src/database/summary-batches.js';
import type {ChatMessage} from '@workpivot/core';
export async function testCompaction(db:Pool,actor:string,foreign:string,check:(ok:unknown,label:string)=>void){
 const workspace=new WorkspaceRepository(db),runs=new RunRepository(db);
 const project=await workspace.createProject(actor,'summary fixture'),task=await workspace.createTask(actor,'summary fixture',project.id);
 async function turn(content:string){const run=await runs.start(actor,task.id,randomUUID(),content);await runs.finish(actor,run,'completed',[{role:'assistant',content:'回答'+content}]);return run;}
 for(let i=1;i<=8;i++)await turn('原文'+i);
 let release:()=>void=()=>{};let gate=new Promise<void>(r=>{release=r;});let calls=0;
 const model={providerId:'fixture',model:'fixture',async *streamChat(messages:ChatMessage[]){calls++;await gate;const id=/\[来源:([0-9a-f-]+)\]/.exec(messages[1]!.content!)![1];yield {type:'delta' as const,text:'目标：保留早期约束；待办：检查报告。[来源:'+id+']'};}};
 const summaries=new CompactionService(db,async()=>model);
 const history=()=>transaction(db,c=>compactedHistory(c,task.id),actor);
 async function ready(service=summaries){for(let i=0;i<100;i++){const row=(await service.list(actor,task.id))[0];if(row.status!=='generating')return row;await new Promise(r=>setTimeout(r,10));}throw Error('generation did not finish');}
 await summaries.request(actor,task.id);await summaries.request(actor,task.id);
 check((await summaries.list(actor,task.id)).length===1,'concurrent summary requests create only one job');
 check((await history()).length===16,'generating summary never replaces history');
 await turn('摘要期间新消息');release();let row=await ready();
 check(calls===1&&row.status==='pending'&&row.turns===3,'summary retains last five full turns');
 check((await history()).length===18,'pending summary never replaces history or new messages');
 await assert.rejects(summaries.list(foreign,task.id));check(true,'foreign user cannot list summary');
 await assert.rejects(summaries.decide(foreign,task.id,row.id,row.revision,true));check(true,'foreign user cannot confirm summary');
 check((await summaries.original(actor,task.id,row.id)).length===3,'source excerpts retain covered range');
 check(row.facts[0]?.status==='linked'&&row.facts[0].sourceIds.length===1,'摘要事实保留有效轮次映射');
 const excerpts=await summaries.original(actor,task.id,row.id);check(excerpts.some(r=>r.id===row.facts[0].sourceIds[0]&&r.messages.includes('回答原文')),'来源摘录包含对应模型回复及原始用户内容');
 await assert.rejects(summaries.decide(actor,task.id,row.id,row.revision,true,'伪造来源[来源:'+randomUUID()+']'));check(true,'拒绝确认其他或不存在的来源标记');
 await summaries.decide(actor,task.id,row.id,row.revision,true,'用户核对后的目标与待办');
 await summaries.decide(actor,task.id,row.id,row.revision,true,'用户核对后的目标与待办');
 check((await summaries.list(actor,task.id))[0].facts[0]?.status==='unattributed','人工新增且未引用的内容明确标为未标注来源');
 check((await history())[0]!.content!.includes('用户核对后的目标与待办'),'edited confirmation is active and duplicate decision idempotent');
 check((await history()).length===13&&(await history()).at(-2)!.content!.includes('摘要期间新消息'),'recent complete turns and concurrent messages retained');
 const restarted=new CompactionService(db,async()=>model);
 check((await restarted.list(actor,task.id))[0].status==='accepted','confirmed summary survives service recreation');
 await turn('第十轮');await summaries.request(actor,task.id);row=await ready();
 await summaries.decide(actor,task.id,row.id,row.revision,false);
 check((await history())[0]!.content!.includes('用户核对后的目标与待办'),'rejecting new summary retains previous confirmed checkpoint');
 await summaries.request(actor,task.id);row=await ready();await summaries.decide(actor,task.id,row.id,row.revision,true,'第二版摘要');
 check((await history())[0]!.content!.includes('第二版摘要'),'second confirmed compaction replaces first');
 const memory=await workspace.createMemory(actor,'测试删除','user');await workspace.deleteMemory(actor,memory.id,1);
 check((await summaries.list(actor,task.id)).every(r=>r.status==='stale'&&!r.content),'forget invalidates and erases all retained summary versions');
 await assert.rejects(summaries.decide(actor,task.id,row.id,row.revision,true));check(true,'forgotten summary cannot be reconfirmed');
 for(let i=0;i<8;i++)await turn('恢复后原文'+i);
 gate=new Promise<void>(r=>{release=r;});await summaries.request(actor,task.id);
 const before=(await summaries.list(actor,task.id))[0];
 await transaction(db,c=>c.query("UPDATE workpivot.context_checkpoints SET lease_until=now()-interval '1 second' WHERE id=$1",[before.id]),actor);
 check((await summaries.list(actor,task.id))[0].status==='failed','expired summary job exposes retry');release();await new Promise(r=>setTimeout(r,30));
 check((await summaries.list(actor,task.id))[0].status==='failed','late generator cannot revive expired checkpoint');
 await summaries.request(actor,task.id);row=await ready();
 const old=await transaction(db,async c=>(await c.query("SELECT id FROM workpivot.conversation_events WHERE task_id=$1 AND kind='user' ORDER BY sequence DESC OFFSET 7 LIMIT 1",[task.id])).rows[0],actor);
 await transaction(db,c=>c.query("UPDATE workpivot.conversation_events SET content='已调整原文' WHERE id=$1",[old.id]),actor);
 check((await summaries.list(actor,task.id))[0].status==='stale','source edits invalidate pending summary');
 await summaries.request(actor,task.id);row=await ready();await summaries.decide(actor,task.id,row.id,row.revision,true);
 await workspace.deleteProject(actor,project.id,project.revision);
 check((await transaction(db,c=>c.query('SELECT id FROM workpivot.context_checkpoints WHERE task_id=$1',[task.id]),actor)).rowCount===0,'project deletion removes all summary data');
 const automatic=await workspace.createTask(actor,'automatic budget');
 for(let i=0;i<8;i++){const r=await runs.start(actor,automatic.id,randomUUID(),'a'.repeat(400));await runs.finish(actor,r,'completed',[{role:'assistant',content:'b'.repeat(400)}]);}
 const auto=new CompactionService(db,async()=>model,24000);
 const duplicate=(await transaction(db,c=>c.query('SELECT request_id FROM workpivot.task_runs WHERE task_id=$1 LIMIT 1',[automatic.id]),actor)).rows[0];
 await auto.guard(actor,automatic.id,'x'.repeat(30000),{},duplicate.request_id);check(true,'retry of existing run bypasses compaction gate without creating another job');
 await assert.rejects(auto.guard(actor,automatic.id,'x'.repeat(6000),{}));
 check((await transaction(db,c=>c.query('SELECT id FROM workpivot.task_runs WHERE task_id=$1',[automatic.id]),actor)).rowCount===8,'automatic trigger does not create or consume the unsent user message');
 let autoRow;for(let i=0;i<100;i++){autoRow=(await auto.list(actor,automatic.id))[0];if(autoRow?.status==='pending')break;await new Promise(r=>setTimeout(r,10));}
 assert(autoRow?.status==='pending');await auto.decide(actor,automatic.id,autoRow.id,autoRow.revision,true);
 await auto.guard(actor,automatic.id,'x'.repeat(6000),{});check(true,'confirmed compaction brings next turn within conservative budget');
 await workspace.deleteTask(actor,automatic.id,(await workspace.listTasks(actor)).find(t=>t.id===automatic.id)!.revision);
 const large=await workspace.createTask(actor,'batch summary');
 for(let i=0;i<15;i++){const r=await runs.start(actor,large.id,randomUUID(),'turn-'+i+'a'.repeat(650));await runs.finish(actor,r,'completed',[{role:'assistant',content:'b'.repeat(650)}]);}
 let batchCalls=0;
 const batchModel={providerId:'batch',model:'batch',async *streamChat(messages:ChatMessage[]){batchCalls++;const input=JSON.parse(messages[1]!.content!);if(batchCalls>1)assert.equal(input.previousSummary,'保留早期约束');yield{type:'delta' as const,text:'保留早期约束'};}};
 let capacity=12000;
 const batchService=new CompactionService(db,async()=>batchModel,65536,async()=>capacity);
 await batchService.request(actor,large.id);
 let batchRow;for(let i=0;i<200;i++){batchRow=(await batchService.list(actor,large.id))[0];if(batchRow.status!=='generating')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(batchRow.status,'pending');check(batchCalls>1&&batchRow.processed===batchRow.total,'oversized history processed in bounded batches with rolling summary');
 check(batchRow.content==='保留早期约束','only complete final summary is offered for confirmation');
 await batchService.decide(actor,large.id,batchRow.id,batchRow.revision,true);
 capacity=100000;await batchService.guard(actor,large.id,'extra'.repeat(1000),{});check(true,'changed model capacity applies on next guard');
 const paired:ChatMessage[]=[{role:'user',content:'tool turn'},{role:'assistant',content:null,tool_calls:[{id:'call',type:'function',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'call',content:'result'}];
 const pairedPlan=summaryBatches([...paired,...paired],12000);check(pairedPlan.batches.every(b=>b.filter(m=>m.role==='tool').length===b.filter(m=>m.tool_calls).length),'batch boundaries preserve tool call/result pairs');
 assert.throws(()=>summaryBatches([{role:'user',content:'x'.repeat(12000)}],12000));check(true,'single oversized turn is rejected without silently splitting protocol');
 await workspace.deleteTask(actor,large.id,(await workspace.listTasks(actor)).find(t=>t.id===large.id)!.revision);
}
