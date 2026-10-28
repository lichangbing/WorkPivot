import { useState } from 'react';
import type { MobileClient, Task } from './client';
import { useResource } from './useResource';

type Scope = 'user' | 'project' | 'task';
const labels = { user: '个人记忆', project: '项目记忆', task: '任务记忆' };
interface Memory { id: string; revision: number; content: string; locked?: boolean; needsReview?: boolean }
interface Props { client: MobileClient; task: Task; onError: (error: unknown) => void }
export function Memories(props: Props) {
  const [scope, setScope] = useState<Scope>('user');
  return <div><label>记忆层级<select value={scope} onChange={event => setScope(event.target.value as Scope)}>{(Object.keys(labels) as Scope[]).map(key => <option key={key} value={key} disabled={key !== 'task' && !props.task.projectId}>{labels[key]}</option>)}</select></label>
    {!props.task.projectId && scope !== 'task' ? <p>请先选择属于项目的任务。</p> : <MemoryEditor key={scope} {...props} scope={scope} />}
  </div>;
}
function MemoryEditor({ client, task, onError, scope }: Props & { scope: Scope }) {
  const scopeId = scope === 'task' ? task.id : task.projectId;
  const base = `/api/memories?scope=${scope}&scopeId=${scopeId}`;
  const resource = useResource<{ memories: Memory[]; nextCursor: string | null }>(client, base, onError);
  const [extra, setExtra] = useState<Memory[]>([]), [cursor, setCursor] = useState<string | null | undefined>();
  const [edit, setEdit] = useState<{ row?: Memory; content: string } | null>(null), [remove, setRemove] = useState<string>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async (action: () => Promise<void>, mutation = true) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await action();
      if (mutation) { setEdit(null); setRemove(undefined); setExtra([]); setCursor(undefined); await resource.refresh(); }
    } catch (reason) { if (!resource.signal().aborted) { setError(reason instanceof Error ? reason.message : '操作失败'); onError(reason); } }
    finally { setBusy(false); }
  };
  const write = async (path: string, method: string, body: unknown) => { await client.json(path, { method, body: JSON.stringify(body), signal: resource.signal() }); };
  const next = cursor === undefined ? resource.value?.nextCursor : cursor;
  return <section className="memory-editor capabilities" aria-label={labels[scope]}>
    <p className="muted">每条独立保存。手动调整直接生效，自动整理的建议在聊天中确认后生效。</p>
    <button disabled={busy} onClick={() => setEdit({ content: '' })}>新增记忆</button>
    {edit && <form onSubmit={event => { event.preventDefault(); void run(() => write(edit.row ? `/api/memories/${edit.row.id}` : '/api/memories', edit.row ? 'PUT' : 'POST', edit.row ? { revision: edit.row.revision, content: edit.content.trim() } : { scope, scopeId, content: edit.content.trim() })); }}>
      <textarea aria-label="记忆内容" maxLength={20000} required disabled={busy} value={edit.content} onChange={event => setEdit({ ...edit, content: event.target.value })} />
      <button disabled={busy || !edit.content.trim()}>保存记忆</button><button type="button" disabled={busy} onClick={() => setEdit(null)}>取消</button>
    </form>}
    {!resource.value && !resource.error && <p>正在读取…</p>}
    {resource.value?.memories.length === 0 && <p>暂无记忆</p>}
    {[...(resource.value?.memories ?? []), ...extra].map(row => <article key={row.id}><small>v{row.revision}{row.locked ? ' · 已锁定' : ''}{row.needsReview ? ' · 来源已删除，待复核' : ''}</small>{row.needsReview && <p role="status">此记忆已停止自动加载，请核对内容后重新保存。</p>}<p>{row.content}</p>
      <button disabled={busy} onClick={() => setEdit({ row, content: row.content })}>修改</button>
      <button disabled={busy} title="锁定阻止自动修改，仍可手动编辑" onClick={() => void run(() => write(`/api/memories/${row.id}/lock`, 'PUT', { revision: row.revision, locked: !row.locked }))}>{row.locked ? '解锁' : '锁定'}</button>
      <button disabled={busy} onClick={() => setRemove(row.id)}>删除</button>
      {remove === row.id && <div role="alertdialog" aria-label="确认删除记忆"><p>移入回收站保留 30 天。旧模型上下文失效，进行中的生成会停止，聊天记录保留。</p><button disabled={busy} onClick={() => void run(() => write(`/api/memories/${row.id}`, 'DELETE', { revision: row.revision }))}>确认移入回收站</button><button disabled={busy} onClick={() => setRemove(undefined)}>保留记忆</button></div>}
    </article>)}
    {next && <button disabled={busy} onClick={() => void run(async () => { const result = await client.json<{ memories: Memory[]; nextCursor: string | null }>(`${base}&after=${encodeURIComponent(next)}`, { signal: resource.signal() }); setExtra(old => [...old, ...result.memories]); setCursor(result.nextCursor); }, false)}>加载更多记忆</button>}
    {(error || resource.error) && <p role="alert" className="error">{error || resource.error}</p>}
  </section>;
}
