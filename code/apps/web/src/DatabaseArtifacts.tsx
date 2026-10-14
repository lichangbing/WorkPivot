import { useEffect, useRef, useState } from 'react';
import { getToken, jsonFetch } from './api';

interface Artifact { id: string; documentId: string; name: string; revision: number }
export function DatabaseArtifacts({ taskId }: { taskId?: string | null }) {
  const [rows, setRows] = useState<Artifact[]>([]), [error, setError] = useState('');
  const [selected, setSelected] = useState<Artifact | null>(null), [versions, setVersions] = useState<Artifact[]>([]), [loading, setLoading] = useState(false);
  const historyRequest = useRef<AbortController | null>(null), dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => () => historyRequest.current?.abort(), []);
  useEffect(() => { historyRequest.current?.abort(); setSelected(null); setVersions([]); dialog.current?.close(); }, [taskId]);
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
      try { const result = await jsonFetch<{ artifacts: Artifact[] }>(`/api/tasks/${taskId}/artifacts`, { signal: controller.signal }); if (!controller.signal.aborted) { setRows(result.artifacts); setError(''); } }
      catch { if (!controller.signal.aborted) setError('产物暂时无法加载'); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, 3000); }
    };
    void refresh(); return () => { controller.abort(); clearTimeout(timer); };
  }, [taskId]);
  const download = async (row: Artifact) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/file-versions/${row.id}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } });
      if (!response.ok) throw Error('产物下载失败，可能已被删除');
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
      link.href = url; link.download = row.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : '下载失败'); }
  };
  return <section aria-label="产物" className="flex h-40 flex-col"><h2 className="mb-2 font-medium text-neutral-300">产物</h2><div className="min-h-0 flex-1 space-y-1 overflow-y-auto">{rows.map(row => <button key={row.id} title={`${row.name} · 版本 ${row.revision} · 点击下载，右键查看历史版本`} aria-haspopup="dialog" className="block w-full truncate rounded p-1 text-left hover:bg-neutral-900" onContextMenu={e => { e.preventDefault(); void history(row); }} onKeyDown={e => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); void history(row); } }} onClick={() => { void download(row); }}>{row.name}</button>)}{!rows.length && <p className="text-neutral-500">暂无产物</p>}{error && !selected && <p role="alert" className="text-red-400">{error}</p>}</div>
    <dialog ref={dialog} aria-label="产物历史版本" className="m-auto w-full max-w-lg rounded-xl border border-neutral-700 bg-neutral-900 p-5 text-neutral-100 backdrop:bg-black/50" onCancel={closeHistory} onClose={() => { historyRequest.current?.abort(); setSelected(null); }}>
      <h3 className="mb-4 break-words text-base font-medium">{selected?.name} · 历史版本</h3>
      {loading ? <p>正在加载…</p> : <ul className="max-h-72 space-y-2 overflow-y-auto">{versions.map((row, index) => <li key={row.id}><button className="w-full rounded p-2 text-left hover:bg-neutral-800" onClick={() => { void download(row); }}>版本 {row.revision}{index === 0 ? '（最新）' : ''} · {row.name} · 下载</button></li>)}</ul>}
      {error && <p role="alert" className="mt-3 text-red-400">{error}<button className="ml-2 underline" onClick={() => { if (selected) void history(selected); }}>重试</button></p>}
      <button className="mt-4 rounded border border-neutral-700 px-3 py-1.5" onClick={closeHistory}>关闭</button>
    </dialog>
  </section>;
}
