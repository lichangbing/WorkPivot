import {exportRetention,applyRetention} from '../packages/server/src/database/restore-retention.js';
import {SkillBuilds} from '../packages/server/src/database/skill-builds.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const AdmZip=createRequire(new URL('../packages/server/package.json',import.meta.url))('adm-zip');
import type {Pool} from 'pg';
import {PersonalData} from '../packages/server/src/database/personal-data.js';
import {WorkspaceRepository} from '../packages/server/src/database/workspace.js';
import {Experts} from '../packages/server/src/database/experts.js';
import {TrashRepository} from '../packages/server/src/database/trash.js';
import {transaction} from '../packages/server/src/database/connection.js';
import type {FileRepository} from '../packages/server/src/database/files.js';
/** 全部内容为隔离库中的合成资料。 */
export async function testPersonalData(db:Pool,actor:string,other:string,files:FileRepository,filesRoot:string,check:(v:unknown,n:string)=>void){
 const personal=new PersonalData(db,files),ws=new WorkspaceRepository(db),experts=new Experts(db),trash=new TrashRepository(db,files);
 const p=await ws.createProject(actor,'清空验收项目'),t=await ws.createTask(actor,'清空验收任务',p.id),m=await ws.createMemory(actor,'清空验收记忆','user');
 const builds=new SkillBuilds(db,files);
 const build=await builds.propose(actor,t.id,{requestId:randomUUID(),displayName:'清空技能',purpose:'合成测试',files:[{path:'SKILL.md',content:'---\nname: clear-fixture\ndescription: 合成测试\n---\n读取给定资料。'}]});
 const foreign=await ws.createTask(other,'其他用户保留');
 const file=await files.upload(actor,t.id,'验收.txt',Buffer.from('归档原件'),randomUUID());
 const e=await experts.create(actor,'可恢复专家',{role:'合成专家',startup:'',skills:[]});
 await experts.editExperience(actor,e.id,{content:'手动合成经验',conditions:'',locked:true});
 const plan=randomUUID();await transaction(db,c=>c.query("INSERT INTO workpivot.automations(id,owner_user_id,request_id,draft) VALUES($1,$2,$3,$4)",[plan,actor,randomUUID(),{name:'归档计划'}]),actor);
 const zip=new AdmZip(await personal.export(actor)),json=JSON.parse(zip.readAsText('data.json'));
 check(zip.readAsText('files/'+file.id)==='归档原件','个人导出包含校验后的原件');
 check(json.data.tasks.some((r:{id:string})=>r.id===t.id)&&!json.data.tasks.some((r:{id:string})=>r.id===foreign.id),'个人导出不包含其他用户资料');
 check(!('model_providers' in json.data)&&!('credentials' in json.data)&&!('sessions' in json.data),'导出固定白名单不包含凭据');
 let preview=await personal.preview(actor);
 await assert.rejects(personal.clear(actor,preview.fingerprint,'确认'));check(true,'清空要求准确确认词');
 await ws.appendMessage(actor,t.id,'user','预览后新增消息',randomUUID());
 await assert.rejects(personal.clear(actor,preview.fingerprint,'清空个人数据'));check((await ws.listTasks(actor,true)).some(r=>r.id===t.id),'预览后变化拒绝清空且不删除任何条目');
 await transaction(db,c=>c.query("UPDATE workpivot.tasks SET status='running' WHERE id=$1",[t.id]),actor);
 preview=await personal.preview(actor);await assert.rejects(personal.clear(actor,preview.fingerprint,'清空个人数据'));check(preview.active>0,'活动任务阻止清空');
 await transaction(db,c=>c.query("UPDATE workpivot.tasks SET status='idle' WHERE id=$1",[t.id]),actor);
 const recycle=WorkspaceRepository.prototype.recyclePersonal;
 const priorTrash=(await trash.list(actor)).entries.length;
 WorkspaceRepository.prototype.recyclePersonal=async function(c,a){await recycle.call(this,c,a);throw Error('合成事务中断');};
 try{const before=await personal.preview(actor);await assert.rejects(personal.clear(actor,before.fingerprint,'清空个人数据'));}finally{WorkspaceRepository.prototype.recyclePersonal=recycle;}
 check((await trash.list(actor)).entries.length===priorTrash&&(await ws.listTasks(actor,true)).some(r=>r.id===t.id)&&(await experts.list(actor)).some(r=>r.id===e.id),'清空事务中途失败同时回滚删除和新增快照');
 let unlock!:()=>void,locked!:()=>void;const acquired=new Promise<void>(r=>locked=r),gate=new Promise<void>(r=>unlock=r);
 const exclusive=transaction(db,async()=>{locked();await gate;},actor,true);await acquired;
 let finished=false;const pending=ws.createTask(actor,'并发写入验收').then(()=>{finished=true;});
 await ws.createTask(other,'其他用户并发不阻塞');check(!finished,'个人独占锁阻止同用户写入且不阻塞其他用户');unlock();await exclusive;await pending;check(finished,'独占事务结束后等待的写入恢复');
 // 自动化也随清空进入回收站，恢复不得恢复旧授权。
 preview=await personal.preview(actor);

 const fresh=await personal.preview(actor);await personal.clear(actor,fresh.fingerprint,'清空个人数据');
 check(!(await ws.listProjects(actor)).length&&!(await ws.listTasks(actor,true)).length&&!(await experts.list(actor)).length,'清空后业务列表为空');
 check((await ws.listTasks(other)).some(r=>r.id===foreign.id),'清空不影响其他用户');
 const retained=await exportRetention(db,actor);await applyRetention(db,filesRoot,retained);
 let entries=(await trash.list(actor)).entries;
 const skillTrash=entries.find(r=>r.kind==='skill')!;await trash.restore(actor,skillTrash.id,skillTrash.revision);check((await builds.detail(actor,build.id)).disabled,'恢复保留清单后私人技能包仍可从回收站恢复为停用');
 for(const id of [p.id,t.id,m.id,file.documentId,e.id,plan])check(entries.some(r=>r.entityId===id),'回收站保留 '+id);
 const planTrash=entries.find(r=>r.entityId===plan)!;await trash.restore(actor,planTrash.id,planTrash.revision);const restoredPlan=await transaction(db,async c=>(await c.query('SELECT * FROM workpivot.automations WHERE id=$1',[plan])).rows[0],actor);check(restoredPlan.state==='draft'&&restoredPlan.grant_id===null&&restoredPlan.next_at===null,'恢复保留清单后自动化仍可恢复且不获得执行授权');
 const expertTrash=entries.find(r=>r.entityId===e.id)!;await assert.rejects(trash.restore(other,expertTrash.id,expertTrash.revision));
 await trash.restore(actor,expertTrash.id,expertTrash.revision);const restored=(await experts.list(actor)).find(r=>r.id===e.id)!;
 check(restored.disabled&&!restored.load_enabled&&!restored.update_enabled,'专家恢复默认停用且关闭经验自动加载/整理');
 check((await experts.experiences(actor,e.id)).some(r=>r.content==='手动合成经验'),'专家手动经验恢复');
 for(const id of [p.id,t.id,file.documentId,m.id]){entries=(await trash.list(actor)).entries;const row=entries.find(r=>r.entityId===id)!;await trash.restore(actor,row.id,row.revision);}
 check((await files.download(actor,t.id,file.id)).data.toString()==='归档原件','清空后按层级恢复文件原件');
 check((await ws.readMemory(actor,m.id))?.content==='清空验收记忆','清空后恢复个人记忆');
 const exported=new AdmZip(await personal.export(actor));check(exported.getEntry('data.json'),'恢复后仍可导出');
}
