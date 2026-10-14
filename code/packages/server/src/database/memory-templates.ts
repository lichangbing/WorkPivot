import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {RepositoryError,transaction,uuid} from './connection.js';
export class MemoryTemplates {
 constructor(private readonly db:Pool){}
 async list(actor:string,manage=false){return transaction(this.db,async c=>(await c.query(manage?'SELECT id,name,content,scope,enabled,revision FROM workpivot.memory_templates WHERE owner_user_id=$1 ORDER BY name':'SELECT id,name,content,scope,revision FROM workpivot.memory_templates WHERE enabled ORDER BY name',manage?[actor]:[])).rows,actor);}
 async save(actor:string,input:{name:string;content:string;scope:string;enabled:boolean},id?:string,revision?:number){
  if(!input||typeof input.name!=='string'||!input.name.trim()||input.name.length>100||typeof input.content!=='string'||!input.content.trim()||input.content.length>20000||!['user','project','task'].includes(input.scope)||typeof input.enabled!=='boolean')throw new RepositoryError(400,'角色模板参数无效');
  if(id){uuid(id);if(!Number.isSafeInteger(revision)||revision!<1)throw new RepositoryError(400,'模板版本无效');}
  return transaction(this.db,async c=>{
   const result=id?await c.query('UPDATE workpivot.memory_templates SET name=$2,content=$3,scope=$4,enabled=$5,revision=revision+1 WHERE id=$1 AND owner_user_id=$6 AND revision=$7 RETURNING id',[id,input.name.trim(),input.content.trim(),input.scope,input.enabled,actor,revision]):await c.query('INSERT INTO workpivot.memory_templates(id,owner_user_id,name,content,scope,enabled) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[randomUUID(),actor,input.name.trim(),input.content.trim(),input.scope,input.enabled]);
   if(!result.rowCount)throw new RepositoryError(409,'模板已变更或无管理权限');return result.rows[0];
  },actor);
 }
 async remove(actor:string,id:string,revision:number){uuid(id);if(!Number.isSafeInteger(revision)||revision<1)throw new RepositoryError(400,'模板版本无效');return transaction(this.db,async c=>{if(!(await c.query('DELETE FROM workpivot.memory_templates WHERE id=$1 AND owner_user_id=$2 AND revision=$3',[id,actor,revision])).rowCount)throw new RepositoryError(409,'模板已变更或无管理权限');},actor);}
}
