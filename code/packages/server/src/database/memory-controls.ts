import type { Pool,PoolClient } from 'pg';
import { RepositoryError,transaction,uuid } from './connection.js';
export async function memoryEnabled(c:PoolClient,scope:string,kind:'load'|'update') {
 const row=(await c.query('SELECT load_enabled,update_enabled FROM workpivot.memory_controls WHERE scope=$1',[scope])).rows[0];
 return !row || row[kind+'_enabled']===true;
}
export async function invalidateMemoryContext(c:PoolClient,actor:string) {
 await c.query("UPDATE workpivot.task_runs SET context_revoked=true,model_messages='[]' WHERE owner_user_id=$1",[actor]);
 await c.query("UPDATE workpivot.memory_jobs SET status='stale',error=NULL WHERE status IN ('pending','running')");
 await c.query("UPDATE workpivot.memory_suggestions SET status='stale',content='',evidence=NULL WHERE status='pending'");
 await c.query('INSERT INTO workpivot.knowledge_state(owner_user_id,epoch) VALUES($1,1) ON CONFLICT(owner_user_id) DO UPDATE SET epoch=workpivot.knowledge_state.epoch+1',[actor]);
}
export class MemoryControls {
 constructor(private readonly db:Pool){}
 async list(actor:string){return transaction(this.db,async c=>{const rows=(await c.query('SELECT scope,load_enabled AS load,update_enabled AS update,revision FROM workpivot.memory_controls')).rows;return ['user','project','task'].map(scope=>rows.find(r=>r.scope===scope)??{scope,load:true,update:true,revision:0});},actor);}
 async save(actor:string,scope:string,load:boolean,update:boolean,revision:number){
  if(!['user','project','task'].includes(scope)||typeof load!=='boolean'||typeof update!=='boolean'||!Number.isSafeInteger(revision)||revision<0)throw new RepositoryError(400,'记忆开关参数无效');
  return transaction(this.db,async c=>{
   const result=revision===0?await c.query('INSERT INTO workpivot.memory_controls(owner_user_id,scope,load_enabled,update_enabled) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING revision',[actor,scope,load,update]):await c.query('UPDATE workpivot.memory_controls SET load_enabled=$2,update_enabled=$3,revision=revision+1 WHERE scope=$1 AND revision=$4 RETURNING revision',[scope,load,update,revision]);
   if(!result.rowCount)throw new RepositoryError(409,'记忆设置已更新，请刷新');
   await invalidateMemoryContext(c,actor);return result.rows[0];
  },actor);
 }
 async lock(actor:string,id:string,locked:boolean,revision:number){
  uuid(id);if(typeof locked!=='boolean'||!Number.isSafeInteger(revision)||revision<1)throw new RepositoryError(400,'锁定参数无效');
  return transaction(this.db,async c=>{
   const row=(await c.query('SELECT revision FROM workpivot.memories WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0];
   if(!row)throw new RepositoryError(404,'记忆不存在');if(row.revision!==revision)throw new RepositoryError(409,'记忆已更新');
   await c.query('INSERT INTO workpivot.memory_revisions(owner_user_id,memory_id,revision,content) SELECT owner_user_id,memory_id,$2,content FROM workpivot.memory_revisions WHERE memory_id=$1 AND revision=$3',[id,revision+1,revision]);
   await c.query('UPDATE workpivot.memories SET locked=$2,revision=revision+1 WHERE id=$1',[id,locked]);
   await invalidateMemoryContext(c,actor);return {revision:revision+1};
  },actor);
 }
}
