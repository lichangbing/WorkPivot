import {createHash,randomUUID} from 'node:crypto';
import AdmZip from 'adm-zip';
import type {Pool,PoolClient,QueryResultRow} from 'pg';
import {RepositoryError,transaction} from './connection.js';
import {FileRepository} from './files.js';
import {WorkspaceRepository} from './workspace.js';
import {captureAutomation,recycleExpert} from './personal-recycle.js';
import {invalidateMemoryContext} from './memory-controls.js';

// 固定白名单不包含身份、模型、MCP、授权令牌或系统配置表。
const tables=['projects','tasks','messages','conversation_turns','conversation_events','documents','document_versions','memories','memory_revisions','memory_sources','experts','expert_experiences','skill_drafts','skill_releases','skill_builds','automations','automation_runs','trash_entries'] as const;
const labels={projects:'项目',tasks:'对话与执行任务',documents:'文件',memories:'记忆',skill_drafts:'私人技能',experts:'私人专家',automations:'自动化任务'};
const kept=['账号和登录会话','模型与MCP配置及凭据','系统和个人偏好设置','用量审计及已有回收站'];
type Snapshot=Record<string,QueryResultRow[]>;
const limit=100*1024*1024;
/** 导出为可读归档；恢复业务数据使用回收站，不将归档宣称为数据库备份。 */
export class PersonalData {
 constructor(private readonly db:Pool,private readonly files?:FileRepository){}
 private async snapshot(c:PoolClient):Promise<Snapshot>{
  const result:Snapshot={};let size=0;
  for(const table of tables){
   const where=table==='experts'?"AND NOT public":table==='expert_experiences'?"AND expert_id IN (SELECT id FROM workpivot.experts WHERE NOT public AND owner_user_id=workpivot.actor_id())":['skill_drafts','skill_releases'].includes(table)?"AND visibility='private'":'';
   const rows=(await c.query(`SELECT * FROM workpivot.${table} WHERE owner_user_id=workpivot.actor_id() ${where} ORDER BY to_jsonb(${table})::text LIMIT 10001`)).rows;
   size+=Buffer.byteLength(JSON.stringify(rows));
   if(rows.length>10000||size>limit)throw new RepositoryError(413,'数据超过单次个人归档上限，请使用管理员备份流程');
   result[table]=rows;
  }
  return result;
 }
 private async previewIn(c:PoolClient){
  const snapshot=await this.snapshot(c);
  const counts=Object.entries(labels).map(([table,label])=>({kind:table,label,count:snapshot[table]!.filter(r=>!r.deleted_at&&r.state!=='deleted').length}));
  const active=(await c.query(`SELECT (SELECT count(*) FROM workpivot.tasks WHERE deleted_at IS NULL AND status IN ('queued','running','waiting'))+(SELECT count(*) FROM workpivot.task_runs WHERE status IN ('running','stopping'))+(SELECT count(*) FROM workpivot.automation_runs WHERE status IN ('queued','running'))+(SELECT count(*) FROM workpivot.skill_trials WHERE status='running') AS count`)).rows[0].count;
  return {fingerprint:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),counts,active:Number(active),kept,retentionDays:30};
 }
 async preview(actor:string){return transaction(this.db,c=>this.previewIn(c),actor,true);}
 async clear(actor:string,fingerprint:string,confirmation:string){
  if(confirmation!=='清空个人数据')throw new RepositoryError(400,'请输入“清空个人数据”确认');
  return transaction(this.db,async c=>{
   const preview=await this.previewIn(c);
   if(preview.fingerprint!==fingerprint)throw new RepositoryError(409,'数据已变化，请重新预览后确认');
   if(preview.active)throw new RepositoryError(409,'请先停止或等待运行、排队任务及技能试运行结束');
   // 先保存专家经验和计划，避免来源删除触发器改写快照。
   for(const r of (await c.query('SELECT id FROM workpivot.experts WHERE NOT public AND owner_user_id=$1 ORDER BY id',[actor])).rows)await recycleExpert(c,r.id);
   for(const r of (await c.query("SELECT id FROM workpivot.automations WHERE state<>'deleted' ORDER BY id")).rows)await captureAutomation(c,r.id);
   await c.query("UPDATE workpivot.automations SET state='deleted',grant_id=NULL,next_at=NULL,revision=revision+1,updated_at=now() WHERE state<>'deleted'");
   await c.query('UPDATE workpivot.automation_runs SET revoked=true');
   await c.query(`INSERT INTO workpivot.trash_entries(owner_user_id,kind,entity_id,name,payload) SELECT owner_user_id,'skill',skill_id,display_name,jsonb_build_object('name',name) FROM workpivot.skill_drafts WHERE visibility='private' AND owner_user_id=$1 AND deleted_at IS NULL ON CONFLICT DO NOTHING`,[actor]);
   await c.query("UPDATE workpivot.skill_catalog SET disabled=true WHERE visibility='private' AND owner_user_id=$1",[actor]);
   await c.query("UPDATE workpivot.skill_builds SET status='stale',validation=NULL,trial=NULL,dismissed=true");
   await c.query("UPDATE workpivot.skill_drafts SET disabled=true,deleted_at=now(),revision=$2 WHERE visibility='private' AND owner_user_id=$1 AND deleted_at IS NULL",[actor,randomUUID()]);
   await new WorkspaceRepository(this.db).recyclePersonal(c,actor);
   await invalidateMemoryContext(c,actor);
   return {ok:true,counts:preview.counts,notice:'已移入回收站；保留30天，到期后仍需手动确认永久删除。恢复后不会自动启动执行。'};
  },actor,true);
 }
 async export(actor:string){return transaction(this.db,async c=>{
  const snapshot=await this.snapshot(c),archive=new AdmZip();
  // 历史授权只具有运行记录意义，归档也不暴露授权标识。
  for(const table of ['automations','automation_runs'])for(const r of snapshot[table]!)delete r.grant_id;
  const metadata=Buffer.from(JSON.stringify({format:'workpivot-personal-archive',version:1,createdAt:new Date().toISOString(),purpose:'可读归档，不支持直接导入；恢复请使用回收站或管理员备份',excluded:kept.slice(0,3),data:snapshot},null,2));
  let bytes=metadata.length;
  if(bytes>limit)throw new RepositoryError(413,'归档超过100MB上限');
  archive.addFile('data.json',metadata);
  const versions=new Map<string,{id:string;size:number}>();
  for(const v of [...snapshot.document_versions!,...snapshot.trash_entries!.flatMap(r=>r.files??[])])versions.set(v.id,{id:v.id,size:Number(v.size)});
  if(versions.size&&!this.files)throw new RepositoryError(503,'文件存储未配置，不能生成完整归档');
  for(const v of versions.values()){
   bytes+=v.size;if(bytes>limit)throw new RepositoryError(413,'含原件的归档超过100MB上限，请使用管理员备份流程');
   archive.addFile('files/'+v.id,await this.files!.exportVersion(c,actor,v.id));
  }
  return archive.toBuffer();
 },actor,true);}
}
