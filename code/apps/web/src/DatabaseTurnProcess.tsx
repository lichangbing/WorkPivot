import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { StoredEvent } from './database-chat-state';
import { Icon } from './Icon';
import { retrievalStatus } from './chat-content';
import { groupProcessSteps, processToolMeta, processToolText } from './process-steps';

export const isProcessEvent = (event: StoredEvent) => event.kind === 'thinking' || event.kind.startsWith('tool_');

/** run_code 的结果是 {output, artifacts:[{id,name}]}；其余工具结果仍按纯文本展示。 */
function codeResult(content: string): { output: string; artifacts: Array<{ name?: string }> } | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value = JSON.parse(trimmed) as { output?: unknown; artifacts?: unknown };
    if (typeof value.output !== 'string' || !Array.isArray(value.artifacts)) return null;
    return { output: value.output, artifacts: value.artifacts as Array<{ name?: string }> };
  } catch {
    return null;
  }
}

/** 过程区独立滚动；接近底部时依次补齐长记录与后续分页。 */
export function DatabaseTurnProcess({ events, cursor, live, onMore, onContent, onInteract }: {
  events: StoredEvent[]; cursor?: string; live: boolean; onInteract: () => void;
  onMore: () => Promise<void>; onContent: (event: StoredEvent) => Promise<void>;
}) {
  const [open, setOpen] = useState(false), regionId = useId();
  const viewport = useRef<HTMLDivElement>(null), sentinel = useRef<HTMLDivElement>(null);
  const previousLive = useRef(live);
  const inflight = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const steps = useMemo(() => groupProcessSteps(events), [events]);
  const currentStepId = steps.at(-1)?.id ?? '';
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(() => new Set());
  const truncated = events.find(event => event.truncated);
  useEffect(() => {
    if (live) {
      setOpen(true);
      setExpandedSteps(currentStepId ? new Set([currentStepId]) : new Set());
    } else if (previousLive.current) {
      // 本轮结束后合并全部步骤，保留可点击的历史摘要。
      setOpen(false);
      setExpandedSteps(new Set());
    }
    previousLive.current = live;
  }, [live, currentStepId]);
  useEffect(() => {
    if (!live || !open || !viewport.current) return;
    viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [events, live, open]);
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
    <button type="button" aria-expanded={open} aria-controls={regionId} className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-400 hover:text-neutral-100 ${open ? 'border-b border-neutral-800' : ''}`} onClick={() => { onInteract(); setOpen(value => !value); }}>
      <Icon name={open ? 'down' : 'right'} size={16}/>
      <span>思考与执行过程</span>
      {steps.length > 0 && <span className="text-[11px] text-neutral-500">{steps.length} 个步骤</span>}
      {live && <span className="ml-auto flex items-center gap-1.5 text-[11px] text-emerald-300"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"/>运行中</span>}
      {error && <span className="text-xs text-red-400">（加载失败，展开重试）</span>}
    </button>
    <div hidden={!open} id={regionId} ref={viewport} role="region" aria-label="思考与执行过程" tabIndex={0} className="conversation-process-scroll h-72 overflow-y-auto overscroll-contain px-2 py-2" onFocus={onInteract} onPointerDown={onInteract} onWheel={event => { event.stopPropagation(); onInteract(); }}>
      <ol className="space-y-2">
        {steps.map((step, index) => {
          const expanded = expandedSteps.has(step.id);
          const thinkingChars = step.events.filter(event => event.kind === 'thinking').reduce((sum, event) => sum + event.content.length, 0);
          const toolCount = step.events.filter(event => event.kind === 'tool_use').length;
          const isCurrent = live && step.id === currentStepId;
          const bodyId = `${regionId}-step-${index}`;
          return <li key={step.id} className={'overflow-hidden rounded-lg border ' + (isCurrent ? 'border-emerald-900/70 bg-neutral-950/60' : 'border-neutral-800 bg-neutral-950/20')}>
            <button type="button" aria-expanded={expanded} aria-controls={bodyId} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200" onClick={() => setExpandedSteps(rows => { const next = new Set(rows); if (next.has(step.id)) next.delete(step.id); else next.add(step.id); return next; })}>
              <Icon name={expanded ? 'down' : 'right'} size={14}/>
              <span className="font-medium text-neutral-300">步骤 {index + 1}</span>
              <span className={isCurrent ? 'text-emerald-300' : 'text-neutral-500'}>{isCurrent ? '进行中' : '已完成'}</span>
              <span className="ml-auto text-neutral-500">{toolCount ? `${toolCount} 个工具` : `${thinkingChars.toLocaleString('zh-CN')} 字`}</span>
            </button>
            <div hidden={!expanded} id={bodyId} className="border-t border-neutral-800/80 px-3 py-2">
              {step.events.map(event => {
                const meta = event.kind.startsWith('tool_') ? processToolMeta(event) : null;
                const parsed = event.kind === 'tool_result' ? codeResult(event.content) : null;
                return <div key={event.id} className="mb-3 min-w-0 last:mb-0">
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-neutral-500">
                    {event.kind === 'thinking'
                      ? <><span className="h-1.5 w-1.5 rounded-full bg-sky-400/80"/><span>思考</span>{isCurrent && <span className="animate-pulse text-sky-300/70">正在输出</span>}</>
                      : <><span className={'h-1.5 w-1.5 rounded-full ' + (event.kind === 'tool_result' ? 'bg-emerald-400/80' : 'bg-amber-400/80')}/><span>{event.kind === 'tool_result' ? '工具完成' : '调用工具'}</span><span className="text-neutral-400">{meta?.displayName}</span>{meta?.durationMs !== undefined && <span>{meta.durationMs}ms</span>}</>}
                  </div>
                  {event.kind === 'thinking'
                    ? <pre className="whitespace-pre-wrap text-xs leading-5 text-neutral-300 [overflow-wrap:anywhere]">{event.content}{isCurrent && <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-sky-300/70 align-middle"/>}</pre>
                    : parsed
                      ? <><pre className="whitespace-pre-wrap text-xs text-neutral-400 [overflow-wrap:anywhere]">{parsed.output || '（无输出）'}</pre>{parsed.artifacts.length > 0 && <ul className="mt-1 space-y-0.5 text-xs text-neutral-400">{parsed.artifacts.map((artifact, artifactIndex) => <li key={`${artifact.name ?? 'artifact'}-${artifactIndex}`}>产物：{artifact.name ?? `#${artifactIndex + 1}`}</li>)}</ul>}</>
                      : <pre className="whitespace-pre-wrap text-xs leading-5 text-neutral-400 [overflow-wrap:anywhere]">{processToolText(event)}</pre>}
                  {event.kind === 'tool_result' && retrievalStatus(event.content) && <p className="my-1 text-xs text-neutral-400">{retrievalStatus(event.content)}</p>}
                </div>;
              })}
            </div>
          </li>;
        })}
      </ol>
      <div ref={sentinel} className="min-h-6 text-xs text-neutral-500" role="status">{busy ? '正在加载过程…' : error ? '' : truncated || cursor ? '向下滚动加载后续过程' : '已显示全部已记录过程'}</div>
      {error && <div role="alert" className="text-xs text-red-400">{error}<button className="ml-2 underline" onClick={() => setError('')}>重试加载过程</button></div>}
    </div>
  </div>;
}
