import { useEffect, useState } from 'react';
import { jsonFetch } from './api';
interface Row {id:string;name:string;status:string;error?:string;indexed?:boolean}
export function DatabaseParsing({taskId}:{taskId:string}) {
  const [rows,setRows]=useState<Row[]>([]),[error,setError]=useState('');
  useEffect(()=>{
    const c=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{try {const r=await jsonFetch<{files:Row[]}>(`/api/tasks/${taskId}/parsing`,{signal:c.signal});if(!c.signal.aborted)setRows(r.files);}catch{/* 下次刷新时重试。 */}finally{if(!c.signal.aborted)timer=setTimeout(()=>{void refresh();},3000);}};
    setRows([]);void refresh();return()=>{c.abort();clearTimeout(timer);};
  },[taskId]);
  if(!rows.length)return null;
  const labels:Record<string,string>={pending:'等待解析',running:'解析中',completed:'解析完成',failed:'解析失败'};
  const retry=async(id:string)=>{try{setError('');await jsonFetch(`/api/tasks/${taskId}/parsing/${id}/retry`,{method:'POST'});setRows(old=>old.map(r=>r.id===id?{...r,status:'pending',error:undefined}:r));}catch(e){setError(e instanceof Error?e.message:'重试失败');}};
  return <details className="mb-3 rounded border border-neutral-700 p-3 text-sm"><summary>文件解析 · {rows.filter(r=>r.status==='completed').length}/{rows.length}</summary><ul>{rows.map(r=><li key={r.id} className="mt-2 break-words">{r.name} · {r.status==='completed' ? (r.indexed ? '可检索' : '解析完成，等待索引') : labels[r.status]}{r.error&&<p>{r.error}</p>}{r.status==='failed'&&<button type="button" onClick={()=>{void retry(r.id);}}>重试</button>}</li>)}</ul>{error&&<p role="alert">{error}</p>}</details>;
}
