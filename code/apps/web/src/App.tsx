import { RequiredPasswordChange } from './AccountAccess';
import { TaskSidebar } from './TaskSidebar';
import { ArtifactSyncController } from './ArtifactBrowser';
import { ProjectModal } from './ProjectModal';
import { Icon } from './Icon';
/**
 * WorkPivot 主界面（参考 ZCode 布局模式，规范见 docs/02-design/ui-ux/主界面布局规范.md）。
 * 左栏：主按钮组（新建任务/搜索/自动化/技能市场）→ 分组 tab（项目/临时任务）→ 项目树（相对时间）→ 底部用户区；
 * 中栏：顶部会话工具条 + 消息流 + 底部输入区（附件/权限档位/模型选择——ZCode 位置）；
 * 右栏：任务侧栏（版本链/转写查看）。
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
  type PlanStep,
  type Project,
  type PublicProvider,
  type PublicUser,
  type Task,
  type Tier,
} from './api';
import { LoginView } from './LoginView';
import { SettingsPanel } from './SettingsPanel';
import { TranscriptModal } from './TranscriptModal';
import { ActivityRow } from './ActivityRow';
import { SkillMarket } from './SkillMarket';
import { fileIcon } from './file-icons';
import { appendContent, toolSummary, type ContentItem } from './chat-content';

interface ChatItem extends ContentItem {
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
  /** R002：授权卡 AI 风险解读（risk_analysis 事件回填） */
  analysis?: string;
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

/** 三栏拖拽调宽：按住分栏条水平拖动，宽度持久化到 localStorage。dir=+1 左缘拖拽（左栏），dir=-1 右缘拖拽（右栏）。 */
function useColumnWidth(key: string, initial: number, min: number, max: number, dir: 1 | -1): { width: number; beginDrag: (e: React.MouseEvent) => void } {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(key));
    return Number.isFinite(saved) && saved >= min && saved <= max ? saved : initial;
  });
  const beginDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      const onMove = (ev: MouseEvent): void => {
        setWidth(Math.min(max, Math.max(min, startW + dir * (ev.clientX - startX))));
      };
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        setWidth((w) => {
          localStorage.setItem(key, String(Math.round(w)));
          return w;
        });
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [width, key, min, max, dir],
  );
  return { width, beginDrag };
}

/** 分栏拖拽条（兼作栏间分隔线）。 */
function ColResizeHandle(props: { onBeginDrag: (e: React.MouseEvent) => void }): React.JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="w-1 shrink-0 cursor-col-resize bg-neutral-800 transition-colors hover:bg-blue-600"
      onMouseDown={props.onBeginDrag}
    />
  );
}

