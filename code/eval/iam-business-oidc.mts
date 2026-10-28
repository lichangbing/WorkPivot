import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {lab,labRoot} from '../scripts/iam-lab.mjs';
import {installSchema,pool} from '../packages/server/src/database/connection.js';
import {AccountRepository} from '../packages/server/src/database/accounts.js';
import {IamRepository} from '../packages/server/src/database/iam.js';
import {createAesBox,setSecretBox} from '../packages/server/src/secret.js';

const require=createRequire(new URL('../packages/server/package.json',import.meta.url));
const {chromium}=require('playwright');
const url=process.env['WORKPIVOT_TEST_PG_URL'];
if(!url||process.env['WORKPIVOT_TEST_PG_DISPOSABLE']!=='1')throw Error('Requires an explicitly disposable PostgreSQL instance');
setSecretBox(createAesBox(randomBytes(32).toString('hex')));
const password=randomBytes(24).toString('hex'),admin=pool(url),redirect='http://127.0.0.1:40191/callback';
let browser: import('playwright').Browser|undefined,callbackServer: ReturnType<typeof createServer>|undefined;
let pendingCallback: ((value:{state:string;code:string})=>void)|undefined;
try{
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='iam_test_app') THEN CREATE ROLE iam_test_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='iam_test_auth') THEN CREATE ROLE iam_test_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  END $$; ALTER ROLE iam_test_app PASSWORD '${password}'; ALTER ROLE iam_test_auth PASSWORD '${password}';`);
  const appUrl=new URL(url),authUrl=new URL(url);appUrl.username='iam_test_app';appUrl.password=password;authUrl.username='iam_test_auth';authUrl.password=password;
  const app=pool(appUrl.toString(),{max:2}),auth=pool(authUrl.toString(),{max:2});
  await installSchema(admin,'iam_test_app','iam_test_auth');
  const accounts=new AccountRepository(auth),owner=await accounts.registerFirst('iam-owner',password);
  const iam=new IamRepository(auth);
  const organization=await iam.createOrganization(owner.user.id,'合成企业');
  await lab('start');
  const credentials=JSON.parse(readFileSync(join(labRoot,'credentials.json'),'utf8')) as {username:string;password:string;clientId:string;clientSecret:string};
  const provider=await iam.createProvider(owner.user.id,{organizationId:organization.id,name:'Keycloak 测试',issuer:'http://127.0.0.1:40190/realms/wp-lab-a',clientId:credentials.clientId,clientSecret:credentials.clientSecret,redirectUri:redirect,enabled:true});
  callbackServer=createServer((req,res)=>{
    const target=new URL(req.url,redirect);
    if(target.pathname!=='/callback'||typeof target.searchParams.get('state')!=='string'||typeof target.searchParams.get('code')!=='string'){res.writeHead(400);res.end();return;}
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<p>登录回调已接收</p>');
    pendingCallback?.({state:target.searchParams.get('state')!,code:target.searchParams.get('code')!});
  });
  await new Promise<void>((resolve,reject)=>{callbackServer!.once('error',reject);callbackServer!.listen(40191,'127.0.0.1',resolve);});
  browser=await chromium.launch({headless:true,executablePath:process.env.WORKPIVOT_TEST_CHROME??'/usr/bin/google-chrome'});
  const login=async()=>{
    const start=await iam.start(provider.id,'/',null);
    const callback=new Promise<{state:string;code:string}>(resolve=>{pendingCallback=resolve;});
    const context=await browser!.newContext();const page=await context.newPage();
    try{
      await page.goto(start.authorizationUrl);
      await page.locator('#username').fill(credentials.username);
      await page.locator('#password').fill(credentials.password);
      await page.locator('#kc-login').click();
      await page.waitForURL(value=>value.origin==='http://127.0.0.1:40191');
      return {binding:start.binding,...await callback};
    }finally{await context.close();}
  };
  const first=await login();
  const pending=await iam.callback(first.state,first.code,first.binding);
  assert.equal(pending.status,'pending');
  assert.equal((await iam.adminOverview(owner.user.id)).pending.length,1);
  const pendingRow=(await iam.adminOverview(owner.user.id)).pending[0]!;
  await iam.approvePending(owner.user.id,pendingRow.id,owner.user.id,pendingRow.revision);
  const second=await login();
  const authorized=await iam.callback(second.state,second.code,second.binding);
  assert.equal(authorized.status,'authorized');
  assert(authorized.status==='authorized');
  const completion=await iam.complete(authorized.ticket,second.binding);
  const session=await accounts.issueExternalSession(completion.userId,provider.id);
  assert.equal((await accounts.resolve(session.token))?.id,owner.user.id);
  await assert.rejects(()=>iam.complete(authorized.ticket,second.binding),/无效|使用/);
  const wrong=await login();
  await assert.rejects(()=>iam.callback(wrong.state,wrong.code,randomBytes(32).toString('base64url')),/浏览器不匹配/);
  console.log('OIDC business integration passed: pending approval, bound login, one-time completion, browser binding rejection');
  await Promise.all([app.end(),auth.end()]);
}finally{
  await browser?.close();
  if(callbackServer?.listening)await new Promise<void>(resolve=>callbackServer!.close(()=>resolve()));
  await admin.end();
}
