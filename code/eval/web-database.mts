import {BrowserProfiles} from '../packages/server/src/database/browser-profiles.js';
import {NetworkTargets} from '../packages/server/src/database/network-targets.js';
import {BrowserEngine} from '../packages/server/src/web/browser-engine.js';
import {browserService} from '../packages/server/src/web/browser-service.js';
import {createDatabaseApp} from '../packages/server/src/database/app.js';
import {TrashRepository} from '../packages/server/src/database/trash.js';
import {AdminOperations} from '../packages/server/src/database/admin-operations.js';
import {Captures} from '../packages/server/src/database/captures.js';
import {schemaUpgrades} from '../packages/server/src/database/schema.js';
/** 隔离 PostgreSQL + 可控网页/模型，验证真实授权、计划快照和撤销。 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelClient, StreamEvent } from '../packages/core/src/index.js';
import { pool, installSchema } from '../packages/server/src/database/connection.js';
import { AccountRepository } from '../packages/server/src/database/accounts.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { FileRepository } from '../packages/server/src/database/files.js';
import { DatabaseSkills } from '../packages/server/src/database/skills.js';
import { DatabaseExecution } from '../packages/server/src/database/execution.js';
import { Automations } from '../packages/server/src/database/automations.js';
import { AutomationWorker } from '../packages/server/src/database/automation-worker.js';
import { newAutomationConfig } from '../packages/shared/src/index.js';
import { SafeHttp, webUrl, type WebPolicy } from '../packages/server/src/web/safe-http.js';
import { WebTools } from '../packages/server/src/web/tools.js';
import { BrowserWorkspace } from '../packages/server/src/web/browser-workspace.js';

const url = process.env.WORKPIVOT_TEST_PG_URL;
if (!url || process.env.WORKPIVOT_TEST_PG_DISPOSABLE !== '1' || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/workpivot_test') throw Error('只允许隔离测试数据库');
const secret = randomBytes(32).toString('hex'), admin = pool(url);
const role = (name: string) => { const u = new URL(url); u.username = name; u.password = secret; return u.href; };
const db = pool(role('web_app')), auth = pool(role('web_auth')), root = await mkdtemp(join(tmpdir(), 'wp-web-'));
let acceptLogin=true;
let bodyText = '网页合成正文42',retryCount=0,feedMode=false,rawSuffix='';
let count = 0, requests = 0, hold: (() => void) | undefined, entered: (() => void) | undefined;
const check = (value: unknown, name: string) => { assert(value, name); count++; console.log('PASS', name); };
class Fixture extends SafeHttp {
  override async get(url: string, policy: WebPolicy = {}) {
    webUrl(url, policy.origins,policy.urls,policy.targets); policy.signal?.throwIfAborted(); requests++;
    if(url==='https://fixture.example/login/session'&&policy.browserRequest?.method==='POST')return {url,status:302,headers:{'content-type':'text/html; charset=utf-8',location:'https://fixture.example/login/report'},setCookies:['profile-cookie=synthetic-profile-cookie; Path=/; Secure; HttpOnly'],body:Buffer.alloc(0)};
    if(url==='https://fixture.example/login/report')return {url,status:acceptLogin&&policy.browserRequest?.headers.cookie?.includes('profile-cookie=synthetic-profile-cookie')?200:401,headers:{'content-type':'text/html; charset=utf-8'},body:Buffer.from('<html><body>私人报告</body></html>')};
    if(url==='https://fixture.example/login/start')return {url,status:200,headers:{'content-type':'text/html; charset=utf-8'},body:Buffer.from('<html><body><form action="/login/session" method="POST"><input name="password" type="password" style="position:absolute;left:20px;top:20px;width:200px;height:30px"><button type="submit" style="position:absolute;left:20px;top:70px;width:100px;height:30px">登录</button></form></body></html>')};
    if (entered) { entered(); await new Promise<void>(resolve => { hold = resolve; }); }
    return { url, retryCount,status: 200, headers: { 'content-type': feedMode?'application/rss+xml':'text/html' }, body: Buffer.from(feedMode?`<rss version="2.0"><channel><title>合成订阅</title><item><guid>item-1</guid><title>合成条目</title><description>${bodyText}</description><link>https://other.example/not-approved</link></item></channel></rss>`:`<html><head><title>公告</title></head><body>${bodyText}</body><!--${rawSuffix}--></html>`) };
  }
}
const engine=new BrowserEngine(new Fixture(),{executablePath:process.env.WORKPIVOT_TEST_CHROME||'/usr/bin/google-chrome'}),service=browserService(secret,engine),browserServer=service.app.listen(0,'127.0.0.1');
await new Promise<void>(resolve=>browserServer.once('listening',resolve));const browserAddress=browserServer.address();if(!browserAddress||typeof browserAddress==='string')throw Error('测试浏览器服务未启动');
const web = new WebTools({url:'http://127.0.0.1:'+browserAddress.port,token:secret});
const call = (name: string, args: unknown): StreamEvent => ({ type: 'tool_calls', tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
let scheduler: AutomationWorker | undefined;
try {
  await admin.query(`CREATE ROLE web_app LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;CREATE ROLE web_auth LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  await installSchema(admin, 'web_app', 'web_auth');
  const accounts = new AccountRepository(auth), user = await accounts.registerFirst('owner', 'synthetic-password', secret, secret), actor = user.user.id;
  const other = (await accounts.createUser(user.token, 'other', 'synthetic-password', 'member')).id;
  const workspace = new WorkspaceRepository(db), project = await workspace.createProject(actor, '网页采集'), files = new FileRepository(db, root);
  const ownedTask=await workspace.createTask(actor,'共享浏览器隔离',project.id);
  const broker=new BrowserWorkspace(db,{url:'http://127.0.0.1:1',token:secret});
  check(broker.key(actor,ownedTask.id)!==broker.key(other,ownedTask.id),'共享浏览器会话按账号和任务隔离');
  assert.deepEqual(await new BrowserWorkspace(db).request(actor,ownedTask.id),{available:false,open:false});
  await assert.rejects(new BrowserWorkspace(db).request(other,ownedTask.id));check(true,'其他用户不能读取或操作该对话浏览器');
  const model: ModelClient = { providerId: 'fixture', model: 'fixture', async *streamChat(messages) {
    if (!messages.some(m => m.role === 'tool')) yield call('web_fetch', { url: 'https://fixture.example' });
    else yield { type: 'delta', text: '已完成。' };
  } };
  const execution = new DatabaseExecution(db, async () => ({ client: model, tools: web.tools(async () => undefined), taskDir: '.', filePolicy: () => false }));
  for (const decision of ['deny', 'allow'] as const) {
    const task = await workspace.createTask(actor, '读取网页' + decision, project.id);
    const before = requests, begun = await execution.begin(actor, task.id, '读取网页', randomUUID());
    const running = begun.execute!(event => {
      if (event.type === 'permission_request') void execution.runs.decidePermission(actor, task.id, event.id, decision);
    });
    check(await running === 'completed', '对话授权决定后正常结束：' + decision);
    check(requests === before + (decision === 'allow' ? 1 : 0), '拒绝零请求，允许才抓取：' + decision);
  }
  const skills = new DatabaseSkills(db); let skill = await skills.create(actor, 'web-collect');
  skill = await skills.save(actor, skill.name, 'SKILL.md', Buffer.from('---\nname: web-collect\ndescription: 读取公开网页并保存结果\n---\n先读取网页，再将符合要求的正文保存为result.txt。'), skill.revision);
  await skills.publish(actor, skill.name, skill.revision); await skills.select(actor, skill.name, true);
  const release = (await skills.market(actor))[0]!.version, plans = new Automations(db, true,true);
  const profiles=new BrowserProfiles(db,secret,{url:"http://127.0.0.1:"+browserAddress.port,token:secret});
  let rawReachedModel=false;
  let mode: 'login' | 'internal' | 'normal' | 'foreign' | 'path' | 'query' | 'repeat' | 'fail' | 'browser_repeat' = 'normal';
  const automaticModel: ModelClient = { providerId: 'fixture', model: 'automatic', async *streamChat(messages) {
    const results = messages.filter(m => m.role === 'tool');
    if(results.some(result=>result.content.includes('"original":')||result.content.includes('只存在原始响应中的标记')))rawReachedModel=true;
    if (!results.length) yield call('load_skill', { name: skill.name });
    else if (results.length === 1) yield call(['browser_repeat','login'].includes(mode)?'browser_visit':'web_fetch', { url: mode==='login'?'https://fixture.example/login/report':mode === 'internal' ? 'https://oa.internal/report' : mode === 'foreign' ? 'https://other.example' : mode==='path'?'https://fixture.example/other':mode==='query'?'https://fixture.example/?export=secret':'https://fixture.example' });
    else if (results.length === 2 && mode === 'fail') throw Error('合成模型故障');
    else if (results.length === 2 && ['repeat','browser_repeat'].includes(mode)) yield call(['browser_repeat','login'].includes(mode)?'browser_visit':'web_fetch', {url:'https://fixture.example'});
    else if (results.length === 2 || (results.length === 3 && ['repeat','browser_repeat'].includes(mode))) yield call('save_artifact', { name: 'result.txt', content: results.at(-1)!.content });
    else yield { type: 'delta', text: '已保存。' };
  } };
  scheduler = new AutomationWorker(auth, plans, files, { url: 'http://127.0.0.1:1', token: secret }, async () => automaticModel, web,profiles);
  const config = { ...newAutomationConfig(), name: '公开网页采集', skill: skill.name, releaseId: release, projectId: project.id, requirements: '读取公开网页正文并保存', webUrls: ['https://fixture.example/'] };
  const run = async (origins: string[]) => {
    let plan = await plans.draft(actor, { ...config, webUrls: origins }, randomUUID()); plan = await plans.confirm(actor, plan.id, plan.revision, true);
    const job = await plans.manual(actor, plan.id, plan.revision, randomUUID());
    await scheduler!.tick(); return { plan, detail: await plans.detail(actor, plan.id), job };
  };
  const before = requests, success = await run(config.webUrls);
  check(success.detail.runs[0]?.status === 'completed' && requests === before + 1, '授权来源自动化可抓取并完成');
  const artifacts = await files.list(actor, success.detail.runs[0]!.taskId!, 'artifact');
  check(artifacts.length === 1 && (await files.download(actor, success.detail.runs[0]!.taskId!, artifacts[0]!.id)).data.toString().includes('网页合成正文42'), '网页结果通过真实文件仓库发布');
  assert.equal((await plans.list(other)).length, 0); check(true, '其他账号不能查看采集计划');
  const captures = new Captures(db);
  const first = (await captures.list(actor,success.plan.id)).items[0]!;
  check(first.changed && first.revision === 1,'首次采集建立正文版本');
  check((await captures.view(actor,success.plan.id,first.versionId)).content.text.includes(bodyText),'创建者可以读取版本正文');
  await assert.rejects(captures.list(other,success.plan.id));
  await assert.rejects(captures.view(other,success.plan.id,first.versionId));check(true,'其他用户不能列出或读取采集正文');
  const rerun=async()=>{const p=await plans.detail(actor,success.plan.id);await plans.manual(actor,p.id,p.revision,randomUUID());await scheduler!.tick();return (await captures.list(actor,p.id)).items[0]!;};
  retryCount=2;const same=await rerun();retryCount=0;check(same.retryCount===2,'采集重试次数独立持久化且不改变正文版本');check(!same.changed&&same.versionId===first.versionId,'新运行重新抓取，正文不变时复用版本');
  bodyText='更新后的合成正文43';const changed=await rerun();check(changed.changed&&changed.revision===2&&changed.versionId!==first.versionId,'正文变化新增版本');
  bodyText='网页合成正文42';check((await rerun()).revision===3,'正文恢复旧内容仍建立新版本，保留变化历史');
  rawSuffix='只存在原始响应中的标记';const rawChanged=await rerun();
  check(rawChanged.changed&&rawChanged.revision===4,'解析正文不变但原始响应改变时新增版本');
  const original=await captures.download(actor,success.plan.id,rawChanged.versionId);
  check(original.toString().includes(rawSuffix),'原始存档保留解析正文之外的响应字节');
  check(!rawReachedModel,'原始正文不会进入模型上下文');
  await admin.query('UPDATE workpivot.capture_versions SET original_body=$2 WHERE id=$1',[rawChanged.versionId,Buffer.from('合成篡改')]);
  await assert.rejects(captures.download(actor,success.plan.id,rawChanged.versionId),/完整性/);check(true,'原始字节哈希不符时拒绝下载');
  await admin.query('UPDATE workpivot.capture_versions SET original_body=$2 WHERE id=$1',[rawChanged.versionId,original]);
  await assert.rejects(captures.download(other,success.plan.id,rawChanged.versionId));check(true,'其他用户不能下载私人原始存档');
  const app=(await createDatabaseApp(auth,db,secret,undefined,undefined,undefined,undefined,files)).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>app.once('listening',resolve));
  try{const addr=app.address();if(!addr||typeof addr==='string')throw Error('测试服务未启动');
   const response=await fetch(`http://127.0.0.1:${addr.port}/api/automations/${success.plan.id}/captures/${rawChanged.versionId}/original`,{headers:{authorization:'Bearer '+user.token}});
   check(response.ok&&response.headers.get('content-type')?.startsWith('application/octet-stream')&&response.headers.get('content-disposition')?.includes('attachment')&&response.headers.get('x-content-type-options')==='nosniff'&&(await response.text()).includes(rawSuffix),'真实下载接口强制附件并返回原始字节');
  }finally{app.closeAllConnections();await new Promise<void>(resolve=>app.close(()=>resolve()));}
  rawSuffix='';
  mode='repeat';const repeatBefore=requests;const repeated=await run(config.webUrls);mode='normal';
  check(requests===repeatBefore+1&&(await captures.list(actor,repeated.plan.id)).items.length===1,'同一运行重复HTTP读取复用快照并只发一次请求');
  mode='fail';const failed=await run(config.webUrls);mode='normal';
  check(failed.detail.runs[0]?.status==='failed'&&(await captures.list(actor,failed.plan.id)).items.length===1,'模型后续失败仍保留已成功采集的正文');
  check(!(await files.list(actor,failed.detail.runs[0]!.taskId!,'artifact')).length,'采集快照不会被误认为失败运行的正式成果');
  feedMode=true;const feedBefore=requests,subscription=await run(config.webUrls);feedMode=false;
  const feedHistory=(await captures.list(actor,subscription.plan.id)).items[0]!;
  const feedVersion=await captures.view(actor,subscription.plan.id,feedHistory.versionId);
  check(feedVersion.content.feed.entries[0].id==='item-1'&&feedVersion.content.feed.totalEntries===1,'RSS结构化条目随采集快照持久化并可查看');
  check(requests===feedBefore+1,'订阅链接未授权时不自动访问，只请求已确认的订阅地址');
  feedMode=true;await plans.manual(actor,subscription.plan.id,subscription.plan.revision,randomUUID());await scheduler.tick();feedMode=false;
  const repeatFeed=(await captures.list(actor,subscription.plan.id)).items[0]!;
  check(!repeatFeed.changed&&repeatFeed.versionId===feedHistory.versionId,'相同订阅跨运行复用版本且保留新的采集记录');
  mode='browser_repeat';const browserPlan=await run(config.webUrls);mode='normal';
  const browserHistory=(await captures.list(actor,browserPlan.plan.id)).items;
  const dom=await captures.view(actor,browserPlan.plan.id,browserHistory[0]!.versionId);
  check(dom.originalKind==='bundle'&&(await captures.download(actor,browserPlan.plan.id,dom.id)).toString().includes('<html>'),'真实浏览器DOM经执行器持久化并可下载');
  check(browserHistory.length===2&&browserHistory[0]!.versionId===browserHistory[1]!.versionId,'浏览器每次真实执行并保留观察记录，相同DOM复用版本');
  check(!rawReachedModel,'DOM原始字节不会进入模型上下文');
  const network=new NetworkTargets(auth,db),rule=await network.approve(user.token,actor,{url:'https://oa.internal/report',address:'10.20.30.40'});
  let privatePlan=await plans.draft(actor,{...config,webUrls:['https://oa.internal/report'],networkGrantIds:[rule.id]},randomUUID());
  privatePlan=await plans.confirm(actor,privatePlan.id,privatePlan.revision,true);await plans.manual(actor,privatePlan.id,privatePlan.revision,randomUUID());
  mode='internal';await scheduler.tick();mode='normal';
  check((await plans.detail(actor,privatePlan.id)).runs[0]?.status==='completed','管理员规则经过计划确认、执行器、集中出口和采集落库完整链路');
  await plans.manual(actor,privatePlan.id,privatePlan.revision,randomUUID());await network.revoke(user.token,actor,rule.id);
  const revoked=await plans.detail(actor,privatePlan.id);check(revoked.state==='blocked'&&revoked.runs[0]?.status==='cancelled','撤销内网规则阻止计划并取消已排队运行');
  const profile=await profiles.create(actor,{name:'合成私人登录',loginUrl:'https://fixture.example/login/start',urls:['https://fixture.example/login/start','https://fixture.example/login/session','https://fixture.example/login/report'],networkGrantIds:[]});
  await assert.rejects(profiles.open(other,profile.id,1));check((await profiles.list(other)).profiles.length===0,'私人登录配置和接管不能被其他用户读取');
  let loginPlan=await plans.draft(actor,{...config,browserProfileId:profile.id,webUrls:['https://fixture.example/login/report']},randomUUID());loginPlan=await plans.confirm(actor,loginPlan.id,loginPlan.revision,true);
  await plans.manual(actor,loginPlan.id,loginPlan.revision,randomUUID());mode='login';await scheduler.tick();
  check((await plans.detail(actor,loginPlan.id)).runs[0]?.status==='waiting_login','无登录态时停止模型并进入等待登录状态');
  mode='normal';const whileWaiting=await run(config.webUrls);check(whileWaiting.detail.runs[0]?.status==='completed','人工登录等待释放执行槽，其他计划仍可完成');mode='login';
  const opened=await profiles.open(actor,profile.id,1),lease=String(opened.leaseId);
  await assert.rejects(profiles.open(actor,profile.id,1));check(true,'同一登录配置只能打开一个人工窗口');
  await profiles.command(actor,profile.id,lease,{kind:'click',x:50,y:35});await profiles.command(actor,profile.id,lease,{kind:'text',text:'synthetic-secret'});await profiles.command(actor,profile.id,lease,{kind:'click',x:50,y:80});
  for(let i=0;i<30;i++){if((await profiles.frame(actor,profile.id,lease)).url==='https://fixture.example/login/report')break;await new Promise(r=>setTimeout(r,50));}
  await profiles.save(actor,profile.id,lease);
  const encrypted=(await admin.query('SELECT state_cipher FROM workpivot.browser_profiles WHERE id=$1',[profile.id])).rows[0].state_cipher;
  check(encrypted.enc==='aes-256-gcm'&&!JSON.stringify(encrypted).includes('synthetic-profile-cookie'),'登录态以AES-GCM加密保存，列表不返回明文或密文');
  await assert.rejects(profiles.frame(actor,profile.id,lease));await scheduler.tick();
  check((await plans.detail(actor,loginPlan.id)).runs[0]?.status==='completed','保存登录态后等待运行自动恢复且只读浏览器完成采集');
  const borrowed=await profiles.acquire(actor,profile.id,1);assert(borrowed);await assert.rejects(profiles.open(actor,profile.id,2));await profiles.release(actor,profile.id,borrowed.lease);check(true,'自动化占用期间人工窗口不能覆盖登录态');
  await plans.manual(actor,loginPlan.id,loginPlan.revision,randomUUID());acceptLogin=false;await scheduler.tick();
  const expiredLogin=await plans.detail(actor,loginPlan.id);check(expiredLogin.runs[0]?.status==='waiting_login'&&!(await profiles.list(actor)).profiles[0].ready,'网站401使旧状态失效并转人工接管，不继续模型推断');
  await plans.stopRun(actor,loginPlan.id,expiredLogin.runs[0]!.id);check((await plans.detail(actor,loginPlan.id)).runs[0]?.status==='cancelled','等待登录期间可以取消任务');
  check((await admin.query('SELECT status FROM workpivot.tasks WHERE id=$1',[expiredLogin.runs[0]!.taskId])).rows[0].status==='stopped','取消等待登录同步释放任务等待状态');
  await plans.manual(actor,loginPlan.id,loginPlan.revision,randomUUID());await scheduler.tick();await admin.query("UPDATE workpivot.automation_runs SET login_deadline=now()-interval '1 second' WHERE plan_id=$1 AND status='waiting_login'",[loginPlan.id]);await scheduler.tick();check((await plans.detail(actor,loginPlan.id)).runs[0]?.status==='failed','等待登录超过截止时间失败并释放队列');
  const currentProfile=(await profiles.list(actor)).profiles[0];await profiles.revoke(actor,profile.id,currentProfile.revision);check((await plans.detail(actor,loginPlan.id)).state==='blocked'&&(await profiles.list(actor)).profiles[0].revokedAt,'撤销配置清除登录态并阻止关联计划');
  mode='normal';acceptLogin=true;
  const noPermissionBefore = requests, offline = await run([]);
  check(offline.detail.runs[0]?.status === 'failed' && requests === noPermissionBefore, '旧计划无来源时不提供网页工具且不发请求');
  mode = 'foreign'; const foreign = await run(config.webUrls); mode = 'normal';
  check(foreign.detail.runs[0]?.status === 'failed' && requests === noPermissionBefore, '未授权来源拒绝并不伪报成功');
  check(!(await files.list(actor, foreign.detail.runs[0]!.taskId!, 'artifact')).length, '网页失败不发布暂存成果');
  for(const variation of ['path','query'] as const){mode=variation;const denied=await run(config.webUrls);check(denied.detail.runs[0]?.status==='failed'&&requests===noPermissionBefore,'同域名未授权路径或查询参数零请求：'+variation);}mode='normal';
  let cancelPlan = await plans.draft(actor, config, randomUUID()); cancelPlan = await plans.confirm(actor, cancelPlan.id, cancelPlan.revision, true);
  const cancelJob = await plans.manual(actor, cancelPlan.id, cancelPlan.revision, randomUUID());
  const waiting = new Promise<void>(resolve => { entered = resolve; }); const running = scheduler.tick(); await waiting;
  await plans.stopRun(actor, cancelPlan.id, cancelJob.id); entered = undefined; hold!(); await running;
  const cancelled = await plans.detail(actor, cancelPlan.id);
  check(cancelled.runs[0]?.status !== 'completed' && !(await files.list(actor, cancelled.runs[0]!.taskId!, 'artifact')).length, '抓取期间停止后拒绝迟到完成和成果');
  check(!(await captures.list(actor,cancelPlan.id)).items.length,'取消运行后迟到网页不得写入快照');
  const monitor=new AdminOperations(auth,db),summary=await monitor.captures(user.token,actor);
  check(summary.counts.domOriginals===2&&summary.counts.originals>0&&Number(summary.counts.originalBytes)>0&&summary.audit.some(event=>event.action==='download'),'管理端统计原始大小并记录下载审计');
  check(summary.audit.some(event=>event.retryCount===2),'管理审计保留重试计数且不包含请求正文');
  check(summary.counts.versions>=3&&!JSON.stringify(summary).includes('fixture.example')&&!JSON.stringify(summary).includes('网页合成正文'),'管理员统计和审计不泄露网页地址与正文');
  await assert.rejects(monitor.captures('invalid-token',actor));check(true,'采集管理接口拒绝无效管理员凭据');
  // 使用同一微秒时间构造分页边界，确保随机UUID不会造成漏项。
  await admin.query(`INSERT INTO workpivot.capture_observations(owner_user_id,run_id,version_id,request_key,changed,created_at) SELECT $1,$2,$3,gen_random_uuid()::text,false,'2026-10-01T00:00:00.123456Z' FROM generate_series(1,55)`,[actor,success.detail.runs[0]!.id,first.versionId]);
  const page1=await captures.list(actor,success.plan.id),page2=await captures.list(actor,success.plan.id,page1.next!);
  check(page1.items.length===50&&new Set([...page1.items,...page2.items].map(r=>r.id)).size===60,'同微秒采集记录完整分页，无重复和漏项');
  const trash=new TrashRepository(db,files);
  let current=await plans.detail(actor,success.plan.id);await plans.action(actor,current.id,current.revision,'delete');
  await assert.rejects(captures.download(actor,current.id,first.versionId));
  await assert.rejects(captures.view(actor,current.id,first.versionId));check(true,'移入回收站后不能直接读取快照');
  let entry=(await trash.list(actor)).entries.find(e=>e.entityId===current.id)!;await trash.restore(actor,entry.id,entry.revision);
  check((await captures.view(actor,current.id,first.versionId)).revision===1,'恢复计划后保留原正文版本');
  current=await plans.detail(actor,current.id);await plans.action(actor,current.id,current.revision,'delete');entry=(await trash.list(actor)).entries.find(e=>e.entityId===current.id)!;
  await assert.rejects(trash.purge(actor,entry.id,entry.revision,'永久删除'),/30天/);
  await admin.query("UPDATE workpivot.trash_entries SET deleted_at=now()-interval '31 days' WHERE id=$1",[entry.id]);await trash.purge(actor,entry.id,entry.revision,'永久删除');
  check(!(await admin.query('SELECT id FROM workpivot.capture_versions WHERE id=$1',[first.versionId])).rowCount,'满30天手动永久删除计划级联清理正文');
  check(!!(await admin.query('SELECT id FROM workpivot.capture_audit WHERE plan_id=$1',[current.id])).rowCount,'永久删除正文后仍保留无正文审计元数据');
  const lifecycle=(await admin.query("SELECT action FROM workpivot.capture_audit WHERE plan_id=$1 AND action IN ('recycle','restore','purge')",[current.id])).rows.map(r=>r.action);check(lifecycle.filter(a=>a==='recycle').length===2&&lifecycle.includes('restore')&&lifecycle.includes('purge'),'回收、恢复和永久删除与采集审计同事务记录');
  // 在隔离库恢复升级前的旧计划快照，验证真正的37到38迁移。
  const legacy={...config,webUrls:undefined,webOrigins:['https://fixture.example']};
  await assert.rejects(plans.draft(actor,legacy,randomUUID()),/旧网页来源/);check(true,'新增草稿不能提交旧域名授权');
  const legacyPlans:string[]=[];
  for(const status of ['queued','running'] as const){
    const id=randomUUID();legacyPlans.push(id);
    await admin.query("INSERT INTO workpivot.automations(id,owner_user_id,request_id,config,draft,state,grant_id,next_at) VALUES($1,$2,$3,$4,$4,'enabled',$5,now())",[id,actor,randomUUID(),legacy,randomUUID()]);
    await admin.query("INSERT INTO workpivot.automation_runs(id,owner_user_id,plan_id,config,grant_id,plan_revision,scheduled_for,status) VALUES($1,$2,$3,$4,$5,1,now(),$6)",[randomUUID(),actor,id,legacy,randomUUID(),status]);
  }
  // 仅重放旧来源迁移的数据变换，不破坏后续迁移的版本链。
  await admin.query(schemaUpgrades.find(upgrade=>upgrade.version===38)!.sql);
  for(const id of legacyPlans){
    const p=await plans.detail(actor,id);check(p.state==='blocked'&&p.revision===2&&!!p.draft?.webOrigins?.length,'旧联网计划阻止调度并保留原草稿');
    await assert.rejects(plans.confirm(actor,id,p.revision,true),/旧网页来源/);
  }
  const oldJobs=(await admin.query('SELECT status,revoked,finished_at FROM workpivot.automation_runs WHERE plan_id=ANY($1::uuid[]) ORDER BY status',[legacyPlans])).rows;
  check(oldJobs.every(j=>j.revoked)&&oldJobs.some(j=>j.status==='cancelled'&&j.finished_at)&&oldJobs.some(j=>j.status==='running'),'旧排队取消、运行中撤销，保留运行状态供执行器收尾');
  check((await plans.detail(actor,offline.plan.id)).state==='enabled','离线计划升级后保持启用');
  let edited=await plans.draft(actor,config,randomUUID(),legacyPlans[0],2);edited=await plans.confirm(actor,edited.id,edited.revision,true);
  check(edited.state==='enabled'&&!edited.config?.webOrigins?.length&&!!edited.config?.webUrls?.length,'旧计划填写完整地址并人工确认后可恢复');
  await installSchema(admin,'web_app','web_auth');check((await plans.detail(actor,edited.id)).revision===edited.revision,'重复安装不会再次撤销新授权');
  console.log(`Web database: ${count} checks passed`);
} finally { hold?.(); await scheduler?.stop();await service.close();browserServer.closeAllConnections();await new Promise<void>(resolve=>browserServer.close(()=>resolve())); await Promise.all([db.end(), auth.end(), admin.end()]); await rm(root, { recursive: true, force: true }); }
