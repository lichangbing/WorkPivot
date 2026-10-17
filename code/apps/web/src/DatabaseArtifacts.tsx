import { useEffect, useRef, useState } from 'react';
import { getToken, jsonFetch } from './api';

interface Artifact { id: string; documentId: string; name: string; revision: number }
export function DatabaseArtifacts({ taskId,purpose='artifact' }: { taskId?: string | null;purpose?:'upload'|'artifact' }) {
  const label=purpose==='upload'?'上传资料':'产物';
  const [removing,setRemoving]=useState<Artifact|null>(null),[deleting,setDeleting]=useState(false);
  const removal=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(removing)removal.current?.showModal();else removal.current?.close();},[removing]);
  const remove=async()=>{if(!removing||deleting)return;setDeleting(true);setError('');try{await jsonFetch(`/api/tasks/${taskId}/files/${removing.documentId}`,{method:'DELETE',body:JSON.stringify({revision:removing.revision})});setRows(v=>v.filter(r=>r.documentId!==removing.documentId));setRemoving(null);}catch(e){setError(e instanceof Error?e.message:'删除失败');}finally{setDeleting(false);}};
  const [rows, setRows] = useState<Artifact[]>([]), [error, setError] = useState('');
  const [selected, setSelected] = useState<Artifact | null>(null), [versions, setVersions] = useState<Artifact[]>([]), [loading, setLoading] = useState(false);
  const historyRequest = useRef<AbortController | null>(null), dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => () => historyRequest.current?.abort(), []);
  useEffect(() => { historyRequest.current?.abort(); setSelected(null); setRemoving(null); setVersions([]); dialog.current?.close(); }, [taskId,purpose]);
  useEffect(() => { if (selected && !dialog.current?.open) dialog.current?.showModal(); }, [selected]);
  const history = async (row: Artifact) => {
    historyRequest.current?.abort(); const controller = new AbortController(); historyRequest.current = controller;
    setSelected(row); setVersions([]); setLoading(true); setError('');
    try { const result = await jsonFetch<{ versions: Artifact[] }>(`/api/tasks/${taskId}/files/${row.documentId}/versions`, { signal: controller.signal }); if (!controller.signal.aborted) setVersions(result.versions); }
    catch { if (!controller.signal.aborted) setError('历史版本加载失败，请重试'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  const closeHistory = () => { historyRequest.current?.abort(); setSelected(null); dialog.current?.close(); };
  useEffect(() => {
    setRows([]); setError(''); if (!taskId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { const result = await jsonFetch<{ artifacts?: Artifact[];files?:Artifact[] }>(`/api/tasks/${taskId}/${purpose==='upload'?'files':'artifacts'}`, { signal: controller.signal }); if (!controller.signal.aborted) { setRows(result.artifacts??result.files??[]); setError(''); } }
      catch { if (!controller.signal.aborted) setError('产物暂时无法加载'); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, 3000); }
    };
    void refresh(); return () => { controller.abort(); clearTimeout(timer); };
  }, [taskId,purpose]);
  const download = async (row: Artifact) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/file-versions/${row.id}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } });
      if (!response.ok) throw Error('产物下载失败，可能已被删除');
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
      link.href = url; link.download = row.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : '下载失败'); }
  };
  return <section aria-label={label} className="flex h-40 flex-col"><h2 className="mb-2 font-medium text-neutral-300">{label}</h2><div className="min-h-0 flex-1 space-y-1 overflow-y-auto">{rows.map(row => <div key={row.id} className="flex items-center gap-1"><button title={`${row.name} · 版本 ${row.revision} · 点击下载，右键查看历史版本`} aria-haspopup="dialog" className="block min-w-0 flex-1 truncate rounded p-1 text-left hover:bg-neutral-900" onContextMenu={e => { e.preventDefault(); void history(row); }} onKeyDown={e => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); void history(row); } }} onClick={() => { void download(row); }}>{row.name}</button><button className="shrink-0 whitespace-nowrap" title="查看历史版本" aria-label={`查看 ${row.name} 历史版本`} onClick={()=>{void history(row);}}>版本</button><button className="shrink-0 whitespace-nowrap" title="移入回收站" aria-label={`删除 ${row.name}`} onClick={()=>{setError('');setRemoving(row);}}>删除</button></div>)}{!rows.length && <p className="text-neutral-500">暂无{label}</p>}{error && !selected && <p role="alert" className="text-red-400">{error}</p>}</div>
    <dialog ref={removal} aria-label="移入回收站" className="m-auto max-w-lg rounded-xl border border-neutral-700 bg-neutral-900 p-5 text-neutral-100" onCancel={e=>{if(deleting)e.preventDefault();else setRemoving(null);}}><h3>移入回收站？</h3><p className="my-3">{removing?.name} 的所有版本将保留30天，关联知识和模型上下文失效，相关自动化需重新确认。</p>{error&&<p role="alert">{error}</p>}<button disabled={deleting} onClick={()=>setRemoving(null)}>取消</button><button className="ml-4" disabled={deleting} onClick={()=>{void remove();}}>确认移入回收站</button></dialog>
    <dialog ref={dialog} aria-label="产物历史版本" className="m-auto w-full max-w-lg rounded-xl border border-neutral-700 bg-neutral-900 p-5 text-neutral-100 backdrop:bg-black/50" onCancel={closeHistory} onClose={() => { historyRequest.current?.abort(); setSelected(null); }}>
      <h3 className="mb-4 break-words text-base font-medium">{selected?.name} · 历史版本</h3>
      {loading ? <p>正在加载…</p> : <ul className="max-h-72 space-y-2 overflow-y-auto">{versions.map((row, index) => <li key={row.id}><button className="w-full rounded p-2 text-left hover:bg-neutral-800" onClick={() => { void download(row); }}>版本 {row.revision}{index === 0 ? '（最新）' : ''} · {row.name} · 下载</button></li>)}</ul>}
      {error && <p role="alert" className="mt-3 text-red-400">{error}<button className="ml-2 underline" onClick={() => { if (selected) void history(selected); }}>重试</button></p>}
      <button className="mt-4 rounded border border-neutral-700 px-3 py-1.5" onClick={closeHistory}>关闭</button>
    </dialog>
  </section>;
}
