import type {Pool} from 'pg';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {exportRetention,applyRetention} from '../packages/server/src/database/restore-retention.js';
import {WorkspaceRepository} from '../packages/server/src/database/workspace.js';
import {Experts} from '../packages/server/src/database/experts.js';
import {FileRepository} from '../packages/server/src/database/files.js';
import {transaction} from '../packages/server/src/database/connection.js';
export async function testRestoreRetention(db:Pool,actor:string,foreign:string,check:(v:unknown,n:string)=>void){
 const root=await mkdtemp(join(tmpdir(),'wp-restore-')),w=new WorkspaceRepository(db),e=new Experts(db),f=new FileRepository(db,root);
 try{
  const project=await w.createProject(actor,'旧快照中的已删除项目'),task=await w.createTask(actor,'旧快照中的任务',project.id);
  const keepTask=await w.createTask(actor,'仍保留的任务');
  const file=await f.upload(actor,keepTask.id,'已删除资料.txt',Buffer.from('deleted fixture'),randomUUID());
  const memory=await w.createMemory(actor,'旧快照记忆','user'),foreignMemory=await w.createMemory(foreign,'另一用户保留记忆','user');
  const expert=await e.create(actor,'保留专家',{role:'研究员',startup:'核对资料',skills:[]});
  await e.editExperience(actor,expert.id,{content:'旧快照经验',conditions:'',locked:false});
  const experience=(await e.experiences(actor,expert.id))[0];
  const manifest=await exportRetention(db,actor);
  check(!manifest.memories.some(r=>r.id===foreignMemory.id),'retention inventory excludes another user');
  // 模拟删除或修订之后的最新权威清单。
  manifest.projects=manifest.projects.filter(r=>r.id!==project.id);manifest.tasks=manifest.tasks.filter(r=>r.id!==task.id);
  manifest.documents=manifest.documents.filter(r=>r.id!==file.documentId);manifest.memories=manifest.memories.filter(r=>r.id!==memory.id);
  manifest.experiences=manifest.experiences.filter(r=>r.id!==experience.id);
  await applyRetention(db,root,manifest);
  check(!(await w.listProjects(actor)).some(p=>p.id===project.id)&&!(await w.listTasks(actor)).some(t=>t.id===task.id),'restore replay removes deleted projects and tasks');
  check(await w.readMemory(actor,memory.id)===null&&(await e.experiences(actor,expert.id)).length===0,'restore replay prevents deleted personal and expert memory resurrection');
  await assert.rejects(f.download(actor,keepTask.id,file.id));check(true,'restore replay revokes deleted original file');
  check(!!await w.readMemory(foreign,foreignMemory.id),'restore replay preserves other user data');
  check(await transaction(db,async c=>(await c.query('SELECT history FROM workpivot.expert_experiences WHERE id=$1',[experience.id])).rows[0].history.length===0,actor),'restore replay removes forgotten experience history');
  await applyRetention(db,root,manifest);check(true,'retention replay is repeatable');
  await w.deleteTask(actor,keepTask.id,(await w.listTasks(actor)).find(t=>t.id===keepTask.id)!.revision);await e.remove(actor,expert.id,expert.revision);
 }finally{await rm(root,{recursive:true,force:true});}
}
