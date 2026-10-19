import {auditCaptureLifecycle} from './captures.js';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {RepositoryError,transaction,uuid} from './connection.js';
import {invalidateMemoryContext} from './memory-controls.js';
import {FileRepository} from './files.js';
const columns=`id,kind,entity_id AS "entityId",name,revision,parent_id AS "parentId",deleted_at AS "deletedAt",deleted_at+interval '30 days' AS "purgeAfter",deleted_at+interval '30 days'<=now() AS "canPurge",jsonb_array_length(files) AS "fileCount"`;
/** 回收站只提供用户界面接口，不注册为模型工具。 */
export class TrashRepository {
 constructor(private readonly db:Pool,private readonly files?:FileRepository){}
 async list(actor:string){return transaction(this.db,async c=>({retentionDays:30,automaticPurge:false,entries:(await c.query(`SELECT ${columns} FROM workpivot.trash_entries ORDER BY deleted_at DESC,id LIMIT 1000`)).rows}),actor);}
 private async entry(c:PoolClient,id:string,revision:string){uuid(id);uuid(revision);const e=(await c.query('SELECT *,deleted_at+interval \'30 days\'<=now() AS eligible FROM workpivot.trash_entries WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!e)throw new RepositoryError(404,'回收站条目不存在');if(e.revision!==revision)throw new RepositoryError(409,'条目已改变，请刷新');return e;}
 private async insert(c:PoolClient,table:string,rows:unknown[]){
  // 表名只来自下面固定的恢复分支，客户端不能指定表名或快照内容。
  if(rows.length)await c.query(`INSERT INTO workpivot.${table} SELECT * FROM jsonb_populate_recordset(NULL::workpivot.${table},$1::jsonb)`,[JSON.stringify(rows)]);
 }
 async restore(actor:string,id:string,revision:string){return transaction(this.db,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['files:'+actor]);
  const e=await this.entry(c,id,revision),p=e.payload,r=p.row;
  if(e.parent_id){
   const parent=(await c.query('SELECT id FROM workpivot.projects WHERE id=$1 AND deleted_at IS NULL UNION ALL SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL',[e.parent_id])).rows[0];
   if(!parent)throw new RepositoryError(409,'请先恢复所属项目或任务，再恢复此条目');
  }
  if(e.kind==='project'){
   const changed=await c.query('UPDATE workpivot.projects SET name=$2,deleted_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1 AND deleted_at IS NOT NULL RETURNING id',[e.entity_id,r.name]);if(!changed.rowCount)throw new RepositoryError(409,'项目状态已变化');
   await c.query("INSERT INTO workpivot.project_members(project_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING",[e.entity_id,actor]);
  }else if(e.kind==='task'){
   const changed=await c.query("UPDATE workpivot.tasks SET name=$2,deleted_at=NULL,status='idle',revision=revision+1 WHERE id=$1 AND deleted_at IS NOT NULL RETURNING id",[e.entity_id,r.name]);if(!changed.rowCount)throw new RepositoryError(409,'任务状态已变化');
   for(const t of ['messages','conversation_turns','conversation_events'])await this.insert(c,t,p[t]??[]);
  }else if(e.kind==='document'){
   if(!this.files)throw new RepositoryError(503,'文件存储未配置');
   await this.files.verifyRetained(actor,e.files);
   await this.insert(c,'documents',[r]);await this.insert(c,'document_versions',e.files);
   for(const v of e.files)if(r.purpose==='upload'&&/\.(docx|xlsx|pptx|pdf|png|jpg|jpeg)$/i.test(v.name))await c.query('INSERT INTO workpivot.document_processing(version_id,owner_user_id) VALUES($1,$2)',[v.id,actor]);
  }else if(e.kind==='memory'){
   const content=(p.revisions as {content:string}[]).at(-1)?.content;if(content===undefined)throw new RepositoryError(409,'此历史条目没有可恢复正文');
   const changed=(await c.query('UPDATE workpivot.memories SET deleted_at=NULL,merged_into=NULL,revision=revision+1 WHERE id=$1 AND deleted_at IS NOT NULL RETURNING revision',[e.entity_id])).rows[0];if(!changed)throw new RepositoryError(409,'记忆状态已变化');
   // 创建新修订，旧遗忘记录保留，旧来源和摘要不会重新获得有效性。
   await this.insert(c,'memory_revisions',p.revisions);
   await c.query('INSERT INTO workpivot.memory_revisions(owner_user_id,memory_id,revision,content) VALUES($1,$2,$3,$4)',[actor,e.entity_id,changed.revision,content]);
  }else if(e.kind==='expert'){
   await this.insert(c,'experts',[{...r,disabled:true,load_enabled:false,update_enabled:false,revision:r.revision+1}]);
   for(const original of p.experiences??[]){
    const missing=(await c.query(`SELECT EXISTS(SELECT 1 FROM unnest($1::uuid[]) i WHERE NOT EXISTS(SELECT 1 FROM workpivot.task_runs WHERE id=i AND NOT context_revoked)) OR EXISTS(SELECT 1 FROM unnest($2::uuid[]) i WHERE NOT EXISTS(SELECT 1 FROM workpivot.document_versions WHERE id=i)) AS missing`,[original.source_runs,original.source_files])).rows[0].missing;
    await this.insert(c,'expert_experiences',[{...original,...(missing?{state:'stale',content:'',conditions:'',history:[]}:{}),revision:original.revision+1}]);
   }
  }else if(e.kind==='automation'){
   const changed=await c.query("UPDATE workpivot.automations SET config=$2,draft=$3,state=$4,next_at=NULL,grant_id=NULL,issue='从回收站恢复，请重新确认',revision=revision+1,updated_at=now() WHERE id=$1 AND state='deleted'",[e.entity_id,r.config,r.draft,r.config?'paused':'draft']);
   if(!changed.rowCount)throw new RepositoryError(409,'自动化状态已变化');
   await auditCaptureLifecycle(c,e.entity_id,'restore');
  }else if(e.kind==='skill'){
   const changed=await c.query('UPDATE workpivot.skill_drafts SET deleted_at=NULL,disabled=true,revision=$2 WHERE skill_id=$1 AND deleted_at IS NOT NULL',[e.entity_id,randomUUID()]);if(!changed.rowCount)throw new RepositoryError(409,'技能状态已变化');
   await c.query("UPDATE workpivot.skill_builds SET status='stale',validation=NULL,trial=NULL,dismissed=true WHERE name=$1",[p.name]);
  }
  await c.query('DELETE FROM workpivot.trash_entries WHERE id=$1',[id]);await invalidateMemoryContext(c,actor);
  return {ok:true,notice:'已恢复；关联子资料需分别恢复，技能、专家和自动化需重新确认启用'};
 },actor);}
 async purge(actor:string,id:string,revision:string,confirmation:string){
  if(confirmation!=='永久删除')throw new RepositoryError(400,'请输入“永久删除”确认');
  await transaction(this.db,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['files:'+actor]);const e=await this.entry(c,id,revision);
   if(!e.eligible)throw new RepositoryError(409,'尚未满30天保留期，可先恢复；到期后才能永久删除');
   if((await c.query('SELECT id FROM workpivot.trash_entries WHERE parent_id=$1 LIMIT 1',[e.entity_id])).rowCount)throw new RepositoryError(409,'请先恢复或永久删除所属子条目，再处理此项目或任务');
   if(e.kind==='automation'){await auditCaptureLifecycle(c,e.entity_id,'purge');await c.query("DELETE FROM workpivot.automations WHERE id=$1 AND state='deleted'",[e.entity_id]);}
   if(e.kind==='skill'){
    // 先清理发布版本的引用，级联清理只作用于当前用户的私人技能。
    await c.query('DELETE FROM workpivot.skill_builds WHERE name=$1',[e.payload.name]);
    await c.query("DELETE FROM workpivot.skill_drafts WHERE skill_id=$1 AND visibility='private' AND deleted_at IS NOT NULL",[e.entity_id]);
   }
   await c.query('DELETE FROM workpivot.trash_entries WHERE id=$1',[id]);
  },actor);
  let cleanupPending=false;try{await this.files?.collect(actor);}catch{cleanupPending=true;}
  return {ok:true,cleanupPending};
 }
}
