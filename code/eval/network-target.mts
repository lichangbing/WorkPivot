import assert from 'node:assert/strict';
import {SafeHttp,webUrl,type WebResponse} from '../packages/server/src/web/safe-http.js';
import {networkTarget} from '../packages/server/src/web/network-target.js';
import {RequestQuota} from '../packages/server/src/web/request-quota.js';
const target=networkTarget({url:'http://oa.internal:8080/report?id=1',address:'10.20.30.40'});
for(const address of ['127.0.0.1','169.254.169.254','0.0.0.0','224.0.0.1','::1','fe80::1','8.8.8.8'])assert.throws(()=>networkTarget({...target,address}));
for(const url of ['http://oa.internal:5432/','http://oa.internal:2375/','http://localhost/','https://user:pass@oa.internal/','http://10.20.30.41/'])assert.throws(()=>networkTarget({...target,url}));
assert.throws(()=>webUrl(target.url));assert.equal(webUrl(target.url,undefined,[target.url],[target]).href,target.url);
assert.throws(()=>webUrl(target.url.replace('id=1','id=2'),undefined,undefined,[target]));
let connections=0;const addresses:string[]=[];
class Fixture extends SafeHttp{protected override async once(url:URL,address:{address:string;family:number}):Promise<WebResponse>{connections++;addresses.push(address.address);return {url:url.href,status:200,headers:{'content-type':'text/plain'},body:Buffer.from('合成内网正文')};}}
const quota=new RequestQuota(2,0);
const valid=new Fixture(async()=>{throw Error('内网名称不能发送给公网解析器');},quota,async()=>[{address:target.address,family:4}]);
assert.equal((await valid.get(target.url,{urls:[target.url],targets:[target]})).body.toString(),'合成内网正文');assert.deepEqual(addresses,[target.address]);
for(const answers of [[{address:'10.20.30.41',family:4}],[{address:'8.8.8.8',family:4}],[{address:target.address,family:4},{address:'127.0.0.1',family:4}]]){
 const service=new Fixture(async()=>{throw Error();},quota,async()=>answers);await assert.rejects(service.get(target.url,{urls:[target.url],targets:[target]}));service.close();
}
assert.equal(connections,1);valid.close();console.log('内网地址语法、保留地址/控制端口、完整URL、固定IP与DNS变更拒绝通过');
