import {ResourceArchive} from '../packages/server/src/web/resource-archive.js';
import assert from 'node:assert/strict';
import {decodeOriginal,originalResponse} from '../packages/server/src/web/original.js';
const source=Buffer.from([0,255,1,10,13,200]),raw=originalResponse({url:'https://fixture.example',status:200,headers:{'set-cookie':'must-not-keep','content-type':'text/plain'},body:source});
assert(decodeOriginal(raw).data.equals(source));assert.deepEqual(Object.keys(raw).sort(),['body','mediaType']);
assert.equal(decodeOriginal({body:'',mediaType:'text/plain'}).data.length,0);
for(const value of [null,{body:'====',mediaType:'text/plain'},{body:'YQ',mediaType:'text/plain'},{body:'YQ==',mediaType:'x\r\ny'},{body:Buffer.alloc(2097153).toString('base64'),mediaType:'text/plain'}])assert.throws(()=>decodeOriginal(value));
assert.equal(decodeOriginal({body:Buffer.alloc(2097152).toString('base64'),mediaType:'text/plain'}).data.length,2097152);
console.log('原始存档编码、响应头排除、空正文、非法输入和2MiB边界通过');

const archive=new ResourceArchive();archive.add({url:'https://example.com/a',status:200,headers:{'content-type':'application/pdf','set-cookie':'SECRET'},body:source});
const bundle=JSON.parse(decodeOriginal(archive.finish('https://example.com','<html></html>',[])).data.toString());
assert.equal(bundle.resources.length,1);assert(!JSON.stringify(bundle).includes('SECRET'));assert.equal(Buffer.from(bundle.resources[0].body,'base64').toString('hex'),source.toString('hex'));
const large=new ResourceArchive();large.add({url:'https://example.com',status:200,headers:{},body:Buffer.alloc(2097153)});assert.throws(()=>large.finish('https://example.com','',[]),/超过/);
console.log('资源包响应字节、敏感头排除及超限拒绝通过');
