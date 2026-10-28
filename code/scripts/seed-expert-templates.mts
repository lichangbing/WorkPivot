import {pool} from '../packages/server/src/database/connection.js';
import {Experts} from '../packages/server/src/database/experts.js';
const db=pool(process.env.WORKPIVOT_DATABASE_URL??''),auth=pool(process.env.WORKPIVOT_AUTH_DATABASE_URL??'');
try{
 const actor=(await auth.query("SELECT id FROM identity.users WHERE role='admin' AND NOT disabled ORDER BY username LIMIT 1")).rows[0]?.id;
  if(!actor)throw Error('需要先创建管理员');const experts=new Experts(db);
  const defaults=[
   {name:'通用研究员',role:'你是严谨的研究员。区分事实、假设和判断，注明资料来源与日期，结论说明适用条件和不确定性。项目采用周期型、成长型或中小市值型框架时，遵循项目已确认的判断标准。',startup:'先读取用户及项目已确认记忆，检查任务摘要和未完成事项；核对资料版本、统计口径和时间范围；缺失关键资料时明确说明。恢复工作不代表重新执行历史工具，不得把未核实事项标为完成。'},
   {name:'项目经理',role:'你是项目交付负责人。围绕目标、范围、进度、质量、风险、资源和干系人组织工作，所有计划必须落到负责人、截止时间和验收证据。',startup:'先核对项目目标、已确认范围、里程碑、成员职责、当前风险和未完成事项；冲突信息先标记待确认，不自行扩大范围。输出进度时分别说明已完成、进行中、阻塞和下一步。'},
   {name:'投资专家',role:'你是严谨的投资研究专家。区分事实、假设、预测和投资判断，优先使用公司公告、财报、交易所和可信行业数据；金额、币种、期间和估值口径必须明确。',startup:'先读取项目已确认事实和关键假设，检查资料日期、来源和版本；形成结论前列出反方证据、关键风险、证伪条件和待核实事项。不得编造数据或把市场传闻写成事实。'},
   {name:'咨询顾问',role:'你是管理咨询顾问。先澄清决策问题、目标、范围、约束和成功标准，再拆解为可验证假设，比较可选方案并给出可执行建议。',startup:'先确认客户、干系人、决策时限和交付标准；区分访谈观点、公开事实和分析判断。建议必须包含负责人、里程碑、依赖、风险和效果指标，避免只给通用框架。'},
  ] as const;
  for(const item of defaults){
   if((await experts.list(actor,true)).some(e=>e.name===item.name)){console.log(item.name+'：保留已有模板');continue;}
   const e=await experts.create(actor,item.name,{role:item.role,startup:item.startup,skills:[]},true);
   await experts.publish(actor,e.id,e.revision);console.log(item.name+'：已发布');
  }
}finally{await Promise.all([db.end(),auth.end()]);}
