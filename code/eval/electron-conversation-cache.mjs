// 真实 Electron 主进程、预加载桥与隔离HTTP服务联调，所有账号和会话均为合成数据。
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,extname} from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../packages/server/package.json',import.meta.url)),{_electron:electron}=require('playwright');
const desktopRequire=createRequire(new URL('../apps/desktop/package.json',import.meta.url));
const binary=process.env.WORKPIVOT_TEST_ELECTRON??desktopRequire('electron'),root=resolve('apps/web/dist'),profile=await mkdtemp(join(tmpdir(),'wp-electron-cache-'));
let signedOut=false;
let app,delay=false,offline=false,deleted=false,newEvent=false,hold=[];
const event=(id,sequence,kind,content)=>({id,sequence:String(sequence),turnId:'turn-a',runId:'run-a',kind,content,truncated:false});
const server=createServer(async(req,res)=>{
 try{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path.startsWith('/api/')){
  const account=req.headers.authorization==='Bearer token-b'?'account-b':'account-a';
  let data={experts:[],suggestions:[],plans:[],checkpoints:[],files:[],executions:[],builds:[]};
  if(path==='/api/auth/login'){
   let raw='';for await(const chunk of req)raw+=chunk;
   const credentials=JSON.parse(raw);
   if(credentials.password!=='test-password'){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:'invalid'}));return;}
   signedOut=false;data={token:'token-a'};
  }
  else if(path==='/api/health')data={ok:true,name:'workpivot',version:'0.3.0-rc.1',apiProtocol:1,storage:'postgresql',chatEnabled:true};
  else if(path==='/api/auth/state')data=signedOut?{authenticated:false,needsSetup:false}:{authenticated:true,user:{id:account,username:account,role:'member'}};
  else if(path==='/api/tasks')data={tasks:deleted?[]:[{id:'task-a',name:'合成任务',projectId:null,status:'completed',revision:1}]};
  else if(path==='/api/projects')data={projects:[]};
  else if(path.endsWith('/conversation')){
   if(delay)await new Promise(r=>hold.push(r));
   if(offline){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'合成离线'}));return;}
   const events=[event('e1',1,'user',account==='account-a'?'本地已保存的会话':'另一个账号的会话'),...(newEvent?[event('e3',3,'assistant','服务端新增答复')]:[])];
   data={turns:[{id:'turn-a',events,hasMoreEvents:false,nextEventSequence:null}],nextCursor:null,snapshotSequence:newEvent?'3':'1'};
  }else if(path.endsWith('/conversation-changes')){const after=new URL(req.url,'http://localhost').searchParams.get('after');data=newEvent?{events:after==='1'?[event('e2',2,'assistant','中间页补齐答复')]:after==='2'?[event('e3',3,'assistant','服务端新增答复')]:[],hasMore:after==='1',nextSequence:after==='1'?'2':'3',snapshotSequence:'3'}:{events:[],hasMore:false,nextSequence:'1',snapshotSequence:'1'};}
  else if(path.endsWith('/permissions'))data={pending:[]};
  else if(path.endsWith('/resource-scope'))data={scope:{versionIds:[],memoryScopes:[],expert:false}};
  res.setHeader('content-type','application/json');res.end(JSON.stringify(data));return;
 }
 const file=resolve(root,path==='/'?'index.html':'.'+path);if(!file.startsWith(root+'/'))throw Error();res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));
 }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const launch=async()=>{
 app=await electron.launch({executablePath:binary,args:process.env.WORKPIVOT_TEST_ELECTRON?['--no-sandbox']:['--no-sandbox',resolve('apps/desktop')],env:{...process.env,XDG_CONFIG_HOME:profile,WORKPIVOT_SERVER_URL:origin},timeout:30000});
 const page=await app.firstWindow();await page.waitForURL(origin+'/',{timeout:30000});
 await page.evaluate(()=>localStorage.setItem('wp_token','token-a'));await page.reload();
 await page.getByRole('button',{name:'合成任务',exact:true}).click();return page;
};
try{
 let page=await launch();
 // 模拟后台断连，验证真正固定定位的顶部提示也处于标题栏下方。
 await page.route('**/api/health',route=>route.fulfill({status:503,body:'unavailable'}));
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 const connectionNotice=page.getByRole('status').filter({hasText:'与后台连接中断'});
 await connectionNotice.waitFor();
 const titlebarBox=await page.locator('#workpivot-titlebar').boundingBox();
 const noticeBox=await connectionNotice.boundingBox();
 assert.ok(noticeBox.y>=titlebarBox.y+titlebarBox.height,'断连提示不能被窗口标题栏遮挡');
 const headerBox=await page.locator('main > header').boundingBox();
 assert.ok(headerBox.y>=titlebarBox.y+titlebarBox.height,'会话工具条必须完整可见');
 await page.screenshot({path:'/tmp/wp-desktop-titlebar-layout.png'});
 await page.unroute('**/api/health');
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await page.getByRole('button',{name:'知道了',exact:true}).click();
 await page.getByRole('button',{name:'最大化',exact:true}).click();
 await page.getByRole('button',{name:'还原窗口',exact:true}).waitFor();
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMaximized()),true);
 await page.getByRole('button',{name:'还原窗口',exact:true}).click();
 await page.getByRole('button',{name:'最大化',exact:true}).waitFor();
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMenuBarVisible()),false);
 await page.getByRole('button',{name:'最小化',exact:true}).click();
 // 窗口管理器异步完成最小化，等待实际状态后再断言。
 for(let attempt=0;attempt<40;attempt++){if(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMinimized()))break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMinimized()),true);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].restore());
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('button',{name:'服务器连接',exact:true}).click();
 await page.getByRole('button',{name:'更换服务器',exact:true}).waitFor();
 await page.getByRole('button',{name:'更换服务器',exact:true}).click();
 await page.waitForURL('**/connection.html');
 await page.getByRole('button',{name:'最大化',exact:true}).waitFor();
 await page.locator('#server-url').fill(origin);
 await page.locator('#username').fill('account-a');
 await page.locator('#password').fill('test-password');
 await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.waitForURL(origin+'/');
 await page.getByRole('button',{name:'合成任务',exact:true}).click();

 await page.getByText('本地已保存的会话',{exact:true}).waitFor();
 await page.waitForFunction(async()=>{const c=window.workpivotDesktop.conversationCache,h=await c.open('token-a');return (await c.status(h)).tasks===1;});
 const dataDir=await app.evaluate(({app})=>app.getPath('userData'));assert.ok(dataDir.startsWith(profile));
 await app.close();app=null;
 delay=true;page=await launch();
 await page.getByText('本地已保存的会话',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'发送',exact:true}).isDisabled(),true);
 assert.ok((await page.locator('body').textContent()).includes('已读取本地会话'));
 newEvent=true;delay=false;hold.splice(0).forEach(r=>r());
 await page.getByText('服务端新增答复',{exact:false}).waitFor();
 await page.getByText('中间页补齐答复',{exact:false}).waitFor();
 assert.equal(await page.getByText('服务端新增答复',{exact:false}).count(),1);
 // 直接伪造账号/任务路径不能越过主进程的身份和任务约束。
 assert.equal(await page.evaluate(async()=>{const c=window.workpivotDesktop.conversationCache,h=await c.open('token-a');try{await c.read(h,'../escape');return false;}catch{return true;}}),true);
 offline=true;await page.reload();
 await page.getByText('本地已保存的会话',{exact:true}).waitFor();
 await page.getByText('正在显示本地会话，服务端尚未确认；恢复连接后自动同步',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'发送',exact:true}).isDisabled(),true);
 offline=false;
 await page.getByRole('button',{name:'用户菜单',exact:true}).click();
 await page.getByRole('button',{name:'本地会话记录',exact:true}).click();
 await page.getByRole('dialog',{name:'本地会话记录',exact:true}).waitFor();
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'清空本地会话副本',exact:true}).click();
 await page.getByText('0 个任务 · 0.00 MB',{exact:true}).waitFor();
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.reload();await page.getByText('服务端新增答复',{exact:false}).waitFor();
 await page.waitForFunction(async()=>{const c=window.workpivotDesktop.conversationCache,h=await c.open('token-a');return (await c.status(h)).tasks===1;});
 const other=await page.evaluate(async()=>{const c=window.workpivotDesktop.conversationCache,h=await c.open('token-b');return (await c.read(h,'task-a')).snapshot;});assert.equal(other,null);
 deleted=true;
 await page.evaluate(async()=>{const c=window.workpivotDesktop.conversationCache,h=await c.open('token-a');await c.reconcile(h,'token-a');});
 const count=await page.evaluate(async()=>{const c=window.workpivotDesktop.conversationCache,h=await c.open('token-a');return (await c.status(h)).tasks;});assert.equal(count,0);
 await page.screenshot({path:'/tmp/wp-electron-conversation-cache.png'});
 signedOut=true;await page.reload();
 await page.getByRole('textbox',{name:'服务器地址',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'更换服务器',exact:true}).count(),0);
 await page.getByRole('textbox',{name:'服务器地址',exact:true}).fill(origin.replace('127.0.0.1','localhost'));
 await page.getByPlaceholder('用户名',{exact:true}).fill('account-a');
 await page.getByPlaceholder('密码（至少 6 位）',{exact:true}).fill('wrong-password');
 await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByText('登录失败，请检查用户名、密码及目标服务器是否已初始化',{exact:true}).waitFor();
 assert.equal(new URL(page.url()).origin,origin,'失败保留原登录页面');
 await page.screenshot({path:'/tmp/wp-desktop-inline-login.png'});
 await page.getByPlaceholder('密码（至少 6 位）',{exact:true}).fill('test-password');
 await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.waitForURL(origin.replace('127.0.0.1','localhost')+'/');
 await page.getByRole('button',{name:'设置',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>localStorage.getItem('wp_token')),'token-a');
 await page.evaluate(()=>{void window.workpivotDesktop.changeServer();});
 await page.waitForURL('**/connection.html');
 await page.screenshot({path:'/tmp/wp-desktop-connection-titlebar.png'});
 await page.getByRole('button',{name:'关闭窗口',exact:true}).click();
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
 console.log('窗口按钮、隐藏菜单、设置切换服务器与关闭到托盘通过');
 console.log('真实Electron联调通过：重启持久化、本地先显示、增量去重、离线门禁、账号隔离、路径拒绝、管理清理与服务端删除同步');
}finally{delay=false;hold.splice(0).forEach(r=>r());await app?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(profile,{recursive:true,force:true});}
