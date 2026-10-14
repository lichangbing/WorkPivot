import { DocumentProcessing } from '../packages/server/src/database/document-processing.js';
/** Opt-in real-model check in a disposable PostgreSQL database; never creates production user records. */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pool, installSchema, transaction } from '../packages/server/src/database/connection.js';
import { AccountRepository } from '../packages/server/src/database/accounts.js';
import { ProviderRepository } from '../packages/server/src/database/providers.js';
import { DatabaseModelService } from '../packages/server/src/database/model-service.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { FileRepository } from '../packages/server/src/database/files.js';
import { DatabaseSkills } from '../packages/server/src/database/skills.js';
import { DatabaseSkillExecution } from '../packages/server/src/database/skill-execution.js';
import { DatabaseFileTools } from '../packages/server/src/database/file-tools.js';
import { DatabaseArtifactTools } from '../packages/server/src/database/artifact-tools.js';
import { DatabaseExecution } from '../packages/server/src/database/execution.js';
const target = process.env.WORKPIVOT_OFFICE_TEST_URL;
if (!target || process.env.WORKPIVOT_OFFICE_TEST_DISPOSABLE !== '1' || new URL(target).pathname !== '/workpivot_office_test') throw Error('Dedicated disposable database required');
const require = createRequire(new URL('../packages/server/package.json',import.meta.url));
const Excel = require('exceljs'), AdmZip = require('adm-zip');
const schema=pool(target), liveDb=pool(process.env.WORKPIVOT_DATABASE_URL!), liveAuth=pool(process.env.WORKPIVOT_AUTH_DATABASE_URL!);
const secret=randomBytes(32).toString('hex'), root=await mkdtemp(join(tmpdir(),'wp-real-office-'));
const urlFor=(user:string)=>{const url=new URL(target);url.username=user;url.password=secret;return url.toString();};
const db=pool(urlFor('office_app')),auth=pool(urlFor('office_auth'));
let stopParser: (() => Promise<void>) | undefined;
try {
  await schema.query(`CREATE ROLE office_app LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; CREATE ROLE office_auth LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;`);
  await installSchema(schema,'office_app','office_auth');
  const user=(await new AccountRepository(auth).registerFirst('office-test',randomBytes(24).toString('hex'),secret,secret)).user;
  const owner=(await liveAuth.query("SELECT id FROM identity.users WHERE role='admin' AND NOT disabled ORDER BY id LIMIT 1")).rows[0]?.id;
  if(!owner)throw Error('Configure a default model first');
  const provider=new ProviderRepository(liveDb,process.env.WORKPIVOT_SECRET_KEY ?? (await readFile('/data/workpivot/database-secret.key','utf8')).trim());
  const configuredClient=await new DatabaseModelService(liveAuth,liveDb,provider).client(owner);
  let requestNumber=0;
  const client: typeof configuredClient = {...configuredClient, async *streamChat(messages, schemas, signal) {
    const started=Date.now(), request=++requestNumber;const pending=new Set<string>();let invalid=0;
    for(const m of messages){if(m.role==='tool'){if(!m.tool_call_id||!pending.delete(m.tool_call_id))invalid++;}else{if(pending.size)invalid++;for(const call of m.tool_calls??[])pending.add(call.id);}}
    console.log(JSON.stringify({modelRequest:request,messageCount:messages.length,unpairedTools:pending.size,invalidToolOrder:invalid}));
    try{yield* configuredClient.streamChat(messages,schemas,signal);}catch(error){console.log(JSON.stringify({modelRequest:request,elapsedMs:Date.now()-started,diagnostic:error instanceof Error?error.cause:undefined}));throw error;}
  }};
  const worker=process.env.WORKPIVOT_WORKER_URL ? {url:process.env.WORKPIVOT_WORKER_URL,token:process.env.WORKPIVOT_WORKER_TOKEN!}:JSON.parse(await readFile('/data/workpivot/worker.json','utf8'));
  const workspace=new WorkspaceRepository(db),files=new FileRepository(db,root),skills=new DatabaseSkills(db);
  const task=await workspace.createTask(user.id,'Office acceptance');
  const workbook=new Excel.Workbook(),sheet=workbook.addWorksheet('Budget');sheet.addRow(['Item','Amount']);sheet.addRow(['A',10]);sheet.addRow(['B',20]);
  const uploadBytes=Buffer.from(await workbook.xlsx.writeBuffer());
  const uploaded=await files.upload(user.id,task.id,'budget.xlsx',uploadBytes,randomUUID());
  const processing=DocumentProcessing.worker(db,files,worker);
  await processing.process(user.id);
  let parsing: Promise<unknown> | undefined;
  let parsingError: unknown;
  const parserTimer=setInterval(()=>{if(!parsing)parsing=processing.process(user.id).catch(e=>{parsingError=e;}).finally(()=>{parsing=undefined;});},500);
  stopParser=async()=>{clearInterval(parserTimer);await parsing;};
  let skill=await skills.create(user.id,'office-acceptance');
  skill=await skills.save(user.id,'office-acceptance','SKILL.md',Buffer.from(`---\nname: office-acceptance\ndescription: Read budget Excel and generate Word reports\n---\nFirst list uploaded files. Use /skills/office-acceptance/report.cjs with Node to read the Excel and generate a Word file. Arguments in order: input path, output path, numeric multiplier. This program sums column B excluding row 1, multiplies by the argument, and writes a DOCX with the actual total. Inputs reside under /workspace/inputs/<versionId>/<name>. Output must be in /workspace root. For edits use list_artifacts and publish to the same documentId at the latest revision. Never invent calculations or document contents.`),skill.revision);
  const script=`const E=require('exceljs'),{Document,Packer,Paragraph}=require('docx'),fs=require('fs');(async()=>{const b=new E.Workbook();await b.xlsx.readFile(process.argv[2]);let n=0;b.worksheets[0].eachRow((r,i)=>{if(i>1)n+=Number(r.getCell(2).value)});n*=Number(process.argv[4]);fs.writeFileSync(process.argv[3],await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('Budget total: '+n)]}]})));console.log('Computed total: '+n)})().catch(e=>{console.error(e.message);process.exitCode=1});`;
  skill=await skills.save(user.id,'office-acceptance','report.cjs',Buffer.from(script),skill.revision);skill=await skills.publish(user.id,'office-acceptance',skill.revision);await skills.select(user.id,'office-acceptance',true);
  const versions=new Map([['office-acceptance',skill.published!]]);
  const createExecution=()=>new DatabaseExecution(db,async(actor,taskId,context)=>({client,tools:[...skills.tools(actor,versions),...new DatabaseFileTools(files,processing).tools(actor,taskId),...new DatabaseArtifactTools(files).tools(actor,taskId),new DatabaseSkillExecution(db,files,skills,worker,()=>context.run).tool(actor,taskId,versions)],taskDir:'.',maxSteps:12,maxDurationMs:240000,system:'You are an office assistant. Use the loaded office-acceptance skill for Excel and Word work. Read its SKILL.md first. Use actual tools and saved files; never invent results.',requestAccess:async request=>request.tool==='execute_skill' && request.external===true}));
  let artifactDocumentId: string | undefined;
  for(const [index,prompt] of ['Read the uploaded budget.xlsx and create budget-report.docx summarizing the total. Use multiplier 1.','Update that same Word report to apply multiplier 2. Keep the same document identity and publish a new version.'].entries()) {
    const execution=createExecution(); // Recreate the orchestration object; conversation state must come from PostgreSQL.
    const started=await execution.begin(user.id,task.id,prompt,randomUUID(),index===0?[uploaded.id]:[]);
    let text='',calls=0;
    const reason=await started.execute!(event=>{if(event.type==='tool_use'){calls++;console.log('tool: '+String(event.toolName ?? 'call'));}if(event.type==='assistant_delta')text+=event.text??'';if(event.type==='tool_result'||event.type==='error'){const message=String(event.message??'');console.log(JSON.stringify({diagnostic:event.type,tool:event.toolName,failure:event.type==='error'||event.ok===false?message.replace(/Bearer\s+\S+|sk-[\w-]+|https?:\/\/\S+/gi,'[redacted]').slice(0,300):undefined,ok:event.ok,status:event.status,durationMs:event.durationMs,categories:['timeout','超时','fetch','connect','socket','429','401','403','quota','permission','denied','不存在','ENOENT','worker','abort'].filter(word=>message.toLowerCase().includes(word.toLowerCase()))}));}});
    const rows=await files.list(user.id,task.id,'artifact');
    console.log(JSON.stringify({checkpoint:'turn-result',turn:index+1,reason,artifacts:rows.map(r=>({revision:r.revision,size:r.size})),answerCharacters:text.length}));
    if(reason!=='completed'||rows.length!==1||rows[0]!.revision!==index+1||!text.trim())throw Error('Model did not finish with exactly one versioned artifact and final answer');
    if(index===0)artifactDocumentId=rows[0]!.documentId;
    else if(rows[0]!.documentId!==artifactDocumentId)throw Error('Artifact identity changed across execution restart');
    const original=await files.download(user.id,task.id,rows[0]!.id);const xml=new AdmZip(original.data).readAsText('word/document.xml');
    if(!xml.includes('Budget total: '+(index===0?30:60)))throw Error('Generated Word calculation is incorrect');
    console.log(JSON.stringify({turn:index+1,passed:true,toolCalls:calls,revision:rows[0]!.revision,answerCharacters:text.length}));
  }
  if(parsingError)throw Error('Background document processing failed');
  const restored=new FileRepository(db,root);
  const artifactVersions=await restored.versions(user.id,task.id,artifactDocumentId!);
  if(artifactVersions.length!==2)throw Error('Version history not preserved');
  for(const version of artifactVersions){const download=await restored.download(user.id,task.id,version.id);const xml=new AdmZip(download.data).readAsText('word/document.xml');if(!xml.includes('Budget total: '+(version.revision===1?30:60)))throw Error('Historical artifact contents changed');}
  if(!(await restored.download(user.id,task.id,uploaded.id)).data.equals(uploadBytes))throw Error('Uploaded file changed');
  console.log('PASS recreated execution and repository retain conversation, artifact identity, both versions and upload');
  const jobs=await transaction(db,c=>c.query("SELECT count(*)::int AS n FROM workpivot.skill_executions WHERE status='completed'"),user.id);
  if(jobs.rows[0].n!==2)throw Error('Unexpected completed executions');
  console.log('PASS real model + XLSX + Skill + worker + DOCX + PostgreSQL version update');
} finally {await stopParser?.();await Promise.all([schema.end(),auth.end(),db.end(),liveDb.end(),liveAuth.end()]);await rm(root,{recursive:true,force:true});}
