// 合成浏览器验收：拖动分隔条调整对话区与右侧窗格，并持久保存宽度。
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname,resolve} from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';

const require=createRequire(new URL('../packages/server/package.json',import.meta.url));
const {chromium}=require('playwright');
const root=resolve('apps/web/dist');
const server=createServer(async(req,res)=>{
  try{
    const path=new URL(req.url,'http://localhost').pathname;
    const file=resolve(root,path==='/'?'index.html':'.'+path);
    if(!file.startsWith(root+'/'))throw Error('invalid path');
    res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(file)]??'application/octet-stream');
    res.end(await readFile(file));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));

let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome'});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    localStorage.setItem('wp_token','synthetic-ui-token');
    localStorage.setItem('wp-right-panel-open','true');
  });
  const task={id:'task-a',projectId:'project-a',name:'可调整宽度任务',status:'idle',revision:1};
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    let data={experts:[],suggestions:[],plans:[],checkpoints:[],files:[],artifacts:[],executions:[],builds:[],entries:[]};
    if(path==='/api/health')data={ok:true,name:'workpivot',apiProtocol:1,storage:'postgresql',chatEnabled:true,filesEnabled:false};
    else if(path==='/api/auth/state')data={authenticated:true,user:{id:'owner',username:'合成用户',role:'member'},quota:{used:1,limit:10,remaining:9}};
    else if(path==='/api/tasks')data={tasks:[task]};
    else if(path==='/api/projects')data={projects:[{id:'project-a',name:'合成项目',revision:1}]};
    else if(path==='/api/tasks/task-a/conversation')data={turns:[],nextCursor:null,snapshotSequence:'0'};
    else if(path==='/api/tasks/task-a/conversation-changes')data={events:[],nextSequence:'0',snapshotSequence:'0',hasMore:false};
    else if(path==='/api/tasks/task-a/permissions')data={pending:[]};
    else if(path==='/api/tasks/task-a/resource-scope')data={scope:{versionIds:[],memoryScopes:[],expert:false,scheduleIds:[],baseRunId:null}};
    else if(path==='/api/tasks/task-a/browser')data={available:false,open:false,busy:false};
    await route.fulfill({json:data});
  });

  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('button',{name:'可调整宽度任务',exact:true}).click();
  const separator=page.getByRole('separator',{name:'调整对话区与右侧窗口宽度'});
  const right=page.getByRole('complementary',{name:'共享浏览器'});
  await separator.waitFor();await right.waitFor();
  const initialBox=await right.boundingBox(),handle=await separator.boundingBox();
  assert.ok(initialBox&&handle,'右侧窗口和分隔条应可见');
  const initial=initialBox.width;
  await page.mouse.move(handle.x+handle.width/2,handle.y+100);
  await page.mouse.down();await page.mouse.move(handle.x-120,handle.y+100,{steps:6});await page.mouse.up();
  const dragged=(await right.boundingBox()).width;
  assert.ok(dragged>=initial+100,'向左拖动分隔条应扩大右侧窗口并压缩对话区');
  assert.equal(Number(await page.evaluate(()=>localStorage.getItem('wp-right-panel-width'))),Math.round(dragged));

  await separator.focus();await separator.press('ArrowRight');
  const narrowed=(await right.boundingBox()).width;
  assert.ok(narrowed<=dragged-18,'键盘右键应缩小右侧窗口');
  await separator.dblclick();
  const restored=(await right.boundingBox()).width;
  assert.ok(Math.abs(restored-initial)<2,'双击分隔条应恢复默认宽度');

  await page.mouse.move((await separator.boundingBox()).x+4,300);
  await page.mouse.down();await page.mouse.move(60,300,{steps:6});await page.mouse.up();
  const persisted=(await right.boundingBox()).width;
  await page.reload();
  await page.getByRole('button',{name:'可调整宽度任务',exact:true}).click();
  await right.waitFor();
  assert.ok(Math.abs((await right.boundingBox()).width-persisted)<2,'刷新后应恢复已保存的右侧窗口宽度');
  assert.ok((await page.getByLabel('聊天记录').boundingBox()).width>=358,'拖动后仍应保留可用的对话区');

  await page.setViewportSize({width:1024,height:900});
  await page.waitForTimeout(50);
  const compactWidth=(await right.boundingBox()).width;
  assert.ok(compactWidth<=400,'窗口缩小时应保留最小对话宽度');
  assert.ok(Number(await page.evaluate(()=>localStorage.getItem('wp-right-panel-width')))>=320,'保存宽度不应低于最小值');
  assert.deepEqual(errors,[]);
  console.log('窗格拖拽检查通过：鼠标拖动、键盘调整、双击复位、宽度持久化和窗口缩放边界。');
}finally{
  await browser?.close();
  await new Promise(done=>server.close(done));
}
