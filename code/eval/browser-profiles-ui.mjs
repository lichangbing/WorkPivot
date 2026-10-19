// 页面使用合成接口；真实登录与隔离在browser-login和web-database专项验证。
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../packages/server/package.json',import.meta.url)),{chromium}=require('playwright');
const root=resolve('apps/web/dist');
const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname,file=resolve(root,path==='/'?'index.html':'.'+path);if(!file.startsWith(root+'/'))throw Error();res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome'});
 const fixture=await browser.newPage({viewport:{width:1280,height:800}});await fixture.setContent('<html><body><h1>合成网站登录</h1><label>用户名 <input></label><p><label>密码 <input type="password"></label></p><button>登录</button></body></html>');const image=(await fixture.screenshot({type:'jpeg'})).toString('base64');await fixture.close();
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.addInitScript(()=>localStorage.setItem('wp_token','synthetic-ui-token'));
 let profile,opened=false,saved=false,revoked=false;const commands=[];
 const frame={image,url:'https://fixture.example/login',width:1280,height:800,expiresAt:'2099-01-01T00:00:00Z',blockedUrls:[]};
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;let data={};
  if(path==='/api/health')data={ok:true,name:'workpivot',apiProtocol:1,storage:'postgresql'};
  else if(path==='/api/auth/state')data={authenticated:true,user:{id:'owner',username:'合成用户',role:'member'}};
  else if(path==='/api/tasks')data={tasks:[]};else if(path==='/api/projects')data={projects:[]};
  else if(path==='/api/automations')data={plans:[]};else if(path==='/api/automations/options')data={skills:[],projects:[],files:[],workerAvailable:true};else if(path==='/api/automations/notices')data={notices:[]};
  else if(path==='/api/browser-profiles'){
   if(route.request().method()==='POST'){profile={...route.request().postDataJSON(),id:'private-profile',revision:1,ready:false,revokedAt:null,leaseId:null,leaseKind:null,leaseUntil:null};data={id:profile.id};}
   else data={available:true,profiles:profile?[profile]:[],networkTargets:[],audit:[]};
  }else if(path.endsWith('/open')){opened=true;data={...frame,leaseId:'private-lease'};}
  else if(path.endsWith('/frame'))data=frame;
  else if(path.endsWith('/command')){commands.push(route.request().postDataJSON());data=frame;}
  else if(path.endsWith('/save')){saved=true;profile.ready=true;profile.revision++;data={ok:true};}
  else if(path.endsWith('/revoke')){revoked=true;profile.revokedAt='2026-10-18';data={ok:true};}
  await route.fulfill({json:data});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/#automations/logins`);
 await page.getByRole('heading',{name:'私人网页登录配置',exact:true}).waitFor();await page.getByLabel('登录配置名称').fill('合成私人网站');await page.getByLabel('登录入口').fill(frame.url);await page.getByLabel('登录允许地址').fill(frame.url);await page.getByRole('button',{name:'创建私人配置',exact:true}).click();await page.getByRole('heading',{name:'合成私人网站',exact:true}).waitFor();
 await page.getByRole('button',{name:'打开登录窗口',exact:true}).click();await page.getByRole('dialog',{name:'确认登录配置操作'}).waitFor();assert.equal(opened,false);await page.getByRole('button',{name:'确认操作',exact:true}).click();await page.getByAltText('私人登录窗口画面').waitFor();
 await page.getByAltText('私人登录窗口画面').click({position:{x:60,y:70}});await page.getByLabel('登录输入文字').fill('synthetic-secret');await page.getByRole('button',{name:'发送输入',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="登录输入文字"]').value==='');assert(commands.some(command=>command.kind==='click'));assert(commands.some(command=>command.kind==='text'&&command.text==='synthetic-secret'));
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);const output=resolve('../local-runtime/acceptance/browser-profiles-'+Date.now());await mkdir(output,{recursive:true});await page.screenshot({path:output+'/mobile.png',fullPage:true});
 await page.getByRole('button',{name:'保存登录态',exact:true}).click();assert.equal(saved,false);await page.getByRole('button',{name:'确认操作',exact:true}).click();await page.getByText('有已保存登录态（仍需网站验证）',{exact:true}).waitFor();assert.equal(saved,true);assert.equal(await page.getByAltText('私人登录窗口画面').count(),0);
 await page.getByRole('button',{name:'撤销并清除登录态',exact:true}).click();assert.equal(revoked,false);await page.getByRole('button',{name:'确认操作',exact:true}).click();await page.getByText('已撤销',{exact:true}).waitFor();assert.equal(revoked,true);assert.deepEqual(errors,[]);
 console.log('私人登录页面：创建、明确确认、坐标及私密输入、保存关闭、撤销、窄屏与无JS错误通过；'+output);
}finally{await browser?.close();await new Promise(r=>server.close(r));}
