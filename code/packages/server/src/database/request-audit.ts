import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {RequestHandler} from 'express';
import {AccountRepository} from './accounts.js';
import {RepositoryError,uuid,transaction} from './connection.js';

const areas=new Set(['browser-profiles','auth','users','admin','tasks','projects','automations','embeddings','personal-data','trash','skill-builds','skill-packages','skill-market','experts','memory','providers','mcp','usage','settings','files','documents']);
const operations:Record<string,string>={
 '/api/admin/request-audits/export':'admin.audit.export','/api/admin/request-audits/cleanup':'admin.audit.cleanup',
 '/api/admin/request-audits/cleanup-preview':'admin.audit.preview','/api/auth/login':'auth.login','/api/auth/password':'auth.password',
 '/api/personal-data/export':'personal-data.export','/api/personal-data/clear':'personal-data.clear',
};
for(const operation of Object.values(operations))areas.add(operation);
/** 开始记录先落库，结束记录追加；崩溃或写入失败保留“未确认”，不能伪报完成。 */
export function requestAudit(db:Pool):RequestHandler {
 const accounts=new AccountRepository(db);
 return async(req,res,next)=>{
  if(!req.path.startsWith('/api/')||['/api/health','/api/auth/state'].includes(req.path)){next();return;}
  const token=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):'';
  let user;
  try{user=await accounts.resolve(token);}catch{throw new RepositoryError(503,'身份与审计服务暂不可用');}
  const id=randomUUID();
  const part=req.path.split('/')[2]??'';
  const method=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(req.method)?req.method:'OTHER';
  try{await db.query('INSERT INTO identity.request_audit(id,actor_id,method,area) VALUES($1,$2,$3,$4)',[id,user?.id??null,method,operations[req.path]??(areas.has(part)?part:'other')]);}
  catch{throw new RepositoryError(503,'请求审计暂不可用，请稍后重试');}
  let recorded=false;
  const finish=(outcome:'responded'|'disconnected')=>{
   if(recorded)return;recorded=true;
   void db.query('INSERT INTO identity.request_audit_results(request_id,status,outcome) VALUES($1,$2,$3)',[id,res.statusCode,outcome]).catch(()=>{
    // 不输出异常文本，以免驱动错误携带连接凭据；未完成记录可由管理界面发现。
    console.error('请求审计结果保存失败，开始记录保留为未确认');
   });
  };
  res.once('finish',()=>finish('responded'));res.once('close',()=>finish('disconnected'));
  next();
 };
}
export class RequestAudits {
 constructor(private readonly db:Pool){}
 private async administrator(token:string){
  const user=await new AccountRepository(this.db).resolve(token);
  if(!user||user.role!=='admin'||user.mustChangePassword)throw new RepositoryError(403,'需要有效管理员登录');
  return user;
 }
 async cleanupPreview(token:string,before:unknown){
  await this.administrator(token);
  if(typeof before!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(before)||!Number.isFinite(Date.parse(before))||new Date(before).toISOString().slice(0,10)!==before||before<'2000-01-01'||Date.parse(before)>Date.now()-30*86400000)throw new RepositoryError(400,'请选择至少30天前的有效UTC日期');
  const result=(await this.db.query(`SELECT count(*)::int AS count,md5(COALESCE(string_agg(id::text,',' ORDER BY id),'')) AS fingerprint FROM (SELECT a.id FROM identity.request_audit a JOIN identity.request_audit_results r ON r.request_id=a.id WHERE a.created_at<$1::date::timestamp AT TIME ZONE 'UTC' AND r.created_at<$1::date::timestamp AT TIME ZONE 'UTC' LIMIT 100001) selected`,[before])).rows[0];
  if(result.count>100000)throw new RepositoryError(413,'单次清理超过100000条，请选择更早的日期');
  return {before,...result};
 }
 async cleanup(token:string,input:Record<string,unknown>){
  const user=await this.administrator(token);
  if(input.confirmation!=='永久清理请求审计'||typeof input.fingerprint!=='string'||!/^[a-f0-9]{32}$/.test(input.fingerprint))throw new RepositoryError(400,'需要核对预览并明确确认永久清理');
  const preview=await this.cleanupPreview(token,input.before);
  if(preview.fingerprint!==input.fingerprint)throw new RepositoryError(409,'清理范围已变化，请重新预览');
  return transaction(this.db,async c=>{
   await c.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
   return {removed:(await c.query('SELECT identity.cleanup_request_audit($1,$2,$3) AS removed',[user.id,preview.before,input.fingerprint])).rows[0].removed};
  });
 }
 async cleanups(token:string){await this.administrator(token);return (await this.db.query('SELECT id,actor_id AS "actorId",before_date::text AS before,removed,created_at AS "createdAt" FROM identity.request_audit_cleanups ORDER BY created_at DESC,id DESC LIMIT 50')).rows;}
 async list(token:string,query:Record<string,unknown>,exporting=false){
  const user=await new AccountRepository(this.db).resolve(token);
  if(!user||user.role!=='admin'||user.mustChangePassword)throw new RepositoryError(403,'需要有效管理员登录');
  const text=(name:string)=>{const value=query[name];if(value===undefined||value==='')return null;if(typeof value!=='string')throw new RepositoryError(400,'审计筛选参数无效');return value;};
  const actor=text('actor'),before=text('before'),area=text('area'),outcome=text('outcome'),from=text('from'),until=text('until');
  if(actor&&actor!=='anonymous')uuid(actor);if(before)uuid(before);
  if(area&&!areas.has(area)&&area!=='other')throw new RepositoryError(400,'审计范围无效');
  if(outcome&&!['success','denied','failed','pending','disconnected'].includes(outcome))throw new RepositoryError(400,'审计状态无效');
  for(const date of [from,until])if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date<'2000-01-01'||date>'2100-12-31'))throw new RepositoryError(400,'审计日期无效');
  if(from&&until&&from>until)throw new RepositoryError(400,'起始日期不能晚于结束日期');
  if(before&&!(await this.db.query('SELECT id FROM identity.request_audit WHERE id=$1',[before])).rowCount)throw new RepositoryError(400,'审计分页位置无效');
  const limit=exporting?10000:50;
  const rows=(await this.db.query(`WITH events AS (
   SELECT a.id,a.actor_id AS "actorId",a.method,a.area,a.created_at AS "createdAt",r.created_at AS "finishedAt",r.status,
    CASE WHEN r.request_id IS NULL THEN 'pending' WHEN r.outcome='disconnected' THEN 'disconnected' WHEN r.status IN (401,403) THEN 'denied' WHEN r.status>=400 THEN 'failed' ELSE 'success' END AS outcome
   FROM identity.request_audit a LEFT JOIN identity.request_audit_results r ON r.request_id=a.id
   WHERE ($1::text IS NULL OR ($1='anonymous' AND a.actor_id IS NULL) OR a.actor_id::text=$1)
    AND ($2::text IS NULL OR a.area=$2)
    AND ($3::date IS NULL OR a.created_at >= $3::date::timestamp AT TIME ZONE 'UTC')
    AND ($4::date IS NULL OR a.created_at < ($4::date+1)::timestamp AT TIME ZONE 'UTC')
    AND ($5::uuid IS NULL OR (a.created_at,a.id)<(SELECT created_at,id FROM identity.request_audit WHERE id=$5))
  ) SELECT * FROM events WHERE ($6::text IS NULL OR outcome=$6) ORDER BY "createdAt" DESC,id DESC LIMIT $7`,[actor,area,from,until,before,outcome,limit+1])).rows;
  if(exporting&&rows.length>limit)throw new RepositoryError(413,'匹配记录超过10000条，请缩小日期或用户范围后导出');
  return {rows:rows.slice(0,limit),next:rows.length>limit?rows[limit-1].id:null};
 }
}
