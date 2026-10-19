// 浏览器验证使用受控API数据；真实鉴权与隐私边界由数据库专项另行验证。
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../packages/server/package.json',import.meta.url)),{chromium}=require('playwright');
const root=resolve('apps/web/dist');
const server=createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;const file=resolve(root,'.'+pathname);if(!file.startsWith(root+'/'))throw Error('路径无效');res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.WORKPIVOT_TEST_CHROME??'/usr/bin/google-chrome'});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('wp_token','synthetic-ui-token'));
 const users=[{id:'owner',username:'合成管理员',role:'admin',platformAdmin:true},{id:'member',username:'合成成员',role:'member'}];let fail=false,failAttempts=false;const capacities=new Map();let approved=false,revoked=false,cleaned=false;
 await page.route('**/api/**',async route=>{const url=new URL(route.request().url());let data={};
  if(url.pathname==='/api/health')data={ok:true,name:'workpivot',apiProtocol:1,version:'synthetic',storage:'postgresql'};
  else if(url.pathname==='/api/auth/state')data={authenticated:true,user:users[0]};
  else if(url.pathname==='/api/users')data={users};
  else if(url.pathname==='/api/admin/request-audits/cleanups')data={rows:cleaned?[{id:'cleanup',actorId:'owner',before:'2020-02-01',removed:1,createdAt:'2026-10-18T00:00:00Z'}]:[]};
  else if(url.pathname==='/api/admin/request-audits/cleanup-preview')data={before:'2020-02-01',count:1,fingerprint:'a'.repeat(32)};
  else if(url.pathname==='/api/admin/request-audits/cleanup'){assert.equal(route.request().postDataJSON().confirmation,'永久清理请求审计');cleaned=true;data={removed:1};}
  else if(url.pathname==='/api/admin/network-targets'&&route.request().method()==='POST'){approved=true;data={id:'network-grant'};}
  else if(url.pathname==='/api/admin/network-targets/network-grant/revoke'){revoked=true;data={ok:true};}
  else if(url.pathname==='/api/admin/network-targets')data={targets:approved?[{id:'network-grant',url:'https://oa.internal/report',address:'10.20.30.40',revokedAt:revoked?'2026-10-18':null}]:[],audit:[]};
  else if(url.pathname==='/api/admin/request-audits/export'){await route.fulfill({contentType:'application/x-ndjson',headers:{'content-disposition':'attachment; filename="workpivot-request-audit.jsonl"'},body:'{"id":"audit-synthetic"}\n'});return;}
  else if(url.pathname==='/api/admin/request-audits'){const older=url.searchParams.has('before'),empty=url.searchParams.get('actor')==='member';data={rows:empty?[]:[{id:older?'audit-older':'audit-new',actorId:null,method:'POST',area:'auth',createdAt:'2026-10-18T00:00:00Z',status:401,outcome:'denied'}],next:empty||older?null:'audit-new'};}
  else if(url.pathname==='/api/admin/captures')data=url.searchParams.get('userId')==='member'?{counts:{sources:0,versions:0,observations:0},audit:[],next:null}:{counts:{sources:1,versions:2,observations:3,originals:2,originalBytes:'1234'},audit:[{id:'capture-event',actorId:'owner',planId:'synthetic-capture-plan',versionId:'synthetic-version',runId:'synthetic-run',action:'new_version',retryCount:2,createdAt:'2026-10-18T00:00:00Z'}],next:null};
  else if(url.pathname==='/api/admin/automation-attempts'){
   if(failAttempts){await route.fulfill({status:503,json:{error:'合成审计查询暂不可用'}});return;}
   const empty=url.searchParams.get('userId')==='member'||url.searchParams.get('category')==='invalid_input';
   const older=url.searchParams.has('at');
   data={attempts:empty?[]:[{id:older?'older':'first',actorId:'member',targetId:'owner',action:'automation.capacity.update',category:older?'conflict':'permission_denied',createdAt:'2026-10-18T00:00:00.123456Z'}],next:empty||older?null:{at:'2026-10-18T00:00:00.123456Z',id:'first'}};
  }
  else if(url.pathname==='/api/admin/automation-capacity'){
   const body=route.request().method()==='PUT'?route.request().postDataJSON():null;
   const owner=body?.userId??url.searchParams.get('userId');
   const old=capacities.get(owner)??{capacity:{enabled:2,queued:1,enabledLimit:20,queuedLimit:10,revision:0},audit:[],nextBefore:null};
   if(body){const next={enabledLimit:body.enabledLimit,queuedLimit:body.queuedLimit};capacities.set(owner,{capacity:{...old.capacity,...next,revision:old.capacity.revision+1},audit:[{revision:1,actorId:'owner',before:{enabledLimit:20,queuedLimit:10},after:next,reason:body.reason,createdAt:new Date().toISOString()}],nextBefore:null});data={revision:1};}
   else data=old;
  }
  else if(url.pathname==='/api/admin/operations'){
   if(fail){await route.fulfill({status:503,json:{error:'合成服务暂不可用'}});return;}
   const member=url.searchParams.get('userId')==='member';data={user:users[member?1:0],month:url.searchParams.get('month'),groups:{task_runs:member?[]:[{status:'failed',count:3}],automation_runs:[{status:'completed',count:2}],document_processing:[],embedding_jobs:[],approvals:[]},usage:member?[]:[{model:'合成模型',source:'chat',requests:2,inputTokens:'42',outputTokens:'12',unfinished:0,estimated:1}],notice:'合成元数据，无私人正文'};
  }
  await route.fulfill({json:data});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/admin.html`);
 await page.getByRole('button',{name:'运行监控与用量',exact:true}).click();
 await page.getByText('采集存档 2 份（DOM 0 份）· 1234 字节',{exact:true}).waitFor();
 await page.getByText('来源 1 · 正文版本 2 · 采集记录 3',{exact:true}).waitFor();
 await page.getByText('合成模型',{exact:true}).waitFor();assert.equal(await page.getByText('失败：3',{exact:true}).count(),1);
 await page.getByText('操作人：合成成员；目标：合成管理员',{exact:true}).waitFor();
 await page.getByRole('button',{name:'加载更早失败记录',exact:true}).click();await page.getByText('版本或请求冲突',{exact:false}).last().waitFor();
 await page.getByLabel('失败分类').selectOption('invalid_input');await page.getByText('暂无额度修改失败记录',{exact:true}).waitFor();
 await page.getByLabel('失败分类').selectOption('');await page.getByText('操作人：合成成员；目标：合成管理员',{exact:true}).waitFor();
 failAttempts=true;await page.getByRole('button',{name:'刷新失败审计',exact:true}).click();await page.getByRole('alert').filter({hasText:'合成审计查询暂不可用'}).waitFor();assert.equal(await page.getByText('操作人：合成成员；目标：合成管理员',{exact:true}).count(),0);
 failAttempts=false;await page.getByRole('button',{name:'刷新失败审计',exact:true}).click();await page.getByText('操作人：合成成员；目标：合成管理员',{exact:true}).waitFor();
 await page.getByLabel('启用上限').fill('12');await page.getByLabel('排队上限').fill('6');await page.getByLabel('变更原因').fill('合成页面容量验收');
 await page.getByRole('button',{name:'核对变更',exact:true}).click();await page.getByRole('dialog',{name:'确认额度变更'}).waitFor();
 await page.getByRole('button',{name:'确认保存额度',exact:true}).click();await page.getByText('合成页面容量验收',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('启用上限').inputValue(),'12');
 await page.getByLabel('监控用户').selectOption('member');await page.getByText('本月暂无用量。',{exact:true}).waitFor();assert.equal(await page.getByText('合成模型',{exact:true}).count(),0);
 await page.getByText('暂无额度变更记录',{exact:true}).waitFor();assert.equal(await page.getByLabel('启用上限').inputValue(),'20');assert.equal(await page.getByText('合成页面容量验收',{exact:true}).count(),0);
 await page.getByText('暂无额度修改失败记录',{exact:true}).waitFor();assert.equal(await page.getByText('操作人：合成成员；目标：合成管理员',{exact:true}).count(),0);
 fail=true;await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByRole('alert').filter({hasText:'合成服务暂不可用'}).waitFor();
 fail=false;await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByText('本月暂无用量。',{exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);assert.deepEqual(errors,[]);assert.equal(await page.getByText('该地址未提供可用的 WorkPivot 服务',{exact:false}).count(),0);
 const output=resolve('../local-runtime/acceptance/admin-monitor-'+Date.now());await mkdir(output,{recursive:true});await page.screenshot({path:output+'/mobile.png',fullPage:true});
 await page.getByRole('button',{name:'请求安全审计',exact:true}).click();
 await page.getByText('请求：audit-new',{exact:true}).waitFor();
 await page.getByRole('button',{name:'加载更早请求',exact:true}).click();await page.getByText('请求：audit-older',{exact:true}).waitFor();
 await page.getByLabel('审计操作人').selectOption('member');await page.getByText('暂无匹配记录',{exact:true}).waitFor();assert.equal(await page.getByText('请求：audit-new',{exact:true}).count(),0);
 await page.getByLabel('审计操作人').selectOption('');await page.getByText('请求：audit-new',{exact:true}).waitFor();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出筛选结果（最多10000条）',exact:true}).click();assert.equal((await download).suggestedFilename(),'workpivot-request-audit.jsonl');
 await page.getByLabel('清理截止日期').fill('2020-02-01');await page.getByRole('button',{name:'预览清理范围',exact:true}).click();await page.getByRole('dialog',{name:'确认永久清理审计'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'确认永久清理',exact:true}).isDisabled(),true);await page.getByLabel('永久清理确认文字').fill('永久清理请求审计');await page.getByRole('button',{name:'确认永久清理',exact:true}).click();await page.getByText('清理 1 条',{exact:false}).waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);assert.deepEqual(errors,[]);await page.screenshot({path:output+'/audit-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'内网地址授权',exact:true}).click();await page.getByText('暂无内网授权',{exact:true}).waitFor();
 await page.getByLabel('内网完整URL').fill('https://oa.internal/report');await page.getByLabel('内网固定IP').fill('10.20.30.40');await page.getByRole('button',{name:'核对并批准',exact:true}).click();await page.getByRole('dialog',{name:'确认内网授权变更'}).waitFor();assert.equal(approved,false);await page.getByRole('button',{name:'确认变更',exact:true}).click();await page.getByRole('button',{name:'撤销授权',exact:true}).waitFor();
 await page.getByRole('button',{name:'撤销授权',exact:true}).click();await page.getByRole('button',{name:'确认变更',exact:true}).click();await page.getByText('10.20.30.40 · 已撤销',{exact:true}).waitFor();assert.equal(revoked,true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);assert.deepEqual(errors,[]);await page.screenshot({path:output+'/network-mobile.png',fullPage:true});

 console.log('管理监控页面：数据展示、用户切换清空旧结果、错误反馈/重试、窄屏和无JS异常通过；'+output);
}finally{await browser?.close();await new Promise(r=>server.close(r));}
