// 页面交互使用合成接口；数据库并发和隔离另由 automation-capacity.mts 验证。
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
 let queued=10;
 await page.route('**/api/**',async route=>{const url=new URL(route.request().url());let data={};
  if(url.pathname==='/api/health')data={ok:true,name:'workpivot',apiProtocol:1,version:'synthetic',storage:'postgresql'};
  else if(url.pathname==='/api/auth/state')data={authenticated:true,user:{id:'owner',username:'合成用户',role:'member'}};
  else if(url.pathname==='/api/tasks')data={tasks:[]};
  else if(url.pathname==='/api/projects')data={projects:[]};
  else if(url.pathname==='/api/automations')data={plans};
  else if(url.pathname==='/api/automations/options')data={skills:[],projects:[],files:[],workerAvailable:true,capacity:{enabled:20,enabledLimit:20,queued,queuedLimit:10}};
  else if(url.pathname==='/api/automations/notices')data={notices:[]};
  else if(url.pathname==='/api/automations/paused/confirm'){await route.fulfill({status:409,json:{error:'最多启用20个自动化计划，请先停用其他计划；计划设置已保留'}});return;}
  await route.fulfill({json:data});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/#automations`);
 await page.getByRole('status').filter({hasText:'已启用 20 / 20'}).waitFor();
 assert.match(await page.getByRole('status').innerText(),/排队 10 \/ 10/);
 await page.getByText('↳ 等待排队额度：最多10次待执行，额度释放后按补跑设置继续调度',{exact:true}).waitFor();
 await page.getByRole('button',{name:'启用',exact:true}).click();
 await page.getByRole('button',{name:'确认并启用',exact:true}).click();
 await page.getByRole('dialog').getByRole('alert').filter({hasText:'最多启用20个自动化计划'}).waitFor();
 assert.equal(await page.getByRole('dialog').count(),1);
 await page.keyboard.press('Escape');
 queued=9;
 await page.getByRole('status').filter({hasText:'排队 9 / 10'}).waitFor({timeout:10000});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 assert.deepEqual(errors,[]);
 const output=resolve('../local-runtime/acceptance/automation-capacity-'+Date.now());await mkdir(output,{recursive:true});await page.screenshot({path:output+'/mobile.png',fullPage:true});
 console.log('自动化额度页面：额度展示、等待原因、启用拒绝、额度刷新、窄屏及无JS异常通过；'+output);
}finally{await browser?.close();await new Promise(r=>server.close(r));}
