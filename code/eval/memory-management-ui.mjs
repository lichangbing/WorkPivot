// 真实 Electron 主进程、预加载桥与隔离HTTP服务联调，所有账号和会话均为合成数据。
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,extname} from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../packages/server/package.json',import.meta.url)),{_electron:electron}=require('playwright');
const desktopRequire=createRequire(new URL('../apps/desktop/package.json',import.meta.url));
const binary=process.env.WORKPIVOT_TEST_ELECTRON??desktopRequire('electron'),root=resolve('apps/web/dist'),profile=await mkdtemp(join(tmpdir(),'wp-electron-cache-'));
let signedOut=false;
let entries=[{id:'memory-fixture',scope:'task',revision:1,content:'任务记忆合成正文：周五交付报告。',taskName:'合成任务',locked:false}],pending=true,analysisState='failed';
let app,delay=false,offline=false,deleted=false,newEvent=false,hold=[];
const event=(id,sequence,kind,content)=>({id,sequence:String(sequence),turnId:'turn-a',runId:'run-a',kind,content,truncated:false});
const server=createServer(async(req,res)=>{
 try{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path.startsWith('/api/')){
  const account=req.headers.authorization==='Bearer token-b'?'account-b':'account-a';
  let data={experts:[],suggestions:[],plans:[],checkpoints:[],files:[],executions:[],builds:[]};
  if(path==='/api/health')data={ok:true,name:'workpivot',version:'0.3.0-rc.1',apiProtocol:1,storage:'postgresql',chatEnabled:true};
  else if(path==='/api/auth/state')data=signedOut?{authenticated:false,needsSetup:false}:{authenticated:true,user:{id:account,username:account,role:'member'}};
  else if(path==='/api/memory-management'){const params=new URL(req.url,'http://localhost').searchParams,p=params.get('project');data={memories:entries.filter(row=>row.scope===params.get('scope')&&(!p||p==='all'||p==='legacy'&&row.legacyPersonal||p==='temporary'&&!row.projectId&&!row.legacyPersonal||p===row.projectId)),nextCursor:null};}
  else if(path==='/api/memories/legacy-fixture/assign-project'){let raw='';for await(const chunk of req)raw+=chunk;const b=JSON.parse(raw);entries=entries.map(e=>e.id==='legacy-fixture'?{...e,projectId:b.projectId,projectName:'项目甲',legacyPersonal:false,revision:2}:e);data={revision:2};}
  else if(path==='/api/memories/memory-fixture'&&req.method==='PUT'){let body='';for await(const chunk of req)body+=chunk;entries[0]={...entries[0],content:JSON.parse(body).content,revision:2};data={revision:2};}
  else if(path==='/api/memories/memory-fixture'&&req.method==='DELETE'){entries=entries.filter(row=>row.id!=='memory-fixture');data={ok:true};}
  else if(path==='/api/memory-suggestions')data={suggestions:pending?[{id:'suggestion-fixture',scope:'user',content:'长期偏好中文报告',reason:'多次明确表达',analysisId:'batch-fixture',taskName:'合成任务',mergeTargets:[],mergeOriginals:[],sourceContext:[],evidence:'请一直使用中文'}]:[]};
  else if(path==='/api/memory-suggestions/suggestion-fixture/decision'){pending=false;entries.push({id:'accepted-fixture',scope:'user',revision:1,content:'长期偏好中文报告',locked:false});data={status:'accepted'};}
  else if(path==='/api/memory-analysis')data={progress:[{scope:'user',scopeId:'user-fixture',projectName:null,pending:7,total:17}],batches:[{id:'batch-fixture',scope:'user',status:analysisState,error:analysisState==='failed'?'合成模型失败':null,createdAt:new Date().toISOString(),finishedAt:null,projectName:null,suggestions:0}]};
  else if(path==='/api/memory-analysis/batch-fixture/retry'){analysisState='pending';data={ok:true};}
  else if(path==='/api/memory-controls')data={layers:[]};
  else if(path==='/api/memory-templates')data={templates:[]};
  else if(path==='/api/memory-jobs')data={jobs:[]};
  else if(path==='/api/tasks')data={tasks:deleted?[]:[{id:'task-a',name:'合成任务',projectId:null,status:'completed',revision:1}]};
  else if(path==='/api/projects')data={projects:[{id:'project-a',name:'项目甲'}]};
  else if(path.endsWith('/conversation')){
   if(delay)await new Promise(r=>hold.push(r));
   if(offline){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'合成离线'}));return;}
   const events=[event('e1',1,'user',account==='account-a'?'本地已保存的会话':'另一个账号的会话'),...(newEvent?[event('e3',3,'assistant','服务端新增答复')]:[])];
   data={turns:[{id:'turn-a',events,hasMoreEvents:false,nextEventSequence:null}],nextCursor:null,snapshotSequence:newEvent?'3':'1'};
  }else if(path.endsWith('/conversation-changes')){const after=new URL(req.url,'http://localhost').searchParams.get('after');data=newEvent?{events:after==='1'?[event('e2',2,'assistant','中间页补齐答复')]:after==='2'?[event('e3',3,'assistant','服务端新增答复')]:[],hasMore:after==='1',nextSequence:after==='1'?'2':'3',snapshotSequence:'3'}:{events:[],hasMore:false,nextSequence:'1',snapshotSequence:'1'};}
  else if(path.endsWith('/permissions'))data={pending:[]};
  else if(path.endsWith('/resource-scope'))data={scope:{versionIds:[],memoryScopes:[],expert:false}};
  res.setHeader('content-type','application/json');res.end(JSON.stringify(data));return;
 }
 const file=resolve(root,path==='/'?'index.html':'.'+path);if(!file.startsWith(root+'/'))throw Error();res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));
 }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const launch=async()=>{
 app=await electron.launch({executablePath:binary,args:process.env.WORKPIVOT_TEST_ELECTRON?['--no-sandbox']:['--no-sandbox',resolve('apps/desktop')],env:{...process.env,XDG_CONFIG_HOME:profile,WORKPIVOT_SERVER_URL:origin},timeout:30000});
 const page=await app.firstWindow();await page.waitForURL(origin+'/',{timeout:30000});
 await page.evaluate(()=>localStorage.setItem('wp_token','token-a'));await page.reload();
 await page.getByRole('button',{name:'合成任务',exact:true}).click();return page;
};
try{
 const page=await launch();
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('button',{name:'记忆管理',exact:true}).click();
 await page.getByText('暂无已保存的个人记忆。可查看“待确认建议”，或切换到其他记忆层级。',{exact:true}).waitFor();
 await page.getByRole('button',{name:'任务记忆',exact:true}).click();
 await page.getByText('任务记忆合成正文：周五交付报告。',{exact:true}).waitFor();
 await page.screenshot({path:'/tmp/wp-memory-management.png'});
 await page.getByRole('button',{name:'修改',exact:true}).click();
 await page.getByRole('textbox',{name:'修改记忆内容'}).fill('任务记忆合成正文：周四交付报告。');
 await page.getByRole('button',{name:'保存修改',exact:true}).click();
 await page.getByText('任务记忆合成正文：周四交付报告。',{exact:true}).waitFor();
 await page.getByRole('button',{name:'删除',exact:true}).click();
 await page.getByRole('alertdialog',{name:'确认删除记忆'}).waitFor();
 await page.getByRole('button',{name:'保留记忆',exact:true}).click();
 assert.equal(entries.length,1);
 await page.getByRole('button',{name:'删除',exact:true}).click();
 await page.getByRole('button',{name:'确认移入回收站',exact:true}).click();
 await page.getByText('暂无已保存的任务记忆。可查看“待确认建议”，或切换到其他记忆层级。',{exact:true}).waitFor();
 assert.equal(entries.length,0);
 await page.getByRole('button',{name:'待确认建议',exact:true}).click();
 await page.getByText('长期偏好中文报告',{exact:true}).waitFor();
 await page.getByRole('button',{name:'确认保存',exact:true}).click();
 await page.getByRole('button',{name:'已保存记忆',exact:true}).click();
 await page.getByRole('button',{name:'个人记忆',exact:true}).click();
 await page.getByText('长期偏好中文报告',{exact:true}).waitFor();
 await page.getByRole('button',{name:'分析与设置',exact:true}).click();
 await page.getByText('7 / 10 轮',{exact:false}).waitFor();
 await page.screenshot({path:'/tmp/wp-memory-analysis.png'});
 await page.getByRole('button',{name:'重试分析',exact:true}).click();
 await page.getByText('个人 · 临时任务范围 · 等待分析',{exact:true}).waitFor();
 entries.push({id:'legacy-fixture',scope:'user',revision:1,content:'旧全局个人偏好',legacyPersonal:true,locked:false});
 await page.getByRole('button',{name:'已保存记忆',exact:true}).click();
 await page.getByRole('button',{name:'刷新',exact:true}).click();
 await page.getByLabel('个人记忆项目筛选',{exact:true}).selectOption('legacy');
 await page.getByText('旧全局个人偏好',{exact:true}).waitFor();
 await page.getByLabel('旧个人记忆归属',{exact:true}).selectOption('project-a');
 await page.getByRole('button',{name:'确认归属并启用',exact:true}).click();
 await page.getByText('暂无已保存的个人记忆。可查看“待确认建议”，或切换到其他记忆层级。',{exact:true}).waitFor();
 await page.getByLabel('个人记忆项目筛选',{exact:true}).selectOption('project-a');
 await page.getByText('旧全局个人偏好',{exact:true}).waitFor();
 await page.screenshot({path:'/tmp/wp-personal-project-memory.png'});
 await page.getByLabel('个人记忆项目筛选',{exact:true}).selectOption('temporary');
 await page.getByText('长期偏好中文报告',{exact:true}).waitFor();
 assert.equal(await page.getByText('旧全局个人偏好',{exact:true}).count(),0);
 console.log('记忆归属界面通过：项目筛选、临时范围、旧全局记忆确认归属');
 console.log('记忆管理界面通过：三层全文、修改、取消删除、确认删除、建议确认后可见、周期进度与失败重试');
}finally{delay=false;hold.splice(0).forEach(r=>r());await app?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(profile,{recursive:true,force:true});}
