import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {Pool} from 'pg';
import {modelCapacity,fetchModelCapacity} from '../packages/server/src/database/model-capacity.js';
import {estimateContextTokens,contextBytes} from '../packages/server/src/database/context-budget.js';
import {transaction} from '../packages/server/src/database/connection.js';
import type {ProviderRepository} from '../packages/server/src/database/providers.js';
export async function testModelCapacity(db:Pool,actor:string,foreign:string,providers:ProviderRepository,check:(v:unknown,label:string)=>void){
 assert.equal(modelCapacity({data:[{id:'model',context_window:1048576,max_output_tokens:393216}]},'model'),1048576);
 for(const data of [{data:[{id:'model',max_output_tokens:8192}]},{data:[{id:'other',context_window:1048576}]},{data:[{id:'model',context_window:'1048576'}]},{data:[{id:'model',context_window:0}]}])assert.throws(()=>modelCapacity(data,'model'));
 check(true,'模型容量按总窗口读取，缺失/错误/输出上限不冒充窗口');
 check(estimateContextTokens('中文'.repeat(1000))<contextBytes('中文'.repeat(1000)),'Token估算与UTF8字节数分离');
 let mode='ok',requests=0,redirects=0;
 const server=createServer((req,res)=>{
  requests++;if(req.url==='/redirected'){redirects++;res.end('{}');return;}
  assert.equal(req.headers.authorization,'Bearer synthetic-capacity-key');
  if(mode==='redirect'){res.writeHead(302,{location:'/redirected'});res.end();return;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'capacity-model',...(mode==='ok'?{context_window:1048576}:{max_output_tokens:8192})}]}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  const row=await providers.save(actor,{name:'capacity metadata fixture',baseUrl:base,modelId:'capacity-model',protocol:'openai',apiKey:'synthetic-capacity-key'});
  await assert.rejects(providers.syncCapacity(foreign,row.id,row.revision));assert.equal(requests,0);
  const updated=await providers.syncCapacity(actor,row.id,row.revision);
  check(updated.contextBudget===1048576&&updated.contextSource==='api'&&!!updated.contextCheckedAt,'同步容量和来源原子保存，支持1048576 tokens');
  await assert.rejects(providers.syncCapacity(actor,row.id,row.revision));
  mode='missing';await assert.rejects(providers.syncCapacity(actor,row.id,updated.revision));
  assert.equal((await providers.list(actor)).find(p=>p.id===row.id)!.contextBudget,1048576);
  mode='redirect';await assert.rejects(fetchModelCapacity(base,'capacity-model','openai','synthetic-capacity-key'));assert.equal(redirects,0);
  check(true,'旧修订/接口缺失不覆盖容量，不携带凭据跟随重定向');
  const edited=await providers.save(actor,{name:row.name,baseUrl:base,modelId:'capacity-model',protocol:'openai',contextBudget:32000},row.id,updated.revision);
  assert.equal(edited.contextSource,'manual');assert.equal(edited.contextCheckedAt,null);
  const records=await providers.capacityAudit(actor,row.id);assert.equal(records.length,3);assert.equal((await providers.capacityAudit(foreign,row.id)).length,0);
  await assert.rejects(transaction(db,c=>c.query('DELETE FROM workpivot.model_capacity_audit WHERE provider_id=$1',[row.id]),actor));
  check(true,'手工覆盖保留，容量审计不可删改且用户隔离');
  await providers.remove(actor,row.id,edited.revision);
 }finally{await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
}