export default function App(): React.JSX.Element {
  const [authState, setAuthState] = useState<'loading' | 'guest' | 'authed' | 'password'>('loading');
  const [currentUser, setCurrentUser] = useState<PublicUser | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [setupTokenRequired, setSetupTokenRequired] = useState(false);

  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [deletingTask, setDeletingTask] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const deletedTaskIds = useRef(new Set<string>());
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
  const [input, setInput] = useState('');
  const [streamIds, setStreamIds] = useState<string[]>([]);
  const streaming = Boolean(activeTask && (streamIds.includes(activeTask.id) || ['queued', 'running', 'waiting'].includes(tasks.find((t) => t.id === activeTask.id)?.status ?? '')));
  const streamIdsRef = useRef(streamIds); streamIdsRef.current = streamIds;
  const activeIdRef = useRef(activeTask?.id); activeIdRef.current = activeTask?.id;
  const chatCache = useRef(new Map<string, ChatItem[]>());
  const planCache = useRef(new Map<string, PlanStep[]>());
  const chatRef = useRef(chat); chatRef.current = chat;
  const updateTaskChat = useCallback((id: string, update: (prev: ChatItem[]) => ChatItem[]): void => {
    const previous = activeIdRef.current === id ? chatRef.current : chatCache.current.get(id) ?? [];
    const next = update(previous); chatCache.current.set(id, next);
    if (activeIdRef.current === id) { chatRef.current = next; setChat(next); }
  }, []);
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [tier, setTier] = useState<Tier>('auto');
  const [skillMarketOpen, setSkillMarketOpen] = useState(false);
  const [defaultTier, setDefaultTier] = useState<Tier>('auto');
  const [tierLabels, setTierLabels] = useState<Record<string, string>>({});
  const [memoryOn, setMemoryOn] = useState(true);
  useEffect(() => {
    const changed = (event: Event) => { const value = (event as CustomEvent<unknown>).detail; if (typeof value === 'boolean') setMemoryOn(value); };
    window.addEventListener('wp:memory-changed', changed);
    return () => window.removeEventListener('wp:memory-changed', changed);
  }, []);
  const [rightPanelOpen, setRightPanelOpen] = useState(() => {
    try { return localStorage.getItem('wp-right-panel-open') !== 'false'; } catch { return true; }
  });
  const activeProjectName = activeTask?.temp ? '临时任务' : projects.find((project) => project.id === activeTask?.projectId)?.name ?? '默认项目';
  const conversationTitle = activeTask ? activeProjectName + ' / ' + activeTask.name : '未选择任务';
  const [serverOk, setServerOk] = useState<boolean | null>(null);

  // 三栏拖拽调宽：左栏最小 200px（栏内按钮组需要），右栏最小 232px
  const leftCol = useColumnWidth('wp-col-left', 256, 200, 480, 1);
  const rightCol = useColumnWidth('wp-col-right', 288, 232, 560, -1);
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
  const drafts = useRef(new Map<string, { input: string; pending: PendingAtt[] }>());
  const draftRef = useRef({ input, pending: pendingAtt }); draftRef.current = { input, pending: pendingAtt };
  const [dragOver, setDragOver] = useState(false);
  const [atk, setAtk] = useState<{ query: string; start: number } | null>(null);
  const [atkItems, setAtkItems] = useState<string[]>([]);
  const [atkIndex, setAtkIndex] = useState(0);
  const [filesForAt, setFilesForAt] = useState<string[]>([]);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
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
  const [projectForm, setProjectForm] = useState<{ name: string; directory: string; localDirectory?: boolean }>({ name: '', directory: '' });
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
      setSetupTokenRequired(state.setupTokenRequired);
      if (state.authenticated && state.user) {
        setCurrentUser(state.user);
        setAuthState(state.user.mustChangePassword ? 'password' : 'authed');
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
    setTasks((await api.listTasks()).tasks.filter(task => !deletedTaskIds.current.has(task.id)));
  }, []);

  const refreshProviders = useCallback(async (): Promise<void> => {
    setProviders((await api.listProviders()).providers);
  }, []);

  const openTask = useCallback(async (task: Task): Promise<void> => {
    if (deletedTaskIds.current.has(task.id)) return;
    const previousId = activeIdRef.current;
    if (previousId) { chatCache.current.set(previousId, chatRef.current); drafts.current.set(previousId, draftRef.current); }
    activeIdRef.current = task.id;
    setActiveTask(task);
    setInput(drafts.current.get(task.id)?.input ?? '');
    setPendingAtt(drafts.current.get(task.id)?.pending ?? []);
    setChat(chatCache.current.get(task.id) ?? []);
    setPlanSteps(planCache.current.get(task.id) ?? []);
    const [detail, plan] = await Promise.all([api.getTask(task.id), api.getPlan(task.id)]);
    if (activeIdRef.current !== task.id) return;
    if (!streamIdsRef.current.includes(task.id)) {
      const rows: ChatItem[] = detail.history.map((m: HistoryMessage) => ({ kind: m.role, text: m.content, attachments: m.attachments }));
      for (const request of detail.pending ?? []) rows.push({ kind: 'permission', text: request.reason, request: { ...request, hasPaths: request.paths.length > 0 } });
      for (const memory of detail.pendingMemory ?? []) rows.push({ kind: 'memory', text: `记忆写入确认：${memory.content}`, request: { id: memory.id, tool: 'memory_promote', reason: memory.content, paths: [], hasPaths: false, scope: 'once' } });
      chatRef.current = rows; chatCache.current.set(task.id, rows); setChat(rows);
    }
    planCache.current.set(task.id, plan.steps); setPlanSteps(plan.steps);
  }, []);

  const confirmDeleteTask = async (): Promise<void> => {
    if (!deleteTarget || deletingTask) return;
    setDeletingTask(true); setDeleteError('');
    try {
      await api.deleteTask(deleteTarget.id);
      deletedTaskIds.current.add(deleteTarget.id);
      chatCache.current.delete(deleteTarget.id); planCache.current.delete(deleteTarget.id); drafts.current.delete(deleteTarget.id);
      setTasks(rows => rows.filter(task => task.id !== deleteTarget.id));
      if (activeIdRef.current === deleteTarget.id) {
        activeIdRef.current = undefined; setActiveTask(null); chatRef.current = []; setChat([]);
        setPlanSteps([]); setInput(''); setPendingAtt([]); setFilesForAt([]); setTranscriptOpen(false);
      }
      setDeleteTarget(null); showToast('任务已删除');
    } catch (error) { setDeleteError(error instanceof Error ? error.message : '删除失败，请重试'); }
    finally { setDeletingTask(false); }
  };
  const requestDeleteTask = (task: Task): void => { setDeleteError(''); setDeleteTarget(task); };

  const loadWorkspaceData = useCallback(async (): Promise<void> => {
    await refreshTasks();
    await refreshProviders();
    const projectData = await api.listProjects();
    setProjects(projectData.projects);
    if (activeTask) setFilesForAt((await api.getFiles(activeTask.id)).files);
    // RL1-02：档位改读个人有效档（含全局默认回落），不再读全局单值
    const myTier = await api.getMyTier();
    setTier(myTier.tier);
    setDefaultTier(myTier.defaultTier);
    setTierLabels(myTier.tierLabels);
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
        // RL1-02：改自己的档位；admin 的全局默认档走 changeDefaultTier
        const result = await api.setMyTier(next);
        setTier(result.tier);
        setDefaultTier(result.defaultTier);
        showToast(`操作模式已切换：${tierLabels[next] ?? next}`);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
      }
    },
    [tierLabels, showToast],
  );

  // RL1-02：admin 修改全局默认档（对未自选个人档位的用户生效）
  const changeDefaultTier = useCallback(
    async (next: Tier): Promise<void> => {
      try {
        const result = await api.setGlobalTier(next);
        setDefaultTier(result.permissionTier);
        showToast(`默认模式已更新：${tierLabels[next] ?? next}`);
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
      const { project } = await api.createProject(projectForm.name.trim(), projectForm.directory.trim() || undefined, projectForm.localDirectory);
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
      const owner = activeTask.id;
      const changePending = (update: (previous: PendingAtt[]) => PendingAtt[]): void => {
        if (activeIdRef.current === owner) setPendingAtt(update);
        else { const saved = drafts.current.get(owner) ?? { input: '', pending: [] }; drafts.current.set(owner, { ...saved, pending: update(saved.pending) }); }
      };
      for (const f of files) {
        if (f.size > 50 * 1024 * 1024) {
          showToast(`附件 ${f.name} 超过 50MB 上限`);
          continue;
        }
        const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        changePending((prev) => [...prev, { id, file: f, name: f.name, progress: 0, status: 'uploading' }]);
        void uploadAttachment(activeTask.id, f, (ratio) => {
          changePending((prev) => prev.map((a) => (a.id === id ? { ...a, progress: ratio } : a)));
        })
          .then((res) => {
            changePending((prev) => prev.map((a) => (a.id === id ? { ...a, progress: 1, status: 'done', serverName: res.name } : a)));
          })
          .catch(() => {
            showToast(`附件 ${f.name} 上传失败`);
            changePending((prev) => prev.map((a) => (a.id === id ? { ...a, status: 'error' } : a)));
          });
      }
    },
    [activeTask, showToast],
  );

  const removeAttachment = useCallback((id: string): void => {
    setPendingAtt((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const send = useCallback(async (override?: string, target?: Task): Promise<void> => {
    const targetTask = target ?? activeTask;
    if (!override && pendingAtt.some(a => a.status === 'uploading')) { showToast('文件正在上传，请稍候再发送'); return; }
    const content = (override ?? input).trim();
    const attached = (override ? [] : pendingAtt).filter((a) => a.status === 'done').map((a) => a.serverName ?? a.name);
    if ((content === '' && attached.length === 0) || !targetTask || streamIdsRef.current.includes(targetTask.id)) return;
    const id = targetTask.id;
    const setChat = (update: (prev: ChatItem[]) => ChatItem[]): void => updateTaskChat(id, update);
    if (activeIdRef.current === id) setInput('');
    streamIdsRef.current = [...streamIdsRef.current, id];
    setStreamIds(streamIdsRef.current);
    setChat((prev) => [...prev, { kind: 'user', text: content, attachments: attached }]);
    const sentIds = new Set(override ? [] : pendingAtt.filter(a => a.status === 'done').map(a => a.id));
    try {
      await streamChat(targetTask.id, content, (event: ChatEvent) => {
        if (event.type === 'plan_update') { planCache.current.set(id, event.steps); if (activeIdRef.current === id) setPlanSteps(event.steps); return; }
        if (event.type === 'done') {
          if (event.stopReason !== 'completed') setChat((prev) => [...prev, { kind: 'error', text: event.stopReason === 'aborted' ? '已停止生成' : '本次回复已中断，可继续发送消息。' }]);
          void refreshTasks();
          return;
        }
        setChat((prev) => {
          const next = [...prev];
          if (event.type === 'assistant_delta') {
            return appendContent(prev, 'assistant', event.text);
          } else if (event.type === 'reasoning_delta') {
            return appendContent(prev, 'thought', event.text);
          } else if (event.type === 'tool_use') {
            next.push({ kind: 'tool', text: toolSummary(event.toolName, event.args), toolName: event.toolName, toolDisplayName: event.displayName, callId: event.callId, toolInput: JSON.stringify(event.args ?? {}, null, 2), toolState: event.status ?? 'running' });
          } else if (event.type === 'tool_status') {
            const index = next.findIndex(item => item.kind === 'tool' && (event.callId ? item.callId === event.callId : item.toolName === event.toolName) && ['waiting', 'running'].includes(item.toolState ?? ''));
            if (index >= 0) next[index] = { ...next[index]!, toolState: event.status ?? 'running' };
          } else if (event.type === 'tool_result') {
            const index = next.findIndex((item) => item.kind === 'tool' && (event.callId ? item.callId === event.callId : item.toolName === event.toolName) && ['waiting', 'running'].includes(item.toolState ?? ''));
            const update = { toolOutput: event.message ?? '', toolDisplayName: event.displayName, durationMs: event.durationMs, toolState: event.status ?? (event.ok ? 'ok' as const : 'error' as const) };
            if (index >= 0) next[index] = { ...next[index]!, ...update };
            else next.push({ kind: 'tool', text: event.toolName, toolName: event.toolName, ...update });
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
          } else if (event.type === 'permission_resolved') {
            const index = next.findIndex((c) => c.kind === 'permission' && c.request?.id === event.id);
            if (index >= 0) next[index] = { ...next[index]!, kind: 'tool', text: event.reason === 'timeout' ? '授权等待超时，已拒绝本次操作' : event.reason === 'aborted' ? '任务已停止，授权请求已取消' : event.decision === 'deny' ? '已拒绝本次操作' : '已授权本次操作' };
          } else if (event.type === 'memory_confirm') {
            next.push({
              kind: 'memory',
              text: `记忆写入确认：${event.content}`,
              request: { id: event.id, tool: 'memory_promote', reason: event.content, paths: [], hasPaths: false, scope: 'once' },
            });
          } else if (event.type === 'memory_resolved') {
            const index = next.findIndex((c) => c.kind === 'memory' && c.request?.id === event.id);
            if (index >= 0) next[index] = { ...next[index]!, kind: 'tool', text: '记忆确认已结束', request: undefined };
          } else if (event.type === 'risk_analysis') {
            // R002：找到对应授权卡回填 AI 风险解读
            const idx = next.map((c) => (c.kind === 'permission' ? c.request?.id : null)).lastIndexOf(event.id);
            if (idx >= 0) next[idx] = { ...next[idx]!, analysis: event.analysis };
          } else if (event.type === 'gate_reject') {
            next.push({
              kind: 'gate',
              text: `成果核验未通过——缺少文件:${event.missing.join('、')}${event.final ? '(已达重试上限,请人工确认)' : ',已打回重做'}`,
            });
          } else if (event.type === 'error') {
            next.push({ kind: 'error', text: `出错：${event.message}` });
          }
          return next;
        });
      }, undefined, attached, () => {
        if (activeIdRef.current === id) setPendingAtt(previous => previous.filter(a => !sentIds.has(a.id)));
        const saved = drafts.current.get(id);
        if (saved) drafts.current.set(id, { ...saved, pending: saved.pending.filter(a => !sentIds.has(a.id)) });
      });
    } catch (err) {
      setChat((prev) => [...prev, { kind: 'error', text: `出错：${err instanceof Error ? err.message : String(err)}` }]);
    } finally {
      setChat((prev) => prev.map((c) => c.kind === 'permission' ? { ...c, kind: 'tool', text: '授权请求已结束，请重新发起任务操作' } : c));
      streamIdsRef.current = streamIdsRef.current.filter((value) => value !== id);
      setStreamIds(streamIdsRef.current);
      void refreshTasks();
    }
  }, [input, activeTask, pendingAtt, refreshTasks, updateTaskChat]);

  const decide = useCallback(
    async (item: ChatItem, decision: 'allow' | 'deny' | 'session' | 'forever'): Promise<void> => {
      if (!activeTask || !item.request) return;
      try {
        if (item.kind === 'memory') {
          await api.confirmMemory(activeTask.id, item.request.id, decision !== 'deny');
          setChat((prev) =>
            prev.map((c) =>
              c === item
                ? { ...c, kind: 'tool', text: `${decision === 'deny' ? '已拒绝写入' : '已写入长期记忆'}：${item.request!.reason}` }
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
                  text: `${decision === 'deny' ? '已拒绝' : '已授权'}：${item.request!.tool}`,
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
    // A fresh document discards all task streams, cached messages and attachment drafts.
    window.location.reload();
  }, []);

  if (authState === 'loading') {
    return <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-500">加载中…</div>;
  }
  if (authState === 'guest') {
    return <LoginView needsSetup={needsSetup} setupTokenRequired={setupTokenRequired} onAuthed={() => void refreshAuth()} />;
  }

  if (authState === 'password') return <RequiredPasswordChange onDone={() => void refreshAuth()} />;

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
      <ArtifactSyncController key={currentUser?.id} />
      {serverOk === false && (
        <div className="bg-red-900/80 px-4 py-1.5 text-xs text-red-100">
          <Icon name="warning" /> 服务层未连接：请确认桌面应用已启动（或单独启动服务层），然后刷新本页。
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* 左栏（ZCode 模式）：按钮组 → 分组 → 树 → 底部用户区；宽度可拖拽（最小 200px） */}
        <aside className="flex shrink-0 flex-col" style={{ width: leftCol.width, minWidth: 200 }}>
          <div className="space-y-0.5 px-3 py-3">
            <button
              className="block w-full rounded px-2 py-1.5 text-left text-sm font-medium hover:bg-neutral-900"
              onClick={() => {
                setGroupTab('projects');
                setProjectFormOpen(true);
                setProjectError(null);
              }}
            >
              <Icon name="plus" /> 新建任务
            </button>
            <button
              className="block w-full rounded px-2 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-900"
              onClick={() => setSearchOpen((v) => !v)}
            >
              <Icon name="search" /> 搜索
            </button>
            <button
              className="block w-full rounded px-2 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-900"
              onClick={() => showToast('自动化（定时任务）将在后续版本提供')}
            >
              <Icon name="bolt" /> 自动化
            </button>
            <button
              className="block w-full rounded px-2 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-900"
              onClick={() => setSkillMarketOpen(true)}
            >
              <Icon name="skill" /> 技能市场
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
                    <div key={task.id} className="flex items-center">
                    <button
                      className={`block min-w-0 flex-1 px-4 py-1.5 text-left text-sm hover:bg-neutral-900 ${
                        activeTask?.id === task.id ? 'bg-neutral-900' : ''
                      }`}
                      onClick={() => { void openTask(task).catch((e: unknown) => showToast(String(e))); }}
                    >
                      <span className="mr-1.5 text-neutral-500"><Icon name="bolt" /></span>
                      {task.name}
                      <span className="ml-2 text-xs text-neutral-600">{fmtRelative(task.createdAt)}</span>
                    </button>
                    <button aria-label={`删除任务 ${task.name}`} title="删除任务" className="mr-2 shrink-0 rounded p-1.5 text-neutral-500 hover:text-red-400" onClick={() => requestDeleteTask(task)}><Icon name="trash" size={15} /></button>
                    </div>
                  ))}
              </div>
            ) : (
              <div>
                {currentUser && (
                  <div className="flex items-center justify-between px-4 py-2">
                    <span className="text-xs text-neutral-500">项目</span>
                    <button
                      className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
                      onClick={() => {
                        setProjectFormOpen(true);
                        setProjectError(null);
                      }}
                    >
                      <Icon name="plus" /> 新建项目
                    </button>
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
                          <span className="text-neutral-500"><Icon name={isCollapsed ? 'right' : 'down'} /></span>
                          <span className="truncate font-medium text-neutral-200"><Icon name="folder" /> {project.name}</span>
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
                          <Icon name="plus" />任务
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
                            <div key={task.id} className="flex items-center">
                            <button
                              className={`block min-w-0 flex-1 px-6 py-1.5 text-left text-sm hover:bg-neutral-900 ${
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
                            <button aria-label={`删除任务 ${task.name}`} title="删除任务" className="mr-2 shrink-0 rounded p-1.5 text-neutral-500 hover:text-red-400" onClick={() => requestDeleteTask(task)}><Icon name="trash" size={15} /></button>
                            </div>
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
                defaultTier={defaultTier}
                onDefaultTierChange={(t) => void changeDefaultTier(t)}
                memoryOn={memoryOn}
                activeModel={activeProvider ? `${activeProvider.name} / ${activeProvider.modelId}` : null}
                activeTaskId={activeTask?.id}
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
                <span className="text-neutral-500"><Icon name="settings" /></span>
              </button>
            )}
          </div>
        </aside>

        {/* 分栏拖拽条（左栏 | 中栏） */}
        <ColResizeHandle onBeginDrag={leftCol.beginDrag} />

        {/* 中栏：会话工具条 + 消息流 + 输入区 */}
        <main className="flex min-w-0 flex-1 flex-col">
          {/* U4 顶部会话工具条 */}
          <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2 text-xs gap-3">
            <h1 className="min-w-0 flex-1 truncate text-left text-sm font-medium text-neutral-100" title={conversationTitle}>{conversationTitle}</h1>
            <div className="flex shrink-0 items-center gap-2">
              {activeTask && <button type="button" title="删除任务" aria-label="删除任务" className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-red-400" onClick={() => requestDeleteTask(activeTask)}><Icon name="trash" /></button>}
              {streaming && <span className="animate-pulse text-amber-400">处理中</span>}
              {activeTask?.status === 'interrupted' && (
                <button
                  className="rounded bg-amber-700 px-2 py-1 hover:bg-amber-600"
                  onClick={() => {
                    setInput(RESUME_MESSAGE);
                    void send(RESUME_MESSAGE);
                  }}
                >
                  <Icon name="play" /> 继续任务
                </button>
              )}
              <button
                type="button"
                aria-label={rightPanelOpen ? '收起右侧任务侧栏' : '展开右侧任务侧栏'}
                title={rightPanelOpen ? '收起右侧任务侧栏' : '展开右侧任务侧栏'}
                aria-expanded={rightPanelOpen}
                aria-controls="task-results-panel"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-100 hover:bg-neutral-800"
                onClick={() => {
                  const open = !rightPanelOpen;
                  setRightPanelOpen(open);
                  try { localStorage.setItem('wp-right-panel-open', String(open)); } catch { /* Session state still applies. */ }
                }}
              ><Icon name={rightPanelOpen ? 'panelClose' : 'panelOpen'} size={19} /></button>
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
                    {Boolean(item.attachments?.length) && <div className="mt-2 flex flex-wrap gap-2">{item.attachments!.map((name, index) => <span key={index} className="flex max-w-full items-center gap-2 rounded border border-neutral-700 px-2 py-1 text-xs" title={name}><Icon name={fileIcon(name)} size={20} /><span className="break-all">{name}</span></span>)}</div>}
                  </div>
                </div>
              ) : item.kind === 'assistant' ? (
                <div key={i} className="message-body mb-3 max-w-[85%] text-sm leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text || '…'}</ReactMarkdown>
                </div>
              ) : item.kind === 'thought' ? (
                <ActivityRow key={i} title="思考" summary={(streaming && i === chat.length - 1 ? item.text.trimEnd().split('\n').at(-1) : item.text.split('\n')[0]) ?? ''} output={item.text} running={streaming && i === chat.length - 1} />
              ) : item.kind === 'tool' && item.toolName ? (
                <ActivityRow key={i} title={item.toolDisplayName ?? item.toolName} summary={item.toolState === 'error' ? item.toolOutput?.split('\n')[0] ?? '操作失败' : item.toolDisplayName ? '' : item.text} input={item.toolInput} output={item.toolOutput} running={streaming && ['waiting', 'running'].includes(item.toolState ?? '')} failed={item.toolState === 'error'} status={item.toolDisplayName ? (!streaming && ['waiting', 'running'].includes(item.toolState ?? '') ? '状态待确认' : ({ waiting: '等待授权', running: '执行中', ok: '成功', error: '失败', denied: '已拒绝', stopped: '已停止' }[item.toolState ?? 'running'])) : undefined} durationMs={item.toolDisplayName ? item.durationMs : undefined} />
              ) : item.kind === 'gate' ? (
                <div key={i} className="mb-2 rounded border border-amber-600/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
                  {item.text}
                </div>
              ) : item.kind === 'memory' && item.request ? (
                <div key={i} className="mb-3 rounded-lg border border-blue-600/60 bg-blue-950/40 p-3 text-sm">
                  <p className="mb-2 text-blue-300"><Icon name="memory" /> 记忆写入确认</p>
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
                  <p className="mb-1 font-medium text-amber-300"><Icon name="lock" /> 授权请求：{item.request.reason}</p>
                  {item.request.command && (
                    <p className="mb-1 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-neutral-300">{item.request.tool.startsWith('mcp_') ? '' : '$ '}{item.request.command}</p>
                  )}
                  {item.request.paths.length > 0 && (
                    <p className="mb-2 font-mono text-xs text-neutral-400">
                      路径：{item.request.paths.map((p) => `${p.mode === 'write' ? '[写]' : '[读]'}${p.path}`).join('、')}
                    </p>
                  )}
                  {/* R002：AI 风险解读（异步回填，仅参考不参与判定） */}
                  {item.analysis !== undefined && item.analysis !== '' && (
                    <details className="mb-2 rounded border border-neutral-700 bg-neutral-900/70 px-2 py-1.5" open>
                      <summary className="cursor-pointer text-xs font-medium text-neutral-300"><Icon name="bot" /> AI 风险解读（仅供参考）</summary>
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-neutral-300">{item.analysis}</p>
                    </details>
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
                          本任务会话记住
                        </button>
                        <button
                          className="rounded bg-neutral-700 px-2 py-1 hover:bg-neutral-600"
                          onClick={() => void decide(item, 'forever')}
                        >
                          本任务永久授权
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

          {/* U3/U5 输入区（ZCode 风格：统一圆角容器，文字在上，工具条在下；拖拽/粘贴/托盘已内置） */}
            {/* U3/U5 输入区（ZCode 风格：统一圆角容器，文字在上，工具条在下） */}
          <div
            className={`relative mx-4 mb-3 shrink-0 rounded-xl border bg-neutral-900 p-3 ${dragOver ? 'border-blue-500 border-dashed' : 'border-neutral-700'}`}
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
            }}>
            {/* 附件托盘（多文件并列，右上角 × 移除） */}
            {pendingAtt.length > 0 && (
              <div aria-label="待发送附件" className="mb-3 flex max-h-40 flex-wrap gap-2 overflow-y-auto border-b border-neutral-700 px-1 pb-3 pt-2">
                {pendingAtt.map((a) => (
                  <div key={a.id} className="relative w-44 rounded border border-neutral-700 bg-neutral-900 p-2">
                    <button
                      className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-neutral-600 text-[10px] text-neutral-100 hover:bg-red-600"
                      title="移除"
                      onClick={() => removeAttachment(a.id)}
                    >
                      <Icon name="close" />
                    </button>
                    <p className="flex items-center gap-2 text-xs text-neutral-200"><Icon name={fileIcon(a.name)} size={20} /><span className="truncate">{a.name}</span></p>
                    <p className="text-[10px] text-neutral-500">
                      {a.status === 'error' ? (
                        <span className="text-red-400">上传失败</span>
                      ) : a.status === 'done' ? (
                        <span className="text-emerald-400">已上传 · {(a.file.size / 1024).toFixed(1)} KB</span>
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
                    <Icon name="file" /> {f}
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              className="message-input max-h-40 min-h-[44px] w-full resize-none bg-transparent px-1 py-1 text-sm outline-none"
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
            {/* 底部工具条：左＝附件/模式，右＝模型/发送 */}
            <div className="mt-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  className="rounded px-1.5 py-1 text-sm text-neutral-400 hover:text-neutral-200 disabled:opacity-40"
                  disabled={!activeTask || streaming}
                  title="添加附件（≤50MB，随消息注入）"
                  onClick={() => attachRef?.click()}
                >
                  <Icon name="plus" />
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
                {/* 模式下拉（权限档位，ZCode 命名） */}
                <div className="relative">
                  <button
                    className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-amber-400 hover:bg-neutral-800"
                    onClick={() => setModeMenuOpen((v) => !v)}
                  >
                    <Icon name="shield" /> {tierLabels[tier] ?? tier} <span className="text-neutral-500"><Icon name="down" /></span>
                  </button>
                  {modeMenuOpen && (
                    <div className="absolute bottom-full left-0 mb-1 w-40 overflow-hidden rounded border border-neutral-700 bg-neutral-800 shadow-xl">
                      {(
                        [
                          ['ask', '确认模式'],
                          ['auto', '自动模式'],
                        ] as Array<[Tier, string]>
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-neutral-700 ${tier === key ? 'text-blue-400' : ''}`}
                          onClick={() => {
                            void changeTier(key);
                            setModeMenuOpen(false);
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* 模型选择（仅管理员可切换） */}
                <select
                  className="max-w-[200px] rounded bg-transparent px-1 py-1 text-xs text-neutral-300 outline-none"
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
                    </option>
                  ))}
                </select>
                {streaming ? (
                  <button
                    className="rounded-full bg-red-900 p-2 text-xs hover:bg-red-800"
                    title="停止"
                    onClick={() => {
                      if (activeTask) void api.stop(activeTask.id);
                    }}
                  >
                    <Icon name="stop" />
                  </button>
                ) : (
                  <button
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-sm hover:bg-blue-500 disabled:opacity-40"
                    disabled={!activeTask || streaming || pendingAtt.some(a => a.status === 'uploading') || (input.trim() === '' && pendingAtt.every((a) => a.status !== 'done'))}
                    title="发送"
                    onClick={() => void send()}
                  >
                    <Icon name="up" />
                  </button>
                )}
              </div>
            </div>
            {!isAdmin && providers.length === 0 && (
              <p className="mt-1 text-xs text-red-400">管理员尚未配置模型，请联系管理员。</p>
            )}
          </div>
        </main>

        {/* 分栏拖拽条（中栏 | 右栏） */}
        {rightPanelOpen && <ColResizeHandle onBeginDrag={rightCol.beginDrag} />}

        {/* 右栏：任务侧栏（B02 版本链 + 转写查看器入口）；宽度可拖拽（最小 232px） */}
        <aside id="task-results-panel" aria-label="任务侧栏" hidden={!rightPanelOpen} className={rightPanelOpen ? 'flex shrink-0 flex-col' : 'hidden'} style={{ width: rightCol.width, minWidth: 232 }}>
          {rightPanelOpen && <TaskSidebar taskId={activeTask?.id} steps={planSteps} onSelect={(task) => { void openTask(task).catch((e: unknown) => showToast(String(e))); }} onTranscript={() => setTranscriptOpen(true)} onTasks={(rows) => setTasks(rows.filter(task => !deletedTaskIds.current.has(task.id)))} onRetry={(task) => { void openTask(task).then(() => send(task.status === 'failed' ? '请重试上次未完成的请求，先检查已有结果，避免重复已经完成的操作。' : RESUME_MESSAGE, task)).catch((e: unknown) => showToast(String(e))); }} />}
        </aside>
      </div>

      {currentUser && projectFormOpen && <ProjectModal value={projectForm} error={projectError} onChange={setProjectForm} onCreate={createProject} onClose={() => setProjectFormOpen(false)} />}

      {deleteTarget && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onKeyDown={event => { if (event.key === 'Escape' && !deletingTask) setDeleteTarget(null); }}>
        <section role="dialog" aria-modal="true" aria-labelledby="delete-task-title" className="w-full max-w-md rounded-xl border border-neutral-700 bg-neutral-950 p-5 shadow-xl">
          <h2 id="delete-task-title" className="text-base font-medium">删除任务“{deleteTarget.name}”？</h2>
          <p className="mt-3 text-sm text-neutral-400">将永久删除该任务的对话、任务记忆、产物版本和专属附件。项目共享材料、项目与个人记忆、已下载到本机的文件会保留，此操作无法撤销。</p>
          {deleteError && <p role="alert" className="mt-3 text-sm text-red-400">{deleteError}</p>}
          <div className="mt-5 flex justify-end gap-3">
            <button autoFocus disabled={deletingTask} className="rounded bg-neutral-800 px-4 py-2 text-sm disabled:opacity-50" onClick={() => setDeleteTarget(null)}>取消</button>
            <button disabled={deletingTask} className="rounded bg-red-700 px-4 py-2 text-sm text-white disabled:opacity-50" onClick={() => void confirmDeleteTask()}>{deletingTask ? '正在删除…' : '删除任务'}</button>
          </div>
        </section>
      </div>}

      {transcriptOpen && activeTask && <TranscriptModal taskId={activeTask.id} onClose={() => setTranscriptOpen(false)} />}
      {skillMarketOpen && <SkillMarket canLoad={Boolean(activeTask) && !streaming} onClose={() => setSkillMarketOpen(false)} onLoad={name => { setInput(value => '/' + name + ' ' + value.replace(/^\/[a-z0-9-]+\s*/, '')); setSkillMarketOpen(false); showToast('已选择技能，发送任务时加载'); }} />}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-neutral-800 px-4 py-2 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );

}
