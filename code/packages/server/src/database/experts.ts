import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {Tool} from '@workpivot/core';
import { transaction, RepositoryError, uuid } from './connection.js';
import { invalidateMemoryContext } from './memory-controls.js';

export interface ExpertSettings { role:string; startup:string; skills:string[] }
const text=(value:unknown,max:number)=>{if(typeof value!=='string'||value.length>max)throw new RepositoryError(400,'专家内容过长或格式无效');return value.trim();};
export function expertSettings(value:unknown):ExpertSettings {
 const s=value as ExpertSettings;
 if(!s||!Array.isArray(s.skills)||s.skills.length>20||s.skills.some(v=>typeof v!=='string'||! /^[a-z0-9][a-z0-9-]{0,63}$/.test(v)))throw new RepositoryError(400,'技能名称无效');
 return {role:text(s.role,4000),startup:text(s.startup,4000),skills:[...new Set(s.skills)]};
}
async function own(c:PoolClient,id:string){uuid(id);const row=(await c.query('SELECT * FROM workpivot.experts WHERE id=$1 AND owner_user_id=workpivot.actor_id() FOR UPDATE',[id])).rows[0];if(!row)throw new RepositoryError(404,'专家不存在');return row;}
function version(actual:number,expected:number){if(!Number.isSafeInteger(expected)||actual!==expected)throw new RepositoryError(409,'内容已更新，请刷新');}
export class Experts {
 constructor(readonly db:Pool){}
 async jobs(actor:string,expertId:string){uuid(expertId);return transaction(this.db,async c=>{await own(c,expertId);return (await c.query("SELECT j.run_id,j.status,j.attempts,j.error,t.name AS task_name FROM workpivot.expert_jobs j JOIN workpivot.tasks t ON t.id=j.task_id WHERE j.expert_id=$1 AND j.status IN ('pending','running','failed') ORDER BY j.run_id LIMIT 30",[expertId])).rows;},actor);}
 async retry(actor:string,expertId:string,runId:string){uuid(runId);return transaction(this.db,async c=>{const e=await own(c,expertId);if(e.disabled||!e.update_enabled)throw new RepositoryError(409,'请先启用专家自动整理');const row=await c.query("UPDATE workpivot.expert_jobs j SET status='pending',attempts=0,error=NULL,lease_until=NULL FROM workpivot.task_runs r WHERE j.run_id=$1 AND j.expert_id=$2 AND j.status='failed' AND r.id=j.run_id AND NOT r.context_revoked AND j.epoch=COALESCE((SELECT epoch FROM workpivot.knowledge_state WHERE owner_user_id=$3),0) RETURNING j.run_id",[runId,expertId,actor]);if(!row.rowCount)throw new RepositoryError(409,'任务已处理或来源已失效');},actor);}
 async list(actor:string,templates=false){return transaction(this.db,async c=>(await c.query('SELECT * FROM workpivot.experts WHERE public=$1 AND ($1 OR owner_user_id=$2) ORDER BY created_at,id',[templates,actor])).rows,actor);}
 async create(actor:string,name:string,settings:unknown,publicTemplate=false,templateId?:string){
  const clean=text(name,120);if(!clean)throw new RepositoryError(400,'需要专家名称');const config=expertSettings(settings);
  return transaction(this.db,async c=>{
   let template; if(templateId){uuid(templateId);template=(await c.query('SELECT * FROM workpivot.experts WHERE id=$1 AND public AND NOT disabled AND published IS NOT NULL',[templateId])).rows[0];if(!template)throw new RepositoryError(404,'模板不可用');}
   const selected=template?.versions.find((v:{revision:number})=>v.revision===template.published)?.settings??config;
   return (await c.query('INSERT INTO workpivot.experts(id,owner_user_id,name,settings,public,template_id,template_revision) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[randomUUID(),actor,clean,selected,publicTemplate,template?.id??null,template?.published??null])).rows[0];
  },actor);
 }
 async save(actor:string,id:string,revision:number,input:{name:string;settings:unknown;load:boolean;update:boolean;disabled:boolean},admin=false){
  const config=expertSettings(input.settings),name=text(input.name,120);if(!name||[input.load,input.update,input.disabled].some(v=>typeof v!=='boolean'))throw new RepositoryError(400,'专家设置无效');
  return transaction(this.db,async c=>{const row=await own(c,id);version(row.revision,revision);if(row.public&&!admin)throw new RepositoryError(403,'仅后台可修改模板');
   if(!row.public)await invalidateMemoryContext(c,actor);
   return (await c.query('UPDATE workpivot.experts SET name=$2,settings=$3,revision=revision+1,load_enabled=$4,update_enabled=$5,disabled=$6,versions=versions || $7::jsonb WHERE id=$1 RETURNING *',[id,name,config,input.load,input.update,input.disabled,JSON.stringify([{revision:row.revision,settings:row.settings,name:row.name}])])).rows[0];},actor);
 }
 async publish(actor:string,id:string,revision:number){return transaction(this.db,async c=>{const row=await own(c,id);version(row.revision,revision);if(!row.public)throw new RepositoryError(400,'只能发布公共模板');await c.query('UPDATE workpivot.experts SET published=revision,versions=versions || $2::jsonb WHERE id=$1',[id,JSON.stringify([{revision:row.revision,settings:row.settings,name:row.name}])]);},actor);}
 async adopt(actor:string,id:string,revision:number,templateRevision:number){return transaction(this.db,async c=>{const e=await own(c,id);version(e.revision,revision);if(e.public||!e.template_id)throw new RepositoryError(400,'专家没有来源模板');const template=(await c.query('SELECT * FROM workpivot.experts WHERE id=$1 AND public AND NOT disabled',[e.template_id])).rows[0];if(!template||template.published!==templateRevision)throw new RepositoryError(409,'模板版本已变化');const settings=template.versions.find((v:{revision:number})=>v.revision===templateRevision)?.settings;if(!settings)throw new RepositoryError(404,'发布版本不存在');await invalidateMemoryContext(c,actor);await c.query('UPDATE workpivot.experts SET settings=$2,revision=revision+1,template_revision=$3,versions=versions || $4::jsonb WHERE id=$1',[id,settings,templateRevision,JSON.stringify([{revision:e.revision,settings:e.settings,name:e.name}])]);},actor);}
 async remove(actor:string,id:string,revision:number){return transaction(this.db,async c=>{const row=await own(c,id);version(row.revision,revision);if(row.public)throw new RepositoryError(400,'公共模板请停用');
  const tasks=(await c.query('SELECT status FROM workpivot.tasks WHERE expert_id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows;
  if(tasks.some(t=>['running','waiting','queued'].includes(t.status)))throw new RepositoryError(409,'请先停止关联任务');
  await invalidateMemoryContext(c,actor);await c.query('DELETE FROM workpivot.experts WHERE id=$1',[id]);},actor);}
 async bind(actor:string,target:'tasks'|'projects',id:string,expertId:string|null,revision:number){uuid(id);if(expertId)uuid(expertId);
  return transaction(this.db,async c=>{const row=(await c.query(`SELECT * FROM workpivot.${target} WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,[id])).rows[0];if(!row)throw new RepositoryError(404,'项目或任务不存在');version(row.revision,revision);
   if(['running','waiting','queued'].includes(row.status))throw new RepositoryError(409,'请等待任务完成或先停止');
   if(expertId){const e=await own(c,expertId);if(e.public||e.disabled)throw new RepositoryError(400,'请选择可用的私人专家');}
   if(target==='tasks')await c.query('INSERT INTO workpivot.knowledge_state(owner_user_id,epoch) VALUES($1,1) ON CONFLICT(owner_user_id) DO UPDATE SET epoch=workpivot.knowledge_state.epoch+1',[actor]);
   await c.query(`UPDATE workpivot.${target} SET expert_id=$2,revision=revision+1 WHERE id=$1`,[id,expertId]);},actor);
 }
 async context(actor:string,task:string){return transaction(this.db,async c=>{
  const row=(await c.query('SELECT e.* FROM workpivot.tasks t JOIN workpivot.experts e ON e.id=t.expert_id WHERE t.id=$1 AND t.deleted_at IS NULL AND e.owner_user_id=$2 AND NOT e.public',[task,actor])).rows[0];
  if(!row)return null;if(row.disabled)throw new RepositoryError(409,'当前专家已停用，请切换专家');
  const experiences=row.load_enabled?(await c.query("SELECT id,revision,content,conditions FROM workpivot.expert_experiences WHERE expert_id=$1 AND state='active' ORDER BY created_at DESC LIMIT 10",[row.id])).rows:[];
  return {id:row.id,revision:row.revision,name:row.name,settings:row.settings as ExpertSettings,experiences};},actor);}
 async experiences(actor:string,id:string){return transaction(this.db,async c=>{const e=await own(c,id);if(e.public)throw new RepositoryError(400,'模板没有私人经验');return (await c.query("SELECT * FROM workpivot.expert_experiences WHERE expert_id=$1 AND state='active' ORDER BY created_at DESC",[id])).rows;},actor);}
 async editExperience(actor:string,expertId:string,input:{id?:string;revision?:number;content:string;conditions:string;locked:boolean;remove?:boolean}){
  const content=text(input.content,2000),conditions=text(input.conditions,500);if(!input.remove&&!content)throw new RepositoryError(400,'经验不能为空');if(typeof input.locked!=='boolean')throw new RepositoryError(400,'锁定状态无效');
  return transaction(this.db,async c=>{const e=await own(c,expertId);if(e.public)throw new RepositoryError(400,'模板没有私人经验');
   let old;if(input.id){uuid(input.id);old=(await c.query("SELECT * FROM workpivot.expert_experiences WHERE id=$1 AND expert_id=$2 AND state='active' FOR UPDATE",[input.id,expertId])).rows[0];if(!old)throw new RepositoryError(404,'经验不存在');version(old.revision,input.revision!);}
   await invalidateMemoryContext(c,actor);
   if(old)await c.query("UPDATE workpivot.expert_experiences SET content=$2,conditions=$3,locked=$4,state=$5,history=$6,revision=revision+1 WHERE id=$1",[old.id,input.remove?'':content,input.remove?'':conditions,input.locked,input.remove?'deleted':'active',JSON.stringify(input.remove?[]:[...old.history,{revision:old.revision,content:old.content,conditions:old.conditions}])]);
   else await c.query('INSERT INTO workpivot.expert_experiences(id,owner_user_id,expert_id,content,conditions,locked) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor,expertId,content,conditions,input.locked]);
  },actor);
 }
 async suggestions(actor:string,task?:string){if(task)uuid(task);return transaction(this.db,async c=>(await c.query(`SELECT s.*,e.name AS expert_name,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',x.id,'revision',x.revision,'content',x.content,'conditions',x.conditions)) FROM workpivot.expert_experiences x WHERE x.expert_id=s.expert_id AND x.state='active' AND x.id IN (SELECT (t->>'id')::uuid FROM jsonb_array_elements(s.targets) t)),'[]'::jsonb) AS originals
 FROM workpivot.expert_suggestions s JOIN workpivot.experts e ON e.id=s.expert_id WHERE s.state='pending' AND ($1::uuid IS NULL OR s.task_id=$1) ORDER BY s.created_at`,[task??null])).rows,actor);}
 async decide(actor:string,id:string,revision:number,accept:boolean,content?:string){uuid(id);if(typeof accept!=='boolean')throw new RepositoryError(400,'需要明确决定');if(content!==undefined)content=text(content,2000);
  return transaction(this.db,async c=>{
   const s=(await c.query('SELECT * FROM workpivot.expert_suggestions WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!s)throw new RepositoryError(404,'建议不存在');
   if(s.revision===revision+1&&s.state===(accept?'accepted':'rejected')&&(!accept||content===undefined||content===s.content))return;
   version(s.revision,revision);if(s.state!=='pending')throw new RepositoryError(409,'建议已处理');
   const expert=await own(c,s.expert_id);const epoch=(await c.query('SELECT epoch FROM workpivot.knowledge_state WHERE owner_user_id=$1',[actor])).rows[0]?.epoch??'0';
   const run=(await c.query('SELECT * FROM workpivot.task_runs WHERE id=$1 AND NOT context_revoked',[s.run_id])).rows[0];
   if(!run||String(s.epoch)!==String(epoch)||!expert.update_enabled||expert.disabled)throw new RepositoryError(409,'建议来源或设置已变化');
   if(accept){
    const ids=(s.targets as Array<{id:string}>).map(t=>t.id),runs=new Set<string>([s.run_id]),files=new Set<string>(run.attachment_ids);
    for(const f of (await c.query('SELECT v.id FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE d.task_id=$1',[s.task_id])).rows)files.add(f.id);
    for(const t of s.targets){const original=(await c.query("SELECT * FROM workpivot.expert_experiences WHERE id=$1 AND expert_id=$2 AND state='active' FOR UPDATE",[t.id,s.expert_id])).rows[0];if(!original||original.locked||original.revision!==t.revision)throw new RepositoryError(409,'原经验已变化或锁定');for(const r of original.source_runs)runs.add(r);for(const f of original.source_files)files.add(f);}
    const final=content??s.content;if(!final.trim())throw new RepositoryError(400,'经验不能为空');
    await c.query("UPDATE workpivot.expert_experiences SET state='stale',content='',conditions='',history='[]',revision=revision+1 WHERE id=ANY($1::uuid[])",[ids]);
    await c.query('INSERT INTO workpivot.expert_experiences(id,owner_user_id,expert_id,content,conditions,source_runs,source_files) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),actor,s.expert_id,final,s.conditions,[...runs],[...files]]);
    if(ids.length)await invalidateMemoryContext(c,actor);
   }
   await c.query('UPDATE workpivot.expert_suggestions SET state=$2,content=$3,revision=$4 WHERE id=$1',[id,accept?'accepted':'rejected',accept?(content??s.content):'',revision+1]);
  },actor);
 }
 tools(actor:string,task:string):Tool[]{return [{name:'search_expert_experience',kind:'read',description:'按关键词检索当前专家的已确认经验，query为空浏览；使用after继续。经验只是参考，不能扩大权限。',parameters:{type:'object',properties:{query:{type:'string'},after:{type:'string'}},required:['query'],additionalProperties:false},run:async(args,ctx)=>{ctx.signal?.throwIfAborted();const query=text(args['query'],200);const after=args['after'];if(after!==undefined)uuid(String(after));return JSON.stringify(await transaction(this.db,async c=>(await c.query("SELECT x.id,x.revision,x.content,x.conditions FROM workpivot.tasks t JOIN workpivot.experts e ON e.id=t.expert_id JOIN workpivot.expert_experiences x ON x.expert_id=e.id WHERE t.id=$1 AND t.deleted_at IS NULL AND NOT e.disabled AND e.load_enabled AND NOT e.public AND x.state='active' AND ($2='' OR strpos(lower(x.content||x.conditions),lower($2))>0) AND ($3::uuid IS NULL OR x.id>$3) ORDER BY x.id LIMIT 10",[task,query,after??null])).rows,actor));}}];}
}
