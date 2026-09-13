// Full HTTP workflow through an isolated host worker; run via W32-host.mjs.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const AdmZip = createRequire(new URL('../packages/server/package.json', import.meta.url))('adm-zip');
const root = mkdtempSync(join(tmpdir(), 'wp32-'));
Object.assign(process.env, { WORKPIVOT_HOME: join(root, 'home'), WORKPIVOT_WORKSPACE: join(root, 'workspace'), WORKPIVOT_HOST: '127.0.0.1', WORKPIVOT_EXECUTION_MODE: 'worker', WORKPIVOT_INSECURE_SECRETS: '1' });
delete process.env['WORKPIVOT_SECRET_KEY']; delete process.env['WORKPIVOT_ADMIN_INIT_TOKEN'];
const script = `const fs=require('fs');
const {Document,Packer,Paragraph}=require('docx');
const Excel=require('exceljs');const Pptx=require('pptxgenjs');const Zip=require('adm-zip');
(async()=>{const text=fs.readFileSync('attachments/source.txt','utf8');
await fs.promises.writeFile('report.docx',await Packer.toBuffer(new Document({sections:[{children:[new Paragraph(text)]}]})));
const book=new Excel.Workbook();book.addWorksheet('验收').addRow([text,42]);await book.xlsx.writeFile('report.xlsx');
const ppt=new Pptx();ppt.addSlide().addText(text,{x:1,y:1,w:8,h:1});await ppt.writeFile({fileName:'report.pptx'});
for(const [file,entry] of [['report.docx','word/document.xml'],['report.xlsx','xl/worksheets/sheet1.xml'],['report.pptx','ppt/slides/slide1.xml']]){if(!new Zip(file).getEntry(entry))throw Error(file);}
console.log('OFFICE_VALIDATED');})().catch(e=>{console.error(e);process.exit(1)});`;
let step = 0;
const model = createServer((req, res) => { req.resume(); req.on('end', () => {
  if(req.method==='GET'){res.end('{"data":[]}');return;}
  const calls = [{name:'load_skill',arguments:'{"name":"release-office"}'},{name:'bash',arguments:'{"command":"node /skills/release-office/generate.cjs"}'}];
  const call=calls[step++];const delta=call?{tool_calls:[{index:0,id:'call-'+step,function:call}]}:{content:'已生成 report.docx、report.xlsx 和 report.pptx，并完成格式检查。'};
  res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta}]})+'\n\ndata: [DONE]\n\n');
}); });
model.listen(0,'127.0.0.1');await new Promise<void>(r=>model.once('listening',r));
const addr=model.address();if(!addr||typeof addr==='string')throw Error('port');
const {createApp}=await import('../packages/server/src/app.js');
const server=createApp().listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
const address=server.address();if(!address||typeof address==='string')throw Error('port');
const base='http://127.0.0.1:'+address.port;let token='';
const api=(path:string,method='GET',body?:unknown,credential=token)=>fetch(base+'/api'+path,{method,headers:{authorization:'Bearer '+credential,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
let count=0;function check(name:string,value:unknown){assert.ok(value,name);count++;console.log('✅ '+name);}
try{
 const registration=await(await api('/auth/register','POST',{username:'release-admin',password:'fixture-password'})).json();token=registration.token;
 check('register and login',Boolean(token)&&(await api('/auth/state')).ok);
 await api('/users','POST',{username:'release-other',password:'fixture-password',role:'admin'});
 const other=await(await api('/auth/login','POST',{username:'release-other',password:'fixture-password'})).json();
 await api('/me/tier','PUT',{tier:'auto'});
 await api('/providers','POST',{name:'fixture',baseUrl:'http://127.0.0.1:'+addr.port+'/v1',modelId:'fixture'});
 const project=await(await api('/projects','POST',{name:'全流程验收'})).json();check('project created',Boolean(project.project?.id));
 const {withAccount}=await import('../packages/server/src/tenants.js');
 const {createPackage,savePackageFile,publishPackage}=await import('../packages/server/src/skill-package-store.js');
 withAccount(registration.user,()=>{let pack=createPackage('release-office');pack=savePackageFile(pack.name,'generate.cjs',Buffer.from(script),pack.revision);publishPackage(pack.name,pack.revision,[]);});
 const {task}=await(await api('/tasks','POST',{name:'文档验收',projectId:project.project.id})).json();
 check('task isolated from other admin',(await api('/tasks/'+task.id,'GET',undefined,other.token)).status===404);
 const upload=await fetch(base+'/api/tasks/'+task.id+'/attachments?name=source.txt',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/octet-stream'},body:'RELEASE-文档验收-42'});check('upload accepted',upload.ok);
 const response=await api('/tasks/'+task.id+'/messages','POST',{content:'执行 release-office 技能生成三个文档',attachments:['source.txt']});
 const output=await response.text();
 check('published skill loaded',output.includes('"toolName":"load_skill"'));
 check('worker generated and validated office formats',output.includes('OFFICE_VALIDATED'));
 check('assistant reply and task completion',output.includes('已生成')&&output.includes('"stopReason":"completed"'));
 const entries:{[key:string]:string}={'report.docx':'word/document.xml','report.xlsx':'xl/worksheets/sheet1.xml','report.pptx':'ppt/slides/slide1.xml'};
 const sidebar=await(await api('/sidebar?taskId='+task.id)).json();
 for(const [name,entry] of Object.entries(entries)){
  const bytes=readFileSync(join(task.directory,name));check(name+' valid OOXML',Boolean(new AdmZip(bytes).getEntry(entry)));
  const artifact=sidebar.artifacts.find((a:{name:string})=>a.name===name);check(name+' version available',artifact?.state==='ready'&&artifact.versions?.length===1);
  const downloaded=await api('/tasks/'+task.id+'/artifact?name='+name);check(name+' download matches output',Buffer.from(await downloaded.arrayBuffer()).equals(bytes));
  check(name+' private download',(await api('/tasks/'+task.id+'/artifact?name='+name,'GET',undefined,other.token)).status===404);
 }
 const transcript=await(await api('/tasks/'+task.id+'/transcript')).json();check('transcript contains worker result',JSON.stringify(transcript).includes('OFFICE_VALIDATED'));
 const history=await(await api('/tasks/'+task.id)).json();check('history retained',history.history?.some((m:{role:string})=>m.role==='assistant'));
 console.log('W32 '+count+'/'+count+' passed');
}finally{for(const item of [server,model]){item.closeAllConnections();await new Promise<void>(r=>item.close(()=>r()));}}
