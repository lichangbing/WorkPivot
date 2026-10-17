import { createRequire } from 'node:module';
import { testBuiltOffice } from './skill-build-office.mts';
/** 本入口仅操作显式隔离的临时实例，模型密钥从本机配置读取且不输出。 */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pool,installSchema,transaction} from '../packages/server/src/database/connection.js';
import {AccountRepository} from '../packages/server/src/database/accounts.js';
import {WorkspaceRepository} from '../packages/server/src/database/workspace.js';
import {ProviderRepository} from '../packages/server/src/database/providers.js';
import {FileRepository} from '../packages/server/src/database/files.js';
import {DatabaseSkills} from '../packages/server/src/database/skills.js';
import {SkillBuilds} from '../packages/server/src/database/skill-builds.js';
import {createDatabaseRuntime} from '../packages/server/src/database/runtime.js';
import {startWorker} from '../scripts/skill-worker.mjs';
const url=process.env.WORKPIVOT_TEST_PG_URL;
if(!url||process.env.WORKPIVOT_TEST_PG_DISPOSABLE!=='1'||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/workpivot_test')throw Error('需要显式的隔离数据库');
const secret=randomBytes(32).toString('hex'),root=await mkdtemp(join(tmpdir(),'wp-skill-workflow-')),admin=pool(url);
const roleUrl=(role:string)=>{const u=new URL(url);u.username=role;u.password=secret;return u.toString();};
const db=pool(roleUrl('skill_app')),auth=pool(roleUrl('skill_auth'));
let worker:Awaited<ReturnType<typeof startWorker>>|undefined,server:ReturnType<Awaited<ReturnType<typeof createDatabaseRuntime>>['listen']>|undefined,stop:()=>void=()=>undefined;
let checks=0;const check=(value:unknown,label:string)=>{assert.ok(value,label);checks++;console.log('通过：'+label);};
try{
 await admin.query(`CREATE ROLE skill_app LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; CREATE ROLE skill_auth LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
 await installSchema(admin,'skill_app','skill_auth');
 const accounts=new AccountRepository(auth),registered=await accounts.registerFirst('skill-acceptance','synthetic-acceptance-password',secret,secret),actor=registered.user.id;
 const w=new WorkspaceRepository(db),files=new FileRepository(db,root),task=await w.createTask(actor,'对话技能与脚本测试验收');
 worker=await startWorker({port:0,token:secret,image:process.env.WORKPIVOT_TEST_WORKER_IMAGE??'workpivot-executor:closeout-20261016',owner:'wp-skill-build-'+randomUUID(),stateDir:join(root,'worker')});
 const address=worker.server.address();if(!address||typeof address==='string')throw Error('隔离执行器未启动');
 const config={url:`http://127.0.0.1:${address.port}`,token:secret},builds=new SkillBuilds(db,files,config),skills=new DatabaseSkills(db);
 const content=[{path:'SKILL.md',content:'---\nname: sum-report\ndescription: 汇总指定JSON数组并生成结果\n---\n\n# 输入输出\n输入数字数组，输出JSON。\n# 步骤\n使用 [脚本](scripts/sum.cjs) 处理，使用 [测试](tests/run.cjs) 验证。\n运行 node {{skill_root}}/tests/run.cjs。'},{path:'scripts/sum.cjs',content:'// 汇总数字，空数组返回零。\nmodule.exports=values=>values.reduce((sum,value)=>sum+value,0);'},{path:'tests/run.cjs',content:"// 使用合成样本验证正常、空值和负值情况。\nconst assert=require('node:assert/strict');const sum=require('../scripts/sum.cjs');assert.equal(sum([10,20]),30);assert.equal(sum([]),0);assert.equal(sum([-5,2]),-3);require('node:fs').writeFileSync('/workspace/result.json',JSON.stringify({total:sum([10,20])}));"}];
 let initial=await builds.propose(actor,task.id,{requestId:randomUUID(),displayName:'合成汇总技能',purpose:'真实沙箱验收',files:content});initial=await builds.validate(actor,initial.id,initial.revision);
 initial=await builds.trial(actor,initial.id,initial.revision,{command:`node /skills/${initial.name}/tests/run.cjs`,outputs:['result.json']});
 check(initial.trial?.passed&&initial.trial.previews[0]?.content==='{"total":30}','真实Docker运行生成脚本与断言测试，合成样本结果正确');
 check(!(await skills.market(actor)).some(v=>v.name===initial.name),'真实试运行不发布草稿');
 const broken=await builds.revise(actor,initial.id,initial.revision,{files:content.map(f=>f.path==='scripts/sum.cjs'?{...f,content:'module.exports = (;'}:f)});
 await builds.validate(actor,broken.id,broken.revision);
 const failed=await builds.trial(actor,broken.id,broken.revision,{command:`node /skills/${broken.name}/tests/run.cjs`});check(!failed.trial?.passed,'自动语法检查拦截错误脚本');
 let uiBuild=await builds.revise(actor,broken.id,broken.revision,{files:content});uiBuild=await builds.validate(actor,uiBuild.id,uiBuild.revision);uiBuild=await builds.trial(actor,uiBuild.id,uiBuild.revision,{command:`node /skills/${uiBuild.name}/tests/run.cjs`,outputs:['result.json']});
 const originalDir=await transaction(db,c=>c.query('SELECT directories FROM workpivot.skill_drafts WHERE name=$1',[uiBuild.name]),actor);check(originalDir.rows[0].directories.includes('scripts')&&originalDir.rows[0].directories.includes('tests'),'持久文件树包含脚本和测试目录');
 await testBuiltOffice(builds,actor,task.id,check);
 if(process.env.WORKPIVOT_LIVE_EVAL==='1'){
  process.loadEnvFile(process.env.WORKPIVOT_LIVE_ENV_FILE??'/tmp/workpivot-deepseek.env');if(!process.env.DEEPSEEK_API_KEY)throw Error('本机未提供模型密钥');
  const providers=new ProviderRepository(db,secret),provider=await providers.save(actor,{name:'隔离DeepSeek验收',baseUrl:'https://api.deepseek.com',modelId:process.env.DEEPSEEK_MODEL??'deepseek-flash',protocol:'openai',apiKey:process.env.DEEPSEEK_API_KEY});await providers.activate(actor,provider.id,provider.revision,true);
 }
 const app=await createDatabaseRuntime(auth,db,{initToken:secret,secretKey:secret,filesRoot:root,webDist:resolve('apps/web/dist'),worker:config});stop=app.locals['stopMemoryWorker'];stop();
 let finishHold:()=>void=()=>undefined;
 app.post('/fixture/finish',(_req,res)=>{res.json({ok:true});finishHold();});
 app.get('/fixture/status',async(_req,res)=>res.json({builds:await builds.list(actor),skills:await skills.market(actor),runs:await transaction(db,async c=>(await c.query('SELECT id,status,stop_reason FROM workpivot.task_runs')).rows,actor)}));
 server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server!.once('listening',r));const http=server.address();if(!http||typeof http==='string')throw Error('界面服务未启动');const base=`http://127.0.0.1:${http.port}`;
 const headers={authorization:'Bearer '+registered.token,'content-type':'application/json'};
 if(process.env.WORKPIVOT_LIVE_EVAL==='1'){
  const liveTask=await w.createTask(actor,'真实模型从对话生成技能');
  const liveOffice=process.env.WORKPIVOT_SKILL_LIVE_OFFICE==='1';let allowExecution=false;
  let permitting=true;const approvals=(async()=>{while(permitting){try{const r=await fetch(`${base}/api/tasks/${liveTask.id}/permissions`,{headers});const p=await r.json() as {pending:{id:string;request:{tool:string}}[]};for(const row of p.pending)if(row.request.tool==='trial_skill_draft'||(allowExecution&&row.request.tool==='execute_skill'))await fetch(`${base}/api/tasks/${liveTask.id}/permissions/${row.id}`,{method:'POST',headers,body:JSON.stringify({decision:'allow',scope:'once'})});}catch{/* 服务暂时不可用时留给主请求报告，不自动扩大授权。 */}await new Promise(r=>setTimeout(r,400));}})();
  try{
   const requestId=randomUUID();
   const content=liveOffice?`请为我创建一个私人办公技能：读取Excel第二列金额求和，生成包含“合计：金额”的Word。用propose_skill（requestId ${randomUUID()}）生成中文SKILL.md、scripts/office.cjs、tests/run.cjs、skill-test.json。仅使用Node CommonJS、预装exceljs、docx、adm-zip和node:assert/strict。测试脚本在/workspace创建合成Excel（标题项目/金额、A=10、B=20），调用生成脚本写report.docx，用adm-zip读取word/document.xml并断言合计30，另写result.json为{"total":30}。说明/测试清单路径用{{skill_root}}，测试内部相对require引入脚本。先validate_skill_draft再trial_skill_draft实际运行并预览report.docx和result.json；失败修复后重试，成功后等待用户窗口确认，不要声称已启用。不联网、不安装依赖、不读其他资料。`:`请为我创建一个私人技能：输入JSON数字数组，计算总和并输出result.json。请真实调用propose_skill（requestId用${randomUUID()}），生成中文SKILL.md、scripts/sum.cjs、tests/run.cjs和skill-test.json。脚本用Node CommonJS，测试用node:assert/strict验证[10,20]得30、空数组得0、[-5,2]得-3，并在/workspace/result.json写入{"total":30}。测试脚本通过require('../scripts/sum.cjs')引入，说明/清单路径使用{{skill_root}}。先validate_skill_draft，再trial_skill_draft运行tests/run.cjs并预览result.json。失败需修复后再试，成功后告诉我等待应用弹窗确认，不要声称已启用。不要访问其他资料或联网安装。`;
   const response=await fetch(`${base}/api/tasks/${liveTask.id}/messages`,{method:'POST',headers,body:JSON.stringify({content,requestId}),signal:AbortSignal.timeout(300000)});assert.equal(response.status,200);const events=await response.text();
   console.log('真实模型任务终态：'+(await transaction(db,async c=>(await c.query('SELECT status,stop_reason FROM workpivot.task_runs WHERE task_id=$1',[liveTask.id])).rows[0]?.status,actor)));
   check(events.includes('propose_skill')&&events.includes('trial_skill_draft'),'真实DeepSeek对话调用生成及隔离测试工具');
   const live=(await builds.list(actor,liveTask.id)).find(b=>b.status==='ready');check(live?.trial?.passed,'真实模型生成脚本并通过Docker测试');
   assert.ok(live);uiBuild=await builds.detail(actor,live.id);
   check(!(await skills.market(actor)).some(v=>v.name===live.name),'真实模型无法绕过弹窗启用');
   if(liveOffice){
    const decision=await fetch(`${base}/api/skill-builds/${uiBuild.id}/decision`,{method:'POST',headers,body:JSON.stringify({revision:uiBuild.revision,hash:uiBuild.hash,decision:'activate'})});assert.equal(decision.status,200);allowExecution=true;
    const use=await fetch(`${base}/api/tasks/${liveTask.id}/messages`,{method:'POST',headers,body:JSON.stringify({requestId:randomUUID(),content:'现在使用刚确认启用的Excel转Word技能，先load_skill读取，再execute_skill调用保存的脚本。在沙箱临时生成第二列金额40和2的合成Excel，不读其他文件。生成report.docx成果，正文明确写合计：42。不要修改技能。'}),signal:AbortSignal.timeout(240000)});assert.equal(use.status,200);const used=await use.text();check(used.includes('load_skill')&&used.includes('execute_skill'),'真实模型下一轮按需读取并执行新办公技能');
    const artifact=(await files.list(actor,liveTask.id,'artifact')).find(f=>f.name==='report.docx');assert.ok(artifact);const downloaded=await files.download(actor,liveTask.id,artifact.id);const require=createRequire(new URL('../packages/server/package.json',import.meta.url));const Zip=require('adm-zip');const body=new Zip(downloaded.data).readAsText('word/document.xml').replace(/<[^>]+>/g,'');check(/合计[：:]\s*42/.test(body),'真实模型新办公技能生成Word，下载正文合计42');
   }
  }finally{permitting=false;await approvals;}
 }
 await writeFile('/tmp/workpivot-skill-browser.json',JSON.stringify({url:base,username:'skill-acceptance',password:'synthetic-acceptance-password',taskId:uiBuild.taskId,buildId:uiBuild.id,name:uiBuild.name}),{mode:0o600});
 console.log('隔离浏览器验收入口：'+base);console.log(`脚本/模型验收：${checks}项通过；确认弹窗尚未操作。`);
 if(process.env.WORKPIVOT_SKILL_BROWSER_HOLD==='1')await new Promise<void>(r=>{const timer=setTimeout(r,600000);finishHold=()=>{clearTimeout(timer);r();};});
 else{
  await builds.decide(actor,uiBuild.id,uiBuild.revision,'activate',uiBuild.hash);check((await skills.market(actor)).find(v=>v.name===uiBuild.name)?.loaded,'已认证确认接口发布并加载');
 }
}finally{
 stop();if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}await worker?.close();await Promise.all([admin.end(),db.end(),auth.end()]);await rm(root,{recursive:true,force:true});
}
