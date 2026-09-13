import { useEffect, useRef, useState } from 'react';
import { api, getToken } from './api';
import { Icon } from './Icon';
import type { SidebarData } from './TaskSidebar';
async function request(taskId: string, body?: unknown) {
  const r = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/deliverables`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + getToken(), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const value = await r.json(); if (!r.ok) throw Error(value.error || '读取文件失败'); return value;
}
export function ArtifactSyncController() {
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const token = getToken(); if (token && window.workpivotDesktop?.syncArtifacts) { const status = await window.workpivotDesktop.syncArtifacts(token); if (!stopped) window.dispatchEvent(new CustomEvent('wp:artifact-sync', { detail: status })); } } catch { /* Next tick retries after reconnection. */ }
      if (!stopped) timer = setTimeout(() => void poll(), 30000);
    };
    void poll(); return () => { stopped = true; clearTimeout(timer); void window.workpivotDesktop?.stopSync?.(); };
  }, []);
  return null;
}
export function ArtifactBrowser({ taskId, onClose }: { taskId?: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<{ files: SidebarData['artifacts']; deliverables: Array<{ name: string; version: { id: string } }> } | null>(null);
  const [tab, setTab] = useState<'results' | 'process'>('results'), [error, setError] = useState(''), [busy, setBusy] = useState(false), [sync, setSync] = useState<ArtifactSyncStatus | null>(null);
  const refresh = async () => { if (taskId) setData(await request(taskId)); };
  useEffect(() => { dialog.current?.showModal(); void refresh().catch(e => setError(String(e))); void window.workpivotDesktop?.syncStatus?.(getToken() ?? '').then(setSync).catch(e => setError(String(e))); const update = (e: Event) => setSync((e as CustomEvent<ArtifactSyncStatus>).detail); window.addEventListener('wp:artifact-sync', update); return () => window.removeEventListener('wp:artifact-sync', update); }, [taskId]);
  const work = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const results = new Map(data?.deliverables.map(d => [d.name, d.version.id]));
  const files = tab === 'results' ? [...results.keys()] : (data?.files.filter(f => !results.has(f.name)).map(f => f.name) ?? []);
  return <dialog ref={dialog} onCancel={e => { if (busy) e.preventDefault(); else onClose(); }} aria-label="服务端文件与成果同步" className="m-auto w-[780px] max-w-[95vw] rounded-xl border border-neutral-700 bg-neutral-950 p-5 text-neutral-100 backdrop:bg-black/60">
    <div className="mb-4 flex items-center justify-between"><h2>服务端文件与成果同步</h2><button disabled={busy} aria-label="关闭成果浏览" onClick={onClose}><Icon name="close" /></button></div>
    <p className="mb-3 text-xs text-neutral-500">成果是明确交付的文件；其他生成文件留在服务器，不会自动下载。旧任务的文件可手动标为成果。</p>
    {error && <p role="alert" className="mb-2 text-sm text-red-400">{error}</p>}
    <div className="mb-4 rounded border border-neutral-800 p-3 text-xs">
      {window.workpivotDesktop?.configureSync ? <><div className="mb-2 break-all">{sync?.enabled ? `自动同步到：${sync.directory}` : '尚未开启成果自动同步'}</div><div className="flex flex-wrap gap-3">
        <button disabled={busy} onClick={() => void work(async () => { const value = await window.workpivotDesktop!.configureSync!(getToken() ?? ''); setSync(value); if (value.enabled) setSync(await window.workpivotDesktop!.syncArtifacts!(getToken() ?? '')); })}>{sync?.directory ? '更换同步目录' : '选择同步目录'}</button>
        {sync?.enabled && <><button disabled={busy} onClick={() => void work(async () => setSync(await window.workpivotDesktop!.syncArtifacts!(getToken() ?? '')))}>立即同步</button><button disabled={busy} onClick={() => void work(async () => setSync(await window.workpivotDesktop!.configureSync!(getToken() ?? '', false)))}>暂停同步</button></>}
        {sync?.directory && <button disabled={busy} onClick={() => void work(async () => { await window.workpivotDesktop!.showSyncFolder!(getToken() ?? ''); })}>打开本地目录</button>}
      </div><p className="mt-2 text-neutral-500">服务器成果单向同步到本机，本地修改不回传。客户端运行并登录时每 30 秒同步所有任务的成果。按账号、任务分目录保存；本地修改保留，冲突时另存服务器版本。单文件上限 50MB；删除或取消成果不会删除本地副本。</p>{Boolean(sync?.conflicts) && <p className="mt-2">{sync!.conflicts} 个文件存在本地修改，服务器版本已另存。</p>}{sync?.errors?.map(e => <p key={e} className="mt-1 text-red-400">{e}</p>)}</> : <p>自动同步需要安装新版桌面客户端。浏览器可浏览清单并下载成果。</p>}
    </div>
    <div className="mb-3 flex gap-4 text-sm"><button onClick={() => setTab('results')} className={tab === 'results' ? 'font-semibold' : 'text-neutral-500'}>已交付成果</button><button onClick={() => setTab('process')} className={tab === 'process' ? 'font-semibold' : 'text-neutral-500'}>其他生成文件</button><button className="ml-auto" disabled={busy} onClick={() => void work(refresh)}>刷新</button></div>
    <ul className="h-64 space-y-2 overflow-y-auto text-sm">{files.map(name => <li key={name} className="flex items-center gap-3 rounded bg-neutral-900 p-2"><span className="min-w-0 flex-1 break-all">{name}</span>{tab === 'results' && <button disabled={busy} onClick={() => void work(async () => { if (window.workpivotDesktop?.openArtifact) await window.workpivotDesktop.openArtifact(taskId!, name, getToken() ?? '', results.get(name)); else await api.downloadArtifact(taskId!, name, results.get(name)); })}>{window.workpivotDesktop ? '打开' : '下载'}</button>}<button disabled={busy} className="shrink-0 text-xs text-neutral-500" onClick={() => void work(async () => { await request(taskId!, { name, selected: tab !== 'results' }); await refresh(); })}>{tab === 'results' ? '取消成果' : '标为成果'}</button></li>)}{!files.length && <li className="text-neutral-500">{taskId ? '暂无文件' : '选择任务后可浏览服务端文件'}</li>}</ul>
  </dialog>;
}
