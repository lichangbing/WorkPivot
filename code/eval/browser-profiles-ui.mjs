// 页面移除后的兼容检查；后台登录与隔离仍由browser-login和web-database专项验证。
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
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.addInitScript(()=>localStorage.setItem('wp_token','synthetic-ui-token'));
 let profileRequests=0;
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;let data={};
  if(path==='/api/health')data={ok:true,name:'workpivot',apiProtocol:1,storage:'postgresql'};
  else if(path==='/api/auth/state')data={authenticated:true,user:{id:'owner',username:'合成用户',role:'member'}};
  else if(path==='/api/tasks')data={tasks:[]};else if(path==='/api/projects')data={projects:[]};
  else if(path==='/api/automations')data={plans:[]};else if(path==='/api/automations/options')data={skills:[],projects:[],files:[],workerAvailable:true};else if(path==='/api/automations/notices')data={notices:[]};
  else if(path.startsWith('/api/browser-profiles')){profileRequests++;data={error:'页面不应请求登录配置'};}
  await route.fulfill({json:data});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/#automations/logins`);
 await page.waitForURL(url=>url.hash==='#automations');
 await page.getByRole('heading',{name:'自动化任务',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'私人网页登录',exact:true}).count(),0);
 assert.equal(await page.getByRole('heading',{name:'私人网页登录配置',exact:true}).count(),0);
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 assert.equal(profileRequests,0);assert.deepEqual(errors,[]);
 console.log('已移除私人登录页面：旧地址返回自动化列表、无导航入口、无登录配置请求、窄屏与无JS错误通过');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
