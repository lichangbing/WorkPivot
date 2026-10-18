import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
// 只操作已显式启动的一次性真实模型夹具，不连接业务服务。
if(process.env.WORKPIVOT_LIVE_EVAL!=='1')throw Error('需要显式开启真实模型验收');
const base=process.env.WORKPIVOT_LIVE_FIXTURE_URL;
if(!base||new URL(base).hostname!=='127.0.0.1'||new URL(base).port==='39986')throw Error('仅允许指定的本机隔离夹具');
let token;
async function api(path,body,headers={}){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json',...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});assert(r.ok,`${path}: ${r.status}`);return r.json();}
token=(await api('/api/auth/login',{username:'live-test',password:'Live-Test-2026!'})).token;
const task=(await api('/api/tasks',{name:'完整授权真实模型验收'})).task;
const prefix='/api/tasks/'+task.id;
const marker=randomUUID();const file=(await api(prefix+'/files?name=input.txt&requestId='+randomUUID(),'数值：19、23\n核验标识：'+marker,{'content-type':'application/octet-stream'})).file;
async function turn(content,resourceScope){const r=await fetch(base+prefix+'/messages',{signal:AbortSignal.timeout(600000),method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({content,requestId:randomUUID(),resourceScope})});assert(r.ok);let buffer='',events=[];const decoder=new TextDecoder();for await(const chunk of r.body){buffer+=decoder.decode(chunk,{stream:true});let i;while((i=buffer.indexOf('\n\n'))>=0){const row=buffer.slice(0,i);buffer=buffer.slice(i+2);if(!row.startsWith('data: '))continue;const e=JSON.parse(row.slice(6));events.push(e);if(e.type==='permission_request'){assert.equal(e.tool,'save_artifact');await api(prefix+'/permissions/'+e.id,{decision:'allow'});}}}assert.equal(events.at(-1)?.stopReason,'completed');return events;}
try{
 const first=await turn('读取当前已选中的 input.txt，把两个数的和与原始核验标识保存成 result.txt。必须使用真实文件内容，不要只给出写文件步骤。',{versionIds:[file.id],scheduleIds:[],memoryScopes:[],expert:false,baseRunId:null});
 const artifacts=(await api(prefix+'/artifacts')).artifacts;assert.equal(artifacts.length,1);
 const response=await fetch(base+prefix+'/file-versions/'+artifacts[0].id,{headers:{authorization:'Bearer '+token}});const text=await response.text();assert(text.includes('42')&&text.includes(marker));
 const current=(await api(prefix+'/resource-scope')).scope;assert(current.versionIds.includes(file.id));
 const second=await turn('重新读取之前的 input.txt，告诉我其中的核验标识。若本轮未获文件授权，请说明无法读取。',{versionIds:[],scheduleIds:[],memoryScopes:[],expert:false,baseRunId:current.baseRunId});
 assert(!(JSON.stringify(second).includes(marker)));assert.deepEqual((await api(prefix+'/resource-scope')).scope.versionIds,[]);
 console.log(JSON.stringify({passed:true,checks:['真实模型读取已选文件','显式许可后发布成果','结果42和随机标识匹配','继承文件范围','撤销后模型不再返回原标识','撤销范围持久化'],firstTools:first.filter(e=>e.type==='tool_use').map(e=>e.toolName)}));
}catch(e){console.error('Live scope acceptance failed:',e.message);process.exitCode=1;}
