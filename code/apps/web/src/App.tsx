/**
 * WorkPivot 主界面：三栏布局（左任务列表/中对话流/右成果区）。
 * 职责：登录门与会话、任务创建与切换、SSE 流式对话渲染、权限/记忆确认卡、
 *       模型与用户管理入口、全局错误提示。
 * 纪律（A01.3）：只经 localhost HTTP/SSE 与服务层通信，禁止 import 服务层/内核。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  api,
  clearToken,
  getToken,
  streamChat,
  type ChatEvent,
  type HistoryMessage,
  type PublicProvider,
  type PublicUser,
  type Task,
  type Tier,
} from './api';
import { LoginView } from './LoginView';
import { ProviderModal } from './ProviderModal';
import { TranscriptModal } from './TranscriptModal';
import { UsersModal } from './UsersModal';

interface ChatItem {
  kind: 'user' | 'assistant' | 'tool' | 'error' | 'permission' | 'done' | 'gate' | 'memory';
  text: string;
  request?: {
    id: string;
    tool: string;
    reason: string;
    command?: string;
    paths: Array<{ path: string; mode: string }>;
    hasPaths: boolean;
    scope: string;
  };
}

/** F04 断点续跑的固定指令（用户点「继续任务」时发送） */
const RESUME_MESSAGE =
  '请从断点继续之前的任务:先读取 PROGRESS.md(如存在),不重做已完成的部分,继续完成剩余工作。';

