import type {PoolClient} from 'pg';
/** 与原删除同事务保存快照，失败则整个删除回滚；原在线清理逻辑继续执行。 */
export async function captureTrash(c:PoolClient,kind:'project'|'task'|'document'|'memory',id:string){
 if((await c.query("SELECT current_setting('workpivot.skip_trash',true) AS skip")).rows[0].skip==='1')return;
 const table={project:'projects',task:'tasks',document:'documents',memory:'memories'}[kind];
 const row=(await c.query(`SELECT * FROM workpivot.${table} WHERE id=$1 FOR UPDATE`,[id])).rows[0];if(!row||row.deleted_at)return;
 const payload:Record<string,unknown>={row};let name=row.name??'',parent=row.task_id??row.project_id??null,files:unknown[]=[];
 if(kind==='document'){
  files=(await c.query('SELECT * FROM workpivot.document_versions WHERE document_id=$1 ORDER BY revision',[id])).rows;
  name=(files.at(-1) as {name?:string})?.name??'文件';
 }else if(kind==='memory'){
  payload.revisions=(await c.query('SELECT * FROM workpivot.memory_revisions WHERE memory_id=$1 ORDER BY revision',[id])).rows;
  name=((payload.revisions as {content:string}[]).at(-1)?.content??'记忆').slice(0,100);
 }else if(kind==='task'){
  for(const child of ['messages','conversation_turns','conversation_events'])payload[child]=(await c.query(`SELECT * FROM workpivot.${child} WHERE task_id=$1`,[id])).rows;
  for(const d of (await c.query('SELECT id FROM workpivot.documents WHERE task_id=$1 ORDER BY id',[id])).rows)await captureTrash(c,'document',d.id);
 }else parent=null;
 await c.query(`INSERT INTO workpivot.trash_entries(owner_user_id,kind,entity_id,name,parent_id,payload,files) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner_user_id,kind,entity_id) DO NOTHING`,[row.owner_user_id,kind,id,name,parent,JSON.stringify(payload),JSON.stringify(files)]);
}
/** 删除依赖立即撤销后台执行，恢复资料不恢复旧授权。 */
export async function revokeTrashAutomations(c:PoolClient,kind:'document'|'project'|'task'|'skill',id:string){
 const clause=kind==='document'?`(config->'input'->'versionIds' ?| ARRAY(SELECT id::text FROM workpivot.document_versions WHERE document_id=$1::uuid) OR config->'input'->>'mode'='latest' AND config->>'projectId'=(SELECT t.project_id::text FROM workpivot.documents d JOIN workpivot.tasks t ON t.id=d.task_id WHERE d.id=$1::uuid))`:kind==='project'?`config->>'projectId'=$1`:kind==='skill'?`config->>'skill'=$1`:`(config->'input'->'versionIds' ?| ARRAY(SELECT v.id::text FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE d.task_id=$1::uuid) OR config->'input'->>'mode'='latest' AND config->>'projectId'=(SELECT project_id::text FROM workpivot.tasks WHERE id=$1::uuid))`;
 // 运行快照可能仍引用修改前的输入，独立检查全部快照，防止删除后快速恢复绕过撤权。
 const runClause=kind==='document'?`(config->'input'->'versionIds' ?| ARRAY(SELECT id::text FROM workpivot.document_versions WHERE document_id=$1::uuid) OR EXISTS(SELECT 1 FROM jsonb_array_elements(inputs) i JOIN workpivot.document_versions v ON v.id::text=i->>'id' WHERE v.document_id=$1::uuid))`:kind==='skill'?`config->>'skill'=$1`:kind==='project'?`config->>'projectId'=$1`:`EXISTS(SELECT 1 FROM jsonb_array_elements(inputs) i WHERE i->>'taskId'=$1)`;
 const rows=(await c.query(`SELECT id,revision FROM workpivot.automations WHERE state<>'deleted' AND (${clause}) ORDER BY id FOR UPDATE`,[id])).rows;
 await c.query(`UPDATE workpivot.automation_runs SET revoked=true,events='[]',summary='',error='关联资料或技能已删除',status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE ${runClause}`,[id]);
 for(const p of rows){
  await c.query("UPDATE workpivot.automations SET state='blocked',grant_id=NULL,next_at=NULL,revision=revision+1,issue='关联资料或技能已删除；恢复后请重新确认' WHERE id=$1",[p.id]);
  await c.query("UPDATE workpivot.automation_runs SET revoked=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,error='关联资料或技能已删除' WHERE plan_id=$1 AND status IN ('queued','running')",[p.id]);
  await c.query("INSERT INTO workpivot.automation_notices(owner_user_id,plan_id,notice_key,message) VALUES(workpivot.actor_id(),$1,$2,'关联资料或技能已删除，计划需要重新确认') ON CONFLICT DO NOTHING",[p.id,'trash:'+p.id+':'+p.revision]);
 }
}
