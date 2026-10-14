import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {Pool} from 'pg';
import {FileRepository} from '../packages/server/src/database/files.js';
import {WorkspaceRepository} from '../packages/server/src/database/workspace.js';
import {DocumentProcessing} from '../packages/server/src/database/document-processing.js';
import {transaction} from '../packages/server/src/database/connection.js';
export async function testParsing(db:Pool,actor:string,foreign:string,check:(ok:unknown,label:string)=>void) {
 const root=await mkdtemp(join(tmpdir(),'wp-parse-')),files=new FileRepository(db,root),workspace=new WorkspaceRepository(db);
 const task=await workspace.createTask(actor,'parse fixture');let fail=false,erase=false;
 let docId='';
 const processor=new DocumentProcessing(db,files,async()=>{if(fail)throw Error('invalid');if(erase)await files.remove(actor,task.id,docId,1);return [{location:'paragraph:1',text:'saved text'}];});
 try {
 const first=await files.upload(actor,task.id,'report.docx',Buffer.from('fixture'),randomUUID());docId=first.documentId;
 check((await processor.list(actor,task.id))[0]?.status==='pending','upload queues parsing transactionally');
 await assert.rejects(processor.list(foreign,task.id));check(true,'parsing status is private');
 await assert.rejects(processor.read(actor,task.id,first.id,0));check(true,'pending parse cannot masquerade as content');
 await processor.process(actor);check((await processor.read(actor,task.id,first.id,0)).content.includes('[paragraph:1]'),'parsed text retains source location');
 await assert.rejects(processor.read(foreign,task.id,first.id,0));check(true,'parsed text enforces owner');
 const second=await files.upload(actor,task.id,'report.docx',Buffer.from('new'),randomUUID(),first.documentId,1);
 fail=true;await processor.process(actor);check((await processor.list(actor,task.id))[0]?.status==='failed','parser failure persists');
 check((await processor.read(actor,task.id,first.id,0)).content.includes('saved text'),'old parsed version remains pinned');
 await assert.rejects(processor.read(actor,task.id,second.id,0));check(true,'failed new version never reads old content implicitly');
 fail=false;await processor.retry(actor,task.id,second.id);await processor.process(actor);check((await processor.list(actor,task.id))[0]?.status==='completed','manual parse retry succeeds');
 const third=await files.upload(actor,task.id,'restart.pdf',Buffer.from('pdf'),randomUUID());
 await transaction(db,c=>c.query("UPDATE workpivot.document_processing SET status='running',attempts=1,fence=$2,lease_until=now()-interval '1 second' WHERE version_id=$1",[third.id,randomUUID()]),actor);
 await processor.process(actor);check((await processor.read(actor,task.id,third.id,0)).content.includes('saved text'),'expired parser lease recovered');
 const fourth=await files.upload(actor,task.id,'delete.pptx',Buffer.from('ppt'),randomUUID());docId=fourth.documentId;erase=true;
 await processor.process(actor);await assert.rejects(processor.read(actor,task.id,fourth.id,0));check(true,'deletion rejects late parsing publication');
 await workspace.deleteTask(actor,task.id,(await workspace.listTasks(actor)).find(t=>t.id===task.id)!.revision);
 check((await transaction(db,c=>c.query('SELECT version_id FROM workpivot.document_processing WHERE version_id=ANY($1::uuid[])',[[first.id,second.id,third.id]]),actor)).rowCount===0,'task deletion clears parsed content and jobs');
 }finally{await rm(root,{recursive:true,force:true});}
}
