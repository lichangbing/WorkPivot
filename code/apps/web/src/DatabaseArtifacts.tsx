import { useEffect, useRef, useState } from 'react';
import { getToken, jsonFetch } from './api';
import { KnowledgeIngestionDialog } from './KnowledgeIngestionDialog';

interface Artifact {
  id: string;
  documentId: string;
  name: string;
  revision: number;
  current?: boolean;
  knowledgeStatus?: 'none'|'pending'|'confirmed'|'rejected';
  knowledgeRevision?: number;
}

const button='rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40';
const knowledgeLabels={none:'未提交入库',pending:'待确认入库',confirmed:'已入库',rejected:'已拒绝入库'};

export function DatabaseArtifacts({ taskId,purpose='artifact',compact=false }: { taskId?: string | null;purpose?:'upload'|'artifact';compact?:boolean }) {
  const label=purpose==='upload'?'上传资料':'产物';
  const [rows,setRows]=useState<Artifact[]>([]),[error,setError]=useState('');
  const [selected,setSelected]=useState<Artifact|null>(null),[versions,setVersions]=useState<Artifact[]>([]),[loading,setLoading]=useState(false);
  const [knowledge,setKnowledge]=useState<Artifact|null>(null);
  const [removing,setRemoving]=useState<Artifact|null>(null),[versionRemoving,setVersionRemoving]=useState<Artifact|null>(null);
  const [busy,setBusy]=useState(false),[generation,setGeneration]=useState(0);
  const historyRequest=useRef<AbortController|null>(null),dialog=useRef<HTMLDialogElement>(null),removal=useRef<HTMLDialogElement>(null);

  useEffect(()=>()=>historyRequest.current?.abort(),[]);
  useEffect(()=>{historyRequest.current?.abort();setSelected(null);setRemoving(null);setVersionRemoving(null);setKnowledge(null);setVersions([]);dialog.current?.close();removal.current?.close();},[taskId,purpose]);
  useEffect(()=>{if(selected&&!dialog.current?.open)dialog.current?.showModal();},[selected]);
  useEffect(()=>{if(removing)removal.current?.showModal();else removal.current?.close();},[removing]);
  useEffect(()=>{
    setRows([]);setError('');if(!taskId)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{
      try{
        const result=await jsonFetch<{artifacts?:Artifact[];files?:Artifact[]}>(`/api/tasks/${taskId}/${purpose==='upload'?'files':'artifacts'}`,{signal:controller.signal});
        if(!controller.signal.aborted){setRows(result.artifacts??result.files??[]);setError('');}
      }catch{if(!controller.signal.aborted)setError('资料暂时无法加载');}
      finally{if(!controller.signal.aborted)timer=setTimeout(()=>void refresh(),3000);}
    };
    void refresh();
    return()=>{controller.abort();clearTimeout(timer);};
  },[taskId,purpose,generation]);

  const history=async(row:Artifact)=>{
    historyRequest.current?.abort();const controller=new AbortController();historyRequest.current=controller;
    setSelected(row);setVersions([]);setLoading(true);setError('');
    try{
      const result=await jsonFetch<{versions:Artifact[]}>(`/api/tasks/${taskId}/files/${row.documentId}/versions`,{signal:controller.signal});
      if(!controller.signal.aborted)setVersions(result.versions);
    }catch{if(!controller.signal.aborted)setError('历史版本加载失败，请重试');}
    finally{if(!controller.signal.aborted)setLoading(false);}
  };
  const closeHistory=()=>{historyRequest.current?.abort();setSelected(null);setVersionRemoving(null);dialog.current?.close();};
  const download=async(row:Artifact)=>{
    try{
      const response=await fetch(`/api/tasks/${taskId}/file-versions/${row.id}`,{headers:{Authorization:`Bearer ${getToken()??''}`}});
      if(!response.ok)throw Error('文件下载失败，可能已被删除');
      const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');
      link.href=url;link.download=row.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(value){setError(value instanceof Error?value.message:'下载失败');}
  };
  const removeDocument=async()=>{
    if(!removing||busy)return;setBusy(true);setError('');
    try{
      await jsonFetch(`/api/tasks/${taskId}/files/${removing.documentId}`,{method:'DELETE',body:JSON.stringify({revision:removing.revision})});
      setRows(current=>current.filter(row=>row.documentId!==removing.documentId));setRemoving(null);setGeneration(value=>value+1);
    }catch(value){setError(value instanceof Error?value.message:'删除失败');}
    finally{setBusy(false);}
  };
  const removeVersion=async()=>{
    if(!versionRemoving||!selected||busy)return;setBusy(true);setError('');
    try{
      await jsonFetch(`/api/tasks/${taskId}/files/${versionRemoving.documentId}/versions/${versionRemoving.id}`,{
        method:'DELETE',body:JSON.stringify({confirmation:'删除此版本'}),
      });
      setVersions(current=>current.filter(row=>row.id!==versionRemoving.id));setVersionRemoving(null);setGeneration(value=>value+1);
    }catch(value){setError(value instanceof Error?value.message:'版本删除失败');}
    finally{setBusy(false);}
  };
  const openKnowledge=(row:Artifact)=>{
    closeHistory();setError('');setKnowledge(row);
  };

  return <section aria-label={label} className={compact?'flex max-h-40 flex-col':'flex h-40 flex-col'}>
    <h2 className="mb-2 font-medium text-neutral-300">{label}</h2>
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
      {rows.map(row=><div key={row.id} className="flex items-center gap-1">
        <button title={`${row.name} · 版本 ${row.revision} · 点击下载，右键查看历史版本`} aria-haspopup="dialog" className="block min-w-0 flex-1 truncate rounded p-1 text-left hover:bg-neutral-900" onContextMenu={event=>{event.preventDefault();void history(row);}} onKeyDown={event=>{if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();void history(row);}}} onClick={()=>void download(row)}>{row.name}</button>
        {purpose==='upload'&&<button className="shrink-0 whitespace-nowrap" title={knowledgeLabels[row.knowledgeStatus??'none']} onClick={()=>openKnowledge(row)}>知识</button>}
        <button className="shrink-0 whitespace-nowrap" title="查看历史版本" aria-label={`查看 ${row.name} 历史版本`} onClick={()=>void history(row)}>版本</button>
        <button className="shrink-0 whitespace-nowrap" title="移入回收站" aria-label={`删除 ${row.name}`} onClick={()=>{setError('');setRemoving(row);}}>删除</button>
      </div>)}
      {!rows.length&&<p className="text-neutral-500">暂无{label}</p>}
      {error&&!selected&&!knowledge&&<p role="alert" className="text-red-400">{error}</p>}
    </div>

    <dialog ref={removal} aria-label="移入回收站" className="m-auto max-w-lg rounded-xl border border-neutral-700 bg-neutral-900 p-5 text-neutral-100" onCancel={event=>{if(busy)event.preventDefault();else setRemoving(null);}}>
      <h3>移入回收站？</h3><p className="my-3">{removing?.name} 的所有版本将保留30天，关联知识和模型上下文失效，相关自动化需重新确认。</p>{error&&<p role="alert">{error}</p>}
      <button disabled={busy} onClick={()=>setRemoving(null)}>取消</button><button className="ml-4" disabled={busy} onClick={()=>void removeDocument()}>确认移入回收站</button>
    </dialog>

    <dialog ref={dialog} aria-label="资料历史版本" className="m-auto max-h-[88vh] w-full max-w-2xl overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 p-0 text-neutral-100 backdrop:bg-black/50" onCancel={closeHistory} onClose={()=>{historyRequest.current?.abort();setSelected(null);}}>
      <header className="border-b border-neutral-800 p-4"><h3 className="break-words text-base font-medium">{selected?.name} · 历史版本</h3><p className="mt-1 text-xs text-neutral-500">删除当前版不会自动启用旧版；新版本需单独确认入库。</p></header>
      <div className="max-h-[65vh] space-y-2 overflow-y-auto p-4">
        {loading?<p>正在加载…</p>:versions.map(row=><article key={row.id} className="rounded-lg border border-neutral-800 p-3">
          <div className="flex flex-wrap items-center gap-2"><strong className="flex-1">版本 {row.revision}{row.current?'（当前）':''}</strong><small className="text-neutral-500">{row.name}</small></div>
          {purpose==='upload'&&<p className="mt-1 text-xs text-neutral-400">{knowledgeLabels[row.knowledgeStatus??'none']}</p>}
          <div className="mt-2 flex flex-wrap gap-2"><button className={button} onClick={()=>void download(row)}>下载</button>{purpose==='upload'&&<button className={button} onClick={()=>openKnowledge(row)}>知识入库</button>}{purpose==='upload'&&<button className={button+' text-red-300'} onClick={()=>{setError('');setVersionRemoving(row);}}>删除此版本</button>}</div>
          {versionRemoving?.id===row.id&&<div role="alertdialog" aria-label="确认删除文件版本" className="mt-3 rounded border border-amber-700 p-3 text-sm"><p>删除后，该版本的知识分片、向量和引用立即失效；原文与产物版本只删除此版本。</p><button className={button} disabled={busy} onClick={()=>void removeVersion()}>确认删除版本</button><button className={button+' ml-2'} disabled={busy} onClick={()=>setVersionRemoving(null)}>取消</button></div>}
        </article>)}
        {error&&<p role="alert" className="text-red-400">{error}</p>}
      </div>
      <footer className="border-t border-neutral-800 p-4"><button className={button} onClick={closeHistory}>关闭</button></footer>
    </dialog>

    {knowledge&&taskId&&<KnowledgeIngestionDialog taskId={taskId} versionId={knowledge.id} name={knowledge.name} onClose={()=>setKnowledge(null)} onChanged={()=>setGeneration(value=>value+1)} />}
  </section>;
}
