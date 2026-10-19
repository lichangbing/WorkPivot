import { useEffect, useId, useRef, useState } from 'react';
import type { StoredEvent } from './database-chat-state';
import { Icon } from './Icon';
import { retrievalStatus } from './chat-content';

export const isProcessEvent = (event: StoredEvent) => event.kind === 'thinking' || event.kind.startsWith('tool_');

/** 过程区独立滚动；接近底部时依次补齐长记录与后续分页。 */
export function DatabaseTurnProcess({ events, cursor, onMore, onContent, onInteract }: {
  events: StoredEvent[]; cursor?: string; onInteract: () => void;
  onMore: () => Promise<void>; onContent: (event: StoredEvent) => Promise<void>;
}) {
  const [open, setOpen] = useState(false), regionId = useId();
  const viewport = useRef<HTMLDivElement>(null), sentinel = useRef<HTMLDivElement>(null);
  const inflight = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const truncated = events.find(event => event.truncated);
  useEffect(() => {
    if (busy || error || (!cursor && (!open || !truncated))) return;
    const load = () => {
      if (inflight.current) return;
      inflight.current = true; setBusy(true);
      void (cursor ? onMore() : onContent(truncated!)).catch(reason => {
        if (mounted.current) setError(reason instanceof Error ? reason.message : '过程加载失败');
      }).finally(() => {
        inflight.current = false;
        if (mounted.current) setBusy(false);
      });
    };
    // 折叠也补齐事件分页，防止分页末尾的正式答复被一起隐藏。长过程正文仅在展开滚动时加载。
    if (cursor) { load(); return; }
    if (!viewport.current || !sentinel.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) load();
    }, { root: viewport.current, rootMargin: '0px 0px 80px 0px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [events, cursor, truncated, onMore, onContent, busy, error, open]);
  return <div className="mb-3 rounded-lg border border-neutral-800">
    <button type="button" aria-expanded={open} aria-controls={regionId} className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-400 hover:text-neutral-100 ${open ? 'border-b border-neutral-800' : ''}`} onClick={() => { onInteract(); setOpen(value => !value); }}><Icon name={open ? 'down' : 'right'} size={16}/>思考与执行过程{error && <span className="text-xs text-red-400">（加载失败，展开重试）</span>}</button>
    <div hidden={!open} id={regionId} ref={viewport} role="region" aria-label="思考与执行过程" tabIndex={0} className="conversation-process-scroll h-64 overflow-y-auto overscroll-contain px-3 py-2" onFocus={onInteract} onPointerDown={onInteract} onWheel={event => { event.stopPropagation(); onInteract(); }}>
      {events.map(event => <div key={event.id} className="mb-4 min-w-0">
        <div className="mb-1 text-xs text-neutral-400">{event.kind === 'thinking' ? '思考' : event.kind === 'tool_result' ? '工具结果' : '工具调用'}</div>
        <pre className="whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">{event.content}</pre>
        {event.kind === 'tool_result' && retrievalStatus(event.content) && <p className="my-2 text-xs text-neutral-400">{retrievalStatus(event.content)}</p>}
      </div>)}
      <div ref={sentinel} className="min-h-6 text-xs text-neutral-500" role="status">{busy ? '正在加载过程…' : error ? '' : truncated || cursor ? '向下滚动加载后续过程' : '已显示全部已记录过程'}</div>
      {error && <div role="alert" className="text-xs text-red-400">{error}<button className="ml-2 underline" onClick={() => setError('')}>重试加载过程</button></div>}
    </div>
  </div>;
}
