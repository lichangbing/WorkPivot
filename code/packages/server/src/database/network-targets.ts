import type {Pool,PoolClient} from 'pg';
import type {AutomationConfig} from '@workpivot/shared';
import {AccountRepository} from './accounts.js';
import {RepositoryError,transaction,uuid} from './connection.js';
import {networkTarget,type NetworkTarget} from '../web/network-target.js';
import {webUrl} from '../web/safe-http.js';
/** 每次执行重新读取授权，模型只能选择标识，不能提供IP例外。 */
export async function approvedTargets(c:PoolClient,config:AutomationConfig):Promise<NetworkTarget[]>{
 const ids=config.networkGrantIds??[];
 const rows=ids.length?(await c.query('SELECT url,address FROM workpivot.network_targets WHERE id=ANY($1::uuid[]) AND revoked_at IS NULL',[ids])).rows:[];
 if(rows.length!==ids.length)throw new RepositoryError(409,'内网地址授权已撤销或不可访问，请重新选择授权');
 const targets=rows.map(networkTarget);
 try{for(const url of config.webUrls??[])webUrl(url,undefined,undefined,targets);}catch{throw new RepositoryError(403,'网页地址没有有效的内网授权');}
 return targets;
}
export class NetworkTargets {
 constructor(private readonly auth:Pool,private readonly db:Pool){}
 private async admin(token:string,owner:string){uuid(owner);const accounts=new AccountRepository(this.auth),user=await accounts.resolve(token);if(!user||user.role!=='admin'||user.mustChangePassword)throw new RepositoryError(403,'需要有效管理员登录');if(!(await accounts.listUsers(token)).some(row=>row.id===owner))throw new RepositoryError(404,'用户不存在');return user;}
 async list(token:string,owner:string){await this.admin(token,owner);return transaction(this.db,async c=>({targets:(await c.query('SELECT id,url,address,revoked_at AS "revokedAt",created_at AS "createdAt" FROM workpivot.network_targets ORDER BY revoked_at NULLS FIRST,created_at DESC,id DESC LIMIT 200')).rows,audit:(await c.query('SELECT id,target_id AS "targetId",actor_id AS "actorId",action,created_at AS "createdAt" FROM workpivot.network_target_audit ORDER BY created_at DESC,id DESC LIMIT 100')).rows}),owner);}
 async approve(token:string,owner:string,value:unknown){const actor=await this.admin(token,owner);let target:NetworkTarget;try{target=networkTarget(value);}catch{throw new RepositoryError(400,'填写完整内网URL和固定RFC1918/ULA地址；仅80、443、8080、8443端口');}
  return transaction(this.db,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['network-target:'+owner]);
   if((await c.query('SELECT 1 FROM workpivot.network_targets WHERE revoked_at IS NULL AND url=$1',[target.url])).rowCount)throw new RepositoryError(409,'此完整地址已有有效授权，修改时先撤销旧规则');
   if((await c.query('SELECT count(*)::int n FROM workpivot.network_targets WHERE revoked_at IS NULL')).rows[0].n>=100)throw new RepositoryError(409,'每个用户最多100条有效内网授权');
   const id=(await c.query('INSERT INTO workpivot.network_targets(owner_user_id,url,address,created_by) VALUES($1,$2,$3,$4) RETURNING id',[owner,target.url,target.address,actor.id])).rows[0].id;
   await c.query("INSERT INTO workpivot.network_target_audit(owner_user_id,target_id,actor_id,action) VALUES($1,$2,$3,'approve')",[owner,id,actor.id]);return {id};
  },owner);
 }
 async revoke(token:string,owner:string,id:string){const actor=await this.admin(token,owner);uuid(id);return transaction(this.db,async c=>{
  const changed=await c.query('UPDATE workpivot.network_targets SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL RETURNING id',[id]);
  if(!changed.rowCount)throw new RepositoryError(409,'授权不存在或已撤销');
  await c.query("INSERT INTO workpivot.network_target_audit(owner_user_id,target_id,actor_id,action) VALUES($1,$2,$3,'revoke')",[owner,id,actor.id]);
  await c.query("UPDATE workpivot.automations SET state='blocked',grant_id=NULL,next_at=NULL,revision=revision+1,issue='内网地址授权已撤销，请重新编辑确认' WHERE state<>'deleted' AND (config->'networkGrantIds' ? $1 OR config->>'browserProfileId' IN (SELECT id::text FROM workpivot.browser_profiles WHERE network_grant_ids ? $1))",[id]);
  await c.query("UPDATE workpivot.automation_runs SET revoked=true,finished_at=CASE WHEN status IN ('queued','waiting_login') THEN now() ELSE finished_at END,status=CASE WHEN status IN ('queued','waiting_login') THEN 'cancelled' ELSE status END,error='内网地址授权已撤销' WHERE status IN ('queued','waiting_login','running') AND (config->'networkGrantIds' ? $1 OR config->>'browserProfileId' IN (SELECT id::text FROM workpivot.browser_profiles WHERE network_grant_ids ? $1))",[id]);
  const profiles=(await c.query('UPDATE workpivot.browser_profiles SET state_cipher=NULL,revision=revision+1 WHERE revoked_at IS NULL AND network_grant_ids ? $1 RETURNING id',[id])).rows;
  for(const profile of profiles)await c.query("INSERT INTO workpivot.browser_profile_audit(owner_user_id,profile_id,actor_id,action) VALUES($1,$2,$3,'expired')",[owner,profile.id,actor.id]);
  return {ok:true};
 },owner);}
}
