import assert from 'node:assert/strict';
import { fileIcon } from '../apps/web/src/file-icons.js';
Object.assign(globalThis,{window:{addEventListener(){},dispatchEvent(){}},localStorage:{getItem(){return 'fixture-token';},removeItem(){}}});
const {streamChat}=await import('../apps/web/src/api.js');
let count=0;function check(name:string,value:unknown){assert.ok(value,name);count++;console.log('✅ '+name);}
for(const [file,icon] of [['REPORT.XLSX','fileExcel'],['report.docx','fileWord'],['report.pdf','filePdf'],['report.pptx','filePpt'],['photo.png','fileImage'],['other.bin','file']])check(file+' type icon',fileIcon(file!)===icon);
const originalFetch=globalThis.fetch;
try{
 let controller:ReadableStreamDefaultController<Uint8Array>;
 globalThis.fetch=async()=>new Response(new ReadableStream<Uint8Array>({start(c){controller=c;}}));
 let accepted=false,finished=false;
 const run=streamChat('fixture','hello',()=>{},undefined,['report.pdf'],()=>{accepted=true;}).then(()=>{finished=true;});
 await new Promise(r=>setTimeout(r,0));
 check('attachment consumption occurs before response completion',accepted&&!finished);
 controller!.enqueue(new TextEncoder().encode('data: {"type":"done","stopReason":"completed","steps":1}\n\n'));controller!.close();await run;
 check('response completes normally',finished);
 globalThis.fetch=async()=>new Response('{"error":"rejected"}',{status:409});accepted=false;
 await assert.rejects(streamChat('fixture','hello',()=>{},undefined,['report.pdf'],()=>{accepted=true;}));check('rejected send retains attachment selection',!accepted);
}finally{globalThis.fetch=originalFetch;}
console.log('W34 '+count+'/'+count+' passed');
