import {readFile,statfs} from 'node:fs/promises';
import type {Pool} from 'pg';
import {MetricsRegistry} from './observability.js';

export interface OperationsConfiguration {
  filesRoot?:string;
  browser?:{url:string};
  worker?:{url:string;token:string};
}

type ServiceState='ready'|'unavailable'|'not_configured';
interface ServiceCheck{state:ServiceState;latencyMs:number|null;detail?:string}
export interface SystemSnapshot {
  version:string;
  generatedAt:string;
  status:'ok'|'degraded'|'critical';
  ready:boolean;
  services:Record<string,ServiceCheck>;
  database:{latencyMs:number;app:{total:number;idle:number;waiting:number};auth:{total:number;idle:number;waiting:number}};
  storage:{state:'ready'|'unavailable';totalBytes:number|null;freeBytes:number|null;usedRatio:number|null};
  work:{runningTasks:number;expiredLeaseTasks:number;pendingApprovals:number;automationQueued:number;automationRunning:number;memoryJobs:number;parsingJobs:number};
  backup:{state:'ready'|'stale'|'failed'|'not_configured';finishedAt:string|null;databaseBytes:number|null;filesBytes:number|null};
  alerts:Array<{code:string;severity:'warning'|'critical';message:string}>;
}

function endpoint(base:string,path:string):URL{
  return new URL(path,base.endsWith('/')?base:base+'/');
}

async function probe(url:URL,headers?:Record<string,string>):Promise<ServiceCheck>{
  const started=performance.now();
  try{
    const response=await fetch(url,{headers,signal:AbortSignal.timeout(2000),redirect:'error'});
    await response.body?.cancel();
    return {state:response.ok?'ready':'unavailable',latencyMs:Math.round(performance.now()-started),...(response.ok?{}:{detail:`HTTP ${response.status}`})};
  }catch{
    return {state:'unavailable',latencyMs:null,detail:'健康检查失败'};
  }
}

function finiteBytes(value:unknown):number|null{
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
}

/** 系统状态只暴露聚合健康信息，不读取任务标题、聊天、文件名或凭据。 */
export class SystemStatusService {
  constructor(
    private readonly appPool:Pool,
    private readonly authPool:Pool,
    private readonly metrics:MetricsRegistry,
    private readonly version:string,
    private readonly config:OperationsConfiguration={},
  ){}

  async readiness():Promise<{ready:boolean;status:SystemSnapshot['status'];database:boolean;storage:boolean}>{
    const dbStarted=performance.now();
    let database=true;
    try{await Promise.all([this.appPool.query('SELECT 1'),this.authPool.query('SELECT 1')]);}catch{database=false;}
    const storage=await this.storageState();
    const ready=database&&storage.state==='ready'&&(storage.usedRatio??0)<0.95;
    return {ready,status:!ready?'critical':(performance.now()-dbStarted>3000?'degraded':'ok'),database,storage:storage.state==='ready'};
  }

