/**
 * WorkPivot 主界面（参考 ZCode 布局模式，规范见 docs/02-design/ui-ux/主界面布局规范.md）。
 * 左栏：主按钮组（新建任务/搜索/自动化/技能市场）→ 分组 tab（项目/临时任务）→ 项目树（相对时间）→ 底部用户区；
 * 中栏：顶部会话工具条 + 消息流 + 底部输入区（附件/权限档位/模型选择——ZCode 位置）；
 * 右栏：成果区（版本链/转写查看）。
 * 纪律（A01.3）：只经 localhost HTTP/SSE 与服务层通信，禁止 import 服务层/内核。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  api,
  clearToken,
  streamChat,
  uploadAttachment,
  type ChatEvent,
  type HistoryMessage,
  type Project,
  type PublicProvider,
  type PublicUser,
  type Task,
  type Tier,
} from './api';
import { LoginView } from './LoginView';
import { SettingsPanel } from './SettingsPanel';
import { TranscriptModal } from './TranscriptModal';

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

const RESUME_MESSAGE =
  '请从断点继续之前的任务:先读取 PROGRESS.md(如存在),不重做已完成的部分,继续完成剩余工作。';

function fmtRelative(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

export default function App(): React.JSX.Element {
  const [authState, setAuthState] = useState<'loading' | 'guest' | 'authed'>('loading');
  const [currentUser, setCurrentUser] = useState<PublicUser | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);

  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [tier, setTier] = useState<Tier>('workdir');
  const [tierLabels, setTierLabels] = useState<Record<string, string>>({});
  const [memoryOn, setMemoryOn] = useState(true);
  const [rightPanel, setRightPanel] = useState<{ directory: string; files: string[] } | null>(null);
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  // U5：待发送附件托盘（上传中/完成/失败）+ 拖拽高亮 + @补全弹窗
  interface PendingAtt {
    id: string;
    file: File;
    name: string;
    progress: number;
    status: 'uploading' | 'done' | 'error';
    serverName?: string;
  }
  const [pendingAtt, setPendingAtt] = useState<PendingAtt[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [atk, setAtk] = useState<{ query: string; start: number } | null>(null);
  const [atkItems, setAtkItems] = useState<string[]>([]);
  const [atkIndex, setAtkIndex] = useState(0);
  const [filesForAt, setFilesForAt] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // U1：搜索过滤 + 分组 tab + 收起状态 + 新建表单
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [groupTab, setGroupTab] = useState<'projects' | 'temp'>('projects');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('wp_collapsed_projects') ?? '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectForm, setProjectForm] = useState({ name: '', directory: '' });
  const [projectError, setProjectError] = useState<string | null>(null);
  const [taskFormFor, setTaskFormFor] = useState<string | null>(null);
  const [newTaskName, setNewTaskName] = useState('');
  const [taskError, setTaskError] = useState<string | null>(null);
  const [attachRef, setAttachRef] = useState<HTMLInputElement | null>(null);

  const chatBottomRef = useRef<HTMLDivElement>(null);

  const showToast = useCallback((text: string): void => {
    setToast(text);
    setTimeout(() => setToast(null), 5000);
  }, []);

  const refreshAuth = useCallback(async (): Promise<void> => {
    // 无论有无令牌都要取 auth/state：首启（无令牌）也必须拿到 needsSetup
    try {
      const state = await api.authState();
      setNeedsSetup(state.needsSetup);
      if (state.authenticated && state.user) {
        setCurrentUser(state.user);
        setAuthState('authed');
      } else {
        clearToken();
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
    const projectData = await api.listProjects();
    setProjects(projectData.projects);
    if (activeTask) setFilesForAt((await api.getFiles(activeTask.id)).files);
    const settings = await api.getSettings();
    setTier(settings.permissionTier);
    setTierLabels(settings.tierLabels);
    setMemoryOn((await api.memoryState()).enabled);
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

  const toggleMemory = useCallback(
    async (enabled: boolean): Promise<void> => {
      try {
        const result = await api.memoryToggle(enabled);
        setMemoryOn(result.enabled);
        showToast(result.enabled ? '记忆功能已开启' : '记忆功能已关闭');
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
      }
    },
    [showToast],
  );

  const selectModel = useCallback(
    async (id: string): Promise<void> => {
      try {
        const result = await api.setActiveProvider(id);
        setProviders((prev) => prev.map((p) => ({ ...p, active: p.id === result.provider.id })));
        showToast(`已切换模型：${result.provider.name} / ${result.provider.modelId}`);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
      }
    },
    [showToast],
  );


  const createProject = useCallback(async (): Promise<void> => {
    setProjectError(null);
    try {
      const { project } = await api.createProject(projectForm.name.trim(), projectForm.directory.trim() || undefined);
      setProjectFormOpen(false);
      setProjectForm({ name: '', directory: '' });
      setCollapsed((prev) => ({ ...prev, [project.id]: false }));
      setProjects((await api.listProjects()).projects);
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : String(err));
    }
  }, [projectForm]);

  const createTaskIn = useCallback(
    async (target: string): Promise<void> => {
      const name = newTaskName.trim();
      if (name === '') {
        setTaskError('任务名称必填');
        return;
      }
      setTaskError(null);
      try {
        const { task } = await api.createTask(
          target === '__temp__' ? { name, temp: true } : { name, projectId: target },
        );
        setTaskFormFor(null);
        setNewTaskName('');
        await refreshTasks();
        await openTask(task);
      } catch (err) {
        setTaskError(err instanceof Error ? err.message : String(err));
      }
    },
    [newTaskName, refreshTasks, openTask],
  );

  // U5：@ 补全——检测光标前 @ 片段，弹文件清单
  const detectAt = useCallback(
    (ta: HTMLTextAreaElement): void => {
      const pos = ta.selectionStart ?? 0;
      const before = ta.value.slice(0, pos);
      const m = /@([^@\s]*)$/.exec(before);
      if (m && filesForAt.length >= 0) {
        const query = m[1] ?? '';
        const items = filesForAt.filter((f) => f.toLowerCase().includes(query.toLowerCase()));
        setAtk({ query, start: m.index });
        setAtkItems(items);
        setAtkIndex(0);
        if (items.length === 0) setAtk(null);
      } else {
        setAtk(null);
      }
    },
    [filesForAt],
  );

  // 选中补全项：替换 @ 片段为完整路径
  const applyAt = useCallback(
    (path: string): void => {
      const ta = textareaRef.current;
      if (!ta || !atk) return;
      const pos = ta.selectionStart ?? ta.value.length;
      const before = ta.value.slice(0, pos);
      const m = /@([^@\s]*)$/.exec(before);
      const newText = (m ? before.slice(0, m.index) : before) + `@${path} ` + ta.value.slice(pos);
      setInput(newText);
      setAtk(null);
    },
    [atk],
  );

  const closeAt = useCallback((): void => setAtk(null), []);

  // U5：文件进托盘并上传（粘贴/拖拽/＋按钮共用）
  const addFiles = useCallback(
    (files: File[]): void => {
      if (!activeTask) return;
      for (const f of files) {
        if (f.size > 50 * 1024 * 1024) {
          showToast(`附件 ${f.name} 超过 50MB 上限`);
          continue;
        }
        const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        setPendingAtt((prev) => [...prev, { id, file: f, name: f.name, progress: 0, status: 'uploading' }]);
        void uploadAttachment(activeTask.id, f, (ratio) => {
          setPendingAtt((prev) => prev.map((a) => (a.id === id ? { ...a, progress: ratio } : a)));
        })
          .then((res) => {
            setPendingAtt((prev) => prev.map((a) => (a.id === id ? { ...a, progress: 1, status: 'done', serverName: res.name } : a)));
            void api.getFiles(activeTask.id).then(setRightPanel);
          })
          .catch(() => {
            showToast(`附件 ${f.name} 上传失败`);
            setPendingAtt((prev) => prev.map((a) => (a.id === id ? { ...a, status: 'error' } : a)));
          });
      }
    },
    [activeTask, showToast],
  );

  const removeAttachment = useCallback((id: string): void => {
    setPendingAtt((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const send = useCallback(async (override?: string): Promise<void> => {
    const content = (override ?? input).trim();
    const attached = pendingAtt.filter((a) => a.status === 'done').map((a) => a.serverName ?? a.name);
    if ((content === '' && attached.length === 0) || !activeTask || streaming) return;
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
      }, undefined, attached);
      setPendingAtt([]);
    } catch (err) {
      setChat((prev) => [...prev, { kind: 'error', text: `出错：${err instanceof Error ? err.message : String(err)}` }]);
    } finally {
      setStreaming(false);
      void refreshTasks();
    }
  }, [input, activeTask, streaming, pendingAtt, refreshTasks, showToast]);

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
                  text: `${decision === 'deny' ? '⛔ 已拒绝' : '✅ 已授权'}：${item.request!.tool}`,
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

  const isAdmin = currentUser?.role === 'admin';
  const activeProvider = providers.find((p) => p.active);
  const tempTasks = tasks.filter((t) => t.temp);
  const projectTasksOf = (pid: string): Task[] =>
    tasks.filter((t) => t.projectId === pid && !t.temp).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const search = searchText.trim().toLowerCase();
  const matchTask = (t: Task): boolean => search === '' || t.name.toLowerCase().includes(search);
  const matchProject = (p: Project): boolean =>
    search === '' || p.name.toLowerCase().includes(search) || projectTasksOf(p.id).some(matchTask);

  const toggleCollapse = (projectId: string): void => {
    setCollapsed((prev) => {
      const next = { ...prev, [projectId]: !prev[projectId] };
      localStorage.setItem('wp_collapsed_projects', JSON.stringify(next));
      return next;
    });
  };

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      {serverOk === false && (
        <div className="bg-red-900/80 px-4 py-1.5 text-xs text-red-100">
          ⚠ 服务层未连接：请确认桌面应用已启动（或单独启动服务层），然后刷新本页。
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* 左栏（ZCode 模式）：按钮组 → 分组 → 树 → 底部用户区 */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-800">
          <div className="space-y-0.5 px-3 py-3">
            <button
              className="block w-full rounded px-2 py-1.5 text-left text-sm font-medium hover:bg-neutral-900"
              onClick={() => {
                setGroupTab('projects');
                setProjectFormOpen(true);
                setProjectError(null);
              }}
            >
              ＋ 新建任务
            </button>
            <button
              className="block w-full rounded px-2 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-900"
              onClick={() => setSearchOpen((v) => !v)}
            >
              🔍 搜索
            </button>
            <button
              className="block w-full rounded px-2 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-900"
              onClick={() => showToast('自动化（定时任务）将在后续版本提供')}
            >
              ⚡ 自动化
            </button>
            <button
              className="block w-full rounded px-2 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-900"
              onClick={() => {
                if (isAdmin) {
                  window.open('/admin', '_blank');
                } else {
                  showToast('技能管理在后台，仅管理员可操作');
                }
              }}
            >
              🧩 技能市场
            </button>
          </div>

          {searchOpen && (
            <div className="px-3 pb-2">
              <input
                autoFocus
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs outline-none focus:border-neutral-500"
                placeholder="搜索任务/项目"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
              />
            </div>
          )}

          {/* 分组 tab（F2/F1：临时任务 与 项目） */}
          <div className="flex gap-1 border-b border-neutral-800 px-3 pb-2 text-xs">
            {(
              [
                ['projects', '项目'],
                ['temp', '临时任务'],
              ] as Array<['projects' | 'temp', string]>
            ).map(([key, label]) => (
              <button
                key={key}
                className={`rounded px-2 py-1 ${groupTab === key ? 'bg-neutral-800 font-medium text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900'}`}
                onClick={() => setGroupTab(key)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto">
            {groupTab === 'temp' ? (
              <div>
                {tempTasks.length === 0 && <p className="px-4 py-2 text-xs text-neutral-600">（暂无临时任务）</p>}
                {tempTasks
                  .filter(matchTask)
                  .map((task) => (
                    <button
                      key={task.id}
                      className={`block w-full px-4 py-1.5 text-left text-sm hover:bg-neutral-900 ${
                        activeTask?.id === task.id ? 'bg-neutral-900' : ''
                      }`}
                      onClick={() => void openTask(task)}
                    >
                      <span className="mr-1.5 text-neutral-500">⚡</span>
                      {task.name}
                      <span className="ml-2 text-xs text-neutral-600">{fmtRelative(task.createdAt)}</span>
                    </button>
                  ))}
              </div>
            ) : (
              <div>
                {isAdmin && (
                  <div className="flex items-center justify-between px-4 py-2">
                    <span className="text-xs text-neutral-500">项目</span>
                    <button
                      className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
                      onClick={() => {
                        setProjectFormOpen((v) => !v);
                        setProjectError(null);
                      }}
                    >
                      ＋ 新建项目
                    </button>
                  </div>
                )}
                {/* F1：新建项目（仅管理员，表单内联） */}
                {isAdmin && projectFormOpen && (
                  <div className="space-y-2 border-b border-neutral-800 px-4 py-2">
                    <input
                      autoFocus
                      className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm outline-none focus:border-neutral-500"
                      placeholder="项目名称（必填）"
                      value={projectForm.name}
                      onChange={(e) => setProjectForm({ ...projectForm, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void createProject();
                        if (e.key === 'Escape') setProjectFormOpen(false);
                      }}
                    />
                    <input
                      className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs outline-none focus:border-neutral-500"
                      placeholder="工作目录（留空自动创建）"
                      value={projectForm.directory}
                      onChange={(e) => setProjectForm({ ...projectForm, directory: e.target.value })}
                    />
                    {projectError && <p className="text-xs text-red-400">{projectError}</p>}
                    <div className="flex gap-2">
                      <button
                        className="rounded bg-blue-600 px-2 py-1 text-xs hover:bg-blue-500"
                        onClick={() => void createProject()}
                      >
                        创建
                      </button>
                      <button
                        className="rounded bg-neutral-800 px-2 py-1 text-xs"
                        onClick={() => setProjectFormOpen(false)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
                {projects.filter(matchProject).map((project) => {
                  const isCollapsed = collapsed[project.id] === true;
                  const projectTasks = projectTasksOf(project.id).filter(matchTask);
                  return (
                    <div key={project.id}>
                      <div
                        className={`group flex items-center justify-between px-4 py-1.5 hover:bg-neutral-900 ${
                          activeTask && activeTask.projectId === project.id ? 'bg-neutral-900' : ''
                        }`}
                      >
                        <button
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
                          onClick={() => toggleCollapse(project.id)}
                        >
                          <span className="text-neutral-500">{isCollapsed ? '▸' : '▾'}</span>
                          <span className="truncate font-medium text-neutral-200">📁 {project.name}</span>
                        </button>
                        <button
                          className="hidden text-xs text-neutral-500 hover:text-neutral-200 group-hover:block"
                          title="在此项目下新建任务"
                          onClick={() => {
                            setCollapsed((prev) => ({ ...prev, [project.id]: false }));
                            setTaskFormFor(project.id);
                            setNewTaskName('');
                            setTaskError(null);
                          }}
                        >
                          ＋任务
                        </button>
                      </div>
                      {!isCollapsed && (
                        <div>
                          {taskFormFor === project.id && (
                            <div className="space-y-2 px-6 py-2">
                              <input
                                autoFocus
                                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm outline-none focus:border-neutral-500"
                                placeholder="任务名称（必填）"
                                value={newTaskName}
                                onChange={(e) => setNewTaskName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') void createTaskIn(project.id);
                                  if (e.key === 'Escape') setTaskFormFor(null);
                                }}
                              />
                              {taskError && taskFormFor === project.id && <p className="text-xs text-red-400">{taskError}</p>}
                              <div className="flex gap-2">
                                <button
                                  className="rounded bg-blue-600 px-2 py-1 text-xs hover:bg-blue-500"
                                  onClick={() => void createTaskIn(project.id)}
                                >
                                  创建
                                </button>
                                <button
                                  className="rounded bg-neutral-800 px-2 py-1 text-xs"
                                  onClick={() => setTaskFormFor(null)}
                                >
                                  取消
                                </button>
                              </div>
                            </div>
                          )}
                          {projectTasks.length === 0 && <p className="px-6 py-1 text-xs text-neutral-600">（无任务）</p>}
                          {projectTasks.map((task) => (
                            <button
                              key={task.id}
                              className={`block w-full px-6 py-1.5 text-left text-sm hover:bg-neutral-900 ${
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
                              <span className="text-neutral-300">{task.name}</span>
                              <span className="ml-2 text-xs text-neutral-600">{fmtRelative(task.createdAt)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {projects.length === 0 && <p className="px-4 py-2 text-xs text-neutral-600">（无项目）</p>}
              </div>
            )}
          </div>

          {/* 底部用户区（ZCode 模式） */}
          <div className="border-t border-neutral-800">
            {settingsOpen ? (
              <SettingsPanel
                user={currentUser!}
                tier={tier}
                tierLabels={tierLabels}
                memoryOn={memoryOn}
                activeModel={activeProvider ? `${activeProvider.name} / ${activeProvider.modelId}` : null}
                onTierChange={(t) => void changeTier(t)}
                onMemoryToggle={(v) => void toggleMemory(v)}
                onLogout={logout}
                onClose={() => setSettingsOpen(false)}
              />
            ) : (
              <button
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-900"
                onClick={() => setSettingsOpen(true)}
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-700 text-sm font-semibold">
                  {(currentUser?.username ?? '?').slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{currentUser?.username}</span>
                  <span className="block text-xs text-neutral-500">
                    {currentUser?.role === 'admin' ? '管理员' : '成员'}
                  </span>
                </span>
                <span className="text-neutral-500">⚙</span>
              </button>
            )}
          </div>
        </aside>

        {/* 中栏：会话工具条 + 消息流 + 输入区 */}
        <main className="flex min-w-0 flex-1 flex-col">
          {/* U4 顶部会话工具条 */}
          <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2 text-xs">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium text-neutral-200">{activeTask ? activeTask.name : '未选择任务'}</span>
              {activeTask && (
                <span className="truncate text-neutral-600">📁 {activeTask.directory}</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {activeTask?.status === 'running' && <span className="animate-pulse text-amber-400">运行中</span>}
              {activeTask?.status === 'interrupted' && (
                <button
                  className="rounded bg-amber-700 px-2 py-1 hover:bg-amber-600"
                  onClick={() => {
                    setInput(RESUME_MESSAGE);
                    void send(RESUME_MESSAGE);
                  }}
                >
                  ▶ 继续任务
                </button>
              )}
              {rightPanel && (
                <span className="text-neutral-500">
                  {activeTask ? `${rightPanel.files.length} 个文件` : ''}
                </span>
              )}
              {activeTask && (
                <button
                  className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700"
                  onClick={() => setTranscriptOpen(true)}
                >
                  转写查看
                </button>
              )}
            </div>
          </div>

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
              ) : item.kind === 'gate' ? (
                <div key={i} className="mb-2 rounded border border-amber-600/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
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

          {/* U3/U5 输入区：附件托盘 + @补全 + 粘贴/拖拽上传 */}
          <div
            className={`relative border-t p-3 ${dragOver ? 'border-2 border-dashed border-blue-500' : 'border-neutral-800'}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              addFiles(Array.from(e.dataTransfer.files));
            }}
          >
            {/* 附件托盘（多文件并列，右上角 × 移除） */}
            {pendingAtt.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {pendingAtt.map((a) => (
                  <div key={a.id} className="relative w-44 rounded border border-neutral-700 bg-neutral-900 p-2">
                    <button
                      className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-neutral-600 text-[10px] text-neutral-100 hover:bg-red-600"
                      title="移除"
                      onClick={() => removeAttachment(a.id)}
                    >
                      ×
                    </button>
                    <p className="truncate text-xs text-neutral-200">📄 {a.name}</p>
                    <p className="text-[10px] text-neutral-500">
                      {a.status === 'error' ? (
                        <span className="text-red-400">上传失败</span>
                      ) : a.status === 'done' ? (
                        <span className="text-emerald-400">就绪 · {(a.file.size / 1024).toFixed(1)} KB</span>
                      ) : (
                        `上传中 ${(a.progress * 100).toFixed(0)}%`
                      )}
                    </p>
                    {a.status === 'uploading' && (
                      <div className="mt-1 h-1 w-full rounded bg-neutral-700">
                        <div className="h-1 rounded bg-blue-500" style={{ width: `${a.progress * 100}%` }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {/* @ 补全弹窗（输入框上方，列工作目录文件） */}
            {atk && atkItems.length > 0 && (
              <div className="absolute bottom-full left-3 mb-1 max-h-48 w-80 overflow-y-auto rounded border border-neutral-700 bg-neutral-900 shadow-xl">
                {atkItems.map((f, i) => (
                  <button
                    key={f}
                    className={`block w-full truncate px-3 py-1.5 text-left text-xs ${i === atkIndex ? 'bg-neutral-700' : 'hover:bg-neutral-800'}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyAt(f);
                    }}
                  >
                    📄 {f}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <button
                className="rounded-lg border border-neutral-700 px-2 py-2 text-xs text-neutral-400 hover:bg-neutral-900 disabled:opacity-40"
                disabled={!activeTask || streaming}
                title="附加文本文件（≤64KB，内容将随消息注入）"
                onClick={() => attachRef?.click()}
              >
                ＋
              </button>
              <input
                ref={setAttachRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              <textarea
                ref={textareaRef}
                className={`max-h-40 min-h-[44px] flex-1 resize-y rounded-lg border bg-neutral-900 px-3 py-2 text-sm outline-none ${dragOver ? 'border-blue-500 border-dashed' : 'border-neutral-700 focus:border-neutral-500'}`}
                placeholder={activeTask ? '输入消息；@ 引用文件；支持粘贴/拖拽文件' : '请先新建/选择任务'}
                value={input}
                disabled={!activeTask || streaming}
                onChange={(e) => {
                  setInput(e.target.value);
                  detectAt(e.target);
                }}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.files);
                  if (files.length > 0) {
                    e.preventDefault();
                    addFiles(files);
                  }
                }}
                onKeyDown={(e) => {
                  if (atk && atkItems.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setAtkIndex((i) => (i + 1) % atkItems.length);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setAtkIndex((i) => (i - 1 + atkItems.length) % atkItems.length);
                      return;
                    }
                    if (e.key === 'Enter' || e.key === 'Tab') {
                      e.preventDefault();
                      applyAt(atkItems[atkIndex]!);
                      return;
                    }
                    if (e.key === 'Escape') {
                      closeAt();
                      return;
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              {/* U3：权限档位 + 模型选择移入输入区（ZCode 位置） */}
              <select
                className="rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-2 text-xs outline-none"
                title="权限档位"
                value={tier}
                onChange={(e) => void changeTier(e.target.value as Tier)}
              >
                {Object.entries(tierLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                className="max-w-[180px] rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-2 text-xs outline-none"
                title="模型选择（切换后下轮生效）"
                value={activeProvider?.id ?? ''}
                onChange={(e) => {
                  if (isAdmin) void selectModel(e.target.value);
                }}
                disabled={!isAdmin}
              >
                {providers.length === 0 && <option value="">未配置</option>}
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} / {p.modelId}
                    {p.active ? '（当前）' : ''}
                  </option>
                ))}
              </select>
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
            {!isAdmin && providers.length === 0 && (
              <p className="mt-1 text-xs text-red-400">管理员尚未配置模型，请联系管理员。</p>
            )}
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

      {transcriptOpen && activeTask && <TranscriptModal taskId={activeTask.id} onClose={() => setTranscriptOpen(false)} />}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-neutral-800 px-4 py-2 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );

  /** B02 版本链：按 `{标题} v{X.Y} …` 分组，最新版本在前 */
  function renderVersionChain(files: string[]): React.JSX.Element[] {
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
  }

}
