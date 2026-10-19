import { useEffect, useState } from 'react';
import { jsonFetch } from './api';

interface Suggestion { analysisId?:string;reason?:string;projectName?:string; id: string; replacedCount?: number; scope: string; content: string; taskName: string; targetId?: string; originalContent?: string; evidence?: string; sourceContext?: { runId: string; evidence: string }[]; mergeTargets: { id: string; revision: number }[]; mergeOriginals: { id: string; content: string; revision: number }[] }
export function MemorySuggestions({onChanged,showEmpty=false}:{onChanged?:()=>void;showEmpty?:boolean}={}) {
  const [loaded,setLoaded]=useState(false);
  const [rows, setRows] = useState<Suggestion[]>([]), [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null), [draft, setDraft] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { const c = new AbortController(); let timer: ReturnType<typeof setTimeout>; const poll = async () => {
    try { const r = await jsonFetch<{ suggestions: Suggestion[] }>('/api/memory-suggestions', { signal: c.signal }); if (!c.signal.aborted) {setRows(r.suggestions);setLoaded(true);setError('');} }
    catch (e) { if(!c.signal.aborted)setError(e instanceof Error?e.message:'记忆建议读取失败'); }
    finally { if (!c.signal.aborted) timer = setTimeout(() => { void poll(); }, 3000); }
  }; void poll(); return () => { c.abort(); clearTimeout(timer); }; }, []);
  const decide = async (s: Suggestion, accept: boolean) => {
    setBusy(true); setError('');
    try { await jsonFetch(`/api/memory-suggestions/${s.id}/decision`, { method: 'POST', body: JSON.stringify({ accept, ...(accept && editing === s.id ? { content: draft } : {}) }) }); const fresh = await jsonFetch<{ suggestions: Suggestion[] }>('/api/memory-suggestions'); setRows(fresh.suggestions); setEditing(null); onChanged?.(); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); }
  };
  if(showEmpty&&!loaded&&!error)return <p className="text-sm text-neutral-400">正在读取待确认建议…</p>;
  if (!rows.length && !error) return showEmpty?<p className="text-sm text-neutral-400">暂无待确认建议。周期分析不会直接写入记忆。</p>:null;
  return <section aria-label="待确认记忆" className="mt-3 space-y-2"><h3 className="font-medium">待确认记忆</h3>{error && <p role="alert" className="text-red-400">{error}</p>}{rows.map(s => <article key={s.id} className="space-y-2 rounded border border-neutral-700 p-2"><p className="text-neutral-500">{s.scope === 'user' ? '个人记忆' : s.scope === 'project' ? '项目记忆' : '任务记忆'} · {s.projectName??s.taskName}{s.analysisId?' · 十轮分析':''}</p>{s.reason&&<p className="text-xs text-neutral-400">建议理由：{s.reason}</p>}{!!s.replacedCount && <p className="text-neutral-500">根据后续纠正替代了 {s.replacedCount} 条待确认建议，仍需你确认。</p>}{s.evidence && <details><summary>查看原文证据</summary><p className="whitespace-pre-wrap break-words text-neutral-500">{s.evidence}</p></details>}{!!s.sourceContext?.length && <details><summary>{s.analysisId?'跨任务分析依据':'参考对话'}（{s.sourceContext.length} 轮）</summary><ol className="list-decimal space-y-2 pl-5">{s.sourceContext.map(item => <li key={item.runId} className="whitespace-pre-wrap break-words text-neutral-500">{item.evidence}</li>)}</ol></details>}{s.mergeTargets?.length > 0 && <details open><summary>合并 {s.mergeTargets.length} 条记忆 · 查看原文</summary><ol className="list-decimal space-y-2 pl-5">{s.mergeOriginals.map(m => <li key={m.id} className="whitespace-pre-wrap break-words text-neutral-500">{m.content}</li>)}</ol><p>确认后由下方内容替换这些条目，原版本和来源保留。</p></details>}{s.targetId && <details><summary>修改已有记忆 · 查看原文</summary><p className="whitespace-pre-wrap break-words text-neutral-500">{s.originalContent}</p></details>}{editing === s.id ? <textarea aria-label="修改记忆建议" maxLength={20000} className="h-28 w-full rounded bg-neutral-900 p-2" value={draft} onChange={e => setDraft(e.target.value)} /> : <p className="whitespace-pre-wrap break-words">{s.content}</p>}<div className="flex gap-3"><button disabled={busy || (editing === s.id && !draft.trim())} onClick={() => { void decide(s, true); }}>{s.mergeTargets?.length ? '确认合并' : '确认保存'}</button><button disabled={busy} onClick={() => { setEditing(s.id); setDraft(s.content); }}>修改</button><button disabled={busy} onClick={() => { void decide(s, false); }}>拒绝</button></div></article>)}</section>;
}
