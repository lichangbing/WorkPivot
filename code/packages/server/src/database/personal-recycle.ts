import type {PoolClient} from 'pg';
import {RepositoryError} from './connection.js';
/** 专家快照不保留后台授权；恢复时重新检查经验来源。 */
export async function recycleExpert(c:PoolClient,id:string){
 const row=(await c.query('SELECT * FROM workpivot.experts WHERE id=$1 AND NOT public AND owner_user_id=workpivot.actor_id() FOR UPDATE',[id])).rows[0];
 if(!row)throw new RepositoryError(404,'私人专家不存在');
 const experiences=(await c.query('SELECT * FROM workpivot.expert_experiences WHERE expert_id=$1',[id])).rows;
 await c.query("INSERT INTO workpivot.trash_entries(owner_user_id,kind,entity_id,name,payload) VALUES(workpivot.actor_id(),'expert',$1,$2,$3) ON CONFLICT DO NOTHING",[id,row.name,JSON.stringify({row,experiences})]);
 await c.query('DELETE FROM workpivot.experts WHERE id=$1',[id]);
}
export async function captureAutomation(c:PoolClient,id:string){
 const row=(await c.query("SELECT * FROM workpivot.automations WHERE id=$1 AND state<>'deleted' FOR UPDATE",[id])).rows[0];
 if(!row)throw new RepositoryError(404,'自动化任务不存在');
 await c.query("INSERT INTO workpivot.trash_entries(owner_user_id,kind,entity_id,name,payload) VALUES(workpivot.actor_id(),'automation',$1,$2,$3) ON CONFLICT DO NOTHING",[id,row.config?.name??row.draft?.name??'自动化任务',JSON.stringify({row:{...row,grant_id:null}})]);
}
