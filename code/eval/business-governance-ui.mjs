// 合成浏览器验收：实体合并/拆回和表格候选仅通过显式确认提交。
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
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const writes=[];
  await page.addInitScript(()=>localStorage.setItem('wp_token','synthetic-ui-token'));
  const task={id:'task-a',projectId:'project-a',name:'业务事实治理',status:'idle',revision:1};
  const objects=[
    {id:'object-a',objectType:'contract',name:'合同 HT-001',status:'active',revision:2,identifiers:[],aliases:[]},
    {id:'object-b',objectType:'contract',name:'星海合同',status:'active',revision:1,identifiers:[],aliases:['HT-001']},
  ];
  const facts={
    modelKey:'company.operations',
    model:{label:'公司经营',objectTypes:['contract'],predicates:['contract.amount.total'],relations:['covers']},
    epoch:'9',facts:[],objects,conflicts:[],relations:[],
    mergeCandidates:[{sourceId:'object-b',targetId:'object-a',sourceRevision:1,targetRevision:2,sourceName:'星海合同',targetName:'合同 HT-001',objectType:'contract',score:96,reasons:['名称与别名存在完全匹配']}],
    merges:[{id:'merge-a',status:'active',revision:1,sourceId:'object-b',sourceName:'星海合同',sourceRevision:2,targetId:'object-a',targetName:'合同 HT-001',targetRevision:3,factCount:2,relationCount:1,mergedAt:new Date().toISOString(),revertedAt:null}],
    imports:[{id:'import-old',status:'confirmed',revision:2,versionId:'version-a',name:'客户合同.xlsx',candidateCount:3,createdAt:new Date().toISOString(),decidedAt:new Date().toISOString()}],
    autoExtraction:true,settingsRevision:1,
  };
  await page.route('**/api/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(req.method()==='POST'){writes.push({path,body:req.postDataJSON()});}
    let data={experts:[],suggestions:[],plans:[],checkpoints:[],files:[],artifacts:[],executions:[],builds:[],entries:[]};
    if(path==='/api/health')data={ok:true,name:'workpivot',apiProtocol:1,storage:'postgresql',chatEnabled:true,filesEnabled:true};
    else if(path==='/api/auth/state')data={authenticated:true,user:{id:'owner',username:'合成用户',role:'member'},quota:{used:1,limit:10,remaining:9}};
    else if(path==='/api/tasks')data={tasks:[task]};
    else if(path==='/api/projects')data={projects:[{id:'project-a',name:'合成项目',revision:1}]};
    else if(path==='/api/tasks/task-a/conversation')data={turns:[],nextCursor:null,snapshotSequence:'0'};
    else if(path==='/api/tasks/task-a/conversation-changes')data={events:[],nextSequence:'0',snapshotSequence:'0',hasMore:false};
    else if(path==='/api/tasks/task-a/permissions')data={pending:[]};
    else if(path==='/api/tasks/task-a/resource-scope')data={scope:{versionIds:[],memoryScopes:[],expert:false,scheduleIds:[],baseRunId:null}};
    else if(path==='/api/tasks/task-a/browser')data={available:false,open:false,busy:false};
    else if(path==='/api/tasks/task-a/files')data={files:[{id:'version-a',name:'客户合同.xlsx',current:true}]};
    else if(path==='/api/projects/project-a/business-facts')data=facts;
    else if(path.endsWith('/business-fact-imports/preview'))data={id:'import-new',revision:1,name:'客户合同.xlsx',candidates:[{ordinal:0,objectName:'客户星河',objectType:'customer',predicate:'contract.amount.total',valueType:'number',value:'1250.50',currency:'CNY',evidence:'客户名称: 客户星河；合同金额: 1250.50',location:'客户!A2 | 客户!B2',row:2}]};
    else if(path.endsWith('/confirm'))data={imported:1,revision:2};
    else if(path.endsWith('/merge'))data={mergeId:'merge-new',revision:1};
    else if(path.endsWith('/revert'))data={ok:true};
    await route.fulfill({json:data});
  });
  page.on('dialog',dialog=>void dialog.accept());
  await page.goto(`http://127.0.0.1:${staticServer.address().port}/`);
  await page.getByRole('button',{name:'业务事实治理',exact:true}).click();
  await page.getByRole('button',{name:/业务事实/}).last().click();
  const panel=page.getByRole('dialog',{name:'项目业务事实'});
  await panel.waitFor();

  await panel.getByRole('button',{name:'实体治理'}).click();
  await panel.getByRole('button',{name:'选择候选'}).click();
  await panel.getByRole('button',{name:'确认合并'}).click();
  await page.waitForFunction(()=>true);
  assert.ok(writes.some(item=>item.path.endsWith('/business-entities/object-b/merge')&&item.body.targetId==='object-a'),'实体合并提交目标与版本');
  await panel.getByRole('button',{name:'实体治理'}).click();
  await panel.getByRole('button',{name:'拆回'}).click();
  assert.ok(writes.some(item=>item.path.endsWith('/business-object-merges/merge-a/revert')&&item.body.revision===1),'实体拆回提交合并版本');

  await panel.getByRole('button',{name:'表格导入'}).click();
  await panel.getByLabel('表格导入文件').selectOption('version-a');
  await panel.getByLabel('主体列名').fill('客户名称');
  await panel.getByLabel('值列名').fill('合同金额');
  await panel.getByRole('button',{name:'生成候选'}).click();
  await panel.getByText('客户星河',{exact:true}).waitFor();
  await panel.getByRole('button',{name:/确认导入 1 条/}).click();
  assert.ok(writes.some(item=>item.path.endsWith('/business-fact-imports/import-new/confirm')&&item.body.selectedOrdinals[0]===0),'表格候选只在用户确认后提交');
  assert.deepEqual(errors,[]);
  console.log('业务实体治理与表格导入界面验收通过。');
}finally{
  await browser?.close();
  await new Promise(done=>staticServer.close(done));
}
