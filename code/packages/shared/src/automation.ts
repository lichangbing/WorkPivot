/** 前后端共用的自动化配置；授权与时间计算始终由服务端完成。 */
export interface AutomationConfig {
 webOrigins?:string[];
 name:string; skill:string; releaseId:string; projectId:string|null; requirements:string;
 input:{mode:'none'|'fixed'|'latest';versionIds:string[];pattern:string};
 timing:{kind:'once'|'daily'|'weekly'|'interval'|'cron';zone:string;at:string;time:string;days:number[];minutes:number;cron:string;end:string};
 catchup:'once'|'skip';notify:'issues'|'all';timeoutMinutes:number;
}
export type AutomationState='draft'|'enabled'|'paused'|'blocked'|'ended'|'deleted';
export interface AutomationPlan {id:string;revision:number;state:AutomationState;config:AutomationConfig|null;draft:AutomationConfig|null;origin:'manual'|'conversation';sourceTaskId:string|null;nextAt:string|null;issue:string;createdAt:string;lastRun?:AutomationRun|null;preview?:string[]}
export interface AutomationRun {id:string;planId:string;taskId:string|null;status:'queued'|'running'|'completed'|'failed'|'interrupted'|'cancelled';scheduledFor:string;startedAt:string|null;finishedAt:string|null;error:string;summary:string;config:AutomationConfig;events:{type:string;text:string;at:string}[];readAt?:string|null}
export interface AutomationOptions {skills:{name:string;displayName:string;version:string;label:string;description:string}[];projects:{id:string;name:string}[];files:{id:string;name:string;revision:number;projectId:string|null;taskId:string}[];workerAvailable:boolean;browserAvailable?:boolean}
export const newAutomationConfig=():AutomationConfig=>({webOrigins:[],name:'',skill:'',releaseId:'',projectId:null,requirements:'',input:{mode:'none',versionIds:[],pattern:''},timing:{kind:'daily',zone:'Asia/Shanghai',at:'',time:'09:00',days:[1,2,3,4,5],minutes:120,cron:'0 9 * * *',end:''},catchup:'once',notify:'issues',timeoutMinutes:10});
