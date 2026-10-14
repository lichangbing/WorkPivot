import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pool} from '../packages/server/src/database/connection.js';
import {WorkspaceRepository} from '../packages/server/src/database/workspace.js';
import {Experts} from '../packages/server/src/database/experts.js';
import {FileRepository} from '../packages/server/src/database/files.js';
const root=process.env.WORKPIVOT_RC_FILES_ROOT!,url=process.env.WORKPIVOT_DATABASE_URL!,mode=process.argv[2];
if(!root.startsWith('/tmp/workpivot-memory-check-')||!['/workpivot_memory_test','/workpivot_forget_restored'].includes(new URL(url).pathname))throw Error('Isolated fixture required');
const db=pool(url),w=new WorkspaceRepository(db),e=new Experts(db),f=new FileRepository(db,root);
try{
 const fixture=JSON.parse(await readFile(root+'/fixture.json','utf8')),actor=fixture.actor;
 if(mode==='prepare'){
  const memory=await w.createMemory(actor,'这条记忆将在备份之后删除','user'),expert=(await e.list(actor))[0];
  await e.editExperience(actor,expert.id,{content:'这条专家经验将在备份之后删除',conditions:'恢复验收',locked:false});
  const experience=(await e.experiences(actor,expert.id))[0],file=await f.upload(actor,fixture.task,'将删除的原件.txt',Buffer.from('forgotten file'),randomUUID());
  await writeFile(root+'/scenario.json',JSON.stringify({memory,expert:expert.id,experience,file}));
 }else{
  const s=JSON.parse(await readFile(root+'/scenario.json','utf8'));
  if(mode==='forget'){
   await w.deleteMemory(actor,s.memory.id,s.memory.revision);
   await e.editExperience(actor,s.expert,{...s.experience,remove:true});
   await f.remove(actor,fixture.task,s.file.documentId,s.file.revision);await f.collect(actor);
  }else if(mode==='verify'){
   assert.equal(await w.readMemory(actor,s.memory.id),null);assert.equal((await e.experiences(actor,s.expert)).length,0);
   await assert.rejects(f.download(actor,fixture.task,s.file.id));
   assert.equal((await f.download(actor,fixture.task,fixture.file)).data.toString(),'RC restoration fixture');
   console.log('PASS restore older backup + replay newer retention inventory: forgotten memories/experience/file absent, retained original intact');
  }else throw Error('Unknown fixture phase');
 }
}finally{await db.end();}
