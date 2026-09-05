import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, streamChat, type ChatEvent, type HistoryMessage, type PublicProvider, type Task } from './api';
import { ProviderModal } from './ProviderModal';

interface ChatItem {
  kind: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
}

export default function App(): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [rightPanel, setRightPanel] = useState<{ directory: string; files: string[] } | null>(null);
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  const refreshTasks = useCallback(async (): Promise<void> => {
    setTasks((await api.listTasks()).tasks);
  }, []);

  const refreshProviders = useCallback(async (): Promise<void> => {
    setProviders((await api.listProviders()).providers);
  }, []);

  const openTask = useCallback(async (task: Task): Promise<void> => {
    setActiveTask(task);
    const detail = await api.getTask(task.id);
    setChat(detail.history.map((m: HistoryMessage) => ({ kind: m.role, text: m.content })));
    setRightPanel(await api.getFiles(task.id));
  }, []);

  useEffect(() => {
    void refreshTasks();
    void refreshProviders();
    void api
      .health()
      .then(() => setServerOk(true))
      .catch(() => setServerOk(false));
  }, [refreshTasks, refreshProviders]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat]);

  const send = useCallback(async (): Promise<void> => {
    const content = input.trim();
    if (content === '' || !activeTask || streaming) return;
    setInput('');
    setStreaming(true);
    setChat((prev) => [...prev, { kind: 'user', text: content }, { kind: 'assistant', text: '' }]);
    try {
      await streamChat(activeTask.id, content, (event: ChatEvent) => {
        setChat((prev) => {
          const next = [...prev];
          const last = next[next.length - 1] ?? { kind: 'assistant' as const, text: '' };
          if (event.type === 'assistant_delta') {
            next[next.length - 1] = { ...last, text: last.text + event.text };
          } else if (event.type === 'tool_use') {
            next.push({ kind: 'tool', text: `🔧 ${event.toolName} ${JSON.stringify(event.args ?? {})}` });
          } else if (event.type === 'tool_result') {
            next.push({ kind: 'tool', text: `${event.ok ? '✓' : '✗'} ${event.toolName}: ${event.message ?? ''}` });
          } else if (event.type === 'error') {
            next.push({ kind: 'error', text: `出错：${event.message}` });
          } else if (event.type === 'done') {
            void refreshTasks();
            void api.getFiles(activeTask.id).then(setRightPanel);
          }
          return next;
        });
      });
    } catch (err) {
      setChat((prev) => [...prev, { kind: 'error', text: `出错：${err instanceof Error ? err.message : String(err)}` }]);
    } finally {
      setStreaming(false);
      void refreshTasks();
    }
  }, [input, activeTask, streaming, refreshTasks]);

  const activeProvider = providers.find((p) => p.active);

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      {serverOk === false && (
        <div className="bg-red-900/80 px-4 py-1.5 text-xs text-red-100">
          ⚠ 服务层未连接：请确认桌面应用已启动（或单独启动服务层），然后刷新本页。
        </div>
      )}
      <div className="flex min-h-0 flex-1">
      {/* 左栏：任务列表 */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-800">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-semibold text-neutral-300">任务</span>
          <button
            className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
            onClick={() => {
              const name = window.prompt('任务名称：');
              if (name !== null && name.trim() !== '') {
                void api.createTask(name.trim()).then(async ({ task }) => {
                  await refreshTasks();
                  await openTask(task);
                });
              }
            }}
          >
            ＋ 新建
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {tasks.length === 0 && <p className="px-4 py-2 text-xs text-neutral-500">尚无任务，点击「＋ 新建」创建</p>}
          {tasks.map((task) => (
            <button
              key={task.id}
              className={`block w-full px-4 py-2 text-left text-sm hover:bg-neutral-900 ${
                activeTask?.id === task.id ? 'bg-neutral-900' : ''
              }`}
              onClick={() => void openTask(task)}
            >
              <span
                className={`mr-2 inline-block h-2 w-2 rounded-full ${
                  task.status === 'running'
                    ? 'animate-pulse bg-amber-400'
                    : task.status === 'idle'
                      ? 'bg-emerald-500'
                      : 'bg-red-500'
                }`}
              />
              {task.name}
            </button>
          ))}
        </div>
      </aside>

      {/* 中栏：对话流 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
          <span className="text-sm text-neutral-400">{activeTask ? activeTask.name : '未选择任务'}</span>
          <div className="flex items-center gap-2 text-xs">
            <span className={activeProvider ? 'text-neutral-500' : 'font-medium text-red-400'}>
              {activeProvider ? `模型：${activeProvider.name} / ${activeProvider.modelId}` : '⚠ 尚未配置模型——点右侧「模型设置」'}
            </span>
            <button
              className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700"
              onClick={() => setProviderModalOpen(true)}
            >
              模型设置
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {chat.length === 0 && (
            <p className="mt-10 text-center text-sm text-neutral-500">选择或新建一个任务，发送第一条消息开始工作</p>
          )}
          {chat.map((item, i) =>
            item.kind === 'user' ? (
              <div key={i} className="mb-3 flex justify-end">
                <div className="max-w-[75%] whitespace-pre-wrap rounded-lg bg-neutral-800 px-3 py-2 text-sm">
                  {item.text}
                </div>
              </div>
            ) : item.kind === 'assistant' ? (
              <div key={i} className="prose prose-invert prose-sm mb-3 max-w-[85%] text-sm leading-relaxed">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text || '…'}</ReactMarkdown>
              </div>
            ) : (
              <div
                key={i}
                className={`mb-2 font-mono text-xs ${item.kind === 'error' ? 'text-red-400' : 'text-neutral-500'}`}
              >
                {item.text}
              </div>
            ),
          )}
          <div ref={chatBottomRef} />
        </div>

        <div className="border-t border-neutral-800 p-3">
          <div className="flex items-end gap-2">
            <textarea
              className="max-h-40 min-h-[44px] flex-1 resize-y rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
              placeholder={activeTask ? '输入消息，Enter 发送' : '请先新建/选择任务'}
              value={input}
              disabled={!activeTask || streaming}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {streaming ? (
              <button
                className="rounded-lg bg-red-900 px-4 py-2 text-sm hover:bg-red-800"
                onClick={() => {
                  if (activeTask) void api.stop(activeTask.id);
                }}
              >
                停止
              </button>
            ) : (
              <button
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-500 disabled:opacity-40"
                disabled={!activeTask || streaming || input.trim() === ''}
                onClick={() => void send()}
              >
                发送
              </button>
            )}
          </div>
        </div>
      </main>

      {/* 右栏：成果区（W1 占位：目录+文件清单） */}
      <aside className="flex w-72 shrink-0 flex-col border-l border-neutral-800">
        <div className="px-4 py-3 text-sm font-semibold text-neutral-300">成果区</div>
        {rightPanel ? (
          <div className="flex-1 overflow-y-auto px-4 text-xs">
            <p className="mb-2 break-all text-neutral-500">{rightPanel.directory}</p>
            {rightPanel.files.length === 0 && <p className="text-neutral-600">（空）</p>}
            {rightPanel.files.map((f) => (
              <p key={f} className="mb-1 break-all text-neutral-300">
                📄 {f}
              </p>
            ))}
          </div>
        ) : (
          <p className="px-4 text-xs text-neutral-600">选择任务后展示产物</p>
        )}
      </aside>
      </div>

      {providerModalOpen && (
        <ProviderModal
          providers={providers}
          onClose={() => setProviderModalOpen(false)}
          onSaved={() => {
            void refreshProviders();
          }}
        />
      )}
    </div>
  );
}
