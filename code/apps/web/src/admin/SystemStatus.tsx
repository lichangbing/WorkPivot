import {useEffect,useState} from 'react';
import {jsonFetch} from '../api';

type Service={state:'ready'|'unavailable'|'not_configured';latencyMs:number|null;detail?:string};
interface Snapshot {
  version:string;generatedAt:string;status:'ok'|'degraded'|'critical';ready:boolean;
  services:Record<string,Service>;
  database:{latencyMs:number;app:{total:number;idle:number;waiting:number};auth:{total:number;idle:number;waiting:number}};
  storage:{state:'ready'|'unavailable';totalBytes:number|null;freeBytes:number|null;usedRatio:number|null};
  work:{runningTasks:number;expiredLeaseTasks:number;pendingApprovals:number;automationQueued:number;automationRunning:number;memoryJobs:number;parsingJobs:number};
  backup:{state:'ready'|'stale'|'failed'|'not_configured';finishedAt:string|null;databaseBytes:number|null;filesBytes:number|null};
  alerts:Array<{code:string;severity:'warning'|'critical';message:string}>;
}

const stateText:Record<string,string>={ready:'正常',unavailable:'不可用',not_configured:'未配置',stale:'已过期',failed:'失败'};
const serviceText:Record<string,string>={api:'API 服务',database:'PostgreSQL',browser:'浏览器服务',worker:'隔离执行服务'};
function bytes(value:number|null):string{
  if(value===null)return '—';
  const units=['B','KiB','MiB','GiB','TiB'];let current=value,index=0;
  while(current>=1024&&index<units.length-1){current/=1024;index++;}
  return `${current.toFixed(index===0?0:1)} ${units[index]}`;
}

export function SystemStatus(){
  const [data,setData]=useState<Snapshot|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    void jsonFetch<Snapshot>('/api/admin/system-status',{signal:controller.signal}).then(value=>{
      if(!controller.signal.aborted)setData(value);
    }).catch(reason=>{
      if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'系统状态读取失败');
    }).finally(()=>{
      if(!controller.signal.aborted)setLoading(false);
    });
    return()=>controller.abort();
  },[refresh]);
  return <section className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-lg font-medium">系统状态</h1><p className="mt-1 text-sm text-neutral-400">只读展示版本、依赖、容量、队列、备份和告警，不读取私人正文、文件名或凭据。</p></div>
      <button disabled={loading} className="rounded bg-neutral-800 px-3 py-2 text-sm disabled:opacity-40" onClick={()=>setRefresh(value=>value+1)}>{loading?'刷新中…':'刷新状态'}</button>
    </div>
    {error&&<p role="alert" className="rounded border border-red-800 bg-red-950/30 p-3 text-sm text-red-300">{error}</p>}
    {!data&&!error&&loading&&<p role="status">正在读取系统状态…</p>}
    {data&&<>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="系统状态摘要">
        <article className="rounded-lg border border-neutral-700 p-4"><p className="text-xs text-neutral-500">总体状态</p><p className={`mt-2 text-lg font-medium ${data.status==='critical'?'text-red-400':data.status==='degraded'?'text-amber-400':'text-emerald-400'}`}>{data.status==='ok'?'正常':data.status==='degraded'?'降级':'严重'}</p><p className="mt-1 text-xs text-neutral-400">{data.ready?'可接收新请求':'关键依赖未就绪'}</p></article>
        <article className="rounded-lg border border-neutral-700 p-4"><p className="text-xs text-neutral-500">版本</p><p className="mt-2 text-lg font-medium">{data.version}</p><p className="mt-1 text-xs text-neutral-400">{new Date(data.generatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</p></article>
        <article className="rounded-lg border border-neutral-700 p-4"><p className="text-xs text-neutral-500">文件存储</p><p className="mt-2 text-lg font-medium">{data.storage.usedRatio===null?'—':`${(data.storage.usedRatio*100).toFixed(1)}%`}</p><p className="mt-1 text-xs text-neutral-400">可用 {bytes(data.storage.freeBytes)} / {bytes(data.storage.totalBytes)}</p></article>
        <article className="rounded-lg border border-neutral-700 p-4"><p className="text-xs text-neutral-500">告警</p><p className="mt-2 text-lg font-medium">{data.alerts.length}</p><p className="mt-1 text-xs text-neutral-400">严重 {data.alerts.filter(alert=>alert.severity==='critical').length} · 警告 {data.alerts.filter(alert=>alert.severity==='warning').length}</p></article>
      </div>

      <section className="rounded-lg border border-neutral-800 p-4">
        <h2 className="font-medium">服务依赖</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {Object.entries(data.services).map(([name,service])=><div key={name} className="flex items-center justify-between rounded border border-neutral-800 px-3 py-2 text-sm"><span>{serviceText[name]??name}</span><span className={service.state==='ready'?'text-emerald-400':service.state==='not_configured'?'text-neutral-500':'text-red-400'}>{stateText[service.state]}{service.latencyMs!==null?` · ${service.latencyMs} ms`:''}{service.detail?` · ${service.detail}`:''}</span></div>)}
        </div>
        <div className="mt-3 grid gap-2 text-xs text-neutral-400 sm:grid-cols-2"><p>业务连接池：{data.database.app.total} 总 / {data.database.app.idle} 空闲 / {data.database.app.waiting} 等待</p><p>认证连接池：{data.database.auth.total} 总 / {data.database.auth.idle} 空闲 / {data.database.auth.waiting} 等待</p></div>
      </section>

      <section className="rounded-lg border border-neutral-800 p-4">
        <h2 className="font-medium">运行与队列</h2>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:grid-cols-7">
          {[['运行中任务',data.work.runningTasks],['过期租约',data.work.expiredLeaseTasks],['待处理审批',data.work.pendingApprovals],['自动化排队',data.work.automationQueued],['自动化运行',data.work.automationRunning],['记忆作业',data.work.memoryJobs],['解析作业',data.work.parsingJobs]].map(([label,value])=><div key={String(label)}><p className="text-xs text-neutral-500">{label}</p><p className="mt-1 text-lg">{value}</p></div>)}
        </div>
      </section>

      <section className="rounded-lg border border-neutral-800 p-4">
        <h2 className="font-medium">备份状态</h2><p className="mt-2 text-sm">{stateText[data.backup.state]??data.backup.state}{data.backup.finishedAt?` · ${new Date(data.backup.finishedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`:''}</p>
        <p className="mt-1 text-xs text-neutral-400">数据库 {bytes(data.backup.databaseBytes)} · 文件 {bytes(data.backup.filesBytes)}</p>
      </section>

      <section className="rounded-lg border border-neutral-800 p-4">
        <h2 className="font-medium">当前告警</h2>
        {!data.alerts.length?<p className="mt-3 text-sm text-emerald-400">当前没有告警。</p>:<ul className="mt-3 space-y-2">{data.alerts.map(alert=><li key={alert.code} className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 p-3 text-sm"><span className={alert.severity==='critical'?'text-red-400':'text-amber-400'}>{alert.severity==='critical'?'严重':'警告'}</span><span>{alert.message}</span><code className="ml-auto text-xs text-neutral-500">{alert.code}</code></li>)}</ul>}
      </section>
    </>}
  </section>;
}
