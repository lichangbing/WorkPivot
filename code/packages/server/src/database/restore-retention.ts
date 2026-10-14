import type {Pool} from 'pg';
import {transaction,uuid,assertRestrictedRole} from './connection.js';
import {WorkspaceRepository} from './workspace.js';
import {Experts} from './experts.js';
import {FileRepository} from './files.js';
import {invalidateMemoryContext} from './memory-controls.js';

type Entry={id:string;revision:number};
export interface RetentionState {actor:string;projects:Entry[];tasks:Entry[];documents:Entry[];memories:Entry[];experts:Entry[];experiences:Entry[]}
/** Content-free inventory. Export after quiescing writes, and keep it newer than the backup being restored. */
export async function exportRetention(db:Pool,actor:string):Promise<RetentionState>{
 uuid(actor);await assertRestrictedRole(db,'workpivot');return transaction(db,async c=>{
  const rows=async(table:string,filter:string)=>(await c.query(`SELECT id,revision FROM workpivot.${table} WHERE ${filter}`)).rows as Entry[];
  return {actor,projects:await rows('projects','deleted_at IS NULL'),tasks:await rows('tasks','deleted_at IS NULL'),documents:await rows('documents','true'),memories:await rows('memories','deleted_at IS NULL'),experts:await rows('experts','NOT public'),experiences:await rows('expert_experiences',"state='active'")};
 },actor);
}
/** OFFLINE restoration only. Never used by the HTTP service; all old model contexts are revoked. */
export async function applyRetention(db:Pool,filesRoot:string,state:RetentionState){
 uuid(state.actor);await assertRestrictedRole(db,'workpivot');const actor=state.actor;
 for(const key of ['projects','tasks','documents','memories','experts','experiences'] as const){if(!Array.isArray(state[key]))throw Error('Incomplete retention inventory');for(const r of state[key]){uuid(r.id);if(!Number.isSafeInteger(r.revision)||r.revision<1)throw Error('Invalid retention revision');}}
 const workspace=new WorkspaceRepository(db),experts=new Experts(db),files=new FileRepository(db,filesRoot);
 const retained=(rows:Entry[],id:string)=>rows.some(r=>r.id===id);
 await transaction(db,async c=>{
  await c.query("UPDATE workpivot.tasks SET status='idle' WHERE status IN ('running','waiting','queued')");
  await c.query("UPDATE workpivot.task_runs SET status='interrupted',stop_reason='offline_restore',lease_until=now(),finished_at=now() WHERE status IN ('running','stopping')");
  await invalidateMemoryContext(c,actor);
  await c.query("UPDATE workpivot.memory_suggestions SET status='stale',content='',evidence=NULL");
  await c.query('DELETE FROM workpivot.context_checkpoints');
 },actor);
 for(const p of await workspace.listProjects(actor))if(!retained(state.projects,p.id))await workspace.deleteProject(actor,p.id,p.revision);
 for(const t of await workspace.listTasks(actor))if(!retained(state.tasks,t.id))await workspace.deleteTask(actor,t.id,t.revision);
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
 await files.collect(actor);
}
