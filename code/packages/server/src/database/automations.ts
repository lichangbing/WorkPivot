import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Tool } from '@workpivot/core';
import type { AutomationConfig, AutomationPlan, AutomationRun } from '@workpivot/shared';
import { RepositoryError, transaction, uuid } from './connection.js';
import { automationConfig, automationPreview, nextAutomationTime } from './automation-time.js';
const planColumns='id,revision,state,config,draft,origin,source_task_id AS "sourceTaskId",next_at AS "nextAt",issue,created_at AS "createdAt"';
export const automationRunColumns='id,plan_id AS "planId",task_id AS "taskId",status,scheduled_for AS "scheduledFor",started_at AS "startedAt",finished_at AS "finishedAt",error,summary,config,events';
export type AutomationInput={id:string;name:string;taskId:string;size:number};
export class Automations {
 constructor(readonly db:Pool,readonly workerAvailable=false,readonly browserAvailable=false){}
 async get(c:PoolClient,id:string,lock=false){uuid(id);const p=(await c.query<AutomationPlan & {grant_id:string|null;source_invalid:boolean;source_run_id:string|null}>(`SELECT ${planColumns},grant_id,source_invalid,source_run_id FROM workpivot.automations WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];if(!p)throw new RepositoryError(404,'自动化不存在');return p;}
 async options(actor:string){return transaction(this.db,async c=>({
  skills:(await c.query('SELECT c.name,c.display_name AS "displayName",r.id AS version,r.label,r.description FROM workpivot.skill_catalog c JOIN workpivot.skill_releases r ON r.id=c.release_id JOIN workpivot.skill_selections s ON s.name=c.name WHERE NOT c.disabled ORDER BY c.name')).rows,
  projects:(await c.query('SELECT id,name FROM workpivot.projects WHERE deleted_at IS NULL ORDER BY created_at')).rows,
  files:(await c.query(`SELECT v.id,v.name,v.revision,t.project_id AS "projectId",t.id AS "taskId" FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id JOIN workpivot.tasks t ON t.id=d.task_id WHERE t.deleted_at IS NULL AND t.origin='chat' AND d.purpose='upload' ORDER BY v.created_at DESC LIMIT 1000`)).rows,
  workerAvailable:this.workerAvailable,browserAvailable:this.browserAvailable,
 }),actor);}
 async dependencies(c:PoolClient,p:AutomationConfig,resolveInputs=true):Promise<AutomationInput[]> {
  if(!this.workerAvailable)throw new RepositoryError(409,'隔离执行服务尚未配置');
  if(p.projectId&&!(await c.query('SELECT id FROM workpivot.projects WHERE id=$1 AND deleted_at IS NULL',[p.projectId])).rowCount)throw new RepositoryError(409,'成果项目已删除或不可访问');
  if(!(await c.query(`SELECT r.id FROM workpivot.skill_releases r JOIN workpivot.skill_catalog c ON c.name=r.name JOIN workpivot.skill_selections s ON s.name=c.name WHERE r.id=$1 AND r.name=$2 AND NOT c.disabled`,[p.releaseId,p.skill])).rowCount)throw new RepositoryError(409,'绑定技能未加载、被停用或版本不可用');
  if(!resolveInputs||p.input.mode==='none')return [];
  const rows=(await c.query<AutomationInput & {projectId:string|null}>(`SELECT v.id,v.name,v.size,d.task_id AS "taskId",t.project_id AS "projectId" FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id JOIN workpivot.tasks t ON t.id=d.task_id WHERE t.deleted_at IS NULL AND t.origin='chat' AND d.purpose='upload' AND ${p.input.mode==='fixed'?'v.id=ANY($1::uuid[])':'t.project_id=$1 AND v.revision=d.revision'} ORDER BY v.created_at DESC,v.id DESC`,[p.input.mode==='fixed'?p.input.versionIds:p.projectId])).rows;
  let inputs:AutomationInput[];
  if(p.input.mode==='fixed'){if(rows.length!==p.input.versionIds.length)throw new RepositoryError(409,'固定输入文件已删除或无权访问');inputs=rows;}
  else {const pattern=new RegExp('^'+p.input.pattern.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$','i');inputs=rows.filter(r=>pattern.test(r.name)).slice(0,1);if(!inputs.length)throw new RepositoryError(409,'未找到匹配的项目资料，请检查文件名规则');}
  if(inputs.reduce((n,r)=>n+Number(r.size),0)>16*1024*1024)throw new RepositoryError(413,'输入文件合计超过16MB');return inputs;
 }
 async list(actor:string){return transaction(this.db,async c=>{
  const rows=(await c.query<AutomationPlan>(`SELECT ${planColumns} FROM workpivot.automations WHERE state<>'deleted' ORDER BY created_at DESC LIMIT 200`)).rows;
  for(const p of rows)p.lastRun=(await c.query<AutomationRun>(`SELECT ${automationRunColumns} FROM workpivot.automation_runs WHERE plan_id=$1 ORDER BY created_at DESC LIMIT 1`,[p.id])).rows[0]??null;
  return rows;
 },actor);}
 async detail(actor:string,id:string){return transaction(this.db,async c=>{const p=await this.get(c,id);const cfg=p.draft??p.config;return {...p,preview:cfg?automationPreview(cfg):[],runs:(await c.query<AutomationRun>(`SELECT ${automationRunColumns} FROM workpivot.automation_runs WHERE plan_id=$1 ORDER BY created_at DESC LIMIT 100`,[id])).rows};},actor);}
 async source(c:PoolClient,taskId:string,run:{id:string;fence:string}){uuid(taskId);if(!(await c.query(`SELECT r.id FROM workpivot.task_runs r JOIN workpivot.tasks t ON t.id=r.task_id WHERE t.id=$1 AND t.deleted_at IS NULL AND r.id=$2 AND r.fence=$3 AND r.status='running' AND NOT r.context_revoked AND r.lease_until>now()`,[taskId,run.id,run.fence])).rowCount)throw new RepositoryError(409,'来源对话运行已失效');}
 async draft(actor:string,value:unknown,requestId:string,id?:string,revision?:number,source?:{taskId:string;run:{id:string;fence:string}}){
  const config=automationConfig(value);uuid(requestId);return transaction(this.db,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['automation-draft:'+actor]);
   if(source)await this.source(c,source.taskId,source.run);
   if(id){const p=await this.get(c,id,true);if(p.state==='deleted'||p.revision!==revision)throw new RepositoryError(409,'计划已改变，请刷新后编辑');
    await c.query(`UPDATE workpivot.automations SET draft=$2,revision=revision+1,source_task_id=$3,source_run_id=$4,source_invalid=false,updated_at=now() WHERE id=$1`,[id,config,source?.taskId??null,source?.run.id??null]);
   }else{
    const prior=(await c.query('SELECT id,draft FROM workpivot.automations WHERE request_id=$1',[requestId])).rows[0];if(prior){if(JSON.stringify(prior.draft)!==JSON.stringify(config)){// JSONB 键顺序不同，使用数据库结构比较。
      if(!(await c.query('SELECT id FROM workpivot.automations WHERE id=$1 AND draft=$2::jsonb',[prior.id,config])).rowCount)throw new RepositoryError(409,'请求标识已用于其他草稿');}return this.get(c,prior.id);}
    if((await c.query("SELECT count(*)::int AS n FROM workpivot.automations WHERE state<>'deleted'")).rows[0].n>=100)throw new RepositoryError(400,'每位用户最多100个自动化计划');
    id=randomUUID();await c.query('INSERT INTO workpivot.automations(id,owner_user_id,draft,request_id,origin,source_task_id,source_run_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,actor,config,requestId,source?'conversation':'manual',source?.taskId??null,source?.run.id??null]);
   }
   return this.get(c,id);
  },actor);
 }
 async confirm(actor:string,id:string,revision:number,enable:boolean){return transaction(this.db,async c=>{
  const p=await this.get(c,id,true);if(p.revision!==revision)throw new RepositoryError(409,'计划已改变，请重新确认');if(p.state==='deleted')throw new RepositoryError(409,'计划已删除');
  const config=p.draft??p.config;if(!config)throw new RepositoryError(409,'需要重新填写执行配置');
  if(p.draft&&(p.source_invalid||p.source_run_id&&!(await c.query("SELECT id FROM workpivot.task_runs WHERE id=$1 AND NOT context_revoked AND status IN ('running','completed','failed')",[p.source_run_id])).rowCount))throw new RepositoryError(409,'来源对话失效，请重新编辑确认');
  const next=nextAutomationTime(config,new Date());if(enable){await this.dependencies(c,config);if(!next)throw new RepositoryError(400,'没有未来可执行的时间');}
  await c.query(`UPDATE workpivot.automations SET config=$2,draft=NULL,state=$3,grant_id=$4,next_at=$5,issue='',revision=revision+1,updated_at=now() WHERE id=$1`,[id,config,enable?'enabled':'paused',enable?randomUUID():null,enable?next:null]);
  await c.query("UPDATE workpivot.automation_runs SET status='cancelled',revoked=true,error='计划设置已变化，旧排队已取消',finished_at=now() WHERE plan_id=$1 AND status='queued'",[id]);
  return this.get(c,id);
 },actor);}
 async action(actor:string,id:string,revision:number,action:'pause'|'delete'|'discard',stopCurrent=false){return transaction(this.db,async c=>{
  const p=await this.get(c,id,true);if(p.revision!==revision)throw new RepositoryError(409,'计划已改变，请刷新');
  if(action==='discard'){await c.query('UPDATE workpivot.automations SET draft=NULL,revision=revision+1 WHERE id=$1 AND config IS NOT NULL',[id]);return this.get(c,id);}
  await c.query("UPDATE workpivot.automations SET state=$2,next_at=NULL,grant_id=NULL,revision=revision+1,updated_at=now() WHERE id=$1",[id,action==='delete'?'deleted':'paused']);
  await c.query("UPDATE workpivot.automation_runs SET revoked=true,status='cancelled',error='计划已停用或删除',finished_at=now() WHERE plan_id=$1 AND status='queued'",[id]);
  if(stopCurrent||action==='delete')await c.query("UPDATE workpivot.automation_runs SET revoked=true WHERE plan_id=$1 AND status='running'",[id]);
  return this.get(c,id);
 },actor);}
 async stopRun(actor:string,planId:string,id:string){return transaction(this.db,async c=>{await this.get(c,planId,true);uuid(id);await c.query("UPDATE workpivot.automation_runs SET revoked=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,error='用户已请求停止',finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE id=$1 AND plan_id=$2 AND status IN ('queued','running')",[id,planId]);},actor);}
 async notice(c:PoolClient,actor:string,id:string,run:string|null,key:string,message:string){await c.query('INSERT INTO workpivot.automation_notices(owner_user_id,plan_id,run_id,notice_key,message) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_user_id,notice_key) DO NOTHING',[actor,id,run,key,message]);}
 async block(c:PoolClient,actor:string,id:string,message:string){const p=await this.get(c,id,true);if(['deleted','paused'].includes(p.state))return;
  await c.query("UPDATE workpivot.automations SET state='blocked',issue=$2,next_at=NULL,grant_id=NULL,revision=revision+1 WHERE id=$1",[id,message]);
  await c.query("UPDATE workpivot.automation_runs SET revoked=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,error=$2 WHERE plan_id=$1 AND status IN ('queued','running')",[id,message]);
  await this.notice(c,actor,id,null,`blocked:${id}:${p.revision}`,message);
 }
 async enqueue(actor:string,now=new Date()){return transaction(this.db,async c=>{
  const plans=(await c.query(`SELECT ${planColumns},grant_id FROM workpivot.automations WHERE state='enabled' ORDER BY next_at FOR UPDATE SKIP LOCKED`)).rows;
  for(const p of plans){try{await this.dependencies(c,p.config);}catch(e){await this.block(c,actor,p.id,e instanceof RepositoryError?e.message:'计划依赖暂不可用');continue;}
   if(!p.nextAt||new Date(p.nextAt)>now)continue;
   const at=new Date(p.nextAt),next=nextAutomationTime(p.config,now,at);
   const late=now.getTime()-at.getTime()>60000;
   if(!late||p.config.catchup==='once')await c.query(`INSERT INTO workpivot.automation_runs(id,owner_user_id,plan_id,config,grant_id,plan_revision,scheduled_for) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[randomUUID(),actor,p.id,p.config,p.grant_id,p.revision,at]);
   await c.query("UPDATE workpivot.automations SET next_at=$2,state=CASE WHEN $2::timestamptz IS NULL THEN 'ended' ELSE state END WHERE id=$1",[p.id,next]);
  }
 },actor);}
 async manual(actor:string,id:string,revision:number,requestId:string){uuid(requestId);return transaction(this.db,async c=>{
  const p=await this.get(c,id,true);const old=(await c.query('SELECT id FROM workpivot.automation_runs WHERE request_id=$1 AND plan_id=$2',[requestId,id])).rows[0];if(old)return old;
  if(p.revision!==revision||p.state!=='enabled'||!p.config||!p.grant_id)throw new RepositoryError(409,'仅可试运行已确认启用的当前计划');await this.dependencies(c,p.config);
  if((await c.query("SELECT 1 FROM workpivot.automation_runs WHERE plan_id=$1 AND status IN ('queued','running')",[id])).rowCount)throw new RepositoryError(409,'此计划已有待执行或运行中的任务');
  const runId=randomUUID();await c.query('INSERT INTO workpivot.automation_runs(id,owner_user_id,plan_id,config,grant_id,plan_revision,scheduled_for,request_id) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),$7)',[runId,actor,id,p.config,p.grant_id,p.revision,requestId]);return {id:runId};
 },actor);}
 async notices(actor:string){return transaction(this.db,async c=>(await c.query('SELECT id,plan_id AS "planId",run_id AS "runId",message,read_at AS "readAt",created_at AS "createdAt" FROM workpivot.automation_notices ORDER BY created_at DESC LIMIT 100')).rows,actor);}
 async readNotice(actor:string,id:string){uuid(id);await transaction(this.db,c=>c.query('UPDATE workpivot.automation_notices SET read_at=now() WHERE id=$1',[id]),actor);}
 tools(actor:string,taskId:string,bound:()=>{id:string;fence:string}|undefined):Tool[]{
  const guard=async()=>{const run=bound();if(!run)throw new RepositoryError(409,'对话运行尚未绑定');await transaction(this.db,c=>this.source(c,taskId,run),actor);return run;};
  const configSchema={type:'object',description:'完整计划配置；先用get_automation_options读取可用技能版本、项目和文件。使用config对象：name、skill、releaseId、projectId(null表示独立成果)、requirements、input{mode:none|fixed|latest,versionIds:[],pattern:""}、timing{kind:once|daily|weekly|interval|cron,zone:Asia/Shanghai,at:"YYYY-MM-DDTHH:mm"或空,time:"09:00",days:[1,2,3,4,5],minutes:120,cron:"0 9 * * *",end:""}、catchup:once|skip、notify:issues|all、timeoutMinutes:10、webOrigins:[]。联网采集必须显式填写用户确认的完整网页来源origin（如https://example.com），包括需要的跳转和子资源来源；空数组表示不允许联网。缺失项应询问，不猜测执行范围。'};
  return [
   {name:'get_automation_options',kind:'read',description:'读取当前用户可用的已加载Skill、发布版本、项目和文件版本，供创建计划草稿。',parameters:{type:'object',properties:{},additionalProperties:false},run:async()=>{await guard();return JSON.stringify(await this.options(actor));}},
   {name:'list_my_schedules',kind:'read',description:'列出本人自动化计划及配置；用于准确定位要修改或暂停的计划。',parameters:{type:'object',properties:{},additionalProperties:false},run:async()=>{await guard();return JSON.stringify((await this.list(actor)).map(p=>({...p,lastRun:undefined})));}},
   {name:'propose_schedule',kind:'write',description:'保存新的自动化草稿，在独立自动化页面显示为待确认。不会启用或执行，必须用户在页面确认。',parameters:{type:'object',properties:{requestId:{type:'string'},config:configSchema},required:['requestId','config'],additionalProperties:false},run:async args=>{const run=await guard();return JSON.stringify(await this.draft(actor,args.config,String(args.requestId),undefined,undefined,{taskId,run}));}},
   {name:'propose_schedule_change',kind:'write',description:'提出计划配置修订，保持原活动配置不变，用户需在自动化页另行确认。',parameters:{type:'object',properties:{id:{type:'string'},revision:{type:'integer'},config:configSchema},required:['id','revision','config'],additionalProperties:false},run:async args=>{const run=await guard();return JSON.stringify(await this.draft(actor,args.config,randomUUID(),String(args.id),Number(args.revision),{taskId,run}));}},
   {name:'pause_schedule',kind:'write',description:'仅当用户明确要求暂停某个已准确定位的本人计划时调用；立即阻止后续触发，当前运行继续。不支持模型启用或恢复。',parameters:{type:'object',properties:{id:{type:'string'},revision:{type:'integer'}},required:['id','revision'],additionalProperties:false},run:async args=>{await guard();return JSON.stringify(await this.action(actor,String(args.id),Number(args.revision),'pause'));}},
   {name:'cancel_schedule_run',kind:'write',description:'仅当用户明确要求停止已准确定位的某次运行时调用；不删除历史，不修改后续计划。',parameters:{type:'object',properties:{id:{type:'string'},runId:{type:'string'}},required:['id','runId'],additionalProperties:false},run:async args=>{await guard();await this.stopRun(actor,String(args.id),String(args.runId));return '已请求停止本次运行。';}},
   {name:'get_schedule_run',kind:'read',description:'查看本人指定自动化的最近运行、状态、日志和结果。',parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},run:async args=>{await guard();return JSON.stringify(await this.detail(actor,String(args.id)));}},
  ];
 }
}
