import { useState } from 'react';
import type { MobileClient } from './client';
import { useResource } from './useResource';

interface Suggestion {
  id: string; taskId: string; taskName: string; scope: string; content: string; reason?: string; evidence?: string;
  targetId?: string; originalContent?: string; mergeOriginals?: { id: string; content: string }[];
  sourceContext?: { runId: string; evidence: string }[];
  revision: number; expert_name?: string; conditions?: string;
  originals?: { id: string; content: string; conditions: string }[];
}
interface Props { client: MobileClient; taskId: string; onError: (error: unknown) => void }

function ReviewCard({ row, endpoint, client, onError, onChanged }: {
  row: Suggestion; endpoint: string; client: MobileClient; onError: (error: unknown) => void; onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const decide = async (accept: boolean) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await client.json(endpoint, { method: 'POST', body: JSON.stringify({ accept, revision: row.revision, ...(accept && draft !== null ? { content: draft } : {}) }) });
      await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '确认失败'); onError(reason); }
    finally { setBusy(false); }
  };
  const originals = row.originals ?? row.mergeOriginals ?? [];
  return <article className="approval memory-card">
    <strong>{row.expert_name ? `${row.expert_name} · 经验建议` : `${({ user: '个人', project: '项目', task: '任务' } as Record<string, string>)[row.scope] ?? ''}记忆建议`}</strong>
    {row.reason && <p>{row.reason}</p>}{row.conditions && <p>适用条件：{row.conditions}</p>}
    {row.evidence && <details><summary>查看原文证据</summary><p>{row.evidence}</p></details>}
    {!!row.sourceContext?.length && <details><summary>参考对话</summary>{row.sourceContext.map(source => <p key={source.runId}>{source.evidence}</p>)}</details>}
    {row.targetId && <details><summary>将修改的原记忆</summary><p>{row.originalContent}</p></details>}
    {!!originals.length && <details open><summary>将替换或合并的条目（{originals.length}）</summary>{originals.map(original => <p key={original.id}>{original.content}</p>)}</details>}
    {draft === null ? <p>{row.content}</p> : <textarea aria-label="修改记忆建议" maxLength={20000} value={draft} onChange={event => setDraft(event.target.value)} disabled={busy} />}
    {error && <p role="alert" className="error">{error}</p>}
    <button disabled={busy || (draft !== null && !draft.trim())} onClick={() => void decide(true)}>确认保存</button>
    <button disabled={busy} onClick={() => setDraft(draft === null ? row.content : null)}>{draft === null ? '修改' : '取消修改'}</button>
    <button disabled={busy} onClick={() => void decide(false)}>拒绝</button>
  </article>;
}
export function MemoryReview({ client, taskId, onError }: Props) {
  const memories = useResource<{ suggestions: Suggestion[] }>(client, '/api/memory-suggestions', onError, 3000);
  const experts = useResource<{ suggestions: Suggestion[] }>(client, `/api/expert-suggestions?task=${taskId}`, onError, 3000);
  return <section aria-label="记忆与经验确认">
    {memories.error && <p role="alert" className="error">记忆建议：{memories.error}</p>}
    {experts.error && <p role="alert" className="error">经验建议：{experts.error}</p>}
    {memories.value?.suggestions.filter(row => row.taskId === taskId).map(row => <ReviewCard key={row.id} row={row} client={client} endpoint={`/api/memory-suggestions/${row.id}/decision`} onError={onError} onChanged={memories.refresh} />)}
    {experts.value?.suggestions.map(row => <ReviewCard key={`${row.id}:${row.revision}`} row={row} client={client} endpoint={`/api/expert-suggestions/${row.id}/decision`} onError={onError} onChanged={experts.refresh} />)}
  </section>;
}

interface Checkpoint { id: string; revision: number; status: string; content: string; turns: number; error?: string }
interface Source { id: string; sequence: string; excerpt: string; truncated: boolean; messages: string; messagesTruncated: boolean }
export function SummaryReview({ client, taskId, onError, running }: Props & { running: boolean }) {
  const base = `/api/tasks/${taskId}/summary`;
  const resource = useResource<{ checkpoints: Checkpoint[] }>(client, base, onError, 3000);
  const [edit, setEdit] = useState<{ id: string; revision: number; content: string } | null>(null);
  const [sources, setSources] = useState<{ id: string; revision: number; rows: Source[] }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const row = resource.value?.checkpoints[0];
  const draft = edit?.id === row?.id && edit?.revision === row?.revision ? edit : null;
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); } catch (reason) { if (!resource.signal().aborted) { setError(reason instanceof Error ? reason.message : '摘要操作失败'); onError(reason); } }
    finally { setBusy(false); }
  };
  const decide = async (accept: boolean) => {
    if (!row) return;
    await client.json(`${base}/${row.id}/decision`, { method: 'POST', body: JSON.stringify({ revision: row.revision, accept, ...(accept && draft ? { content: draft.content } : {}) }), signal: resource.signal() });
    setEdit(null); await resource.refresh();
  };
  if (!row && !resource.error) return null;
  return <section className="approval memory-card" aria-label="对话摘要">
    <strong>{row?.status === 'pending' ? '请核对对话摘要' : '对话摘要'}</strong>
    <p>原始聊天保留；摘要经你确认后才用于续聊。确认后请重新发送输入框中保留的消息。</p>
    {row?.status === 'generating' ? <p>正在整理早期对话…</p> : row && ['pending', 'accepted'].includes(row.status) ? <>
      {draft ? <textarea aria-label="修改对话摘要" maxLength={12000} value={draft.content} disabled={busy} onChange={event => setEdit({ ...draft, content: event.target.value })} /> : <details open={row.status === 'pending'}><summary>{row.turns} 轮对话的摘要{row.status === 'accepted' ? '（已确认）' : ''}</summary><p>{row.content}</p></details>}
      <button disabled={busy} onClick={() => void run(async () => { const result = await client.json<{ sources: Source[] }>(`${base}/${row.id}/sources`, { signal: resource.signal() }); setSources({ id: row.id, revision: row.revision, rows: result.sources }); })}>核对原文</button>
      {sources?.id === row.id && sources.revision === row.revision && <details open><summary>来源摘录</summary>{sources.rows.map(source => <article key={source.id}><strong>第 {source.sequence} 轮</strong><p>{source.excerpt}</p><pre>{source.messages}</pre>{(source.truncated || source.messagesTruncated) && <small>摘录已截断，请回到聊天记录核对完整内容。</small>}</article>)}</details>}
      {row.status === 'pending' && <div><button disabled={busy || running || (!!draft && !draft.content.trim())} onClick={() => void run(() => decide(true))}>确认使用</button>
        <button disabled={busy || running} onClick={() => setEdit(draft ? null : { id: row.id, revision: row.revision, content: row.content })}>{draft ? '取消修改' : '修改摘要'}</button>
        <button disabled={busy || running} onClick={() => void run(() => decide(false))}>拒绝摘要</button></div>}
    </> : row && <><p>{row.error ?? '摘要未生效，可以重新整理。'}</p><button disabled={busy || running} onClick={() => void run(async () => { await client.json(base, { method: 'POST', signal: resource.signal() }); await resource.refresh(); })}>重新整理</button></>}
    {(error || resource.error) && <p className="error" role="alert">{error || resource.error}</p>}
  </section>;
}
