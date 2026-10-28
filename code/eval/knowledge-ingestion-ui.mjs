// 合成 API + 浏览器验收：逐段确认知识、查看版本状态并精确删除单个版本。
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname,resolve} from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';

const require=createRequire(new URL('../packages/server/package.json',import.meta.url));
const {chromium}=require('playwright');
const root=resolve('apps/web/dist');
const staticServer=createServer(async(req,res)=>{
  try{
    const path=new URL(req.url,'http://localhost').pathname;
    const file=resolve(root,path==='/'?'index.html':'.'+path);
    if(!file.startsWith(root+'/'))throw Error('invalid path');
    res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(file)]??'application/octet-stream');
    res.end(await readFile(file));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(done=>staticServer.listen(0,'127.0.0.1',done));

let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome'});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    localStorage.setItem('wp_token','synthetic-ui-token');
    localStorage.setItem('wp-right-panel-open','true');
  });
  const task={id:'task-a',projectId:'project-a',name:'合成知识任务',status:'idle',revision:1};
  const version=(id,revision,current)=>id==='version-2'
    ? {id,documentId:'document-1',name:'合成知识.pdf',revision,current,size:32,knowledgeStatus:'confirmed',knowledgeRevision:2}
    : {id,documentId:'document-1',name:'合成知识.pdf',revision,current,size:24,knowledgeStatus:'confirmed',knowledgeRevision:2};
  let knowledgeState='pending',confirmBody=null,deleteBody=null,deletePath='';
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    let data={experts:[],suggestions:[],plans:[],checkpoints:[],files:[],artifacts:[],executions:[],builds:[],entries:[]};
    if(path==='/api/health')data={ok:true,name:'workpivot',apiProtocol:1,storage:'postgresql',chatEnabled:true,filesEnabled:true};
    else if(path==='/api/auth/state')data={authenticated:true,user:{id:'owner',username:'合成用户',role:'member'},quota:{used:1,limit:10,remaining:9}};
    else if(path==='/api/tasks')data={tasks:[task]};
    else if(path==='/api/projects')data={projects:[{id:'project-a',name:'合成项目',revision:1}]};
    else if(path==='/api/tasks/task-a/conversation')data={turns:[],nextCursor:null,snapshotSequence:'0'};
    else if(path==='/api/tasks/task-a/conversation-changes')data={events:[],nextSequence:'0',snapshotSequence:'0',hasMore:false};
    else if(path==='/api/tasks/task-a/permissions')data={pending:[]};
    else if(path==='/api/tasks/task-a/resource-scope')data={scope:{versionIds:[],memoryScopes:[],expert:false,scheduleIds:[],baseRunId:null}};
    else if(path==='/api/tasks/task-a/files')data={files:[version('version-2',2,true)]};
    else if(path==='/api/tasks/task-a/artifacts')data={artifacts:[]};
    else if(path==='/api/tasks/task-a/files/document-1/versions')data={versions:[version('version-2',2,true),version('version-1',1,false)]};
    else if(path==='/api/tasks/task-a/knowledge-ingestions/version-2'){
      data={
        versionId:'version-2',documentId:'document-1',taskId:'task-a',projectId:'project-a',
        name:'合成知识.pdf',versionRevision:2,status:knowledgeState,revision:knowledgeState==='pending'?1:2,
        selectedOrdinals:knowledgeState==='confirmed'?[0]:[],total:2,offset:0,limit:50,nextOffset:null,
        candidates:[
          {id:'0',ordinal:0,location:'第1页',sourceOffset:0,content:'合成项目预算说明',suggested:true,reason:null},
          {id:'1',ordinal:1,location:'第2页',sourceOffset:8,content:'合成项目人员说明',suggested:true,reason:null},
        ],
      };
    }else if(path==='/api/tasks/task-a/knowledge-ingestions/version-2/confirm'&&request.method()==='POST'){
      confirmBody=request.postDataJSON();knowledgeState='confirmed';data={status:'confirmed',revision:2,selected:1,excluded:1};
    }else if(path==='/api/tasks/task-a/files/document-1/versions/version-1'&&request.method()==='DELETE'){
      deleteBody=request.postDataJSON();deletePath=path;data={cleanupPending:false};
    }
    await route.fulfill({json:data});
  });

  await page.goto(`http://127.0.0.1:${staticServer.address().port}/`);
  await page.getByRole('button',{name:'合成知识任务',exact:true}).click();
  await page.getByRole('button',{name:'展开悬浮工具区'}).click();
  const tools=page.getByRole('region',{name:'悬浮工具区'});
  await tools.getByText('合成知识.pdf',{exact:true}).first().waitFor();
  await tools.getByRole('button',{name:'知识',exact:true}).click();
  const review=page.getByRole('dialog',{name:'知识入库审核'});
  await review.waitFor();
  await review.getByRole('checkbox',{name:'选择候选 2'}).uncheck();
  await review.getByRole('button',{name:'确认入库（1）'}).click();
  await review.getByText('已确认 1 段内容').waitFor();
  assert.deepEqual(confirmBody,{revision:1,selected:[0]},'确认请求只提交用户勾选片段');
  await review.getByRole('button',{name:'关闭'}).click();

  await page.getByRole('button',{name:'查看 合成知识.pdf 历史版本'}).click();
  const history=page.getByRole('dialog',{name:'资料历史版本'});
  await history.getByText('版本 1',{exact:false}).waitFor();
  assert.equal(await history.getByText('已入库',{exact:true}).count(),2,'历史版本显示各自知识状态');
  const first=history.getByRole('article').filter({hasText:'版本 1'});
  await first.getByRole('button',{name:'删除此版本'}).click();
  await first.getByRole('button',{name:'确认删除版本'}).click();
  await page.waitForFunction(()=>!document.querySelector('[aria-label="资料历史版本"]')?.textContent?.includes('版本 1'));
  assert.equal(deletePath,'/api/tasks/task-a/files/document-1/versions/version-1');
  assert.deepEqual(deleteBody,{confirmation:'删除此版本'},'单版本删除必须携带精确确认');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:'/tmp/workpivot-knowledge-ingestion.png'});
  console.log('知识入库 UI 检查通过：部分勾选确认、历史状态展示、单版本精确删除。');
}finally{
  await browser?.close();
  await new Promise(done=>staticServer.close(done));
}
