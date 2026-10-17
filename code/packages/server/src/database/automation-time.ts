import { webUrl } from '../web/safe-http.js';
import { CronDate, CronExpressionParser } from 'cron-parser';
import type { AutomationConfig } from '@workpivot/shared';
import { RepositoryError, uuid } from './connection.js';
const invalid=(s:string):never=>{throw new RepositoryError(400,s);};
export function automationConfig(value:unknown):AutomationConfig {
 if(!value||typeof value!=='object')return invalid('需要计划配置');
 const p=structuredClone(value) as AutomationConfig;
 const text=(v:unknown,max:number,empty=false)=>typeof v==='string'&&(empty||v.trim().length>0)&&v.length<=max;
 if(!text(p.name,120)||!text(p.requirements,8000)||!text(p.skill,100)||!text(p.releaseId,36))return invalid('请填写名称、技能和执行要求');uuid(p.releaseId);
 if(p.projectId!==null)uuid(p.projectId);
 if(!p.input||!['none','fixed','latest'].includes(p.input.mode)||!Array.isArray(p.input.versionIds)||p.input.versionIds.length>10||new Set(p.input.versionIds).size!==p.input.versionIds.length||!text(p.input.pattern,240,true))return invalid('输入规则无效');
 p.input.versionIds.forEach(uuid);
 if(p.input.mode==='fixed'&&!p.input.versionIds.length)return invalid('请选择固定文件版本');
 if(p.input.mode==='latest'&&(!p.projectId||!p.input.pattern.trim()||/[\\/\x00-\x1f]/.test(p.input.pattern)))return invalid('最新资料须限定项目和文件名匹配规则');
 if(!['once','skip'].includes(p.catchup)||!['issues','all'].includes(p.notify)||!Number.isInteger(p.timeoutMinutes)||p.timeoutMinutes<1||p.timeoutMinutes>30)return invalid('运行策略无效，超时范围为1至30分钟');
 const rawOrigins=p.webOrigins??[];
 if(!Array.isArray(rawOrigins)||rawOrigins.some(v=>typeof v!=='string'))return invalid('网页来源格式无效');
 const webOrigins=rawOrigins.map(v=>v.trim()).filter(Boolean);
 if(!Array.isArray(webOrigins)||webOrigins.length>20)return invalid('网页来源最多20项');
 try{for(const origin of webOrigins)if(typeof origin!=='string'||webUrl(origin).origin!==origin)throw Error();}catch{return invalid('网页来源须为公网HTTP/HTTPS origin，如https://example.com，不包含路径');}
 if(new Set(webOrigins).size!==webOrigins.length)return invalid('网页来源不能重复');
 const t=p.timing;if(!t||!['once','daily','weekly','interval','cron'].includes(t.kind)||!text(t.zone,80)||!text(t.at,40,true)||!text(t.end,10,true)||!text(t.cron,100,true)||!Array.isArray(t.days))return invalid('时间规则无效');
 try{new Intl.DateTimeFormat('zh-CN',{timeZone:t.zone}).format();}catch{return invalid('时区无效');}
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time))return invalid('执行时间格式应为 HH:mm');
 if(t.days.some(d=>!Number.isInteger(d)||d<0||d>6)||new Set(t.days).size!==t.days.length||t.kind==='weekly'&&!t.days.length)return invalid('请选择有效星期');
 if(t.kind==='interval'&&(!Number.isSafeInteger(t.minutes)||t.minutes<5||t.minutes>525600))return invalid('固定间隔须为5至525600分钟');
 try{
  if(t.kind==='once'){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t.at))return invalid('请填写指定日期和时间');new CronDate(t.at,t.zone);}
  if(t.end){if(!/^\d{4}-\d{2}-\d{2}$/.test(t.end))return invalid('结束日期无效');new CronDate(t.end+'T23:59:59',t.zone);}
  if(t.kind==='cron'){
   // 高级规则仅支持五字段，禁止秒级或随机抖动，限制分钟间隔的下界。
   if(t.cron.trim().split(/\s+/).length!==5||/[HL?#@]/i.test(t.cron))return invalid('Cron 使用五字段，不支持随机或扩展标记');
   const expr=CronExpressionParser.parse(t.cron,{tz:t.zone});const minutes=[...expr.fields.minute.values].map(Number).sort((a,b)=>a-b);
   for(let i=0;i<minutes.length;i++)if(minutes.length>1&&((minutes[(i+1)%minutes.length]!+60-minutes[i]!)%60)<5)return invalid('Cron 的分钟间隔不得小于5分钟');
  }
 }catch(e){if(e instanceof RepositoryError)throw e;return invalid('日期或周期表达式无效');}
 return {webOrigins,name:p.name.trim(),skill:p.skill,releaseId:p.releaseId,projectId:p.projectId,requirements:p.requirements.trim(),input:{mode:p.input.mode,versionIds:p.input.mode==='fixed'?p.input.versionIds:[],pattern:p.input.mode==='latest'?p.input.pattern.trim():''},timing:t,catchup:p.catchup,notify:p.notify,timeoutMinutes:p.timeoutMinutes};
}
export function nextAutomationTime(p:AutomationConfig,after:Date,anchor?:Date):Date|null {
 const t=p.timing;let result:Date;
 try{
 if(t.kind==='once'){result=new CronDate(t.at,t.zone).toDate();if(result<=after)return null;}
 else if(t.kind==='interval'){const gap=t.minutes*60000,base=anchor?.getTime()??after.getTime();result=new Date(base+Math.max(1,Math.floor((after.getTime()-base)/gap)+1)*gap);}
 else {const [h,m]=t.time.split(':');const expr=t.kind==='cron'?t.cron:`${m} ${h} * * ${t.kind==='weekly'?t.days.join(','):'*'}`;result=CronExpressionParser.parse(expr,{tz:t.zone,currentDate:after}).next().toDate();}
 if(t.end&&result>new CronDate(t.end+'T23:59:59',t.zone).toDate())return null;return result;
 }catch{return null;}
}
export function automationPreview(p:AutomationConfig,now=new Date()):string[]{const result:string[]=[];let cursor=now;for(let i=0;i<3;i++){const next=nextAutomationTime(p,cursor);if(!next)break;result.push(next.toISOString());cursor=next;}return result;}
