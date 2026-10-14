import { useEffect, useState } from 'react';
import { jsonFetch } from './api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
interface Checkpoint { id:string;status:string;content:string;revision:number;through:string;turns:number;error?:string;processed?:number;total?:number }
export function DatabaseSummary({taskId,busy}:{taskId:string;busy:boolean}){
  const [row,setRow]=useState<Checkpoint>(),[error,setError]=useState(''),[working,setWorking]=useState(false),[editing,setEditing]=useState(false),[draft,setDraft]=useState('');
  const [original,setOriginal]=useState<{sequence:string;excerpt:string;truncated:boolean}[]>();
  const base=`/api/tasks/${taskId}/summary`;
  useEffect(()=>{const c=new AbortController();let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const r=await jsonFetch<{checkpoints:Checkpoint[]}>(base,{signal:c.signal});if(!c.signal.aborted)setRow(r.checkpoints[0]);}catch{/* Older servers may not expose compaction. */}finally{if(!c.signal.aborted)timer=setTimeout(()=>{void poll();},2000);}};void poll();return()=>{c.abort();clearTimeout(timer);};},[base]);
  const action=async(accept?:boolean)=>{if(working||busy)return;setWorking(true);setError('');try{if(accept===undefined)await jsonFetch(base,{method:'POST'});else if(row)await jsonFetch(`${base}/${row.id}/decision`,{method:'POST',body:JSON.stringify({revision:row.revision,accept,...(accept&&editing?{content:draft}:{})})});const r=await jsonFetch<{checkpoints:Checkpoint[]}>(base);setRow(r.checkpoints[0]);setEditing(false);setOriginal(undefined);}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setWorking(false);}};
  if(!row&&!error)return null;
  return <section aria-label="对话摘要" className="my-3 rounded-xl border border-neutral-700 p-4 text-sm"><h3 className="font-medium">{row?.status==='pending'?'请核对对话摘要':row?.status==='accepted'?'已使用确认的对话摘要':'对话摘要'}</h3>
    <p className="my-2 text-xs text-neutral-400">{row?.turns??0} 轮早期对话，覆盖至第 {row?.through??'—'} 轮。原始聊天保留；最近五轮完整保留。确认后再发送输入框里的消息。</p>
    {row?.status==='generating'?<p>正在整理摘要{row.total ? `（${row.processed??0}/${row.total} 批）` : ''}，未经确认不会用于续聊…</p>:row?.status==='pending'||row?.status==='accepted'?<>
      {editing?<textarea aria-label="修改对话摘要" className="h-48 w-full rounded border border-neutral-700 bg-neutral-900 p-2" value={draft} onChange={e=>setDraft(e.target.value)} maxLength={12000}/>:<details open={row.status==='pending'}><summary>摘要内容</summary><div className="message-body mt-2 break-words"><ReactMarkdown remarkPlugins={[remarkGfm]}>{row.content}</ReactMarkdown></div></details>}
      <button className="my-2 underline" disabled={working} onClick={()=>{if(original){setOriginal(undefined);return;}void jsonFetch<{sources:{sequence:string;excerpt:string;truncated:boolean}[]}>(`${base}/${row.id}/sources`).then(r=>setOriginal(r.sources)).catch(e=>setError(String(e)));}}>查看用户原文摘录</button>
      {original&&<div className="max-h-48 overflow-auto text-xs">{original.map(s=><p key={s.sequence} className="my-2 whitespace-pre-wrap">第{s.sequence}轮：{s.excerpt}{s.truncated?'…（完整内容可在聊天记录中回看）':''}</p>)}</div>}
      {row.status==='pending'&&<div className="flex gap-4"><button disabled={working||busy||(editing&&!draft.trim())} onClick={()=>{void action(true);}}>确认使用</button><button disabled={working||busy} onClick={()=>{setDraft(row.content);setEditing(!editing);}}>{editing?'取消修改':'修改'}</button><button disabled={working||busy} onClick={()=>{void action(false);}}>拒绝</button></div>}
    </>:<><p>{row?.error??(row?.status==='stale'?'来源已变化，旧摘要已失效。':'已拒绝，摘要未投入使用。')}</p><button disabled={working||busy} className="mt-2 underline" onClick={()=>{void action();}}>重新整理</button></>}
    {error&&<p role="alert" className="mt-2 text-red-400">{error}</p>}
  </section>;
}
