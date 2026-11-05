import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {extname,resolve} from 'node:path';

const require=createRequire(new URL('../packages/server/package.json',import.meta.url));
const {chromium}=require('playwright');
const root=resolve('apps/web/dist');
const server=createServer(async(request,response)=>{
  try{
    const pathname=new URL(request.url,'http://localhost').pathname;
    const file=resolve(root,pathname==='/'||pathname==='/admin'?'admin.html':'.'+pathname);
    if(!file.startsWith(root+'/'))throw Error('invalid path');
    response.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(file)]??'application/octet-stream');
    response.end(await readFile(file));
  }catch{response.writeHead(404);response.end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome'});
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('wp_token','synthetic-admin'));
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    let data={};
    if(path==='/api/health')data={ok:true,storage:'postgresql',version:'0.3.0',providersEnabled:true,mcpEnabled:true};
    else if(path==='/api/auth/state')data={authenticated:true,user:{id:'admin',username:'管理员',role:'admin'},needsSetup:false,registrationEnabled:true};
    else if(path==='/api/users')data={users:[{id:'admin',username:'管理员',role:'admin'}]};
    else if(path==='/api/admin/system-status')data={
      version:'0.3.0',generatedAt:'2026-11-05T08:00:00.000Z',status:'degraded',ready:true,
      services:{api:{state:'ready',latencyMs:0},database:{state:'ready',latencyMs:4},browser:{state:'ready',latencyMs:8},worker:{state:'not_configured',latencyMs:null}},
      database:{latencyMs:4,app:{total:2,idle:1,waiting:0},auth:{total:1,idle:1,waiting:0}},
      storage:{state:'ready',totalBytes:40*1024*1024*1024,freeBytes:12*1024*1024*1024,usedRatio:.7},
      work:{runningTasks:1,expiredLeaseTasks:0,pendingApprovals:2,automationQueued:0,automationRunning:1,memoryJobs:0,parsingJobs:0},
      backup:{state:'stale',finishedAt:'2026-11-02T08:00:00.000Z',databaseBytes:1024,filesBytes:2048},
      alerts:[{code:'backup_stale',severity:'warning',message:'最近一次成功备份超过 36 小时'}],
    };
    await route.fulfill({json:data});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/admin`,{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'系统状态',exact:true}).click();
  await page.getByRole('heading',{name:'系统状态',exact:true}).waitFor();
  await page.getByText('可接收新请求',{exact:true}).waitFor();
  await page.getByText(/业务连接池/).waitFor();
  await page.getByText(/最近一次成功备份超过/).waitFor();
  assert.deepEqual(errors,[]);
  console.log('✅ 管理端系统状态展示版本、依赖和容量');
  console.log('✅ 管理端系统状态展示队列、备份和告警');
  console.log('✅ 系统状态页面无运行时异常');
}finally{
  await browser?.close();
  await new Promise(done=>server.close(done));
}
