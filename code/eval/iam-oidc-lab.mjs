// 仅验证独立实验身份源与协议边界；此接收器不是WorkPivot生产登录实现。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomBytes,createPublicKey,verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {lab,labRoot} from '../scripts/iam-lab.mjs';
const require=createRequire(new URL('../packages/server/package.json',import.meta.url)),{chromium}=require('playwright');
const redirect='http://127.0.0.1:40191/callback',pending=new Map();let checks=0,browser,server;
const check=(value,label)=>{assert.ok(value,label);console.log('通过：'+label);checks++;};
const random=()=>randomBytes(32).toString('base64url');
function validate(token,keys,expected){
 if(typeof token!=='string'||token.length>32768)throw Error('令牌格式无效');
 const parts=token.split('.');if(parts.length!==3)throw Error('令牌格式无效');
 const header=JSON.parse(Buffer.from(parts[0],'base64url')),claims=JSON.parse(Buffer.from(parts[1],'base64url'));
 if(header.alg!=='RS256')throw Error('算法不允许');
 const key=keys.find(key=>key.kid===header.kid&&key.kty==='RSA'&&key.use==='sig');
 if(!key||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key,format:'jwk'}),Buffer.from(parts[2],'base64url')))throw Error('签名无效');
 const now=expected.now??Math.floor(Date.now()/1000),aud=Array.isArray(claims.aud)?claims.aud:[claims.aud];
 if(claims.iss!==expected.issuer||!aud.includes(expected.clientId)||(aud.length>1&&claims.azp!==expected.clientId))throw Error('身份源或受众不匹配');
 if(!Number.isFinite(claims.exp)||claims.exp<=now||!Number.isFinite(claims.iat)||claims.iat>now+60)throw Error('令牌时效无效');
 if(claims.nonce!==expected.nonce||typeof claims.sub!=='string'||!claims.sub)throw Error('登录事务不匹配');
 return claims;
}
async function main(){
 await lab('start');const credentials=JSON.parse(readFileSync(join(labRoot,'credentials.json'),'utf8'));
 server=createServer((req,res)=>{const url=new URL(req.url,redirect);if(url.pathname!=='/callback'){res.writeHead(404);res.end();return;}const state=url.searchParams.get('state'),entry=pending.get(state);if(!entry||entry.expires<=Date.now()||entry.used||url.searchParams.getAll('state').length!==1||url.searchParams.getAll('code').length!==1){res.writeHead(400);res.end('测试回调被拒绝');return;}entry.used=true;entry.code=url.searchParams.get('code');res.setHeader('Content-Type','text/plain; charset=utf-8');res.end('测试回调已接收；未建立WorkPivot会话');});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(40191,'127.0.0.1',resolve);});
 browser=await chromium.launch({headless:true,executablePath:process.env.WORKPIVOT_TEST_CHROME??'/usr/bin/google-chrome'});
 const discoveries=[];
 for(const realm of ['wp-lab-a','wp-lab-b']){
  const issuer='http://127.0.0.1:40190/realms/'+realm,response=await fetch(issuer+'/.well-known/openid-configuration');assert(response.ok);const discovery=await response.json();
  check(discovery.issuer===issuer&&discovery.code_challenge_methods_supported.includes('S256'),'发现配置保留完整issuer并支持S256：'+realm);discoveries.push(discovery);
 }
 async function authorize(discovery){
  const state=random(),nonce=random(),verifier=random(),entry={nonce,verifier,expires:Date.now()+120000,used:false};pending.set(state,entry);
  const url=new URL(discovery.authorization_endpoint);url.search=new URLSearchParams({client_id:credentials.clientId,redirect_uri:redirect,response_type:'code',scope:'openid profile email',state,nonce,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  const context=await browser.newContext();try{const page=await context.newPage();await page.goto(url.href);await page.locator('#username').fill(credentials.username);await page.locator('#password').fill(credentials.password);await page.locator('#kc-login').click();await page.waitForURL(u=>u.origin==='http://127.0.0.1:40191'&&u.pathname==='/callback');assert(entry.used&&entry.code);return {...entry,state};}finally{await context.close();}
 }
 async function exchange(discovery,entry,overrides={}){return fetch(discovery.token_endpoint,{method:'POST',body:new URLSearchParams({grant_type:'authorization_code',client_id:credentials.clientId,client_secret:credentials.clientSecret,redirect_uri:redirect,code:entry.code,code_verifier:entry.verifier,...overrides})});}
 const identities=[];
 for(const discovery of discoveries){
  const entry=await authorize(discovery),response=await exchange(discovery,entry);check(response.ok,'真实浏览器授权码与PKCE交换成功');
  const tokens=await response.json(),keys=(await(await fetch(discovery.jwks_uri)).json()).keys,expected={issuer:discovery.issuer,clientId:credentials.clientId,nonce:entry.nonce};
  const claims=validate(tokens.id_token,keys,expected);check(!!claims.sub,'JWKS签名、issuer、audience、时效及nonce通过');identities.push({issuer:claims.iss,subject:claims.sub,email:claims.email,username:claims.preferred_username});
  for(const replacement of [{issuer:discoveries.find(d=>d.issuer!==discovery.issuer).issuer},{clientId:'other-client'},{nonce:random()},{now:claims.exp+1}])assert.throws(()=>validate(tokens.id_token,keys,{...expected,...replacement}));
  const parts=tokens.id_token.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);assert.throws(()=>validate(parts.join('.'),keys,expected));check(true,'跨issuer、错误受众/nonce、过期及签名篡改均拒绝');
  check((await exchange(discovery,entry)).status===400,'已使用授权码不能重复交换');
  const repeated=new URL(redirect);repeated.search=new URLSearchParams({state:entry.state,code:entry.code});check((await fetch(repeated)).status===400,'本地接收器拒绝已消费state回调');
 }
 check(identities[0].issuer!==identities[1].issuer&&identities[0].email===identities[1].email&&identities[0].username===identities[1].username,'两realm同邮箱/用户名仍为不同外部身份，不能自动合并');
 const discovery=discoveries[0],wrongVerifier=await authorize(discovery);check((await exchange(discovery,wrongVerifier,{code_verifier:random()})).status===400,'错误PKCE验证器拒绝交换');
 const wrongClient=await authorize(discovery);check((await exchange(discovery,wrongClient,{client_secret:random()})).status===401,'错误客户端凭据拒绝交换');
 const wrongRedirect=await authorize(discovery);check((await exchange(discovery,wrongRedirect,{redirect_uri:redirect+'?changed=1'})).status===400,'令牌交换阶段拒绝不同回调地址');
 const bad=new URL(discovery.authorization_endpoint);bad.search=new URLSearchParams({client_id:credentials.clientId,redirect_uri:'http://127.0.0.1:40191/other',response_type:'code',scope:'openid'});check((await fetch(bad)).status===400,'未登记回调地址被身份源拒绝');
 bad.search=new URLSearchParams({client_id:credentials.clientId,redirect_uri:redirect,response_type:'code',scope:'openid'});check((await fetch(bad)).status===400,'客户端要求PKCE，不带challenge不能授权');
 check((await fetch(redirect+'?state=unknown&code=synthetic')).status===400,'本地接收器拒绝未知state');
 pending.set('expired',{expires:Date.now()-1,used:false});check((await fetch(redirect+'?state=expired&code=synthetic')).status===400,'本地接收器拒绝过期state');
 check((await fetch(discovery.token_endpoint,{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:credentials.clientId,client_secret:credentials.clientSecret,username:credentials.username,password:credentials.password})})).status===400,'密码直接交换模式关闭');
 console.log('OIDC实验环境：'+checks+'项通过；未接入WorkPivot登录或业务数据');
}
try{await main();}catch(error){console.error('OIDC实验验收失败：'+(error.code==='ERR_ASSERTION'?error.message.split('\n')[0]:error.name));process.exitCode=1;}finally{await browser?.close();if(server?.listening)await new Promise(resolve=>server.close(resolve));pending.clear();}
