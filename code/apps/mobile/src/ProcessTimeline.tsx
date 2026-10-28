import { useEffect, useMemo, useRef, useState } from 'react';
import { groupProcessSteps, processToolMeta, processToolText } from '../../web/src/process-steps';
import type { StoredEvent } from '../../web/src/database-chat-state';

export function ProcessTimeline({ events, live }: { events: StoredEvent[]; live: boolean }) {
  const steps = useMemo(() => groupProcessSteps(events), [events]);
  const currentStepId = steps.at(-1)?.id ?? '';
  const [open, setOpen] = useState(live);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const previousLive = useRef(live), viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live) {
      setOpen(true);
      setExpanded(currentStepId ? new Set([currentStepId]) : new Set());
    } else if (previousLive.current) {
      setOpen(false);
      setExpanded(new Set());
    }
    previousLive.current = live;
  }, [live, currentStepId]);
  useEffect(() => {
    if (live && open && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [events, live, open]);
  if (!steps.length) return null;
  return <section className="process-timeline" aria-label="思考与执行过程">
    <button type="button" className="process-timeline-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span>{open ? '收起' : '展开'}思考与执行过程</span>
      <small>{steps.length} 个步骤</small>
      {live && <span className="process-live"><i/>运行中</span>}
    </button>
    {open && <div className="process-timeline-body" ref={viewport}>
      {steps.map((step, index) => {
        const isOpen = expanded.has(step.id), current = live && step.id === currentStepId;
        const toolCount = step.events.filter(event => event.kind === 'tool_use').length;
        return <article className={'process-step ' + (current ? 'current' : '')} key={step.id}>
          <button type="button" className="process-step-toggle" aria-expanded={isOpen} onClick={() => setExpanded(rows => { const next = new Set(rows); if (next.has(step.id)) next.delete(step.id); else next.add(step.id); return next; })}>
            <span>步骤 {index + 1}</span><small>{current ? '进行中' : '已完成'}</small>
            <em>{toolCount ? `${toolCount} 个工具` : '思考'}</em>
          </button>
          {isOpen && <div className="process-step-body">
            {step.events.map(event => {
              const meta = event.kind.startsWith('tool_') ? processToolMeta(event) : null;
              return <div className="process-event" key={event.id}>
                <strong>{event.kind === 'thinking' ? '思考' : event.kind === 'tool_result' ? '工具完成' : '调用工具'}{meta ? ` · ${meta.displayName}` : ''}</strong>
                {event.kind === 'thinking'
                  ? <pre>{event.content}{current && <span className="process-cursor"/>}</pre>
                  : <pre>{processToolText(event)}</pre>}
              </div>;
            })}
          </div>}
        </article>;
      })}
    </div>}
  </section>;
}
