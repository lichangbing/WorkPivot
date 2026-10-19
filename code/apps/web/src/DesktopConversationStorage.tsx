import { useEffect, useState } from 'react';
import { getToken } from './api';

export function DesktopConversationStorage({onClose}:{onClose:()=>void}){
  const [status,setStatus]=useState<ConversationCacheStatus|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const bridge=window.workpivotDesktop?.conversationCache;
  const load=async()=>{if(!bridge||!getToken())return;const handle=await bridge.open(getToken()!);setStatus(await bridge.status(handle));};
  useEffect(()=>{void load().catch(reason=>setError(reason.message));},[]);
  const clear=async()=>{
    if(!bridge||!getToken()||!window.confirm('清空当前账号在此服务器的本地会话副本？服务端聊天和文件不会删除，下次打开任务可重新同步。'))return;
    setBusy(true);setError('');
    try{const handle=await bridge.open(getToken()!);await bridge.clear(handle);window.dispatchEvent(new Event('wp:conversation-cache-cleared'));await load();}
    catch(reason){setError(reason instanceof Error?reason.message:'清理失败');}finally{setBusy(false);}
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><section role="dialog" aria-modal="true" aria-label="本地会话记录" className="w-full max-w-lg space-y-4 rounded-xl border border-neutral-700 bg-neutral-950 p-5" onKeyDown={event=>{if(event.key==='Escape'&&!busy)onClose();}}>
    <h2 className="text-base font-medium">本地会话记录</h2>
    <p className="text-sm text-neutral-400">会话按服务器与账号分别保存在当前系统用户目录，优先显示本地，再与服务端同步。生成文件仍在服务器，本地只保存文件引用。</p>
    <p className="text-sm">{status?`${status.tasks} 个任务 · ${(status.bytes/1024/1024).toFixed(2)} MB`:'正在读取…'}</p>
    {status?.lastSavedAt&&<p className="text-xs text-neutral-500">最近保存：{new Date(status.lastSavedAt).toLocaleString()}</p>}
    <p className="text-xs text-neutral-500">单任务最多32 MB，当前账号最多256 MB；超过总量时清理较早缓存，需要时从服务器重新读取。仅已加载的历史落盘。</p>
    {!!status?.audit?.length&&<details><summary className="text-sm">本地管理记录</summary><ul className="max-h-40 overflow-auto text-xs text-neutral-400">{status.audit.map((entry,index)=><li key={index}>{new Date(entry.at).toLocaleString()} · {entry.action} · {entry.count} 项</li>)}</ul></details>}
    {error&&<p role="alert" className="text-sm text-red-400">{error}</p>}
    <div className="flex justify-end gap-3"><button className="rounded border border-neutral-700 px-3 py-2 text-sm" disabled={busy} onClick={()=>{void clear();}}>清空本地会话副本</button><button autoFocus className="rounded bg-blue-600 px-3 py-2 text-sm text-white" disabled={busy} onClick={onClose}>关闭</button></div>
  </section></div>;
}
