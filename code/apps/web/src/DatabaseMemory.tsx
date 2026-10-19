import { splitMemoryEntries } from './memory-entries';
import { MemoryEntryReview } from './MemoryEntryReview';
import { DatabaseMemoryControls,MemoryTemplatePicker } from './DatabaseMemoryControls';
import { MemoryAutoControl } from './MemoryAutoControl';
import { MemorySuggestions } from './MemorySuggestions';
import { useEffect, useRef, useState } from 'react';
import { jsonFetch } from './api';
import { Icon } from './Icon';

type Scope = 'user' | 'project' | 'task';
interface Memory { locked?:boolean; id: string; revision: number; content: string }
const labels = { user: '个人记忆', project: '项目记忆', task: '任务记忆' };
const button = 'rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-40';

export function DatabaseMemory({ taskId, projectId }: { taskId?: string; projectId?: string | null }) {
  const [scope, setScope] = useState<Scope | null>(null);
  return <section aria-label="三层记忆"><h2 className="mb-2 font-medium text-neutral-300">记忆</h2>{(['user', 'project', 'task'] as const).map(value => <button key={value} disabled={value === 'project' ? !projectId : value === 'task' ? !taskId : false} className="flex w-full items-center gap-2 rounded py-2 text-left text-neutral-300 hover:bg-neutral-900 disabled:text-neutral-600" onClick={() => setScope(value)}><Icon name="memory" /><span>{labels[value]}</span></button>)}<MemoryAutoControl /><MemorySuggestions />{scope && <MemoryEditor key={`${scope}:${projectId}:${taskId}`} scope={scope} scopeId={scope !== 'task' ? projectId ?? undefined : scope === 'task' ? taskId : undefined} onClose={() => setScope(null)} />}</section>;
}

export function MemoryEditor({ scope, scopeId, onClose }: { scope: Scope; scopeId?: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<Memory[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [entries,setEntries]=useState<string[]|null>(null);
  const [draft, setDraft] = useState(''), [editing, setEditing] = useState<Memory | null>(null), [form, setForm] = useState(false);
  const [removing,setRemoving]=useState<Memory|null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const endpoint = `/api/memories?scope=${scope}${scopeId ? `&scopeId=${encodeURIComponent(scopeId)}` : ''}`;
  const load = async (after?: string, signal?: AbortSignal) => {
    const result = await jsonFetch<{ memories: Memory[]; nextCursor: string | null }>(endpoint + (after ? `&after=${encodeURIComponent(after)}` : ''), { signal });
    if (signal?.aborted) return;
    setRows(old => after ? [...old, ...result.memories] : result.memories); setCursor(result.nextCursor); setLoaded(true);
  };
  useEffect(() => { const node = dialog.current, c = new AbortController(); node?.showModal(); void load(undefined, c.signal).catch(e => { if (!c.signal.aborted) setError(String(e)); }); return () => { c.abort(); node?.close(); }; }, [endpoint]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return; setBusy(true); setError('');
    try { await action(); setForm(false); setEntries(null); setDraft(''); setEditing(null); setRemoving(null); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); }
  };
  return <dialog ref={dialog} onCancel={e => { if (busy) e.preventDefault(); else onClose(); }} aria-label={labels[scope]} className="m-auto w-[90vw] max-w-2xl rounded-xl border border-neutral-700 bg-neutral-950 p-5 text-neutral-100 backdrop:bg-black/40"><div className="max-h-[75vh] space-y-4 overflow-y-auto"><header className="flex items-center justify-between"><h2 className="text-base font-medium">{labels[scope]}</h2><button className={button} disabled={busy} onClick={onClose}>关闭</button></header><p className="text-xs text-neutral-500">手动新增、修改和删除会保存到后台。任务可按需检索已保存记忆；后台会整理新增或修改建议，需你确认后生效。</p><DatabaseMemoryControls scope={scope} /><MemoryTemplatePicker scope={scope} disabled={busy} onChoose={content=>{setEditing(null);setEntries(splitMemoryEntries(content));setForm(false);}} />{error && <p role="alert" className="text-sm text-red-400">{error}</p>}<button className={button} disabled={busy} onClick={() => { setEntries(null); setEditing(null); setDraft(''); setForm(true); }}>新增记忆</button>
    {entries && <MemoryEntryReview entries={entries} onChange={setEntries} busy={busy} replacing={!!editing} onCancel={()=>{setEntries(null);setEditing(null);}} onSave={()=>void run(()=>jsonFetch('/api/memory-entries',{method:'POST',body:JSON.stringify({entries:entries.map(v=>v.trim()),scope,scopeId,replace:editing?{id:editing.id,revision:editing.revision}:undefined})}))} />}
    {form && <form className="space-y-2" onSubmit={e => { e.preventDefault(); void run(() => jsonFetch(editing ? `/api/memories/${editing.id}` : '/api/memories', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(editing ? { content: draft.trim(), revision: editing.revision } : { content: draft.trim(), scope, scopeId }) })); }}><p className="text-xs text-neutral-400">只编辑当前这一条记忆，其他条目不受影响。</p><textarea disabled={busy} aria-label="记忆内容" autoFocus required maxLength={20000} value={draft} onChange={e => setDraft(e.target.value)} className="h-40 w-full rounded border border-neutral-700 bg-neutral-900 p-3 text-sm" /><div className="flex gap-2"><button className={button} disabled={busy || !draft.trim()}>保存</button><button type="button" className={button} disabled={busy} onClick={() => setForm(false)}>取消</button></div></form>}
    {!loaded && !error && <p>正在读取…</p>}{loaded && !rows.length && <p className="text-neutral-500">暂无记忆</p>}{rows.map(row => <article key={row.id} className="rounded-lg border border-neutral-800 p-3"><p className="mb-2 text-xs text-neutral-500">独立条目 · v{row.revision}{row.locked?' · 已锁定':''}</p><p className="whitespace-pre-wrap break-words text-sm">{row.content}</p><div className="mt-3 flex gap-2"><button className={button} disabled={busy} title="锁定只阻止自动修改和合并，仍可手动编辑或删除" onClick={()=>{void run(()=>jsonFetch(`/api/memories/${row.id}/lock`,{method:'PUT',body:JSON.stringify({locked:!row.locked,revision:row.revision})}));}}>{row.locked?'解锁':'锁定'}</button><button className={button} disabled={busy} onClick={() => { setEntries(null); setEditing(row); setDraft(row.content); setForm(true); }}>修改</button><button className={button} disabled={busy} onClick={()=>{setEditing(row);setForm(false);setEntries(splitMemoryEntries(row.content));}}>拆分为多条</button><button className={button} disabled={busy} onClick={() => setRemoving(row)}>删除</button></div>{removing?.id===row.id&&<div role="alertdialog" aria-label="确认删除记忆" className="mt-3 space-y-2 rounded-lg border border-amber-700 p-3 text-sm"><p>移入回收站并保留30天，之后需手动确认永久删除。旧模型上下文会失效，进行中的生成停止；聊天记录保留。</p><button className={button} disabled={busy} onClick={()=>void run(()=>jsonFetch(`/api/memories/${row.id}`,{method:'DELETE',body:JSON.stringify({revision:row.revision})}))}>确认移入回收站</button><button className={button+' ml-2'} disabled={busy} onClick={()=>setRemoving(null)}>保留记忆</button></div>}</article>)}{cursor && <button className={button} disabled={busy} onClick={() => { setBusy(true); void load(cursor).catch(e => setError(String(e))).finally(() => setBusy(false)); }}>加载更多</button>}
    </div></dialog>;
}
