/**
 * M1-11：记忆查看/编辑弹窗（设置面板「管理记忆」打开，批次 1 遗留 UI）。
 * 三个分区：手写区 MEMORY.md（可编辑保存）/ 条目区 entries（逐条删除）/ 项目记忆（只读，随当前任务）。
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

interface MemoryData {
  handbook: string;
  entries: Array<{ id: string; content: string; createdAt?: string }>;
  project: string;
  enabled: boolean;
}

type Tab = 'handbook' | 'entries' | 'project';

const TAB_LABELS: Array<[Tab, string]> = [
  ['handbook', '手写区'],
  ['entries', '条目区'],
  ['project', '项目记忆'],
];

export function MemoryModal({ taskId, onClose }: { taskId?: string; onClose: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('handbook');
  const [data, setData] = useState<MemoryData | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const view = await api.memoryView(taskId);
      setData(view);
      setDraft(view.handbook);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveHandbook = async (): Promise<void> => {
    setError(null);
    if (draft.length > 20_000) {
      setError('手写区超过 20000 字符上限');
      return;
    }
    setBusy(true);
    try {
      await api.memoryEditHandbook(draft);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const deleteEntry = async (id: string): Promise<void> => {
    setError(null);
    try {
      await api.memoryDeleteEntry(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const dirty = data !== null && draft !== data.handbook;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex h-[560px] w-[640px] max-w-full flex-col rounded-xl border border-neutral-700 bg-neutral-900">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-semibold">记忆管理</h2>
          <button className="text-neutral-500 hover:text-neutral-200" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="flex gap-1 border-b border-neutral-800 px-3 py-2">
          {TAB_LABELS.map(([key, label]) => (
            <button
              key={key}
              className={`rounded px-3 py-1 text-xs ${tab === key ? 'bg-neutral-800 font-medium text-white' : 'text-neutral-400 hover:bg-neutral-800'}`}
              onClick={() => setTab(key)}
            >
              {label}
              {key === 'entries' && data ? `（${data.entries.length}）` : ''}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
          {error && <p className="mb-2 text-xs text-red-400">{error}</p>}

          {data === null && !error && <p className="text-xs text-neutral-500">加载中…</p>}

          {data !== null && tab === 'handbook' && (
            <div className="flex h-full flex-col">
              <p className="mb-2 text-xs text-neutral-500">
                手写区（MEMORY.md）：全部内容注入每轮对话的 system 提示。可直接编辑，保存后下一轮生效。
              </p>
              <textarea
                className="min-h-0 w-full flex-1 resize-none rounded border border-neutral-700 bg-neutral-800 p-2 font-mono text-xs text-neutral-100 outline-none focus:border-neutral-500"
                placeholder="# 我的偏好&#10;- 输出用中文&#10;- 周报按固定模板"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  className="rounded bg-blue-600 px-3 py-1.5 text-xs hover:bg-blue-500 disabled:opacity-40"
                  disabled={busy || !dirty}
                  onClick={() => void saveHandbook()}
                >
                  {busy ? '保存中…' : '保存'}
                </button>
                {savedFlash && <span className="text-xs text-emerald-400">已保存</span>}
                <span className="ml-auto text-xs text-neutral-600">{draft.length} / 20000 字符</span>
              </div>
            </div>
          )}

          {data !== null && tab === 'entries' && (
            <div>
              <p className="mb-2 text-xs text-neutral-500">
                条目区：agent 在对话中经 remember 工具静默记录的信息（上限 200 条，超量丢最旧）。删除后不再注入。
              </p>
              {data.entries.length === 0 && <p className="mt-4 text-center text-xs text-neutral-600">暂无条目</p>}
              <div className="space-y-1">
                {[...data.entries].reverse().map((e) => (
                  <div key={e.id} className="flex items-start justify-between gap-2 rounded bg-neutral-800 px-3 py-2 text-xs">
                    <span className="min-w-0">
                      {e.content}
                      {e.createdAt && <span className="ml-2 text-neutral-600">{e.createdAt.slice(0, 10)}</span>}
                    </span>
                    <button className="shrink-0 rounded bg-neutral-700 px-2 py-0.5 hover:bg-red-900" title="删除" onClick={() => void deleteEntry(e.id)}>
                      删除
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data !== null && tab === 'project' && (
            <div>
              <p className="mb-2 text-xs text-neutral-500">
                项目记忆：当前任务工作目录下 .workpivot/memory/MEMORY.md，同目录任务共享，随项目目录走。
                {taskId ? '' : '（未选择任务，仅显示全局视图）'}
              </p>
              <pre className="max-h-[380px] overflow-auto whitespace-pre-wrap rounded border border-neutral-700 bg-neutral-800 p-2 font-mono text-xs text-neutral-100">
                {data.project.trim() === '' ? '（空）' : data.project}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
