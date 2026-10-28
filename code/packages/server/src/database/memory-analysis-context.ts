import type {PoolClient} from 'pg';
import {RepositoryError,uuid} from './connection.js';
import type {MemorySource} from './memory-context.js';

/** 周期分析允许跨任务，但十轮证据必须完整、属于同一用户及批次范围。 */
export async function analysisSources(c:PoolClient,id:string){
 uuid(id);
 const batch=(await c.query('SELECT * FROM workpivot.memory_analysis_batches WHERE id=$1',[id])).rows[0];
 if(!batch||batch.legacy_personal||batch.status==='stale')throw new RepositoryError(409,'分析记录已失效');
 const rows=(await c.query(`SELECT r.id AS "runId",r.task_id AS "taskId",t.name AS "taskName",e.content AS evidence
 FROM workpivot.memory_analysis_turns a JOIN workpivot.task_runs r ON r.id=a.run_id
 JOIN workpivot.tasks t ON t.id=r.task_id JOIN workpivot.conversation_events e ON e.turn_id=r.turn_id AND e.kind='user'
 WHERE a.batch_id=$1 AND r.status='completed' AND NOT r.context_revoked AND t.deleted_at IS NULL
 AND t.project_id IS NOT DISTINCT FROM $3::uuid ORDER BY a.counted_at,r.id`,[id,batch.scope,batch.scope==='user'&&batch.scope_id===batch.owner_user_id?null:batch.scope_id])).rows as (MemorySource&{taskId:string;taskName:string})[];
 if(rows.length!==10||new Set(rows.map(r=>r.runId)).size!==10)throw new RepositoryError(409,'分析来源已删除、撤销或改变归属');
 if(rows.reduce((n,r)=>n+r.evidence.length,0)>80000)throw new RepositoryError(409,'十轮原文超过80000字，未截断分析，请缩短后续输入');
 return {batch,rows};
}
export async function validateAnalysisContext(c:PoolClient,id:string,taskId:string,scope:string,source:MemorySource,context:MemorySource[]){
 const {batch,rows}=await analysisSources(c,id);
 // 确认事务持有来源任务锁，删除项目/任务不能与记忆发布交错。
 await c.query('SELECT id FROM workpivot.tasks WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[rows.map(r=>r.taskId)]);
 await analysisSources(c,id);
 if(batch.scope!==scope||context.length!==9||new Set([source,...context].map(r=>r.runId)).size!==10)throw new RepositoryError(409,'分析证据范围不匹配');
 if(rows.find(r=>r.runId===source.runId)?.taskId!==taskId)throw new RepositoryError(409,'建议来源任务不匹配');
 for(const entry of [source,...context]){
  if(typeof entry.evidence!=='string'||!entry.evidence.trim()||!rows.some(r=>r.runId===entry.runId&&r.evidence.includes(entry.evidence)))throw new RepositoryError(409,'分析证据已失效');
 }
}