  async snapshot():Promise<SystemSnapshot>{
    const generatedAt=new Date().toISOString();
    const started=performance.now();
    let databaseLatencyMs=0;
    let work:SystemSnapshot['work']={runningTasks:0,expiredLeaseTasks:0,pendingApprovals:0,automationQueued:0,automationRunning:0,memoryJobs:0,parsingJobs:0};
    let databaseReady=true;
    try{
      await Promise.all([this.appPool.query('SELECT 1'),this.authPool.query('SELECT 1')]);
      databaseLatencyMs=Math.round(performance.now()-started);
      const row=(await this.appPool.query(`SELECT
        (SELECT count(*)::int FROM workpivot.task_runs WHERE status='running') AS "runningTasks",
        (SELECT count(*)::int FROM workpivot.task_runs WHERE status='running' AND lease_until<=now()) AS "expiredLeaseTasks",
        (SELECT count(*)::int FROM workpivot.run_permissions WHERE state='pending' AND expires_at>now()) AS "pendingApprovals",
        (SELECT count(*)::int FROM workpivot.automation_runs WHERE status='queued') AS "automationQueued",
        (SELECT count(*)::int FROM workpivot.automation_runs WHERE status='running') AS "automationRunning",
        (SELECT count(*)::int FROM workpivot.memory_jobs WHERE status IN ('pending','running','failed')) AS "memoryJobs",
        (SELECT count(*)::int FROM workpivot.document_processing WHERE status IN ('pending','running','failed')) AS "parsingJobs"`)).rows[0];
      work={runningTasks:Number(row.runningTasks),expiredLeaseTasks:Number(row.expiredLeaseTasks),pendingApprovals:Number(row.pendingApprovals),automationQueued:Number(row.automationQueued),automationRunning:Number(row.automationRunning),memoryJobs:Number(row.memoryJobs),parsingJobs:Number(row.parsingJobs)};
    }catch{
      databaseReady=false;
      databaseLatencyMs=Math.round(performance.now()-started);
    }
    const storage=await this.storageState();
    const backup=await this.backupState();
    const [browser,worker]=await Promise.all([
      this.config.browser?probe(endpoint(this.config.browser.url,'health')):Promise.resolve({state:'not_configured' as const,latencyMs:null}),
      this.config.worker?probe(endpoint(this.config.worker.url,'v1/health'),{authorization:`Bearer ${this.config.worker.token}`}):Promise.resolve({state:'not_configured' as const,latencyMs:null}),
    ]);
    const alerts:SystemSnapshot['alerts']=[];
    if(!databaseReady)alerts.push({code:'database_unavailable',severity:'critical',message:'PostgreSQL 连接检查失败'});
    if(storage.state!=='ready')alerts.push({code:'storage_unavailable',severity:'critical',message:'文件存储不可用'});
    else if((storage.usedRatio??0)>=0.9)alerts.push({code:'disk_critical',severity:'critical',message:'文件存储使用率已达到 90%'});
    else if((storage.usedRatio??0)>=0.8)alerts.push({code:'disk_warning',severity:'warning',message:'文件存储使用率已达到 80%'});
    if(this.appPool.waitingCount>0||this.authPool.waitingCount>0)alerts.push({code:'database_pool_waiting',severity:'warning',message:'数据库连接池出现等待请求'});
    if(work.expiredLeaseTasks>0)alerts.push({code:'expired_task_lease',severity:'warning',message:'存在租约过期但尚未恢复的运行'});
    if(browser.state!=='not_configured'&&browser.state!=='ready')alerts.push({code:'browser_unavailable',severity:'warning',message:'已配置的浏览器服务不可用'});
    if(worker.state!=='not_configured'&&worker.state!=='ready')alerts.push({code:'worker_unavailable',severity:'warning',message:'已配置的隔离执行服务不可用'});
    if(backup.state==='not_configured')alerts.push({code:'backup_status_unavailable',severity:'warning',message:'尚未配置最近一次备份状态'});
    if(backup.state==='failed')alerts.push({code:'backup_failed',severity:'critical',message:'最近一次备份失败'});
    if(backup.state==='stale')alerts.push({code:'backup_stale',severity:'warning',message:'最近一次成功备份超过 36 小时'});
    const critical=alerts.some(alert=>alert.severity==='critical');
    const status=critical?'critical':alerts.length?'degraded':'ok';
    return {
      version:this.version,generatedAt,status,ready:databaseReady&&storage.state==='ready'&&(storage.usedRatio??0)<0.95,
      services:{
        api:{state:'ready',latencyMs:0},
        database:{state:databaseReady?'ready':'unavailable',latencyMs:databaseLatencyMs},
        browser,worker,
      },
      database:{
        latencyMs:databaseLatencyMs,
        app:{total:this.appPool.totalCount,idle:this.appPool.idleCount,waiting:this.appPool.waitingCount},
        auth:{total:this.authPool.totalCount,idle:this.authPool.idleCount,waiting:this.authPool.waitingCount},
      },
      storage,work,backup,alerts,
    };
  }

