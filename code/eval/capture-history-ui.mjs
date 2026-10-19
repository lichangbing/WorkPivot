// 使用合成接口验证采集管理页面；真实隔离和删除由 web-database.mts 验证。
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../packages/server/package.json',import.meta.url)),{chromium}=require('playwright');
const root=resolve('apps/web/dist');
const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;const file=resolve(root,path==='/'?'index.html':'.'+path);if(!file.startsWith(root+'/'))throw Error('路径无效');res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.WORKPIVOT_TEST_CHROME??'/usr/bin/google-chrome'});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>localStorage.setItem('wp_token','synthetic-ui-token'));
 const config={name:'合成等待计划',skill:'sample',releaseId:'synthetic-release',requirements:'读取合成公告',projectId:null,input:{mode:'none',versionIds:[],pattern:''},timing:{kind:'daily',zone:'Asia/Shanghai',time:'09:00',days:[],minutes:120},catchup:'once',notify:'issues',timeoutMinutes:10,webUrls:[]};
 const plans=[{id:'waiting',revision:1,state:'enabled',config,draft:null,origin:'manual',nextAt:'2026-10-18T01:00:00Z',issue:'等待排队额度：最多10次待执行，额度释放后按补跑设置继续调度'}, {id:'paused',revision:1,state:'paused',config:{...config,name:'合成停用计划'},draft:null,origin:'manual',issue:'',nextAt:null}];
 let queued=10,deleted=false;
 const item=(n)=>({id:'observation'+n,versionId:'version'+n,runId:'run'+n,revision:n,changed:n===2,retryCount:n===2?2:0,capturedAt:'2026-10-18T00:00:00Z',title:'合成公告',url:'https://fixture.example/',runStatus:n===2?'failed':'completed'});
 await page.route('**/api/**',async route=>{const url=new URL(route.request().url());let data={};
  if(url.pathname==='/api/health')data={ok:true,name:'workpivot',apiProtocol:1,version:'synthetic',storage:'postgresql'};
  else if(url.pathname==='/api/auth/state')data={authenticated:true,user:{id:'owner',username:'合成用户',role:'member'}};
  else if(url.pathname==='/api/tasks')data={tasks:[]};
  else if(url.pathname==='/api/projects')data={projects:[]};
  else if(url.pathname==='/api/automations/waiting/action'){assert.equal(route.request().postDataJSON().action,'delete');deleted=true;data={};}
  else if(url.pathname==='/api/automations/waiting')data={...plans[0],runs:[]};
  else if(url.pathname==='/api/automations/waiting/captures')data={items:[item(2),item(1)],next:null};
  else if(url.pathname.endsWith('/original')){await route.fulfill({body:'<html>合成原始存档</html>',headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="capture-original.bin"'}});return;}
  else if(url.pathname.startsWith('/api/automations/waiting/captures/version')){const n=Number(url.pathname.at(-1));data={id:'version'+n,revision:n,originalBytes:n===2?32:null,originalKind:'dom',originalType:'text/html',originalHash:'a'.repeat(64),createdAt:'2026-10-18T00:00:00Z',content:{url:'https://fixture.example/',title:'合成公告',text:n===2?'新版正文 <script>不执行</script>':'旧版正文',warning:'合成来源',truncated:true,blockedRequests:1,...(n===1?{feed:{format:'rss',totalEntries:1,entries:[{id:'synthetic-entry',title:'合成订阅条目',published:'2026-10-18',url:'https://fixture.example/article',summary:'旧版正文'}]}}:{})}};}
  else if(url.pathname==='/api/automations')data={plans:deleted?[]:plans};
  else if(url.pathname==='/api/automations/options')data={skills:[],projects:[],files:[],workerAvailable:true,capacity:{enabled:20,enabledLimit:20,queued,queuedLimit:10}};
  else if(url.pathname==='/api/automations/notices')data={notices:[]};
  else if(url.pathname==='/api/automations/paused/confirm'){await route.fulfill({status:409,json:{error:'最多启用20个自动化计划，请先停用其他计划；计划设置已保留'}});return;}
  await route.fulfill({json:data});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/#automations/detail/waiting`);
 await page.getByRole('heading',{name:'采集历史与正文版本'}).waitFor();
 await page.getByText('HTTP 重试 2 次',{exact:true}).waitFor();
 await page.getByRole('button',{name:'查看快照',exact:true}).first().click();
 await page.getByText('新版正文 <script>不执行</script>',{exact:true}).waitFor();
 await page.getByText('正文已截断。',{exact:false}).waitFor();
 await page.getByText('浏览器 DOM 快照',{exact:false}).waitFor();
 const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'下载原始存档',exact:true}).click();assert.match((await downloading).suggestedFilename(),/\.bin$/);
 await page.getByRole('button',{name:'保留当前快照用于对照'}).click();
 await page.getByRole('button',{name:'查看快照',exact:true}).last().click();
 await page.getByRole('heading',{name:'对照快照',exact:true}).waitFor();
 await page.getByText('旧版正文',{exact:true}).waitFor();
 await page.getByText('RSS 2.0 · 已保存 1 / 来源 1 条',{exact:true}).waitFor();
 await page.getByRole('heading',{name:'合成订阅条目',exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 assert.deepEqual(errors,[]);
 const output=resolve('../local-runtime/acceptance/capture-history-'+Date.now());await mkdir(output,{recursive:true});await page.screenshot({path:output+'/mobile.png',fullPage:true});
 await page.getByRole('button',{name:'移入回收站',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'移入回收站',exact:true}).click();
 await page.getByText('还没有自动化。新增一个计划，或在对话中描述执行要求和周期。',{exact:true}).waitFor();assert(deleted);assert.deepEqual(errors,[]);
 console.log('采集历史页面：版本读取、文本转义、截断说明、版本对照、窄屏、回收站确认及无JS异常通过；'+output);
}finally{await browser?.close();await new Promise(r=>server.close(r));}
