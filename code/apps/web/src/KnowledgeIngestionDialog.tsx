import { useEffect, useRef, useState } from 'react';
import { jsonFetch } from './api';

interface Candidate {
  id: string;
  ordinal: number;
  location: string;
  sourceOffset: number;
  content: string;
  suggested: boolean;
  reason: string | null;
}

interface CandidatePage {
  versionId: string;
  documentId: string;
  taskId: string;
  projectId: string;
  name: string;
  versionRevision: number;
  status: 'pending'|'confirmed'|'rejected';
  revision: number;
  selectedOrdinals: number[];
  total: number;
  nextOffset: number | null;
  candidates: Candidate[];
}

const statusText = { pending:'待确认', confirmed:'已入库', rejected:'已拒绝' } as const;
const button = 'rounded-lg border border-neutral-700 px-3 py-2 text-xs hover:bg-neutral-800 disabled:opacity-40';

export function KnowledgeIngestionDialog({ taskId, versionId, name, onClose, onChanged }: {
  taskId: string;
  versionId: string;
  name: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController|null>(null);
  const [data, setData] = useState<CandidatePage|null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');

  const load = async (offset = 0) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError('');
    try {
      const page = await jsonFetch<CandidatePage>(
        `/api/tasks/${taskId}/knowledge-ingestions/${versionId}?offset=${offset}&limit=50`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setData(page);
      setCandidates(rows => offset === 0 ? page.candidates : [...rows, ...page.candidates]);
      setSelected(current => {
        const next = offset === 0 ? new Set<number>(page.selectedOrdinals) : new Set(current);
        if (page.status === 'pending') for (const candidate of page.candidates) if (candidate.suggested) next.add(candidate.ordinal);
        return next;
      });
    } catch (value) {
      if (!controller.signal.aborted) setError(value instanceof Error ? value.message : '知识候选加载失败');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    dialog.current?.showModal();
    void load();
    return () => request.current?.abort();
  }, []);

  const act = async (action:'confirm'|'reject'|'reopen') => {
    if (!data || busy) return;
    setBusy(true); setError('');
    try {
      await jsonFetch(`/api/tasks/${taskId}/knowledge-ingestions/${versionId}/${action}`, {
        method:'POST',
        body: JSON.stringify(action === 'confirm'
          ? { revision:data.revision, selected:[...selected].sort((a,b)=>a-b) }
          : action === 'reject'
            ? { revision:data.revision, reason:reason.trim() || null }
            : { revision:data.revision }),
        signal:request.current?.signal,
      });
      onChanged();
      await load(0);
    } catch (value) {
      setError(value instanceof Error ? value.message : '知识入库操作失败');
    } finally { setBusy(false); }
  };

  const toggle = (ordinal:number) => setSelected(current => {
    const next = new Set(current);
    if (next.has(ordinal)) next.delete(ordinal); else next.add(ordinal);
    return next;
  });

  return <dialog ref={dialog} aria-label="知识入库审核" className="m-auto max-h-[90vh] w-[960px] max-w-[96vw] overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 p-0 text-neutral-100 backdrop:bg-black/60" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} onClose={onClose}>
    <header className="flex items-start gap-3 border-b border-neutral-800 p-4">
      <div className="min-w-0 flex-1"><h2 className="font-semibold">项目知识入库</h2><p className="mt-1 break-all text-xs text-neutral-400">{name} · 版本 {data?.versionRevision ?? '…'} · {data ? statusText[data.status] : '读取中'}</p></div>
      <button className={button} onClick={onClose} disabled={busy}>关闭</button>
    </header>
    <div className="max-h-[65vh] space-y-3 overflow-y-auto p-4">
      <p className="text-xs leading-6 text-neutral-400">只有勾选并通过确认的内容才会建立项目知识索引。原始文件不会因此改变；新版本需要单独确认。</p>
      {data?.status === 'confirmed' && <p className="rounded border border-emerald-800 bg-emerald-950/20 p-3 text-sm">已确认 {data.selectedOrdinals.length} 段内容。重新审核会先撤销当前版本的检索内容。</p>}
      {data?.status === 'rejected' && <p className="rounded border border-amber-800 bg-amber-950/20 p-3 text-sm">该版本已拒绝入库，不会生成任何可检索分片。</p>}
      {!!candidates.length && <div className="flex justify-end gap-2"><button className={button} disabled={busy || loading} onClick={() => setSelected(new Set(candidates.map(row => row.ordinal)))}>全选已加载</button><button className={button} disabled={busy || loading} onClick={() => setSelected(new Set())}>清空选择</button></div>}
      <ol className="space-y-2">{candidates.map(candidate => <li key={candidate.id} className="rounded-lg border border-neutral-800 p-3">
        <label className="flex items-start gap-3"><input aria-label={`选择候选 ${candidate.ordinal + 1}`} type="checkbox" className="mt-1" checked={selected.has(candidate.ordinal)} disabled={busy || data?.status !== 'pending'} onChange={() => toggle(candidate.ordinal)} />
          <span className="min-w-0 flex-1"><strong className="text-sm">{candidate.location}</strong><span className="ml-2 text-xs text-neutral-500">偏移 {candidate.sourceOffset}</span>
            {candidate.reason && <span className="ml-2 text-xs text-amber-400">{candidate.reason}</span>}
            <span className="mt-2 block whitespace-pre-wrap break-words text-xs leading-6 text-neutral-300">{candidate.content}</span>
          </span>
        </label>
      </li>)}</ol>
      {loading && <p className="text-sm text-neutral-400">正在读取候选片段…</p>}
      {data?.nextOffset !== null && data?.nextOffset !== undefined && <button className={button} disabled={loading || busy} onClick={() => void load(data.nextOffset!)}>加载更多候选</button>}
      {!loading && data && !candidates.length && <p className="text-sm text-neutral-400">没有可入库的文字片段。</p>}
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    </div>
    <footer className="border-t border-neutral-800 p-4">
      {data?.status === 'pending' && <label className="mb-3 block text-xs text-neutral-400">拒绝原因（可选）<input maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100" /></label>}
      <div className="flex flex-wrap justify-end gap-2">
        {data?.status === 'pending' && <><button className={button} disabled={busy || !selected.size} onClick={() => void act('confirm')}>确认入库（{selected.size}）</button><button className={button} disabled={busy} onClick={() => void act('reject')}>拒绝入库</button></>}
        {data && data.status !== 'pending' && <button className={button} disabled={busy} onClick={() => void act('reopen')}>重新审核</button>}
      </div>
    </footer>
  </dialog>;
}
