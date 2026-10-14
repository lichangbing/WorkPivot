import {pool} from '../packages/server/src/database/connection.js';
import {Experts} from '../packages/server/src/database/experts.js';
const db=pool(process.env.WORKPIVOT_DATABASE_URL??''),auth=pool(process.env.WORKPIVOT_AUTH_DATABASE_URL??'');
try{
 const actor=(await auth.query("SELECT id FROM identity.users WHERE role='admin' AND NOT disabled ORDER BY username LIMIT 1")).rows[0]?.id;
 if(!actor)throw Error('需要先创建管理员');const experts=new Experts(db);
 if(!(await experts.list(actor,true)).some(e=>e.name==='通用研究员')){
  const e=await experts.create(actor,'通用研究员',{role:'你是严谨的研究员。区分事实、假设和判断，注明资料来源与日期，结论说明适用条件和不确定性。项目采用周期型、成长型或中小市值型框架时，遵循项目已确认的判断标准。',startup:'先读取用户及项目已确认记忆，检查任务摘要和未完成事项；核对资料版本、统计口径和时间范围；缺失关键资料时明确说明。恢复工作不代表重新执行历史工具，不得把未核实事项标为完成。',skills:[]},true);
  await experts.publish(actor,e.id,e.revision);console.log('Default researcher template published');
 }else console.log('Existing expert template preserved');
}finally{await Promise.all([db.end(),auth.end()]);}
