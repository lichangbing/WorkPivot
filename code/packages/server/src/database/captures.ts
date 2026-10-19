import {approvedTargets} from './network-targets.js';
import type {NetworkTarget} from '../web/network-target.js';
import {decodeOriginal} from '../web/original.js';
import {validatedFeed} from '../web/feed.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {RepositoryError,transaction,uuid} from './connection.js';
import {webUrl} from '../web/safe-http.js';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ordered(value:unknown):unknown{
 if(Array.isArray(value))return value.map(ordered);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,ordered(item)]));
 return value;
}
export function captureKey(tool:string,args:Record<string,unknown>,targets?:NetworkTarget[]){
 if(!['web_fetch','browser_visit'].includes(tool)||JSON.stringify(args).length>65536)throw new RepositoryError(400,'采集请求无效');
 const {screenshotName,...input}=args;void screenshotName;
 return digest([tool,ordered({...input,url:webUrl(input.url,undefined,undefined,targets).href})]);
}
function snapshot(value:unknown,urls:string[],targets?:NetworkTarget[]){
 if(!value||typeof value!=='object')throw new RepositoryError(400,'采集结果无效');
 const v=value as Record<string,unknown>;
 const url=webUrl(v.url,undefined,urls,targets).href;
 if(typeof v.text!=='string'||v.text.length>24000||typeof v.title!=='string'||v.title.length>500||typeof v.truncated!=='boolean'||!Array.isArray(v.links)||v.links.length>40||typeof v.warning!=='string'||v.warning.length>2000)throw new RepositoryError(400,'采集结果超出快照范围');
 const links=v.links.map(item=>{if(!item||typeof item!=='object'||typeof item.title!=='string'||item.title.length>200||typeof item.url!=='string'||item.url.length>1024)throw new RepositoryError(400,'采集链接无效');return {title:item.title,url:item.url};});
 // 截图、输入字段、临时成果和未授权请求参数不进入正文版本。
 return {...(v.feed===undefined?{}:{feed:validatedFeed(v.feed)}),url,title:v.title,text:v.text.replace(/\r\n/g,'\n'),links,truncated:v.truncated,warning:v.warning,blockedRequests:Number.isInteger(v.blockedRequests)&&Number(v.blockedRequests)>=0?Number(v.blockedRequests):0};
}
export class Captures {
 constructor(private readonly db:Pool){}
 private async plan(c:PoolClient,id:string){uuid(id);if(!(await c.query("SELECT id FROM workpivot.automations WHERE id=$1 AND state<>'deleted' FOR SHARE",[id])).rowCount)throw new RepositoryError(404,'采集计划不存在或不可访问');}
 private async run(c:PoolClient,id:string,fence:string){
  uuid(id);uuid(fence);
  const run=(await c.query("SELECT id,plan_id,config FROM workpivot.automation_runs WHERE id=$1 AND fence=$2 AND status='running' AND NOT revoked AND lease_until>now() FOR UPDATE",[id,fence])).rows[0];
  if(!run)throw new RepositoryError(409,'采集运行已失效');return run;
 }
 async cached(actor:string,runId:string,fence:string,key:string){return transaction(this.db,async c=>{
  await this.run(c,runId,fence);
  const row=(await c.query('SELECT v.content,o.version_id AS "versionId",o.changed,o.retry_count AS "retryCount" FROM workpivot.capture_observations o JOIN workpivot.capture_versions v ON v.id=o.version_id WHERE o.run_id=$1 AND o.request_key=$2',[runId,key])).rows[0];
  return row?{...row.content,capture:{versionId:row.versionId,changed:row.changed,retryCount:row.retryCount,reusedWithinRun:true}}:null;
 },actor);}
 async record(actor:string,planId:string,runId:string,fence:string,key:string,value:unknown,reuseWithinRun=true){return transaction(this.db,async c=>{
  uuid(planId);if(!/^[a-f0-9]{64}$/.test(key))throw new RepositoryError(400,'采集来源标识无效');
  // 与停用保持先计划后运行的锁顺序，旧租约不能提交快照。
  const plan=(await c.query("SELECT id FROM workpivot.automations WHERE id=$1 AND state<>'deleted' FOR UPDATE",[planId])).rows[0];if(!plan)throw new RepositoryError(404,'采集计划不可访问');
  const run=await this.run(c,runId,fence);if(run.plan_id!==planId)throw new RepositoryError(409,'采集运行与计划不匹配');
  const content=snapshot(value,run.config.webUrls??[],await approvedTargets(c,run.config));
  const rawValue=(value as Record<string,unknown>).original;
  const original=rawValue===undefined?null:decodeOriginal(rawValue);
  const originalHash=original?createHash('sha256').update(original.data).digest('hex'):null;
  const hash=original?digest({content,originalHash,mediaType:original.mediaType,...(original.kind!=='http'?{kind:original.kind}:{})}):digest(content);
  const retryCount=(value as Record<string,unknown>).retryCount??0;
  if(!Number.isInteger(retryCount)||Number(retryCount)<0||Number(retryCount)>2)throw new RepositoryError(400,'采集重试计数无效');
  const requestKey=reuseWithinRun?key:randomUUID();
  const prior=(await c.query('SELECT o.version_id AS "versionId",o.changed,o.retry_count AS "retryCount",v.content FROM workpivot.capture_observations o JOIN workpivot.capture_versions v ON v.id=o.version_id WHERE o.run_id=$1 AND o.request_key=$2',[runId,requestKey])).rows[0];if(prior)return prior;
  await c.query('INSERT INTO workpivot.capture_sources(owner_user_id,plan_id,source_key) VALUES($1,$2,$3) ON CONFLICT(plan_id,source_key) DO NOTHING',[actor,planId,key]);
  const source=(await c.query('SELECT * FROM workpivot.capture_sources WHERE plan_id=$1 AND source_key=$2 FOR UPDATE',[planId,key])).rows[0];
  const changed=source.content_hash!==hash;let versionId=source.current_version;
  if(changed){versionId=(await c.query('INSERT INTO workpivot.capture_versions(owner_user_id,source_id,revision,content_hash,content,original_body,original_type,original_hash,original_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[actor,source.id,source.revision+1,hash,content,original?.data??null,original?.mediaType??null,originalHash,original?.kind??'http'])).rows[0].id;
   await c.query('UPDATE workpivot.capture_sources SET current_version=$2,content_hash=$3,revision=revision+1 WHERE id=$1',[source.id,versionId,hash]);}
  await c.query('INSERT INTO workpivot.capture_observations(owner_user_id,run_id,version_id,request_key,changed,retry_count) VALUES($1,$2,$3,$4,$5,$6)',[actor,runId,versionId,requestKey,changed,retryCount]);
  await c.query('INSERT INTO workpivot.capture_audit(owner_user_id,actor_id,plan_id,version_id,run_id,action,retry_count) VALUES($1,$1,$2,$3,$4,$5,$6)',[actor,planId,versionId,runId,changed?'new_version':'unchanged',retryCount]);
  return {versionId,changed,content,retryCount};
 },actor);}
 async list(actor:string,planId:string,before?:string){return transaction(this.db,async c=>{
  await this.plan(c,planId);if(before)uuid(before);
  // 游标只传ID，由数据库读取原始微秒时间，避免前端日期精度造成漏项。
  if(before&&!(await c.query('SELECT o.id FROM workpivot.capture_observations o JOIN workpivot.capture_versions v ON v.id=o.version_id JOIN workpivot.capture_sources s ON s.id=v.source_id WHERE o.id=$1 AND s.plan_id=$2',[before,planId])).rowCount)throw new RepositoryError(400,'采集分页位置已失效');
  const rows=(await c.query(`SELECT o.id,o.run_id AS "runId",o.version_id AS "versionId",o.changed,o.retry_count AS "retryCount",o.created_at AS "capturedAt",v.revision,v.content->>'title' AS title,v.content->>'url' AS url,r.status AS "runStatus" FROM workpivot.capture_observations o JOIN workpivot.capture_versions v ON v.id=o.version_id JOIN workpivot.capture_sources s ON s.id=v.source_id JOIN workpivot.automation_runs r ON r.id=o.run_id WHERE s.plan_id=$1 AND ($2::uuid IS NULL OR (o.created_at,o.id)<(SELECT created_at,id FROM workpivot.capture_observations WHERE id=$2)) ORDER BY o.created_at DESC,o.id DESC LIMIT 51`,[planId,before??null])).rows;
  return {items:rows.slice(0,50),next:rows.length>50?rows[49].id:null};
 },actor);}
 async download(actor:string,planId:string,versionId:string){return transaction(this.db,async c=>{
  await this.plan(c,planId);uuid(versionId);
  const row=(await c.query('SELECT v.original_body AS data,v.original_hash AS hash FROM workpivot.capture_versions v JOIN workpivot.capture_sources s ON s.id=v.source_id WHERE v.id=$1 AND s.plan_id=$2',[versionId,planId])).rows[0];
  if(!row?.data)throw new RepositoryError(404,'此版本没有可下载存档');
  if(createHash('sha256').update(row.data).digest('hex')!==row.hash)throw new RepositoryError(409,'原始存档完整性校验失败');
  await c.query("INSERT INTO workpivot.capture_audit(owner_user_id,actor_id,plan_id,version_id,action) VALUES($1,$1,$2,$3,'download')",[actor,planId,versionId]);return row.data as Buffer;
 },actor);}
 async view(actor:string,planId:string,versionId:string){return transaction(this.db,async c=>{
  await this.plan(c,planId);uuid(versionId);
  const row=(await c.query('SELECT v.id,v.revision,v.content,octet_length(v.original_body) AS "originalBytes",v.original_type AS "originalType",v.original_kind AS "originalKind",v.original_hash AS "originalHash",v.created_at AS "createdAt" FROM workpivot.capture_versions v JOIN workpivot.capture_sources s ON s.id=v.source_id WHERE v.id=$1 AND s.plan_id=$2',[versionId,planId])).rows[0];if(!row)throw new RepositoryError(404,'采集版本不存在或不可访问');
  await c.query("INSERT INTO workpivot.capture_audit(owner_user_id,actor_id,plan_id,version_id,action) VALUES($1,$1,$2,$3,'view')",[actor,planId,versionId]);return row;
 },actor);}
}

/** 与回收站事务共同提交，只记录确实存在采集数据的计划。 */
export async function auditCaptureLifecycle(c:PoolClient,planId:string,action:'recycle'|'restore'|'purge'){
 await c.query(`INSERT INTO workpivot.capture_audit(owner_user_id,actor_id,plan_id,action) SELECT workpivot.actor_id(),workpivot.actor_id(),$1,$2 WHERE EXISTS(SELECT 1 FROM workpivot.capture_sources WHERE plan_id=$1)`,[planId,action]);
}
