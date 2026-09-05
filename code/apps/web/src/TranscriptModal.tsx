import { useEffect, useState } from 'react';
import { api, type TranscriptRow } from './api';

/** T3-01/A03：转写查看器最简版——全量过程记录回看。 */
export function TranscriptModal({ taskId, onClose }: { taskId: string; onClose: () => void }): React.JSX.Element {
  const [rows, setRows] = useState<TranscriptRow[] | null>(null);

  useEffect(() => {
    void api
      .getTranscript(taskId)
      .then((r) => setRows(r.rows))
      .catch(() => setRows([]));
  }, [taskId]);

  const kindLabel = (kind: string): string => {
    switch (kind) {
      case 'user_message':
        return '用户';
      case 'assistant_message':
        return '助手';
      case 'tool_use':
        return '工具调用';
      case 'tool_result':
        return '工具结果';
      case 'meta':
        return '状态';
      default:
        return kind;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex h-[80vh] w-[760px] flex-col rounded-xl border border-neutral-700 bg-neutral-900 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">转写记录（全量，含工具调用原文）</h2>
          <button className="text-neutral-500 hover:text-neutral-200" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto font-mono text-xs">
          {rows === null && <p className="text-neutral-500">加载中…</p>}
          {rows?.length === 0 && <p className="text-neutral-500">（无记录）</p>}
          {rows?.map((row) => (
            <div key={row.ordinal} className="mb-2 border-b border-neutral-800 pb-2">
              <span className="text-neutral-500">
                #{row.ordinal} {row.ts.slice(11, 19)}
              </span>{' '}
              <span className="text-blue-400">[{kindLabel(row.kind)}]</span>{' '}
              <span className="break-all text-neutral-300">{JSON.stringify(row.payload).slice(0, 260)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
