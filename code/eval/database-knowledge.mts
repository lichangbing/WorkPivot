import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {FileRepository} from '../packages/server/src/database/files.js';
import {WorkspaceRepository} from '../packages/server/src/database/workspace.js';
import {KnowledgeRepository,splitKnowledge} from '../packages/server/src/database/knowledge.js';
import {RunRepository} from '../packages/server/src/database/runs.js';
import {transaction} from '../packages/server/src/database/connection.js';
export async function testKnowledge(db:Pool,actor:string,foreign:string,check:(ok:unknown,label:string)=>void){
 const root=await mkdtemp(join(tmpdir(),'wp-knowledge-')),files=new FileRepository(db,root),workspace=new WorkspaceRepository(db),knowledge=new KnowledgeRepository(db),runs=new RunRepository(db);
 const project=await workspace.createProject(actor,'Knowledge project'),otherProject=await workspace.createProject(actor,'Other project');
 const source=await workspace.createTask(actor,'Source',project.id),reader=await workspace.createTask(actor,'Reader',project.id),outside=await workspace.createTask(actor,'Outside',otherProject.id),privateTask=await workspace.createTask(foreign,'Private');
 const publish=async(owner:string,versionId:string,text:string)=>{await transaction(db,c=>c.query("UPDATE workpivot.document_processing SET status='completed',parts=$2::jsonb WHERE version_id=$1",[versionId,JSON.stringify([{location:'page:2',text}])]),owner);await knowledge.indexNext(owner);};
 try{
 const split=splitKnowledge([{location:'page:1',text:'😀'.repeat(2500)}]);check(split.length===3&&Array.from(split[0]!.content).length===1200&&split[1]!.offset===1080,'chunks preserve Unicode and overlap');
 const first=await files.upload(actor,source.id,'report.pdf',Buffer.from('v1'),randomUUID());await publish(actor,first.id,'收入增长 confidential first revision');
 const privateFile=await files.upload(foreign,privateTask.id,'report.pdf',Buffer.from('private'),randomUUID());await publish(foreign,privateFile.id,'收入增长 foreign secret');
 const found=await knowledge.search(actor,reader.id,'收入');check(found.matches.length===1&&found.matches[0].versionId===first.id,'project search recalls sibling task source but no foreign user');
 check(found.matches[0].name==='report.pdf'&&found.matches[0].location==='page:2'&&found.matches[0].revision===1,'knowledge result includes source and version');
 check((await knowledge.search(actor,outside.id,'收入')).matches.length===0,'same user cannot retrieve unrelated project');
 await assert.rejects(knowledge.search(foreign,reader.id,'收入'));check(true,'forged task scope rejected');
 await assert.rejects(knowledge.read(foreign,privateTask.id,found.matches[0].chunkId));check(true,'foreign citation ID rejected');
 await assert.rejects(knowledge.read(actor,outside.id,found.matches[0].chunkId));check(true,'citation read rechecks project scope');
 check((await knowledge.read(actor,reader.id,found.matches[0].chunkId)).content.includes('first revision'),'citation reads original chunk');
 const second=await files.upload(actor,source.id,'report.pdf',Buffer.from('v2'),randomUUID(),first.documentId,1);
 const pending=await knowledge.search(actor,reader.id,'收入');check(pending.matches[0].versionId===first.id&&pending.matches[0].latestRevision===2,'pending replacement retains old ready index with explicit latest version');
 await publish(actor,second.id,'收入下降 replacement revision');
 check((await knowledge.search(actor,reader.id,'增长')).matches.length===0,'new ready version atomically replaces old search results');
 await assert.rejects(knowledge.read(actor,reader.id,found.matches[0].chunkId));check(true,'superseded citation cannot silently serve stale text');
 check((await knowledge.search(actor,reader.id,'下降')).matches[0].versionId===second.id,'new version is retrievable');
 check(await knowledge.indexNext(actor)===false,'index publication idempotent');
 const run=await runs.start(actor,reader.id,randomUUID(),'use project knowledge');await runs.finish(actor,run,'completed',[]);
 await files.remove(actor,source.id,first.documentId,2);
 check((await knowledge.search(actor,reader.id,'收入')).matches.length===0,'deleted file immediately excluded from project retrieval');
 check((await transaction(db,c=>c.query('SELECT id FROM workpivot.knowledge_chunks WHERE version_id=ANY($1::uuid[])',[[first.id,second.id]]),actor)).rowCount===0,'deletion physically clears all retained chunks');
 check((await transaction(db,c=>c.query('SELECT context_revoked FROM workpivot.task_runs WHERE id=$1',[run.id]),actor)).rows[0].context_revoked,'file deletion revokes sibling task model history');
 check((await knowledge.search(foreign,privateTask.id,'收入')).matches.length===1,'deletion preserves another user same-name document');
 await assert.rejects(knowledge.search(actor,reader.id,'%'));check(true,'invalid keyword does not become wildcard');
 }finally{
 await workspace.deleteProject(actor,project.id,1);await workspace.deleteProject(actor,otherProject.id,1);
 await workspace.deleteTask(foreign,privateTask.id,(await workspace.listTasks(foreign)).find(t=>t.id===privateTask.id)!.revision);
 await rm(root,{recursive:true,force:true});
 }
}
