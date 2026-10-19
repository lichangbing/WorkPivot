import type {Pool} from 'pg';
import {transaction,uuid,assertRestrictedRole} from './connection.js';
import {WorkspaceRepository} from './workspace.js';
import {Experts} from './experts.js';
import {FileRepository} from './files.js';
import {invalidateMemoryContext} from './memory-controls.js';

type Entry={id:string;revision:number};
export interface RetentionState {actor:string;trash?:{id:string;revision:string}[];projects:Entry[];tasks:Entry[];documents:Entry[];memories:Entry[];experts:Entry[];experiences:Entry[];automations?:Entry[];skills?:{id:string;revision:string}[]}
/** 不含正文的清单；停止写入后导出，并确保比待恢复备份更新。 */
export async function exportRetention(db:Pool,actor:string):Promise<RetentionState>{
 uuid(actor);await assertRestrictedRole(db,'workpivot');return transaction(db,async c=>{
  const rows=async(table:string,filter:string)=>(await c.query(`SELECT id,revision FROM workpivot.${table} WHERE ${filter}`)).rows as Entry[];
  return {actor,trash:(await c.query('SELECT id,revision FROM workpivot.trash_entries')).rows,automations:await rows('automations',"state<>'deleted'"),projects:await rows('projects','deleted_at IS NULL'),tasks:await rows('tasks','deleted_at IS NULL'),documents:await rows('documents','true'),memories:await rows('memories','deleted_at IS NULL'),experts:await rows('experts','NOT public'),experiences:await rows('expert_experiences',"state='active'"),skills:(await c.query("SELECT skill_id AS id,revision FROM workpivot.skill_drafts WHERE visibility='private' AND deleted_at IS NULL")).rows};
 },actor);
}
/** 仅用于离线恢复，不由 HTTP 服务调用；撤销全部旧模型上下文。 */
export async function applyRetention(db:Pool,filesRoot:string,state:RetentionState){
 uuid(state.actor);await assertRestrictedRole(db,'workpivot');const actor=state.actor;
 for(const key of ['projects','tasks','documents','memories','experts','experiences'] as const){if(!Array.isArray(state[key]))throw Error('Incomplete retention inventory');for(const r of state[key]){uuid(r.id);if(!Number.isSafeInteger(r.revision)||r.revision<1)throw Error('Invalid retention revision');}}
 if(state.automations)for(const a of state.automations){uuid(a.id);if(!Number.isSafeInteger(a.revision)||a.revision<1)throw Error('Invalid automation revision');}
 if(state.trash)for(const t of state.trash){uuid(t.id);uuid(t.revision);}
 if(state.skills)for(const s of state.skills){uuid(s.id);uuid(s.revision);}
 const workspace=new WorkspaceRepository(db,false),experts=new Experts(db),files=new FileRepository(db,filesRoot,false);
 const retained=(rows:Entry[],id:string)=>rows.some(r=>r.id===id);
 await transaction(db,async c=>{
  await c.query("UPDATE workpivot.tasks SET status='idle' WHERE status IN ('running','waiting','queued')");
  await c.query("UPDATE workpivot.task_runs SET status='interrupted',stop_reason='offline_restore',lease_until=now(),finished_at=now() WHERE status IN ('running','stopping')");
  await invalidateMemoryContext(c,actor);
  await c.query("UPDATE workpivot.automation_runs SET status='interrupted',revoked=true,error='恢复备份后需重新确认',lease_until=NULL WHERE status IN ('queued','waiting_login','running')");
  const retainedTrash=(await c.query('SELECT id,revision,kind,entity_id FROM workpivot.trash_entries')).rows.filter(t=>state.trash?.some(r=>r.id===t.id&&r.revision===t.revision));
  for(const a of (await c.query('SELECT id,revision,state FROM workpivot.automations')).rows){if(!state.automations?.some(r=>r.id===a.id&&r.revision===a.revision)&&!(a.state==='deleted'&&retainedTrash.some(t=>t.kind==='automation'&&t.entity_id===a.id)))await c.query('DELETE FROM workpivot.automations WHERE id=$1',[a.id]);}
  await c.query('UPDATE workpivot.browser_profiles SET state_cipher=NULL,revoked_at=now(),lease_id=NULL,lease_kind=NULL,lease_until=NULL,revision=revision+1');
  await c.query('UPDATE workpivot.network_targets SET revoked_at=now() WHERE revoked_at IS NULL');
  await c.query("UPDATE workpivot.automations SET state='paused',grant_id=NULL,next_at=NULL,draft=NULL,revision=revision+1,issue='恢复备份后需要重新确认启用' WHERE state<>'deleted'");
  await c.query("UPDATE workpivot.memory_suggestions SET status='stale',content='',evidence=NULL");
  await c.query('DELETE FROM workpivot.context_checkpoints');
  await c.query("UPDATE workpivot.skill_trials SET status='interrupted',report=NULL WHERE status='running'");
  await c.query("UPDATE workpivot.skill_builds SET status='stale',validation=NULL,trial=NULL,dismissed=true");
  await c.query("UPDATE workpivot.skill_drafts SET disabled=true WHERE visibility='private'");
  await c.query("UPDATE workpivot.skill_catalog SET disabled=true WHERE visibility='private'");
  for(const s of (await c.query("SELECT name,skill_id,revision,deleted_at FROM workpivot.skill_drafts WHERE visibility='private'")).rows){
   if(!state.skills?.some(k=>k.id===s.skill_id&&k.revision===s.revision)&&!(s.deleted_at&&retainedTrash.some(t=>t.kind==='skill'&&t.entity_id===s.skill_id))){
    // 恢复旧备份不能重新暴露后续已删除或修订的脚本、样本及历史版本。
    await c.query('DELETE FROM workpivot.skill_builds WHERE name=$1',[s.name]);
    await c.query('DELETE FROM workpivot.skill_drafts WHERE name=$1',[s.name]);
   }
  }
 },actor);
 for(const p of await workspace.listProjects(actor))if(!retained(state.projects,p.id))await workspace.deleteProject(actor,p.id,p.revision);
 for(const t of await workspace.listTasks(actor,true))if(!retained(state.tasks,t.id))await workspace.deleteTask(actor,t.id,t.revision);
 const documents=await transaction(db,async c=>(await c.query('SELECT id,task_id,revision FROM workpivot.documents')).rows,actor);
 for(const d of documents)if(!retained(state.documents,d.id))await files.remove(actor,d.task_id,d.id,d.revision);
 for(const e of await experts.list(actor))if(!retained(state.experts,e.id))await experts.remove(actor,e.id,e.revision);
 await transaction(db,async c=>{
  for(const m of (await c.query('SELECT id,revision FROM workpivot.memories WHERE deleted_at IS NULL')).rows){
   if(state.memories.some(r=>r.id===m.id&&r.revision===m.revision))continue;
   await c.query('INSERT INTO workpivot.forget_rules(memory_id,owner_user_id,deleted_revision) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[m.id,actor,m.revision]);
   await c.query('DELETE FROM workpivot.memory_revisions WHERE memory_id=$1 OR memory_id IN (SELECT id FROM workpivot.memories WHERE merged_into=$1)',[m.id]);
   await c.query('UPDATE workpivot.memories SET deleted_at=now(),revision=revision+1 WHERE id=$1',[m.id]);
  }
  for(const e of (await c.query("SELECT id,revision FROM workpivot.expert_experiences WHERE state='active'")).rows)if(!state.experiences.some(r=>r.id===e.id&&r.revision===e.revision))await c.query("UPDATE workpivot.expert_experiences SET state='stale',content='',conditions='',history='[]',revision=revision+1 WHERE id=$1",[e.id]);
  for(const e of (await c.query('SELECT id,revision FROM workpivot.experts WHERE NOT public')).rows)if(!state.experts.some(r=>r.id===e.id&&r.revision===e.revision))await c.query("UPDATE workpivot.experts SET settings=$2,versions='[]',disabled=true,revision=revision+1 WHERE id=$1",[e.id,{role:'',startup:'',skills:[]}]);
 },actor);
 await transaction(db,async c=>{for(const t of (await c.query('SELECT id,revision FROM workpivot.trash_entries')).rows)if(!state.trash?.some(r=>r.id===t.id&&r.revision===t.revision))await c.query('DELETE FROM workpivot.trash_entries WHERE id=$1',[t.id]);},actor);
 await files.collect(actor);
}
