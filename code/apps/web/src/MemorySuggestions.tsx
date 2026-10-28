import { useEffect, useState } from 'react';
import { jsonFetch } from './api';

interface Suggestion {
  analysisId?: string;
  reason?: string;
  projectName?: string;
  id: string;
  replacedCount?: number;
  scope: string;
  content: string;
  taskName: string;
  targetId?: string;
  originalContent?: string;
  evidence?: string;
  sourceContext?: { runId: string; evidence: string }[];
  mergeTargets: { id: string; revision: number }[];
  mergeOriginals: { id: string; content: string; revision: number }[];
}

const scopeLabel: Record<string, string> = { user: '个人记忆', project: '项目记忆', task: '任务记忆' };
const actionButton = 'rounded border border-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-800 disabled:opacity-40';

export function MemorySuggestions({ onChanged, showEmpty = false }: { onChanged?: () => void; showEmpty?: boolean } = {}) {
  const [loaded, setLoaded] = useState(false);
  const [rows, setRows] = useState<Suggestion[]>([]), [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null), [draft, setDraft] = useState(''), [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await jsonFetch<{ suggestions: Suggestion[] }>('/api/memory-suggestions', { signal: controller.signal });
        if (!controller.signal.aborted) {
          setRows(result.suggestions);
          setLoaded(true);
          setError('');
        }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '记忆建议读取失败');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 3000);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);

  const decide = async (suggestion: Suggestion, accept: boolean) => {
    setBusy(true);
    setError('');
    try {
      await jsonFetch(`/api/memory-suggestions/${suggestion.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ accept, ...(accept && editing === suggestion.id ? { content: draft } : {}) }),
      });
      const fresh = await jsonFetch<{ suggestions: Suggestion[] }>('/api/memory-suggestions');
      setRows(fresh.suggestions);
      setEditing(null);
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  if (showEmpty && !loaded && !error) return <p className="text-sm text-neutral-400">正在读取记忆冲突…</p>;
  if (!rows.length && !error) return showEmpty ? <p className="text-sm text-neutral-400">暂无需要确认的记忆冲突。新的无冲突事实会自动保存。</p> : null;
  const visible = rows.slice(0, 1);

  return <section aria-label="待确认记忆" className="mt-3 space-y-2">
    <div className="flex items-center justify-between gap-3">
      <h3 className="font-medium">需要确认的记忆</h3>
      {rows.length > 1 && <span className="text-xs text-neutral-500">当前第 1 条，共 {rows.length} 条</span>}
    </div>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    <ul role="list" className="divide-y divide-neutral-800 overflow-hidden rounded-xl border border-neutral-800">
      {visible.map(suggestion => <li key={suggestion.id} className="flex flex-col gap-3 bg-neutral-950/40 px-4 py-3 md:flex-row md:items-start">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
            <span className="rounded bg-neutral-800 px-2 py-0.5">{scopeLabel[suggestion.scope] ?? suggestion.scope}</span>
            <span>{suggestion.projectName ?? suggestion.taskName}</span>
            {suggestion.analysisId && <span>· 十轮分析</span>}
          </div>
          {suggestion.reason && <p className="text-xs text-neutral-400">建议理由：{suggestion.reason}</p>}
          {!!suggestion.replacedCount && <p className="text-xs text-neutral-500">根据后续纠正替代了 {suggestion.replacedCount} 条待确认建议，仍需你确认。</p>}
          {suggestion.evidence && <details><summary className="cursor-pointer text-xs text-neutral-500">查看原文证据</summary><p className="mt-1 whitespace-pre-wrap break-words text-xs text-neutral-500">{suggestion.evidence}</p></details>}
          {!!suggestion.sourceContext?.length && <details><summary className="cursor-pointer text-xs text-neutral-500">{suggestion.analysisId ? '跨任务分析依据' : '参考对话'}（{suggestion.sourceContext.length} 轮）</summary><ol className="mt-1 list-decimal space-y-2 pl-5">{suggestion.sourceContext.map(item => <li key={item.runId} className="whitespace-pre-wrap break-words text-xs text-neutral-500">{item.evidence}</li>)}</ol></details>}
          {suggestion.mergeTargets?.length > 0 && <details><summary className="cursor-pointer text-xs text-neutral-500">合并 {suggestion.mergeTargets.length} 条记忆 · 查看原文</summary><ol className="mt-1 list-decimal space-y-2 pl-5">{suggestion.mergeOriginals.map(memory => <li key={memory.id} className="whitespace-pre-wrap break-words text-xs text-neutral-500">{memory.content}</li>)}</ol></details>}
          {suggestion.targetId && <details><summary className="cursor-pointer text-xs text-neutral-500">修改已有记忆 · 查看原文</summary><p className="mt-1 whitespace-pre-wrap break-words text-xs text-neutral-500">{suggestion.originalContent}</p></details>}
          {editing === suggestion.id
            ? <textarea aria-label="修改记忆建议" maxLength={20000} className="h-28 w-full rounded bg-neutral-900 p-2 text-sm" value={draft} onChange={event => setDraft(event.target.value)} />
            : <p className="whitespace-pre-wrap break-words text-sm leading-6">{suggestion.content}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 md:justify-end">
          <button type="button" className={actionButton} disabled={busy || (editing === suggestion.id && !draft.trim())} onClick={() => { void decide(suggestion, true); }}>{suggestion.mergeTargets?.length ? '确认合并' : '确认保存'}</button>
          <button type="button" className={actionButton} disabled={busy} onClick={() => { if (editing === suggestion.id) { setEditing(null); setDraft(''); } else { setEditing(suggestion.id); setDraft(suggestion.content); } }}>{editing === suggestion.id ? '取消修改' : '修改'}</button>
          <button type="button" className={actionButton + ' text-red-300'} disabled={busy} onClick={() => { void decide(suggestion, false); }}>删除</button>
        </div>
      </li>)}
    </ul>
  </section>;
}
