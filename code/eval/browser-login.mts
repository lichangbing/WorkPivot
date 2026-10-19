import {loginState} from '../packages/server/src/web/login-state.js';
import assert from 'node:assert/strict';
import {BrowserEngine} from '../packages/server/src/web/browser-engine.js';
import {BrowserLogin} from '../packages/server/src/web/browser-login.js';
import {SafeHttp,webUrl,type WebPolicy,type WebResponse} from '../packages/server/src/web/safe-http.js';
const urls=['https://login.example/','https://login.example/session','https://login.example/report'];
let posts=0,redirectStatus=302;
class Fixture extends SafeHttp{override async get(url:string,policy:WebPolicy={}):Promise<WebResponse>{webUrl(url,undefined,policy.urls,policy.targets);const method=policy.browserRequest?.method??'GET';
 if(url===urls[1]&&method==='POST'){posts++;assert.match(policy.browserRequest?.body?.toString()??'',/password=synthetic-secret/);return {url,status:redirectStatus,headers:{location:urls[2],'content-type':'text/html; charset=utf-8'},setCookies:['sid=synthetic-session; Path=/; Secure; HttpOnly; SameSite=Lax','second=synthetic-second; Path=/; Secure; HttpOnly'],body:Buffer.alloc(0)};}
 if(url===urls[2])return {url,status:policy.browserRequest?.headers.cookie?.includes('sid=synthetic-session')?200:401,headers:{'content-type':'text/html; charset=utf-8'},body:Buffer.from('<html><body>登录后报告<script>localStorage.setItem("retained","synthetic-local")</script></body></html>')};
 return {url,status:200,headers:{'content-type':'text/html; charset=utf-8'},body:Buffer.from('<html><body><form action="/session" method="POST"><input name="password" type="password" style="position:absolute;left:20px;top:20px;width:200px;height:30px"><button type="submit" style="position:absolute;left:20px;top:70px;width:100px;height:30px">登录</button></form></body></html>')};
}}
const engine=new BrowserEngine(new Fixture(),{executablePath:process.env.WORKPIVOT_BROWSER_EXECUTABLE_PATH??'/usr/bin/google-chrome'}),logins=new BrowserLogin(engine),id='a'.repeat(64);
try{
 assert.throws(()=>loginState('/etc/passwd'));assert.throws(()=>loginState({cookies:[],origins:[{origin:'file:///',localStorage:[]}]}));
 const first=await logins.start(id,urls[0],{urls});assert(first.image);await assert.rejects(logins.start(id,urls[0],{urls}));
 await logins.command(id,{kind:'click',x:50,y:35});await logins.command(id,{kind:'text',text:'synthetic-secret'});await logins.command(id,{kind:'click',x:50,y:80});
 let frame=await logins.frame(id);for(let i=0;i<30&&frame.url!==urls[2];i++){await new Promise(r=>setTimeout(r,50));frame=await logins.frame(id);}
 assert.equal(frame.url,urls[2]);assert.equal(posts,1);assert(!JSON.stringify(frame).includes('synthetic-secret'));
 const state=await logins.state(id);assert(state.cookies.some(cookie=>cookie.name==='sid'&&cookie.httpOnly));assert(state.cookies.some(cookie=>cookie.name==='second'));assert(state.origins.some(origin=>origin.localStorage.some(item=>item.name==='retained')));
 await logins.close(id);await assert.rejects(logins.frame(id));
 const result=await engine.browse({url:urls[2],actions:[],screenshot:false},{urls},true,{state});assert.match(result.text,/登录后报告/);assert(!JSON.stringify(result).includes('synthetic-session'));assert.equal(posts,1);
 await assert.rejects(engine.browse({url:urls[2],actions:[],screenshot:false},{urls},false));
 await assert.rejects(engine.browse({url:urls[0],actions:[{kind:'click',selector:'button'}],screenshot:false},{urls},false,{state}));assert.equal(posts,1);
 // 未授权跳转和必须保留POST的重定向都不能重发凭据。
 for(const mode of ['unauthorized','preserve-post']){
  redirectStatus=mode==='preserve-post'?307:302;
  const allowed=mode==='unauthorized'?urls.slice(0,2):urls;
  await logins.start(id,urls[0],{urls:allowed});
  await logins.command(id,{kind:'click',x:50,y:35});await logins.command(id,{kind:'text',text:'synthetic-secret'});
  const before=posts;const rejected=await logins.command(id,{kind:'click',x:50,y:80});
  assert.equal(posts,before+1);assert.notEqual(rejected.url,urls[2]);
  if(mode==='unauthorized')assert(rejected.blockedUrls.includes(urls[2]));
  await logins.close(id);
 }
 console.log('人工登录坐标输入、POST/双Cookie、localStorage保存、私密画面、关闭、登录态只读复用、未授权跳转/307不重发及非登录模式禁止提交通过');
}finally{await logins.close();await engine.close();}
