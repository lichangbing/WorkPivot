import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {SafeHttp,type WebResponse} from '../packages/server/src/web/safe-http.js';
import {RequestQuota} from '../packages/server/src/web/request-quota.js';
import {retryAfter} from '../packages/server/src/web/retry.js';
let checks=0;
async function check(name:string,run:()=>Promise<void>|void){await run();console.log('PASS',name);checks++;}
class Fixture extends SafeHttp{
 calls=0;
 constructor(private readonly statuses:number[],private readonly after?:string,quota=new RequestQuota(2,0),resolve=async()=>[{address:'8.8.8.8',family:4}]){super(resolve,quota);}
 override async once(url:URL):Promise<WebResponse>{const status=this.statuses[Math.min(this.calls++,this.statuses.length-1)]!;return {url:url.href,status,headers:{'content-type':'text/plain',...(this.after===undefined?{}:{'retry-after':this.after})},body:Buffer.from('合成正文')};}
}
const address='https://fixture.example/',policy={urls:[address],retryTransient:true};
await check('Retry-After秒数、日期、过去时间、异常及超大值',()=>{
 assert.equal(retryAfter('3'),3000);assert.equal(retryAfter('Sun, 18 Oct 2026 00:00:03 GMT',Date.parse('2026-10-18T00:00:00Z')),3000);
 assert.equal(retryAfter('Sun, 18 Oct 2026 00:00:00 GMT',Date.parse('2026-10-18T00:00:03Z')),0);
 for(const input of ['-1','1.5','invalid'])assert.equal(retryAfter(input),undefined);
 assert.ok(retryAfter('9'.repeat(400))!>20000);
});
await check('429遵守服务端等待后恢复，最多额外两次',async()=>{
 const http=new Fixture([429,503,200],'1'),start=performance.now();const result=await http.get(address,policy);
 assert.equal(result.status,200);assert.equal(result.retryCount,2);assert.equal(http.calls,3);assert.ok(performance.now()-start>=2000);http.close();
});
await check('持续临时失败三次即停止',async()=>{const http=new Fixture([502]);assert.equal((await http.get(address,policy)).retryCount,2);assert.equal(http.calls,3);http.close();});
await check('401、403、404、500及普通对话均不自动重试',async()=>{
 for(const status of [401,403,404,500]){const http=new Fixture([status]);assert.equal((await http.get(address,policy)).status,status);assert.equal(http.calls,1);http.close();}
 const http=new Fixture([503]);await http.get(address);assert.equal(http.calls,1);http.close();
});
await check('服务端等待超过本次预算时直接返回失败，不提前重试',async()=>{const http=new Fixture([429],'120');assert.equal((await http.get(address,policy)).status,429);assert.equal(http.calls,1);http.close();});
await check('退避期间取消立即退出且不发出第二次请求',async()=>{
 const http=new Fixture([503],'5'),controller=new AbortController();const run=http.get(address,{...policy,signal:controller.signal});const rejected=assert.rejects(run);await delay(30);controller.abort();await rejected;assert.equal(http.calls,1);http.close();
});
await check('每次重试重新校验DNS，拒绝重绑定到内网',async()=>{
 let dns=0;const http=new Fixture([503,200],undefined,new RequestQuota(2,0),async()=>[{address:++dns===1?'8.8.8.8':'127.0.0.1',family:4}]);await assert.rejects(http.get(address,policy),/非公网/);assert.equal(http.calls,1);http.close();
});
await check('同站点其他调用遵守共享冷却且其他站点可运行',async()=>{
 const quota=new RequestQuota(1,0),signal=new AbortController().signal,release=await quota.acquire('a',signal);quota.defer('a',120);release();
 let ready=false;const a=quota.acquire('a',signal).then(r=>{ready=true;r();});(await quota.acquire('b',signal))();assert.equal(ready,false);await a;
});
await check('重定向后的重试不能重置预算，也不能扩大授权',async()=>{
 class Redirect extends Fixture{override async once(url:URL){if(url.pathname==='/'){this.calls++;return {url:url.href,status:302,headers:{location:'https://fixture.example/next'},body:Buffer.alloc(0)};}return super.once(url);}}
 const denied=new Redirect([503]);await assert.rejects(denied.get(address,policy),/未获授权/);assert.equal(denied.calls,1);denied.close();
 const http=new Redirect([503]);const result=await http.get(address,{...policy,urls:[address,address+'next']});assert.equal(result.retryCount,2);assert.equal(http.calls,4);http.close();
});
console.log(`HTTP重试 ${checks} 项通过`);