export default function App(): React.JSX.Element {
  const [authState, setAuthState] = useState<'loading' | 'guest' | 'authed'>('loading');
  const [currentUser, setCurrentUser] = useState<PublicUser | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [usersModalOpen, setUsersModalOpen] = useState(false);
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [tier, setTier] = useState<Tier>('workdir');
  const [tierLabels, setTierLabels] = useState<Record<string, string>>({});
  const [rightPanel, setRightPanel] = useState<{ directory: string; files: string[] } | null>(null);
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [newTaskName, setNewTaskName] = useState('');
  const [newTaskDir, setNewTaskDir] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  /** B02 版本链：按 `{标题} v{X.Y} …` 分组，最新版本在前 */
  const renderVersionChain = (files: string[]): React.JSX.Element[] => {
    const versioned: Array<{ title: string; version: string; file: string }> = [];
    const plain: string[] = [];
    const versionRe = /^(.+) v(\d+\.\d+)( \d{4}-\d{2}-\d{2})?\.([^.]+)$/;
    for (const file of files) {
      const m = versionRe.exec(file);
      if (m) versioned.push({ title: m[1] ?? '', version: m[2] ?? '', file });
      else plain.push(file);
    }
    const groups = new Map<string, Array<{ version: string; file: string }>>();
    for (const v of versioned) {
      const list = groups.get(v.title) ?? [];
      list.push({ version: v.version, file: v.file });
      groups.set(v.title, list);
    }
    const nodes: React.JSX.Element[] = [];
    for (const [title, list] of groups) {
      const sorted = [...list].sort((a, b) => (a.version < b.version ? 1 : -1));
      nodes.push(
        <div key={title} className="mb-3">
          <p className="mb-1 font-medium text-neutral-200">📄 {title}</p>
          {sorted.map((v) => (
            <p key={v.file} className="mb-0.5 break-all pl-3 text-neutral-400">
              v{v.version} —— {v.file}
            </p>
          ))}
        </div>,
      );
    }
    for (const f of plain) {
      nodes.push(
        <p key={f} className="mb-1 break-all text-neutral-300">
          📄 {f}
        </p>,
      );
    }
    return nodes;
  };

  const showToast = useCallback((text: string): void => {
    setToast(text);
    setTimeout(() => setToast(null), 5000);
  }, []);

  const refreshAuth = useCallback(async (): Promise<void> => {
    if (getToken() === null) {
      setAuthState('guest');
      return;
    }
    try {
      const state = await api.authState();
      if (state.authenticated && state.user) {
        setCurrentUser(state.user);
        setAuthState('authed');
      } else {
        clearToken();
        setNeedsSetup(state.needsSetup);
        setAuthState('guest');
      }
    } catch {
      setServerOk(false);
      setAuthState('guest');
    }
  }, []);

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

  const loadWorkspaceData = useCallback(async (): Promise<void> => {
    await refreshTasks();
    await refreshProviders();
    const settings = await api.getSettings();
    setTier(settings.permissionTier);
    setTierLabels(settings.tierLabels);
    setServerOk(true);
  }, [refreshTasks, refreshProviders]);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  useEffect(() => {
    if (authState !== 'authed') return;
    void loadWorkspaceData().catch((err: unknown) => {
      showToast(err instanceof Error ? err.message : String(err));
    });
    // 渲染层全局错误提示（不再静默）
    const onError = (event: ErrorEvent): void => showToast(`页面错误：${event.message}`);
    const onRejection = (event: PromiseRejectionEvent): void => showToast(`未处理异常：${String(event.reason)}`);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [authState, loadWorkspaceData, showToast]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat]);

  const changeTier = useCallback(
    async (next: Tier): Promise<void> => {
      try {
        const result = await api.setTier(next);
        setTier(result.permissionTier);
        showToast(`权限档位已切换：${tierLabels[next] ?? next}`);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
      }
    },
    [tierLabels, showToast],
  );

  const createTask = useCallback(async (): Promise<void> => {
    const name = newTaskName.trim();
    if (name === '') {
      setCreateError('任务名称必填');
      return;
    }
    setCreateError(null);
    try {
      const { task } = await api.createTask(name, newTaskDir.trim() || undefined);
      setCreatingTask(false);
      setNewTaskName('');
      setNewTaskDir('');
      await refreshTasks();
      await openTask(task);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    }
  }, [newTaskName, newTaskDir, refreshTasks, openTask]);

  const send = useCallback(async (override?: string): Promise<void> => {
    const content = (override ?? input).trim();
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
          } else if (event.type === 'permission_request') {
            next.push({
              kind: 'permission',
              text: event.reason,
              request: {
                id: event.id,
                tool: event.tool,
                reason: event.reason,
                command: event.command,
                paths: event.paths,
                hasPaths: event.paths.length > 0,
                scope: event.scope,
              },
            });
          } else if (event.type === 'memory_confirm') {
            next.push({
              kind: 'memory',
              text: `🧠 记忆写入确认：${event.content}`,
              request: { id: event.id, tool: 'memory_promote', reason: event.content, paths: [], hasPaths: false, scope: 'once' },
            });
          } else if (event.type === 'gate_reject') {
            next.push({
              kind: 'gate',
              text: `⚠ 成果核验未通过——缺少文件:${event.missing.join('、')}${event.final ? '(已达重试上限,请人工确认)' : ',已打回重做'}`,
            });
          } else if (event.type === 'error') {
            next.push({ kind: 'error', text: `出错：${event.message}` });
          } else if (event.type === 'done') {
            next.push({
              kind: 'done',
              text:
                event.stopReason === 'completed'
                  ? `✅ 任务完成（${event.steps} 步）`
                  : `⚠ 任务结束（${event.stopReason}，${event.steps} 步）`,
            });
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
  }, [input, activeTask, streaming, refreshTasks, showToast]);

  const decide = useCallback(
    async (item: ChatItem, decision: 'allow' | 'deny' | 'session' | 'forever'): Promise<void> => {
      if (!activeTask || !item.request) return;
      try {
        if (item.kind === 'memory') {
          await api.confirmMemory(activeTask.id, item.request.id, decision !== 'deny');
          setChat((prev) =>
            prev.map((c) =>
              c === item
                ? { ...c, kind: 'tool', text: `${decision === 'deny' ? '⛔ 已拒绝写入' : '🧠 已写入长期记忆'}：${item.request!.reason}` }
                : c,
            ),
          );
          return;
        }
        await api.decidePermission(activeTask.id, item.request.id, decision);
        setChat((prev) =>
          prev.map((c) =>
            c === item
              ? {
                  ...c,
                  kind: 'tool',
                  text: `${decision === 'deny' ? '⛔ 已拒绝' : '✅ 已授权（' + decision + '）'}：${item.request!.tool}`,
                }
              : c,
          ),
        );
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
      }
    },
    [activeTask, showToast],
  );

  const logout = useCallback(async (): Promise<void> => {
    await api.logout().catch(() => undefined);
    clearToken();
    setAuthState('guest');
    setCurrentUser(null);
  }, []);

  if (authState === 'loading') {
    return <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-500">加载中…</div>;
  }
  if (authState === 'guest') {
    return <LoginView needsSetup={needsSetup} onAuthed={() => void refreshAuth()} />;
  }

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
              onClick={() => setCreatingTask((v) => !v)}
            >
              ＋ 新建
            </button>
          </div>
          {creatingTask && (
            <div className="space-y-2 border-y border-neutral-800 px-3 py-2">
              <input
                autoFocus
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm outline-none focus:border-neutral-500"
                placeholder="任务名称（必填）"
                value={newTaskName}
                onChange={(e) => setNewTaskName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createTask();
                  if (e.key === 'Escape') setCreatingTask(false);
                }}
              />
              <input
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs outline-none focus:border-neutral-500"
                placeholder="工作目录（留空则自动创建）"
                value={newTaskDir}
                onChange={(e) => setNewTaskDir(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createTask();
                }}
              />
              {createError && <p className="text-xs text-red-400">{createError}</p>}
              <div className="flex gap-2">
                <button
                  className="rounded bg-blue-600 px-2 py-1 text-xs hover:bg-blue-500 disabled:opacity-40"
                  disabled={newTaskName.trim() === ''}
                  onClick={() => void createTask()}
                >
                  创建
                </button>
                <button
                  className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
                  onClick={() => setCreatingTask(false)}
                >
                  取消
                </button>
              </div>
            </div>
          )}
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
            <div className="flex items-center gap-2">
              <span className="text-sm text-neutral-400">{activeTask ? activeTask.name : '未选择任务'}</span>
              {activeTask?.status === 'interrupted' && (
                <button
                  className="rounded bg-amber-700 px-2 py-1 text-xs hover:bg-amber-600"
                  onClick={() => {
                    setInput(RESUME_MESSAGE);
                    void send(RESUME_MESSAGE);
                  }}
                >
                  ▶ 继续任务
                </button>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1 text-neutral-500">
                权限档位
                <select
                  className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1"
                  value={tier}
                  onChange={(e) => void changeTier(e.target.value as Tier)}
                >
                  {Object.entries(tierLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <span className={activeProvider ? 'text-neutral-500' : 'font-medium text-red-400'}>
                {activeProvider ? `模型：${activeProvider.name} / ${activeProvider.modelId}` : '⚠ 尚未配置模型——点右侧「模型设置」'}
              </span>
              <button
                className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700"
                onClick={() => setProviderModalOpen(true)}
              >
                模型设置
              </button>
              {currentUser?.role === 'admin' && (
                <button
                  className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700"
                  onClick={() => setUsersModalOpen(true)}
                >
                  用户管理
                </button>
              )}
              <span className="text-neutral-500">{currentUser?.username}</span>
              <button className="text-neutral-500 hover:text-neutral-200" onClick={() => void logout()}>
                退出
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
              ) : item.kind === 'permission' && item.request ? (
                <div key={i} className="mb-3 rounded-lg border border-amber-600/60 bg-amber-950/40 p-3 text-sm">
                  <p className="mb-1 font-medium text-amber-300">🔐 授权请求：{item.request.reason}</p>
                  {item.request.command && (
                    <p className="mb-1 font-mono text-xs text-neutral-300">$ {item.request.command}</p>
                  )}
                  {item.request.paths.length > 0 && (
                    <p className="mb-2 font-mono text-xs text-neutral-400">
                      路径：{item.request.paths.map((p) => `${p.mode === 'write' ? '[写]' : '[读]'}${p.path}`).join('、')}
                    </p>
                  )}
                  <div className="flex gap-2 text-xs">
                    <button
                      className="rounded bg-emerald-700 px-2 py-1 hover:bg-emerald-600"
                      onClick={() => void decide(item, 'allow')}
                    >
                      仅此次允许
                    </button>
                    {item.request.scope === 'session-or-forever' && (
                      <>
                        <button
                          className="rounded bg-neutral-700 px-2 py-1 hover:bg-neutral-600"
                          onClick={() => void decide(item, 'session')}
                        >
                          本会话记住
                        </button>
                        <button
                          className="rounded bg-neutral-700 px-2 py-1 hover:bg-neutral-600"
                          onClick={() => void decide(item, 'forever')}
                        >
                          永久白名单
                        </button>
                      </>
                    )}
                    <button className="rounded bg-red-900 px-2 py-1 hover:bg-red-800" onClick={() => void decide(item, 'deny')}>
                      拒绝
                    </button>
                  </div>
                </div>
              ) : item.kind === 'done' ? (
                <div
                  key={i}
                  className={`mb-3 rounded-lg border px-3 py-2 text-sm ${
                    item.text.startsWith('✅')
                      ? 'border-emerald-700 bg-emerald-950/50 text-emerald-300'
                      : 'border-amber-700 bg-amber-950/40 text-amber-300'
                  }`}
                >
                  {item.text}
                </div>
              ) : item.kind === 'memory' && item.request ? (
                <div key={i} className="mb-3 rounded-lg border border-blue-600/60 bg-blue-950/40 p-3 text-sm">
                  <p className="mb-2 text-blue-300">🧠 记忆写入确认</p>
                  <p className="mb-2 text-neutral-200">{item.request.reason}</p>
                  <div className="flex gap-2 text-xs">
                    <button
                      className="rounded bg-emerald-700 px-2 py-1 hover:bg-emerald-600"
                      onClick={() => void decide(item, 'allow')}
                    >
                      写入长期记忆
                    </button>
                    <button className="rounded bg-red-900 px-2 py-1 hover:bg-red-800" onClick={() => void decide(item, 'deny')}>
                      拒绝
                    </button>
                  </div>
                </div>
              ) : item.kind === 'gate' ? (
                <div key={i} className="mb-2 rounded border border-amber-600/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
                  {item.text}
                </div>
              ) : item.kind === 'error' ? (
                <div key={i} className="mb-2 text-xs text-red-400">
                  {item.text}
                </div>
              ) : (
                <div key={i} className="mb-2 font-mono text-xs text-neutral-500">
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
                placeholder={activeTask ? '输入消息；可用 @文件名 引用任务目录内文件，Enter 发送' : '请先新建/选择任务'}
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

        {/* 右栏：成果区（B02 版本链 + 转写查看器入口） */}
        <aside className="flex w-72 shrink-0 flex-col border-l border-neutral-800">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm font-semibold text-neutral-300">成果区</span>
            {activeTask && (
              <button
                className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
                onClick={() => setTranscriptOpen(true)}
              >
                转写查看
              </button>
            )}
          </div>
          {rightPanel ? (
            <div className="flex-1 overflow-y-auto px-4 text-xs">
              <p className="mb-2 break-all text-neutral-500">{rightPanel.directory}</p>
              {rightPanel.files.length === 0 && <p className="text-neutral-600">（空）</p>}
              {renderVersionChain(rightPanel.files)}
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
      {usersModalOpen && <UsersModal onClose={() => setUsersModalOpen(false)} onSaved={() => undefined} />}
      {transcriptOpen && activeTask && (
        <TranscriptModal taskId={activeTask.id} onClose={() => setTranscriptOpen(false)} />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-neutral-800 px-4 py-2 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