  async prometheus():Promise<string>{
    const value=await this.snapshot();
    const lines=[
      '# HELP workpivot_ready 服务是否具备处理新请求的关键条件。',
      '# TYPE workpivot_ready gauge',
      `workpivot_ready ${value.ready?1:0}`,
      '# HELP workpivot_database_ready 数据库健康状态。',
      '# TYPE workpivot_database_ready gauge',
      `workpivot_database_ready ${value.services.database?.state==='ready'?1:0}`,
      '# HELP workpivot_database_pool_connections 数据库连接池连接数。',
      '# TYPE workpivot_database_pool_connections gauge',
      `workpivot_database_pool_connections{pool="app",state="total"} ${value.database.app.total}`,
      `workpivot_database_pool_connections{pool="app",state="idle"} ${value.database.app.idle}`,
      `workpivot_database_pool_connections{pool="app",state="waiting"} ${value.database.app.waiting}`,
      `workpivot_database_pool_connections{pool="auth",state="total"} ${value.database.auth.total}`,
      `workpivot_database_pool_connections{pool="auth",state="idle"} ${value.database.auth.idle}`,
      `workpivot_database_pool_connections{pool="auth",state="waiting"} ${value.database.auth.waiting}`,
      '# HELP workpivot_storage_used_ratio 文件存储使用比例。',
      '# TYPE workpivot_storage_used_ratio gauge',
      `workpivot_storage_used_ratio ${(value.storage.usedRatio??-1).toFixed(6)}`,
      '# HELP workpivot_task_runs 运行队列与状态计数。',
      '# TYPE workpivot_task_runs gauge',
      `workpivot_task_runs{status="running"} ${value.work.runningTasks}`,
      `workpivot_task_runs{status="expired_lease"} ${value.work.expiredLeaseTasks}`,
      '# HELP workpivot_automation_runs 自动化运行队列计数。',
      '# TYPE workpivot_automation_runs gauge',
      `workpivot_automation_runs{status="queued"} ${value.work.automationQueued}`,
      `workpivot_automation_runs{status="running"} ${value.work.automationRunning}`,
      '# HELP workpivot_background_jobs 后台失败或待处理作业计数。',
      '# TYPE workpivot_background_jobs gauge',
      `workpivot_background_jobs{kind="memory"} ${value.work.memoryJobs}`,
      `workpivot_background_jobs{kind="parsing"} ${value.work.parsingJobs}`,
      '# HELP workpivot_alerts 当前系统告警数量。',
      '# TYPE workpivot_alerts gauge',
      `workpivot_alerts{severity="warning"} ${value.alerts.filter(alert=>alert.severity==='warning').length}`,
      `workpivot_alerts{severity="critical"} ${value.alerts.filter(alert=>alert.severity==='critical').length}`,
      '# HELP workpivot_backup_ready 最近备份状态是否为 ready。',
      '# TYPE workpivot_backup_ready gauge',
      `workpivot_backup_ready{state=${JSON.stringify(value.backup.state)}} ${value.backup.state==='ready'?1:0}`,
    ];
    return this.metrics.render(lines);
  }

  private async storageState():Promise<SystemSnapshot['storage']>{
    if(!this.config.filesRoot)return {state:'unavailable',totalBytes:null,freeBytes:null,usedRatio:null};
    try{
      const value=await statfs(this.config.filesRoot);
      const total=Number(value.blocks)*Number(value.bsize),free=Number(value.bavail)*Number(value.bsize);
      return {state:'ready',totalBytes:total,freeBytes:free,usedRatio:total>0?Math.min(1,Math.max(0,(total-free)/total)):null};
    }catch{return {state:'unavailable',totalBytes:null,freeBytes:null,usedRatio:null};}
  }

  private async backupState():Promise<SystemSnapshot['backup']>{
    const file=process.env['WORKPIVOT_BACKUP_STATUS_FILE'];
    if(!file)return {state:'not_configured',finishedAt:null,databaseBytes:null,filesBytes:null};
    try{
      const parsed=JSON.parse((await readFile(file,'utf8')).slice(0,65536)) as Record<string,unknown>;
      const finishedAt=typeof parsed['finishedAt']==='string'&&Number.isFinite(Date.parse(parsed['finishedAt']))?new Date(parsed['finishedAt']).toISOString():null;
      const failed=parsed['status']==='failed';
      const stale=!!finishedAt&&Date.now()-Date.parse(finishedAt)>36*60*60*1000;
      return {state:failed?'failed':stale?'stale':'ready',finishedAt,databaseBytes:finiteBytes(parsed['databaseBytes']),filesBytes:finiteBytes(parsed['filesBytes'])};
    }catch{return {state:'failed',finishedAt:null,databaseBytes:null,filesBytes:null};}
  }
}
