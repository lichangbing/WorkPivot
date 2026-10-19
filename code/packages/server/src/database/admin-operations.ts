import {automationCapacity,lockAutomationCapacity} from './automation-capacity.js';
import type {Pool} from 'pg';
import {AccountRepository} from './accounts.js';
import {RepositoryError,transaction,uuid} from './connection.js';

/** 管理端只读取状态与计数，不返回任务名称、正文、审批参数或原始错误。 */
export class AdminOperations {
 constructor(private readonly auth:Pool,private readonly db:Pool){}
 private async target(token:string,owner:string){
  uuid(owner);const accounts=new AccountRepository(this.auth);
  const actor=await accounts.resolve(token);
  if(!actor||actor.role!=='admin'||actor.mustChangePassword)throw new RepositoryError(403,'需要有效管理员登录');
  if(!(await accounts.listUsers(token)).some(user=>user.id===owner))throw new RepositoryError(404,'用户不存在');
  return actor;
 }
 async capacity(token:string,owner:string,before?:number){
  await this.target(token,owner);
  if(before!==undefined&&(!Number.isSafeInteger(before)||before<1||before>2147483647))throw new RepositoryError(400,'审计游标无效');
  return transaction(this.db,async c=>{
   const rows=(await c.query('SELECT revision,actor_id AS "actorId",before_limits AS "before",after_limits AS "after",reason,created_at AS "createdAt" FROM workpivot.automation_capacity_audit WHERE ($1::integer IS NULL OR revision<$1) ORDER BY revision DESC LIMIT 51',[before??null])).rows;
   return {capacity:await automationCapacity(c),audit:rows.slice(0,50),nextBefore:rows.length>50?rows[49].revision:null};
  },owner);
 }
 async attempts(token:string,owner:string,category?:string,at?:string,id?:string){
  await this.target(token,owner);
  const categories=['permission_denied','invalid_input','conflict','not_found','internal_error'];
  if(category!==undefined&&!categories.includes(category))throw new RepositoryError(400,'审计分类无效');
  if((at===undefined)!==(id===undefined))throw new RepositoryError(400,'审计游标不完整');
  if(at!==undefined){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at)||at.startsWith('0000-')||!Number.isFinite(Date.parse(at))||new Date(at).toISOString().slice(0,19)!==at.slice(0,19))throw new RepositoryError(400,'审计时间游标无效');uuid(id!);}
  return transaction(this.db,async c=>{
   const rows=(await c.query(`SELECT id,actor_id AS "actorId",target_id AS "targetId",action,category,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt" FROM workpivot.management_attempts WHERE ($1::text IS NULL OR category=$1) AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,[category??null,at??null,id??null])).rows;
   return {attempts:rows.slice(0,50),next:rows.length>50?{at:rows[49].createdAt,id:rows[49].id}:null};
  },owner);
 }
 async setCapacity(token:string,owner:unknown,value:Record<string,unknown>){
  const actor=await new AccountRepository(this.auth).resolve(token);
  try{
   if(typeof owner!=='string')throw new RepositoryError(400,'目标用户无效');
   return await this.changeCapacity(token,owner,value);
  }catch(error){
   // 未认证流量由接入层处理；这里不记录令牌、原始参数或异常文本。
   if(actor){
    let target:string|null=null;try{if(typeof owner==='string'){uuid(owner);target=owner;}}catch{/* 无效目标归入操作人名下，避免保存原始输入。 */}
    const status=error instanceof RepositoryError?error.status:500;
    const category=({400:'invalid_input',401:'permission_denied',403:'permission_denied',404:'not_found',409:'conflict'} as Record<number,string>)[status]??'internal_error';
    try{
     const exists=target&&(await this.auth.query('SELECT id FROM identity.users WHERE id=$1',[target])).rowCount;
     const auditOwner=exists?target!:actor.id;
     await transaction(this.db,c=>c.query("INSERT INTO workpivot.management_attempts(owner_user_id,actor_id,target_id,action,category) VALUES($1,$2,$3,'automation.capacity.update',$4)",[auditOwner,actor.id,target,category]),auditOwner);
    }
    catch{throw new RepositoryError(503,'额度操作失败，且失败审计未能保存；请联系管理员检查服务');}
   }
   throw error;
  }
 }
 private async changeCapacity(token:string,owner:string,value:Record<string,unknown>){
  const actor=await this.target(token,owner);
  const {enabledLimit,queuedLimit,revision,requestId,reason}=value;
  if(!Number.isInteger(enabledLimit)||Number(enabledLimit)<0||Number(enabledLimit)>100||!Number.isInteger(queuedLimit)||Number(queuedLimit)<0||Number(queuedLimit)>100||!Number.isSafeInteger(revision)||Number(revision)<0||typeof requestId!=='string'||typeof reason!=='string'||!reason.trim()||reason.trim().length>300)throw new RepositoryError(400,'额度需为0至100的整数，并填写不超过300字的变更原因');
  uuid(requestId);
  return transaction(this.db,async c=>{
   await lockAutomationCapacity(c,owner);
   const after={enabledLimit,queuedLimit};
   const prior=(await c.query('SELECT actor_id,after_limits,reason,revision FROM workpivot.automation_capacity_audit WHERE request_id=$1',[requestId])).rows[0];
   if(prior){if(prior.actor_id!==actor.id||prior.after_limits.enabledLimit!==enabledLimit||prior.after_limits.queuedLimit!==queuedLimit||prior.reason!==reason.trim())throw new RepositoryError(409,'请求标识已用于其他额度变更');return {revision:prior.revision};}
   const current=await automationCapacity(c);
   if(current.revision!==revision)throw new RepositoryError(409,'额度已被修改，请刷新后重新确认');
   const next=current.revision+1;
   await c.query('INSERT INTO workpivot.automation_capacity(owner_user_id,enabled_limit,queued_limit,revision) VALUES($1,$2,$3,$4) ON CONFLICT(owner_user_id) DO UPDATE SET enabled_limit=$2,queued_limit=$3,revision=$4',[owner,enabledLimit,queuedLimit,next]);
   await c.query('INSERT INTO workpivot.automation_capacity_audit(owner_user_id,revision,actor_id,request_id,before_limits,after_limits,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',[owner,next,actor.id,requestId,{enabledLimit:current.enabledLimit,queuedLimit:current.queuedLimit},after,reason.trim()]);
   return {revision:next};
  },owner);
 }
 async captures(token:string,owner:string,before?:string){
  await this.target(token,owner);if(before)uuid(before);return transaction(this.db,async c=>{
   if(before&&!(await c.query('SELECT id FROM workpivot.capture_audit WHERE id=$1',[before])).rowCount)throw new RepositoryError(400,'采集审计分页位置无效');
   const rows=(await c.query('SELECT id,actor_id AS "actorId",plan_id AS "planId",version_id AS "versionId",run_id AS "runId",action,retry_count AS "retryCount",created_at AS "createdAt" FROM workpivot.capture_audit WHERE ($1::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM workpivot.capture_audit WHERE id=$1)) ORDER BY created_at DESC,id DESC LIMIT 51',[before??null])).rows;
   return {counts:(await c.query(`SELECT (SELECT count(*)::int FROM workpivot.capture_sources) AS sources,(SELECT count(*)::int FROM workpivot.capture_versions) AS versions,(SELECT count(*)::int FROM workpivot.capture_observations) AS observations,(SELECT count(*)::int FROM workpivot.capture_versions WHERE original_body IS NOT NULL) AS originals,(SELECT count(*)::int FROM workpivot.capture_versions WHERE original_body IS NOT NULL AND original_kind IN ('dom','bundle')) AS "domOriginals",(SELECT COALESCE(sum(octet_length(original_body)),0)::text FROM workpivot.capture_versions) AS "originalBytes"`)).rows[0],audit:rows.slice(0,50),next:rows.length>50?rows[49].id:null};
  },owner);
 }
 async overview(token:string,owner:string,month:string){
  uuid(owner);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month<'2020-01'||month>'2100-12')throw new RepositoryError(400,'月份无效');
  const users=await new AccountRepository(this.auth).listUsers(token);
  const user=users.find(u=>u.id===owner);if(!user)throw new RepositoryError(404,'用户不存在');
  const metrics=await transaction(this.db,async c=>{
   const groups:Record<string,Array<{status:string;count:number}>>={};
   // 表名为固定白名单，不能来自请求；RLS始终限定当前被查询用户。
   for(const table of ['task_runs','automation_runs','document_processing','embedding_jobs']){
    groups[table]=(await c.query(`SELECT status,count(*)::int AS count FROM workpivot.${table} GROUP BY status ORDER BY status`)).rows;
   }
   groups['browser_profiles']=(await c.query("SELECT CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN lease_until>now() THEN lease_kind WHEN state_cipher IS NULL THEN 'waiting_login' ELSE 'ready' END AS status,count(*)::int AS count FROM workpivot.browser_profiles GROUP BY status ORDER BY status")).rows;
   groups['approvals']=(await c.query("SELECT state AS status,count(*)::int AS count FROM workpivot.run_permissions WHERE state='pending' AND expires_at>now() GROUP BY state")).rows;
   const usage=(await c.query(`SELECT model,source,count(*)::int AS requests,COALESCE(sum(input_tokens),0)::text AS "inputTokens",COALESCE(sum(output_tokens),0)::text AS "outputTokens",count(*) FILTER(WHERE status='pending')::int AS unfinished,count(*) FILTER(WHERE measurement='estimated')::int AS estimated FROM workpivot.model_usage WHERE started_at>=($1||'-01')::timestamp AT TIME ZONE 'Asia/Shanghai' AND started_at<(($1||'-01')::timestamp+interval '1 month') AT TIME ZONE 'Asia/Shanghai' GROUP BY model,source ORDER BY requests DESC,model,source LIMIT 100`,[month])).rows;
   return {groups,usage};
  },owner);
  return {user:{id:user.id,username:user.username},month,...metrics,limits:{usageGroups:100},notice:'仅展示运行元数据；状态计数覆盖保留的历史记录，用量按上海时区月份汇总，未知和估算用量单独标记。管理员不能通过此接口读取私人内容。'};
 }
}
