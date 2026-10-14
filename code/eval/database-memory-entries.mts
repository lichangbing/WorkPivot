import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {WorkspaceRepository} from '../packages/server/src/database/workspace.js';
import {RunRepository} from '../packages/server/src/database/runs.js';
import {transaction} from '../packages/server/src/database/connection.js';
import {splitMemoryEntries} from '../apps/web/src/memory-entries.js';

export async function testMemoryEntries(db:Pool,actor:string,foreign:string,check:(v:unknown,n:string)=>void){
 const w=new WorkspaceRepository(db),runs=new RunRepository(db);
 const project=await w.createProject(actor,'逐条记忆测试'),task=await w.createTask(actor,'条目来源',project.id);
 for(const scope of ['user','project','task'] as const){
  const scopeId=scope==='user'?undefined:scope==='project'?project.id:task.id;
  const batch=await w.saveMemoryEntries(actor,['独立事实甲','独立事实乙'],scope,scopeId);
  await w.editMemory(actor,batch[0]!.id,'只修改甲',1);
  check((await w.readMemory(actor,batch[1]!.id))?.content==='独立事实乙',scope+' editing one entry preserves sibling');
  await w.deleteMemory(actor,batch[0]!.id,2);
  check((await w.readMemory(actor,batch[1]!.id))?.content==='独立事实乙',scope+' deleting one entry preserves sibling');
 }
 const source=await runs.start(actor,task.id,randomUUID(),'统计注明日期；报告使用中文');await runs.finish(actor,source,'completed',[]);
 const old=await w.createMemory(actor,'统计注明日期\n报告使用中文','project',project.id);
 await transaction(db,async c=>{await c.query('UPDATE workpivot.memories SET locked=true WHERE id=$1',[old.id]);await c.query('INSERT INTO workpivot.memory_sources(owner_user_id,memory_id,run_id) VALUES($1,$2,$3)',[actor,old.id,source.id]);},actor);
 await assert.rejects(w.saveMemoryEntries(foreign,['窃取'],'user',undefined,old));check(true,'foreign split denied');
 await assert.rejects(w.saveMemoryEntries(actor,['移动'],'user',undefined,old));check(true,'split cannot change scope');
 await assert.rejects(w.saveMemoryEntries(actor,['保留',''],'project',project.id,old));
 check((await w.readMemory(actor,old.id))?.content.includes('报告'),'invalid split preserves original');
 const parts=await w.saveMemoryEntries(actor,['统计注明日期','报告使用中文'],'project',project.id,old);
 check(await w.readMemory(actor,old.id)===null,'split retires original only after saving entries');
 const copied=await transaction(db,async c=>(await c.query('SELECT m.locked,(SELECT count(*)::int FROM workpivot.memory_sources s WHERE s.memory_id=m.id) AS sources FROM workpivot.memories m WHERE id=ANY($1::uuid[])',[parts.map(p=>p.id)])).rows,actor);
 check(copied.length===2&&copied.every(r=>r.locked&&r.sources===1),'split retains lock and source provenance for every entry');
 await assert.rejects(w.saveMemoryEntries(actor,['repeat'],'project',project.id,old));check(true,'duplicate split does not add entries twice');
 await w.deleteTask(actor,task.id,(await w.listTasks(actor)).find(t=>t.id===task.id)!.revision);
 check((await Promise.all(parts.map(p=>w.readMemory(actor,p.id)))).every(v=>v===null),'source deletion invalidates split derivatives');
 const preview=splitMemoryEntries('# 交付约束\n- 使用中文\n- 核对口径\n  保留统计时间\n');
 check(preview.length===2&&preview[1]!.includes('保留统计时间')&&preview[0]!.includes('交付约束'),'entry preview preserves category and nested detail');
 const stale=await w.createMemory(actor,'旧版本','user');await w.editMemory(actor,stale.id,'新版本',1);
 await assert.rejects(w.saveMemoryEntries(actor,['覆盖'],'user',undefined,stale));check(true,'stale split cannot overwrite manual correction');
}
