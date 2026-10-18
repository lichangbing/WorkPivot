import {pool} from '../packages/server/src/database/connection.js';
import {DatabaseSkills} from '../packages/server/src/database/skills.js';
import {seedOfficeSkills} from '../packages/server/src/database/office-skills.js';
/** 显式发布内置Office资源；保留用户草稿，不更换自动化固定版本。 */
const db=pool(process.env.WORKPIVOT_DATABASE_URL??'');
try{
 const actor=process.env.WORKPIVOT_RELEASE_ACTOR;if(!actor)throw Error('缺少发布操作者');
 const skills=new DatabaseSkills(db),results=await seedOfficeSkills(skills,actor,true);
 for(const r of results){if(r.status==='已暂存更新，请在技能管理中审阅并发布'&&process.argv.includes('--publish')){const d=await skills.open(actor,r.name);await skills.publish(actor,r.name,d.revision);r.status='已显式发布新版本，既有自动化固定版本保留';}}
 console.log(JSON.stringify(results));
}catch{console.error('内置技能发布未完成；原授权版本及用户草稿保留，请检查角色和版本冲突');process.exitCode=1;}finally{await db.end();}
