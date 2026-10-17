import { useEffect, useState } from 'react';
import { jsonFetch } from './api';
interface Execution { id: string; status: string; error?: string; artifactName?: string; artifacts?: {id:string;name:string}[]; createdAt: string }
export function DatabaseExecutionStatus({ taskId }: { taskId: string }) {
  const [result,setResult] = useState<{taskId:string;rows:Execution[]}>({taskId,rows:[]});
  const rows = result.taskId === taskId ? result.rows : [];
  useEffect(() => {
    const c = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { const result = await jsonFetch<{executions:Execution[]}>(`/api/tasks/${taskId}/executions`,{signal:c.signal}); if(!c.signal.aborted)setResult({taskId,rows:result.executions}); }
      catch { /* 下次刷新时重新获取持久记录。 */ }
      finally { if(!c.signal.aborted)timer=setTimeout(()=>{void refresh();},3000); }
    }; void refresh(); return ()=>{c.abort();clearTimeout(timer);};
  },[taskId]);
  if(!rows.length)return null;
  const labels: Record<string,string> = {running:'执行中',completed:'已完成',failed:'失败',interrupted:'已中断'};
  return <details className="mb-3 rounded border border-neutral-700 p-3 text-sm"><summary className="cursor-pointer">执行记录 · {labels[rows[0]!.status] ?? rows[0]!.status}</summary><ul className="mt-2 space-y-2">{rows.map(row=><li key={row.id}><span>{labels[row.status] ?? row.status} · {new Date(row.createdAt).toLocaleString()}</span>{(row.artifacts ?? (row.artifactName ? [{id:row.id,name:row.artifactName}] : [])).map(artifact=><p key={artifact.id} className="break-words text-neutral-400">产物：{artifact.name}</p>)}{row.error && <p className="text-neutral-400">{row.error}</p>}</li>)}</ul><p className="mt-2 text-xs text-neutral-500">中断的执行不会自动重跑。请先检查产物，再发送消息继续。</p></details>;
}
