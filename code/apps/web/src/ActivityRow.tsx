import { Icon } from './Icon';
import { useState } from 'react';

/** Compact disclosure inspired by DeepSeek Harness's reasoning/tool rows. */
export function ActivityRow({ title, summary, input, output, running, failed, status, durationMs }: {
  title: string; summary: string; input?: string; output?: string; running?: boolean; failed?: boolean; status?: string; durationMs?: number;
}) {
  const [open, setOpen] = useState(false);
  return <div className="mb-2 max-w-[90%] text-xs text-neutral-400">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={`flex w-full items-center gap-2 rounded px-1 py-1.5 text-left hover:bg-neutral-800/50 ${failed ? 'text-red-400' : ''}`}>
      <span aria-hidden className="w-3 shrink-0"><Icon name={open ? 'down' : 'right'} /></span>
      <span className="max-w-[50%] shrink-0 truncate whitespace-nowrap" title={title}>{title}</span>
      {status && <span className="shrink-0">{status}</span>}
      {durationMs !== undefined && <span className="shrink-0 text-neutral-500" title="执行耗时，不含授权等待">{(durationMs / 1000).toFixed(1)} 秒</span>}
      {running && <span aria-label="进行中" className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue-400" />}
      {summary && <><span aria-hidden>·</span><span className="min-w-0 truncate text-neutral-500">{summary}</span></>}
    </button>
    {open && <div className="ml-2 max-h-72 overflow-auto border-l border-neutral-700 py-2 pl-4">
      {input !== undefined && <><div className="mb-1 text-neutral-500">输入</div><pre className="mb-3 whitespace-pre-wrap break-words font-mono">{input}</pre></>}
      {output !== undefined && <><div className="mb-1 text-neutral-500">{input !== undefined ? '输出' : '详情'}</div><div className="whitespace-pre-wrap break-words leading-relaxed">{output}</div></>}
    </div>}
  </div>;
}
