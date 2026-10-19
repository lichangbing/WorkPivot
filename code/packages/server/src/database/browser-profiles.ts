import {loginState} from '../web/login-state.js';
import {createHmac,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {createAesBox,type SecretEnvelope} from '../secret.js';
import type {LoginState} from '../web/browser-engine.js';
import type {BrowserConfiguration} from '../web/tools.js';
import {webUrl} from '../web/safe-http.js';
import {RepositoryError,transaction,uuid} from './connection.js';
import {approvedTargets} from './network-targets.js';
import {newAutomationConfig} from '@workpivot/shared';
const columns='id,name,login_url AS "loginUrl",urls,network_grant_ids AS "networkGrantIds",revision,revoked_at AS "revokedAt",(state_cipher IS NOT NULL) AS ready,lease_id AS "leaseId",lease_kind AS "leaseKind",lease_until AS "leaseUntil"';
export class BrowserProfiles {
 private readonly box;
 constructor(private readonly db:Pool,key:string,private readonly config?:BrowserConfiguration){this.box=createAesBox(key);}
 private key(actor:string,id:string,lease:string){if(!this.config)throw new RepositoryError(503,'浏览器服务尚未启用');return createHmac('sha256',this.config.token).update('private-login:'+actor+':'+id+':'+lease).digest('hex');}
 private async remote(actor:string,id:string,lease:string,body:Record<string,unknown>){
  const key=this.key(actor,id,lease),config=this.config!;
  const response=await fetch(config.url+'/v1/logins/'+key,{method:'POST',headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(['heartbeat','close'].includes(String(body.kind))?5000:30000)});
  if(!response.body)throw new RepositoryError(502,'登录窗口响应为空');
  const chunks:Uint8Array[]=[];let size=0;const reader=response.body.getReader();try{for(;;){const result=await reader.read();if(result.done)break;size+=result.value.length;if(size>8*1024*1024)throw new RepositoryError(502,'登录窗口响应过大');chunks.push(result.value);}}finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  if(!response.ok)throw new RepositoryError(422,'登录窗口操作失败或已过期，请重新打开窗口');
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>;
 }
 private audit(c:PoolClient,actor:string,id:string,action:string){return c.query('INSERT INTO workpivot.browser_profile_audit(owner_user_id,profile_id,actor_id,action) VALUES($1,$2,$1,$3)',[actor,id,action]);}
 private async get(c:PoolClient,id:string){uuid(id);const row=(await c.query('SELECT * FROM workpivot.browser_profiles WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row||row.revoked_at)throw new RepositoryError(404,'登录配置不存在或已撤销');return row;}
 private targets(c:PoolClient,row:{urls:string[];network_grant_ids:string[]}){return approvedTargets(c,{...newAutomationConfig(),webUrls:row.urls,networkGrantIds:row.network_grant_ids});}
 private decrypt(actor:string,id:string,cipher:SecretEnvelope|null):LoginState|undefined{if(!cipher)return undefined;try{const value=JSON.parse(this.box.decrypt(cipher));if(value.actor!==actor||value.id!==id)throw Error();const state=loginState(value.state);if(!state)throw Error();return state;}catch{throw new RepositoryError(409,'登录状态无法解密，请撤销配置并重新登录');}}
 async list(actor:string){return transaction(this.db,async c=>({available:!!this.config,profiles:(await c.query(`SELECT ${columns} FROM workpivot.browser_profiles ORDER BY created_at DESC LIMIT 100`)).rows,networkTargets:(await c.query('SELECT id,url,address FROM workpivot.network_targets WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 100')).rows,audit:(await c.query('SELECT id,profile_id AS "profileId",action,created_at AS "createdAt" FROM workpivot.browser_profile_audit ORDER BY created_at DESC LIMIT 100')).rows}),actor);}
 async create(actor:string,input:Record<string,unknown>){
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100||typeof input.loginUrl!=='string'||!Array.isArray(input.urls)||input.urls.length<1||input.urls.length>20||input.urls.some(url=>typeof url!=='string')||!Array.isArray(input.networkGrantIds)||input.networkGrantIds.length>20)throw new RepositoryError(400,'请填写名称、登录地址和最多20个完整地址');
  input.networkGrantIds.forEach(id=>uuid(String(id)));const name=input.name.trim(),loginUrl=input.loginUrl,urls=input.urls as string[],ids=input.networkGrantIds as string[];
  return transaction(this.db,async c=>{
   const targets=await this.targets(c,{urls,network_grant_ids:ids});const normalized=[...new Set(urls.map(url=>webUrl(url,undefined,undefined,targets).href))];webUrl(loginUrl,undefined,normalized,targets);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['browser-profile:'+actor]);
   if((await c.query('SELECT count(*)::int n FROM workpivot.browser_profiles WHERE revoked_at IS NULL')).rows[0].n>=20)throw new RepositoryError(409,'最多20个有效私人登录配置');
   const id=(await c.query('INSERT INTO workpivot.browser_profiles(owner_user_id,name,login_url,urls,network_grant_ids) VALUES($1,$2,$3,$4,$5) RETURNING id',[actor,name,webUrl(loginUrl,undefined,normalized,targets).href,JSON.stringify(normalized),JSON.stringify(ids)])).rows[0].id;
   await this.audit(c,actor,id,'create');return {id};
  },actor);
 }
 async open(actor:string,id:string,revision:unknown){
  if(!this.config)throw new RepositoryError(503,'浏览器服务尚未启用');
  const lease=randomUUID();const data=await transaction(this.db,async c=>{const row=await this.get(c,id);if(row.revision!==revision)throw new RepositoryError(409,'登录配置已变化，请刷新');if(row.lease_until&&new Date(row.lease_until)>new Date())throw new RepositoryError(409,'登录配置正被其他窗口或自动化占用');const targets=await this.targets(c,row);
   await c.query("UPDATE workpivot.browser_profiles SET lease_id=$2,lease_kind='manual',lease_until=now()+interval '20 minutes' WHERE id=$1",[id,lease]);await this.audit(c,actor,id,'open');return {url:row.login_url,urls:row.urls,targets,state:this.decrypt(actor,id,row.state_cipher)};
  },actor);
  try{const frame=await this.remote(actor,id,lease,{kind:'start',...data});await this.checkManual(actor,id,lease);return {...frame,leaseId:lease};}
  catch(error){await this.cancel(actor,id,lease).catch(()=>undefined);throw error;}
 }
 private async checkManual(actor:string,id:string,lease:string){uuid(lease);return transaction(this.db,async c=>{const row=await this.get(c,id);if(row.lease_id!==lease||row.lease_kind!=='manual'||!row.lease_until||new Date(row.lease_until)<=new Date())throw new RepositoryError(409,'登录窗口已失效');await this.targets(c,row);return row;},actor);}
 async frame(actor:string,id:string,lease:string){await this.checkManual(actor,id,lease);const frame=await this.remote(actor,id,lease,{kind:'frame'});await this.checkManual(actor,id,lease);return frame;}
 async command(actor:string,id:string,lease:string,input:Record<string,unknown>){
  if(!['allow','navigate','reload','click','text','key','scroll'].includes(String(input.kind)))throw new RepositoryError(400,'登录操作不受支持');
  await this.checkManual(actor,id,lease);
  if(input.kind==='allow')await transaction(this.db,async c=>{const row=await this.get(c,id);if(row.lease_id!==lease)throw new RepositoryError(409,'登录窗口已变化');const targets=await this.targets(c,row);const url=webUrl(input.url,undefined,undefined,targets).href;if(!row.urls.includes(url)){if(row.urls.length>=20)throw new RepositoryError(400,'登录完整地址最多20项');await c.query('UPDATE workpivot.browser_profiles SET urls=$2,revision=revision+1 WHERE id=$1',[id,JSON.stringify([...row.urls,url])]);await this.audit(c,actor,id,'allow_url');}},actor);
  // 只传递手动操作字段，不能把用户伪造的state、targets等内部参数转给浏览器。
  const frame=await this.remote(actor,id,lease,{kind:input.kind,url:input.url,x:input.x,y:input.y,text:input.text,key:input.key,pixels:input.pixels});await this.checkManual(actor,id,lease);return frame;
 }
 async save(actor:string,id:string,lease:string){await this.checkManual(actor,id,lease);const value=await this.remote(actor,id,lease,{kind:'state'});if(!value.state||Buffer.byteLength(JSON.stringify(value.state))>256*1024)throw new RepositoryError(422,'登录状态大小或格式无效');
  const cipher=this.box.encrypt(JSON.stringify({actor,id,state:loginState(value.state)}));await transaction(this.db,async c=>{const row=await this.get(c,id);if(row.lease_id!==lease||row.lease_kind!=='manual'||new Date(row.lease_until)<=new Date())throw new RepositoryError(409,'登录窗口已失效');await this.targets(c,row);await c.query('UPDATE workpivot.browser_profiles SET state_cipher=$2,revision=revision+1,lease_id=NULL,lease_kind=NULL,lease_until=NULL WHERE id=$1',[id,cipher]);await this.audit(c,actor,id,'save');},actor);
  await this.remote(actor,id,lease,{kind:'close'}).catch(()=>undefined);return {ok:true};
 }
 async cancel(actor:string,id:string,lease:string){uuid(id);uuid(lease);await transaction(this.db,async c=>{const changed=await c.query('UPDATE workpivot.browser_profiles SET lease_id=NULL,lease_kind=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2',[id,lease]);if(changed.rowCount)await this.audit(c,actor,id,'cancel');},actor);await this.remote(actor,id,lease,{kind:'close'}).catch(()=>undefined);return {ok:true};}
 async revoke(actor:string,id:string,revision:unknown){const lease=await transaction(this.db,async c=>{const row=await this.get(c,id);if(row.revision!==revision)throw new RepositoryError(409,'配置已变化，请刷新');await c.query('UPDATE workpivot.browser_profiles SET revoked_at=now(),state_cipher=NULL,revision=revision+1,lease_id=NULL,lease_kind=NULL,lease_until=NULL WHERE id=$1',[id]);await this.audit(c,actor,id,'revoke');
  await c.query("UPDATE workpivot.automations SET state='blocked',grant_id=NULL,next_at=NULL,revision=revision+1,issue='登录配置已撤销' WHERE state<>'deleted' AND config->>'browserProfileId'=$1",[id]);
  await c.query("UPDATE workpivot.automation_runs SET revoked=true,status=CASE WHEN status IN ('queued','waiting_login') THEN 'cancelled' ELSE status END,error='登录配置已撤销' WHERE status IN ('queued','waiting_login','running') AND config->>'browserProfileId'=$1",[id]);return row.lease_kind==='manual'?row.lease_id:null;
 },actor);if(lease)await this.remote(actor,id,lease,{kind:'close'}).catch(()=>undefined);return {ok:true};}
 async acquire(actor:string,id:string,minutes:number){return transaction(this.db,async c=>{const row=await this.get(c,id);await this.targets(c,row);if(!row.state_cipher||row.lease_until&&new Date(row.lease_until)>new Date())return null;const lease=randomUUID();const state=this.decrypt(actor,id,row.state_cipher)!;await c.query("UPDATE workpivot.browser_profiles SET lease_id=$2,lease_kind='automation',lease_until=now()+$3*interval '1 minute' WHERE id=$1",[id,lease,minutes+1]);await this.audit(c,actor,id,'lease');return {lease,state};},actor);}
 async invalidate(actor:string,id:string,lease:string){await transaction(this.db,async c=>{const changed=await c.query('UPDATE workpivot.browser_profiles SET state_cipher=NULL,revision=revision+1 WHERE id=$1 AND lease_id=$2',[id,lease]);if(changed.rowCount)await this.audit(c,actor,id,'expired');},actor);}
 async release(actor:string,id:string,lease:string){await transaction(this.db,async c=>{const changed=await c.query('UPDATE workpivot.browser_profiles SET lease_id=NULL,lease_kind=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2',[id,lease]);if(changed.rowCount)await this.audit(c,actor,id,'release');},actor);}
 async reap(actor:string,disabled=false){const rows=await transaction(this.db,async c=>(await c.query("SELECT * FROM workpivot.browser_profiles WHERE lease_kind='manual' AND lease_id IS NOT NULL")).rows,actor);for(const row of rows){let invalid=disabled||row.revoked_at||new Date(row.lease_until)<=new Date();if(!invalid)try{await transaction(this.db,c=>this.targets(c,row),actor);}catch{invalid=true;}if(!invalid&&new Date(row.lease_until).getTime()-Date.now()>19.5*60000)continue;if(!invalid)try{await this.remote(actor,row.id,row.lease_id,{kind:'heartbeat'});}catch{invalid=true;}if(invalid)await this.cancel(actor,row.id,row.lease_id);}}
}
