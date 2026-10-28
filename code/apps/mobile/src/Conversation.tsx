import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { groupEvents, mergeEvents, type ConversationPage, type StoredEvent, type StoredTurn } from '../../web/src/database-chat-state';
import { readChatStream } from '@workpivot/shared';
import { ApiError, MobileClient, type Task } from './client';
import { Attachments, FileLabel } from './Attachments';
import { ComposerSettings } from './ComposerSettings';
import { MemoryReview, SummaryReview } from './MemoryReview';
import { ResourceScope, type ResourceSelection } from './ResourceScope';

interface Changes { type: 'changes'; events: StoredEvent[]; nextSequence: string }
interface Permission { id: string; request: { tool: string; command?: string } }
interface State { type: 'state'; value: { tasks: Task[]; pending: Permission[] } }

export function Conversation({ client, task, onError }: { client: MobileClient; task: Task; onError: (error: unknown) => void }) {
  const [events, setEvents] = useState<StoredEvent[]>([]), [permissions, setPermissions] = useState<Permission[]>([]);
  const [before, setBefore] = useState<string | null>(null), [ready, setReady] = useState(false);
  const [details, setDetails] = useState<Record<string, { after: string; snapshot: string }>>({});
  const [status, setStatus] = useState(task.status), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [connected, setConnected] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]), [uploadBlocked, setUploadBlocked] = useState(false), [attachmentKey, setAttachmentKey] = useState(0);
  const attached = useCallback((ids: string[], blocked: boolean) => { setAttachments(ids); setUploadBlocked(blocked); }, []);
  const [resourceScope, setResourceScope] = useState<ResourceSelection | null>(null);
  const pending = useRef<{ content: string; id: string } | null>(null);
  const viewport = useRef<HTMLDivElement>(null), follow = useRef(true), loading = useRef(false);
  const anchor = useRef<number | null>(null), lifetime = useRef(new AbortController());
  const report = (reason: unknown) => { setError(reason instanceof Error ? reason.message : '操作失败'); onError(reason); };
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout>, watermark = '0', initialized = false;
    let connection: AbortController | undefined;
    const sync = async () => {
      connection = new AbortController();
      const signal = AbortSignal.any([controller.signal, connection.signal]);
      try {
        if (!initialized) {
          const page = await client.json<ConversationPage>(`/api/tasks/${task.id}/conversation`, { signal });
          if (signal.aborted) return;
          setEvents(page.turns.flatMap(turn => turn.events)); setBefore(page.nextCursor);
          setDetails(Object.fromEntries(page.turns.filter(turn => turn.hasMoreEvents).map(turn => [turn.id, { after: turn.nextEventSequence!, snapshot: page.snapshotSequence }])));
          watermark = page.snapshotSequence; initialized = true; setReady(true);
        }
        const response = await client.response(`/api/tasks/${task.id}/stream?after=${watermark}`, { signal }, 30 * 60 * 1000);
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('实时连接不可用');
        setConnected(true); setError('');
        await readChatStream<Changes | State | { type: 'unavailable'; status: number }>(response.body, event => {
          if (signal.aborted) return;
          if (event.type === 'changes') { setEvents(rows => mergeEvents(rows, event.events)); watermark = event.nextSequence; }
          else if (event.type === 'state') {
            setPermissions(event.value.pending);
            setStatus(event.value.tasks.find(row => row.id === task.id)?.status ?? 'unavailable');
          } else { throw new ApiError('会话连接已失效，请重新打开任务', event.status); }
        }, signal);
      } catch (reason) { if (!signal.aborted) { setError(reason instanceof Error ? reason.message : '连接失败'); onError(reason); } }
      finally {
        if (!controller.signal.aborted) { setConnected(false); timer = setTimeout(() => void sync(), 2000); }
      }
    };
    // 页面重新可见时断开旧订阅，由同一循环按持久化水位重新连接。
    const resume = () => { if (document.visibilityState === 'visible') connection?.abort(); };
    document.addEventListener('visibilitychange', resume); void sync();
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', resume); };
  }, [client, task.id]);
  useLayoutEffect(() => {
    const node = viewport.current; if (!node) return;
    if (anchor.current !== null) { node.scrollTop += node.scrollHeight - anchor.current; anchor.current = null; }
    else if (follow.current) node.scrollTop = node.scrollHeight;
  }, [events]);
  const older = async () => {
    if (!before || loading.current) return;
    loading.current = true;
    try {
      const page = await client.json<ConversationPage>(`/api/tasks/${task.id}/conversation?before=${encodeURIComponent(before)}`, { signal: lifetime.current.signal });
      anchor.current = viewport.current?.scrollHeight ?? null;
      setEvents(rows => mergeEvents(rows, page.turns.flatMap(turn => turn.events))); setBefore(page.nextCursor);
      setDetails(rows => ({ ...rows, ...Object.fromEntries(page.turns.filter(turn => turn.hasMoreEvents).map(turn => [turn.id, { after: turn.nextEventSequence!, snapshot: page.snapshotSequence }])) }));
    } catch (reason) { if (!lifetime.current.signal.aborted) report(reason); }
    finally { loading.current = false; }
  };
  const running = ['running', 'waiting', 'queued'].includes(status);
  const send = async () => {
    if (busy || running || uploadBlocked || !resourceScope || !ready || !message.trim()) return;
    const content = message.trim();
    const fingerprint = JSON.stringify({ content, attachments, resourceScope });
    if (!pending.current || pending.current.content !== fingerprint) pending.current = { content: fingerprint, id: crypto.randomUUID() };
    setBusy(true); setError(''); follow.current = true; setStatus('running');
    try {
      const response = await client.response(`/api/tasks/${task.id}/messages`, { method: 'POST', body: JSON.stringify({ content, attachments, resourceScope, requestId: pending.current.id }), signal: lifetime.current.signal });
      // 实际结果由持久化订阅读取，关闭发送连接不重放后台任务。
      await response.body?.cancel().catch(() => undefined); pending.current = null; setMessage(''); setAttachments([]); setUploadBlocked(false); setAttachmentKey(value => value + 1);
    } catch (reason) {
      if (!lifetime.current.signal.aborted) {
        report(reason);
        // 网络错误不等于未提交，重新读取后台状态后才开放后续操作。
        try { const value = await client.json<{ tasks: Task[] }>('/api/tasks', { signal: lifetime.current.signal }); setStatus(value.tasks.find(row => row.id === task.id)?.status ?? 'unavailable'); } catch (error) { onError(error); }
      }
    }
    finally { setBusy(false); }
  };
  const action = async (path: string, body?: unknown) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await client.json(path, { method: 'POST', body: JSON.stringify(body ?? {}), signal: lifetime.current.signal }); }
    catch (reason) { if (!lifetime.current.signal.aborted) report(reason); }
    finally { setBusy(false); }
  };
  const expand = async (event: StoredEvent) => {
    if (busy) return;
    setBusy(true);
    try {
      let offset: number | null = 0, content = '';
      do {
        const part: { content: string; nextOffset: number | null } = await client.json(`/api/tasks/${task.id}/conversation-events/${event.id}/content?offset=${offset}`, { signal: lifetime.current.signal });
        if (part.nextOffset !== null && part.nextOffset <= offset) throw new Error('内容加载未前进');
        content += part.content; offset = part.nextOffset;
      } while (offset !== null);
      setEvents(rows => rows.map(row => row.id === event.id ? { ...row, content, truncated: false } : row));
    } catch (reason) { if (!lifetime.current.signal.aborted) report(reason); }
    finally { setBusy(false); }
  };
  const expandTurn = async (id: string) => {
    const cursor = details[id]; if (!cursor || busy) return;
    setBusy(true);
    try {
      const value = await client.json<Pick<StoredTurn, 'events' | 'hasMoreEvents' | 'nextEventSequence'>>(`/api/tasks/${task.id}/conversation/${id}/events?after=${cursor.after}&snapshot=${cursor.snapshot}`, { signal: lifetime.current.signal });
      setEvents(rows => mergeEvents(rows, value.events));
      setDetails(rows => { const next = { ...rows }; if (value.hasMoreEvents) next[id] = { ...cursor, after: value.nextEventSequence! }; else delete next[id]; return next; });
    } catch (reason) { if (!lifetime.current.signal.aborted) report(reason); }
    finally { setBusy(false); }
  };
  return <>
    <div className="connection-note" role="status">{connected ? '已同步' : ready ? '正在恢复实时连接…' : '正在加载对话…'}</div>
    {['failed', 'interrupted'].includes(status) && <p className="error" role="alert">本轮执行失败或中断。请查看执行过程，调整后重新发送；系统不会自动重复执行。</p>}
    <div className="conversation" ref={viewport} onScroll={() => {
      const node = viewport.current!; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 70;
      if (node.scrollTop < 30 && !follow.current) void older();
    }}>
      {before && <button className="load-more" onClick={() => void older()}>查看更早一轮</button>}
      {ready && !events.length && <div className="empty"><h2>开始这个项目的工作</h2><p>输入你的问题，继续整理想法。</p></div>}
      {groupEvents(events).map(turn => <section key={turn.id}>{turn.events.filter(e => e.kind !== 'meta').map(event =>
        ['user', 'assistant'].includes(event.kind)
          ? <article key={event.id} className={event.kind === 'user' ? 'message user-message' : 'message'}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
            {event.truncated && <button disabled={busy} onClick={() => void expand(event)}>展开完整内容</button>}
            {event.attachments?.map(file => <FileLabel key={file.id} name={file.name ?? '附件'} />)}
          </article>
          : <details className="process" key={event.id}><summary>{event.kind === 'thinking' ? '思考过程' : '执行过程'}</summary><pre>{event.content}</pre></details>
      )}{details[turn.id] && <button disabled={busy} onClick={() => void expandTurn(turn.id)}>继续加载本轮内容</button>}</section>)}
      {permissions.map(permission => <section className="approval" key={permission.id}><strong>需要你的确认</strong><p>{permission.request.tool}</p>{permission.request.command && <pre>{permission.request.command}</pre>}
        <details><summary>操作详情</summary><pre>{JSON.stringify(permission.request, null, 2)}</pre></details>
        <button disabled={busy} onClick={() => void action(`/api/tasks/${task.id}/permissions/${permission.id}`, { decision: 'deny', scope: 'once' })}>拒绝</button>
        <button disabled={busy} onClick={() => void action(`/api/tasks/${task.id}/permissions/${permission.id}`, { decision: 'allow', scope: 'once' })}>本次允许</button></section>)}
      <MemoryReview client={client} taskId={task.id} onError={onError} />
      <SummaryReview client={client} taskId={task.id} onError={onError} running={running} />
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <ResourceScope client={client} taskId={task.id} refresh={attachmentKey} disabled={busy || running} onChange={setResourceScope} onError={onError} />
      <Attachments key={attachmentKey} client={client} taskId={task.id} disabled={busy || running} onChange={attached} onError={onError} />
      <textarea aria-label="消息" placeholder="发送消息…" rows={2} value={message} onChange={e => setMessage(e.target.value)} disabled={busy} />
      <footer><ComposerSettings client={client} disabled={busy || running} onError={onError} />{running
        ? <button type="button" disabled={busy} onClick={() => void action(`/api/tasks/${task.id}/stop`)}>停止</button>
        : <button className="send" disabled={busy || uploadBlocked || !resourceScope || !ready || !connected || !message.trim()} aria-label="发送消息"><span className="send-face" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 19V5m0 0-6 6m6-6 6 6" /></svg></span></button>}</footer>
    </form>
  </>;
}
