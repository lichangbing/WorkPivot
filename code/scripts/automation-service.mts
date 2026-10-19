import {BrowserProfiles} from '../packages/server/src/database/browser-profiles.js';
// 独立后台调度进程与API共用数据库协议；不持有Docker socket或创建公开HTTP入口。
import {resolve} from 'node:path';
import {pool} from '../packages/server/src/database/connection.js';
import {Automations} from '../packages/server/src/database/automations.js';
import {AutomationWorker} from '../packages/server/src/database/automation-worker.js';
import {FileRepository} from '../packages/server/src/database/files.js';
import {ProviderRepository} from '../packages/server/src/database/providers.js';
import {DatabaseModelService} from '../packages/server/src/database/model-service.js';
import {WebTools,browserConfiguration} from '../packages/server/src/web/tools.js';
const db=pool(process.env.WORKPIVOT_DATABASE_URL??''),auth=pool(process.env.WORKPIVOT_AUTH_DATABASE_URL??'');
let worker:AutomationWorker|undefined,timer:ReturnType<typeof setInterval>|undefined,closing=false;
async function close(){if(closing)return;closing=true;clearInterval(timer);await worker?.stop();await Promise.all([db.end(),auth.end()]);}
try{
 const secret=process.env.WORKPIVOT_SECRET_KEY??'',root=process.env.WORKPIVOT_DATABASE_FILES_ROOT;
 const url=process.env.WORKPIVOT_WORKER_URL,token=process.env.WORKPIVOT_WORKER_TOKEN;
 if(secret.length<32||!root||!!url!==!!token)throw Error('调度服务配置不完整');
 await Promise.all([db.query('SELECT 1'),auth.query('SELECT 1')]);
 const browser=browserConfiguration(),plans=new Automations(db,!!url,!!browser),files=new FileRepository(db,resolve(root));
 const models=new DatabaseModelService(auth,db,new ProviderRepository(db,secret));
 worker=new AutomationWorker(auth,plans,files,url&&token?{url,token}:undefined,(actor,taskId)=>models.client(actor,{source:'automation',taskId}),new WebTools(browser),new BrowserProfiles(db,secret,browser));
 const tick=()=>{void worker!.tick().catch(()=>{console.error('调度轮次失败，持久队列保留，等待下次重试');});};
 timer=setInterval(tick,2000);tick();
 console.log('WorkPivot automation service ready');
 process.once('SIGTERM',()=>{void close();});process.once('SIGINT',()=>{void close();});
}catch{console.error('自动化服务启动失败，请核对受保护配置与数据库');await close();process.exitCode=1;}
