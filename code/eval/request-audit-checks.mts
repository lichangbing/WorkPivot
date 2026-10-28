import {NetworkTargets,approvedTargets} from '../packages/server/src/database/network-targets.js';
import {transaction} from '../packages/server/src/database/connection.js';
import {newAutomationConfig} from '../packages/shared/src/index.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {RequestAudits} from '../packages/server/src/database/request-audit.js';
import {createDatabaseApp} from '../packages/server/src/database/app.js';
export async function auditChecks(admin:Pool,auth:Pool,db:Pool,secret:string,actor:string,token:string,memberToken:string,check:(value:unknown,label:string)=>void){
 const audits=new RequestAudits(auth),app=await createDatabaseApp(auth,db,secret);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
 try{
  const request=(path:string,bearer?:string,body?:string)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(bearer?{authorization:'Bearer '+bearer}:{}),'content-type':'application/json'},...(body===undefined?{}:{body})});
  check((await request('/api/tasks?PRIVATE_QUERY_SECRET=1')).status===401,'匿名权限拒绝进入请求审计');
  check((await request('/api/tasks',token,'{PRIVATE_BODY_SECRET')).status===400,'JSON解析之前创建审计，畸形正文不落库');
  check((await request('/api/admin/request-audits',memberToken)).status===403,'成员不能查询全站审计');
  check((await request('/api/admin/request-audits/export',memberToken)).status===403,'成员不能导出审计');
  for(let i=0;i<50;i++){if((await auth.query('SELECT count(*)::int n FROM identity.request_audit_results')).rows[0].n>=4)break;await new Promise(r=>setTimeout(r,10));}
  const entries=await audits.list(token,{});
  check(entries.rows.length===4&&entries.rows.filter(row=>row.outcome==='denied').length===3&&entries.rows.some(row=>row.status===400),'请求结束追加真实响应状态');
  check(entries.rows.every(row=>typeof row.description==='string'&&row.description.includes('·')&&!row.description.includes(row.id)),'审计返回中文操作描述且不混入请求ID');
  check(!JSON.stringify(entries).includes('PRIVATE_'),'审计不包含查询字符串、正文或令牌');
  check((await audits.list(token,{actor:'anonymous',outcome:'denied'})).rows.length===1,'匿名和拒绝筛选生效');
  const id=randomUUID();await auth.query("INSERT INTO identity.request_audit(id,actor_id,method,area) VALUES($1,$2,'POST','tasks')",[id,actor]);
  check((await audits.list(token,{outcome:'pending'})).rows.some(row=>row.id===id),'没有结束记录时显示未确认，不误报成功');
  await auth.query("INSERT INTO identity.request_audit_results(request_id,status,outcome) VALUES($1,200,'disconnected')",[id]);
  check((await audits.list(token,{outcome:'disconnected'})).rows.some(row=>row.id===id),'连接中断独立于HTTP状态分类');
  const exported=await request('/api/admin/request-audits/export',token);
  check(exported.status===200&&exported.headers.get('content-disposition')?.includes('.jsonl')&&(await exported.text()).trim().split('\n').every(line=>JSON.parse(line).id),'导出带附件头且每行都是合法JSON');
  await assert.rejects(auth.query("UPDATE identity.request_audit SET area='tasks'"));
  await assert.rejects(auth.query('DELETE FROM identity.request_audit_results'));
  await assert.rejects(db.query('SELECT * FROM identity.request_audit'));
  check(true,'审计不可修改删除，业务数据库角色无法读取');
  await auth.query("INSERT INTO identity.request_audit(id,method,area,created_at) SELECT gen_random_uuid(),'GET','other','2026-01-01T01:02:03.123456Z' FROM generate_series(1,53)");
  const first=await audits.list(token,{area:'other'}),second=await audits.list(token,{area:'other',before:first.next});
  check(first.rows.length===50&&second.rows.length===3&&new Set([...first.rows,...second.rows].map(row=>row.id)).size===53,'同微秒请求分页无重复遗漏');
  check((await audits.list(token,{from:'2026-01-01',until:'2026-01-01',area:'other'})).rows.length===50,'日期筛选包含完整UTC结束日期');
  for(const query of [{from:'2026-02-31'},{from:'2026-02-01',until:'2026-01-01'},{outcome:'PRIVATE_SECRET'},{actor:['bad']},{before:randomUUID()}])await assert.rejects(audits.list(token,query));
  check(true,'查询数组、无效日期、未知游标和结果分类被拒绝');
  await auth.query("INSERT INTO identity.request_audit(id,method,area) SELECT gen_random_uuid(),'GET','files' FROM generate_series(1,10001)");
  await assert.rejects(audits.list(token,{area:'files'},true),/缩小/);check(true,'超过导出上限明确拒绝，不静默截断');
  const started=performance.now(),baseline=(await auth.query('SELECT count(*) n,clock_timestamp()::text at FROM identity.request_audit')).rows[0],beforeLoad=Number(baseline.n);
  const burst=await Promise.all(Array.from({length:40},(_,index)=>request('/api/tasks',token,index<30?undefined:'{"name":""}')));
  check(burst.slice(0,30).every(response=>response.status===200)&&burst.slice(30).every(response=>response.status===400),'40个并发读写请求正确区分成功和校验失败');
  for(let i=0;i<100;i++){const finished=Number((await auth.query('SELECT count(*) n FROM identity.request_audit a JOIN identity.request_audit_results r ON r.request_id=a.id WHERE a.created_at>=$1',[baseline.at])).rows[0].n);if(finished===40)break;await new Promise(r=>setTimeout(r,10));}
  check(Number((await auth.query('SELECT count(*) n FROM identity.request_audit a JOIN identity.request_audit_results r ON r.request_id=a.id WHERE a.created_at>=$1',[baseline.at])).rows[0].n)===40,'并发请求的结束记录均关联正确');
  check(Number((await auth.query('SELECT count(*) n FROM identity.request_audit')).rows[0].n)===beforeLoad+40,'并发请求审计不丢开始记录');
  console.log('隔离并发40请求耗时毫秒：'+Math.round(performance.now()-started));
  const grants=new NetworkTargets(auth,db),networkValue={url:'https://oa.internal/reports?id=1',address:'10.20.30.40'};
  await assert.rejects(grants.approve(memberToken,actor,networkValue));
  const grant=await grants.approve(token,actor,networkValue);
  await assert.rejects(grants.approve(token,actor,networkValue));
  const config={...newAutomationConfig(),webUrls:[networkValue.url],networkGrantIds:[grant.id]};
  check((await transaction(db,c=>approvedTargets(c,config),actor))[0].address===networkValue.address,'执行时从数据库取得目标IP，不采用模型提供的例外');
  const otherActor=(await auth.query('SELECT id FROM identity.users WHERE id<>$1 LIMIT 1',[actor])).rows[0].id;
  await assert.rejects(transaction(db,c=>approvedTargets(c,config),otherActor));
  await assert.rejects(transaction(db,c=>approvedTargets(c,{...config,webUrls:[networkValue.url.replace('id=1','id=2')]}),actor));
  check(true,'内网授权跨用户、路径和查询参数不能复用');
  const profileId=await transaction(db,async c=>(await c.query("INSERT INTO workpivot.browser_profiles(owner_user_id,name,login_url,urls,network_grant_ids,state_cipher) VALUES($1,'合成内网登录',$2,$3::jsonb,$4::jsonb,'{}'::jsonb) RETURNING id",[actor,networkValue.url,JSON.stringify([networkValue.url]),JSON.stringify([grant.id])])).rows[0].id,actor);
  await grants.revoke(token,actor,grant.id);
  check(await transaction(db,async c=>!(await c.query('SELECT state_cipher FROM workpivot.browser_profiles WHERE id=$1',[profileId])).rows[0].state_cipher&&(await c.query("SELECT 1 FROM workpivot.browser_profile_audit WHERE profile_id=$1 AND action='expired'",[profileId])).rowCount===1,actor),'撤销内网地址同时清除关联登录凭据并记录失效审计');
  await assert.rejects(transaction(db,c=>approvedTargets(c,config),actor));
  const grantView=await grants.list(token,actor);
  check(grantView.targets[0].revokedAt&&grantView.audit.length===2,'撤销立即拒绝后续读取，批准与撤销均有业务审计');
  await assert.rejects(transaction(db,c=>c.query('DELETE FROM workpivot.network_target_audit'),actor));
  check(true,'内网授权业务审计禁止修改删除');
  const oldId=randomUUID(),pendingId=randomUUID();
  await auth.query("INSERT INTO identity.request_audit(id,method,area,created_at) VALUES($1,'POST','tasks','2020-01-01'),($2,'POST','tasks','2020-01-01')",[oldId,pendingId]);
  await auth.query("INSERT INTO identity.request_audit_results(request_id,status,outcome,created_at) VALUES($1,200,'responded','2020-01-01')",[oldId]);
  const preview=await audits.cleanupPreview(token,'2020-02-01');check(preview.count===1,'清理预览只选择已结束记录');
  await assert.rejects(audits.cleanup(token,{...preview,confirmation:'wrong'}));
  await assert.rejects(audits.cleanup(memberToken,{...preview,confirmation:'永久清理安全审计'}));
  await assert.rejects(audits.cleanupPreview(token,'2100-01-01'));
  await assert.rejects(audits.cleanup(token,{...preview,fingerprint:'0'.repeat(32),confirmation:'永久清理安全审计'}));
  check(true,'清理拒绝未确认、成员、30天内范围和过期预览');
  check((await audits.cleanup(token,{...preview,confirmation:'永久清理安全审计'})).removed===1,'受限身份角色通过授权函数完成核对后的清理');
  check((await auth.query('SELECT id FROM identity.request_audit WHERE id=$1',[pendingId])).rowCount===1&&(await auth.query('SELECT id FROM identity.request_audit WHERE id=$1',[oldId])).rowCount===0,'未确认记录保留，只删除已核对的完整请求');
  check((await audits.cleanups(token))[0].removed===1,'永久清理与清理审计在同一事务保存');
  await assert.rejects(auth.query('DELETE FROM identity.request_audit_cleanups'));
  await assert.rejects(db.query('SELECT identity.cleanup_request_audit($1,$2,$3)',[actor,'2020-02-01',preview.fingerprint]));
  check(true,'清理记录不可删除，业务角色不能调用特权清理函数');
  await admin.query("CREATE FUNCTION identity.synthetic_request_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER synthetic_request_failure BEFORE INSERT ON identity.request_audit FOR EACH ROW EXECUTE FUNCTION identity.synthetic_request_failure()");
  try{check((await request('/api/tasks',token,JSON.stringify({name:'must-not-create'}))).status===503,'开始审计不可用时拒绝执行业务');}
  finally{await admin.query('DROP TRIGGER synthetic_request_failure ON identity.request_audit; DROP FUNCTION identity.synthetic_request_failure()');}
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
