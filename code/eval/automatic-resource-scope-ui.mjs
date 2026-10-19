// 验证自动关联资料和发送门禁，不访问真实对话。
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../packages/server/package.json',import.meta.url)),{chromium}=require('playwright');
const root=resolve('apps/web/dist');
const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname,file=resolve(root,path==='/'?'index.html':'.'+path);if(!file.startsWith(root+'/'))throw Error();res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error(error.stack);});
 await page.addInitScript(()=>{localStorage.setItem('wp_token','synthetic-ui-token');localStorage.setItem('wp-right-panel-open','false');});
 const tasks=[{id:'task-a',projectId:'project-a',name:'合成任务',status:'completed',revision:1}];
 let restored=false, scopeRequests=0; const sent=[];
 const scope={versionIds:['version-a'],scheduleIds:['plan-a'],memoryScopes:['task'],expert:true,baseRunId:'run-old'};
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;let data={experts:[],suggestions:[],plans:[],checkpoints:[],files:[],executions:[],builds:[]};
  if(path==='/api/health')data={ok:true,name:'workpivot',apiProtocol:1,storage:'postgresql',chatEnabled:true};
  else if(path==='/api/auth/state')data={authenticated:true,user:{id:'owner',username:'合成用户',role:'member'}};
  else if(path==='/api/tasks')data={tasks};
  else if(path==='/api/projects')data={projects:[{id:'project-a',name:'合成项目',revision:1},...(restored?[{id:'project-b',name:'恢复的项目',revision:1}]:[])]};
  else if(path==='/api/trash')data={entries:restored?[]:[{id:'entry',kind:'project',entityId:'project-b',name:'恢复的项目',revision:'1',parentId:null,deletedAt:new Date().toISOString(),purgeAfter:new Date(Date.now()+30*86400000).toISOString(),canPurge:false,fileCount:0}]};
  else if(path==='/api/trash/entry/restore'){restored=true;data={};}
  else if(path.endsWith('/conversation'))data={turns:[],nextCursor:null,snapshotSequence:'0'};
  else if(path.endsWith('/conversation-changes'))data={events:[],nextSequence:'0',snapshotSequence:'0',hasMore:false};
  else if(path.endsWith('/permissions'))data={pending:[]};
  else if(path.endsWith('/resource-scope')){scopeRequests++;if(scopeRequests===1){await route.fulfill({status:503,json:{error:'合成加载失败'}});return;}data={scope:{...scope,baseRunId:sent.length?'run-new':'run-old'}};}
  else if(path.endsWith('/messages')){sent.push(route.request().postDataJSON());await route.fulfill({status:202,json:{accepted:true}});return;}
  await route.fulfill({json:data});
 });
 const base=`http://127.0.0.1:${server.address().port}/`;
 await page.goto(base);
 const nav=page.getByRole('complementary',{name:'项目与任务',exact:true});
 await nav.getByRole('button',{name:'合成任务',exact:true}).click();
 await page.getByRole('textbox',{name:'消息',exact:true}).waitFor();
 await page.getByRole('button',{name:'重试关联资料',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'发送',exact:true}).isDisabled(),true);
 assert.equal(await page.getByText(/^读取范围：/).count(),0);
 assert.equal(await page.getByRole('button',{name:'撤销全部读取范围（下次发送生效）',exact:true}).count(),0);
 await page.getByRole('button',{name:'重试关联资料',exact:true}).click();
 const message=page.getByRole('textbox',{name:'消息',exact:true});
 await message.fill('第一条消息');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('textarea[aria-label="消息"]')?.value==='');
 assert.equal(sent.length,1);assert.deepEqual(sent[0].resourceScope,scope);
 await message.fill('第二条消息');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('textarea[aria-label="消息"]')?.value==='');
 assert.equal(sent.length,2);assert.deepEqual(sent[1].resourceScope,{...scope,baseRunId:'run-new'});
 assert.equal(await page.getByText(/^读取范围：/).count(),0);
 await page.screenshot({path:'/tmp/wp-automatic-scope.png'});
 assert.deepEqual(errors,[]);
 console.log('自动关联检查通过：无读取范围面板、加载失败禁止发送、重试、自动沿用及发送后刷新范围');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
