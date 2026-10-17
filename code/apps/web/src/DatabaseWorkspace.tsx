import type {ReactNode} from 'react';
import {DatabaseCitation} from './DatabaseCitation';
import {retrievalStatus} from './chat-content';
import {DatabaseTrash} from './DatabaseTrash';
import {DatabaseAutomations,AutomationDraftNotice} from './DatabaseAutomations';
import { DatabaseSkillBuilds } from './DatabaseSkillBuilds';
import {ExpertSelector,ExpertSuggestions} from './DatabaseExperts';
import { DatabaseParsing } from './DatabaseParsing';
import { DatabaseSummary } from './DatabaseSummary';
import { DatabaseExecutionMode } from './DatabaseExecutionMode';
import { DatabaseModelStatus } from './DatabaseModelStatus';
import { DatabaseExecutionStatus } from './DatabaseExecutionStatus';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DatabaseAttachments, AttachmentLabel, type AttachmentActions } from './DatabaseAttachments';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, clearToken, getToken, jsonFetch } from './api';
import { LoginView } from './LoginView';
import { RequiredPasswordChange } from './AccountAccess';
import { Icon } from './Icon';
import { DatabaseWorkspaceNavigation, DatabaseWorkspaceSidebar } from './DatabaseWorkspaceNavigation';
import { readChatStream } from './chat-stream';
import { DatabaseSettings, type SettingsSection } from './DatabaseSettings';
import { mergeEvents, groupEvents, type StoredEvent, type ConversationPage, type StoredTurn } from './database-chat-state';

interface Task { expertId?:string|null; id: string; name: string; status: string; revision: number; projectId: string | null }
interface Project { id: string; name: string; revision: number }
interface Permission { id: string; request: { tool: string; command?: string }; expiresAt: string }
const errorText = (e: unknown) => e instanceof Error ? e.message : '操作失败，请重试';
const button = 'rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-40';
const selectionKey = (userId: string) => `wp-active-task:${userId}`;
function rememberedTask(userId: string): string | null {
  try { return sessionStorage.getItem(selectionKey(userId)); } catch { return null; }
}
function rememberTask(userId: string, taskId: string | null) {
  try { if (taskId) sessionStorage.setItem(selectionKey(userId), taskId); else sessionStorage.removeItem(selectionKey(userId)); } catch { /* 存储可能被禁用，任务导航仍可使用。 */ }
}

/** 基于数据库的客户端界面，复用现有桌面连接、登录和主题设施。 */
export function DatabaseWorkspace({ chatEnabled, filesEnabled = false }: { chatEnabled: boolean; filesEnabled?: boolean }) {
  const [trashPage,setTrashPage]=useState(location.hash==='#trash');
  useEffect(()=>{const change=()=>setTrashPage(location.hash==='#trash');window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  const [automationPage,setAutomationPage]=useState(location.hash.startsWith('#automations'));
  useEffect(()=>{const change=()=>setAutomationPage(location.hash.startsWith('#automations'));window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  const attachmentControl = useRef<AttachmentActions>(null);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]), [attachmentBlocked, setAttachmentBlocked] = useState(false), [attachmentEpoch, setAttachmentEpoch] = useState(0);
  const attachmentChange = useCallback((ids: string[], blocked: boolean) => { setAttachmentIds(ids); setAttachmentBlocked(blocked); }, []);
  const [auth, setAuth] = useState<Awaited<ReturnType<typeof api.authState>> | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]), [projects, setProjects] = useState<Project[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // 保持渲染器身份稳定，后台事件刷新不能卸载已经打开的引用窗口。
  const citationComponents=useMemo(()=>({a:({href,children}:{href?:string;children?:ReactNode})=>{const match=href?.match(/^#citation\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);return match&&active?<DatabaseCitation taskId={active} chunkId={match[1]!}>{children}</DatabaseCitation>:<a href={href}>{children}</a>;}}),[active]);
  const selectionOwner = useRef<string | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]), [permissions, setPermissions] = useState<Permission[]>([]);
  const [older, setOlder] = useState<string | null>(null), [details, setDetails] = useState<Record<string, { after: string; snapshot: string }>>({});
  const [loading, setLoading] = useState(false), [ready, setReady] = useState(false), [sending, setSending] = useState(false);
  const [error, setError] = useState(''), [input, setInput] = useState('');
  const [newMessages, setNewMessages] = useState(false);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [rightOpen, setRightOpen] = useState(() => localStorage.getItem('wp-right-panel-open') !== 'false');
  const generation = useRef(0);
  const pendingSend = useRef<{ fingerprint: string; id: string } | null>(null);
  const expanding = useRef(new Set<string>());
  const viewport = useRef<HTMLDivElement>(null), follow = useRef(true), loadingRef = useRef(false);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const streams = useRef(new Set<AbortController>());
  const watermark = useRef('0');
  const previousTop = useRef(0);
  const reloadAuth = () => { void api.authState().then(setAuth).catch(e => setError(errorText(e))); };
  useEffect(() => { reloadAuth(); const reset = () => { clearToken(); setAuth(null); reloadAuth(); }; window.addEventListener('wp:unauthorized', reset); return () => { window.removeEventListener('wp:unauthorized', reset); for (const c of streams.current) c.abort(); }; }, []);
  const refreshTasks = async () => { const value = await jsonFetch<{ tasks: Task[] }>('/api/tasks'); setTasks(value.tasks); };
  const refreshWorkspace = async () => {
    const [t, p] = await Promise.all([jsonFetch<{ tasks: Task[] }>('/api/tasks'), jsonFetch<{ projects: Project[] }>('/api/projects')]);
    setTasks(t.tasks); setProjects(p.projects);
    setActive(id => id && t.tasks.some(row => row.id === id) ? id : null);
  };
  useEffect(() => {
    if (!auth?.authenticated || auth.user?.mustChangePassword) return;
    let cancelled = false;
    void Promise.all([jsonFetch<{ tasks: Task[] }>('/api/tasks'), jsonFetch<{ projects: Project[] }>('/api/projects')]).then(([t, p]) => { if (!cancelled) {
      const owner = auth.user?.id;
      const restored = owner ? rememberedTask(owner) : null;
      const sameOwner = selectionOwner.current === owner;
      setTasks(t.tasks); setProjects(p.projects);
      setActive(current => { const candidate = sameOwner ? current : restored; return candidate && t.tasks.some(task => task.id === candidate) ? candidate : null; });
      selectionOwner.current = owner ?? null;
    } }).catch(e => { if (!cancelled) setError(errorText(e)); });
    return () => { cancelled = true; };
  }, [auth]);
  useEffect(() => {
    const owner = auth?.user?.id;
    // 取得已认证任务列表后，再持久化或恢复当前选择。
    if (auth?.authenticated && owner && selectionOwner.current === owner) rememberTask(owner, active);
  }, [active, auth]);
  useEffect(() => {
    const epoch = ++generation.current, controller = new AbortController();
    setAttachmentIds([]); setAttachmentBlocked(false);
    setEvents([]); setPermissions([]); setOlder(null); setDetails({}); setReady(false); setError(''); setNewMessages(false); setInput('');
    follow.current = true; anchor.current = null; loadingRef.current = false; setLoading(false);
    if (!active || !auth?.authenticated) return () => controller.abort();
    const current = () => generation.current === epoch && !controller.signal.aborted;
    const options = { signal: controller.signal };
    let timer: ReturnType<typeof setTimeout>;
    type Changes = { events: StoredEvent[]; nextSequence: string; snapshotSequence: string; hasMore: boolean };
    type State = { pending: Permission[]; tasks: Task[]; expertSuggestions?:unknown[] };
    const apply = (changes: Changes) => {
      if (!current()) return;
      setEvents(rows => mergeEvents(rows, changes.events));
      if (changes.events.length && !follow.current) setNewMessages(true);
      watermark.current = changes.nextSequence;
    };
    const catchup = async () => {
      try {
        // 完成当前固定追赶窗口后，再推进水位。
        let through: string | undefined, more = true;
        while (more && current()) {
          const changes = await jsonFetch<{ events: StoredEvent[]; nextSequence: string; snapshotSequence: string; hasMore: boolean }>(`/api/tasks/${active}/conversation-changes?after=${watermark.current}${through ? `&through=${through}` : ''}`, options);
          if (!current()) return;
          apply(changes); through = changes.snapshotSequence; more = changes.hasMore;
        }
        const [p, t] = await Promise.all([chatEnabled ? jsonFetch<{ pending: Permission[] }>(`/api/tasks/${active}/permissions`, options) : Promise.resolve({ pending: [] }), jsonFetch<{ tasks: Task[] }>('/api/tasks', options)]);
        if (current()) { setPermissions(p.pending); setTasks(t.tasks); }
      } catch (e) { if (current()) setError(errorText(e)); }
    };
    let retry = 1000;
    const subscribe = async () => {
      try {
        const response = await fetch(`/api/tasks/${active}/stream?after=${watermark.current}`, {headers:{Authorization:`Bearer ${getToken() ?? ''}`},signal:controller.signal});
        if (response.status===401) { window.dispatchEvent(new Event('wp:unauthorized')); return; }
        if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw Error('实时连接暂不可用');
        await readChatStream<({type:'changes'} & Changes) | {type:'state';value:State} | {type:'unavailable';status:number}>(response.body,event=>{
          if (!current()) return;
          if(event.type==='changes'){apply(event);retry=1000;}
          else if(event.type==='state'){setPermissions(event.value.pending);setTasks(event.value.tasks);if(event.value.expertSuggestions)window.dispatchEvent(new CustomEvent('wp:expert-suggestions',{detail:{task:active,rows:event.value.expertSuggestions}}));}
          else {if(event.status===401)window.dispatchEvent(new Event('wp:unauthorized'));throw Error('实时连接已失效');}
        },controller.signal);
      } catch { if(current()) await catchup(); }
      finally { if(current()){timer=setTimeout(()=>{void subscribe();},retry);retry=Math.min(retry*2,10000);} }
    };
    void jsonFetch<ConversationPage>(`/api/tasks/${active}/conversation`, options).then(page => {
      if (!current()) return;
      setEvents(page.turns.flatMap(t => t.events)); setOlder(page.nextCursor); watermark.current = page.snapshotSequence;
      setDetails(Object.fromEntries(page.turns.filter(t => t.hasMoreEvents).map(t => [t.id, { after: t.nextEventSequence!, snapshot: page.snapshotSequence }])));
      setReady(true); void subscribe();
    }).catch(e => { if (current()) setError(errorText(e)); });
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, auth, chatEnabled]);
  useLayoutEffect(() => {
    const el = viewport.current; if (!el) return;
    if (anchor.current) {
      const target = el.querySelector<HTMLElement>(`[data-turn="${anchor.current.id}"]`);
      if (target) el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.current.offset;
      anchor.current = null;
    } else if (follow.current) el.scrollTop = el.scrollHeight;
  }, [events, permissions]);
  const loadOlder = async () => {
    if (!active || !older || loadingRef.current || !ready) return;
    const epoch = generation.current, el = viewport.current;
    loadingRef.current = true; setLoading(true);
    try {
      const page = await jsonFetch<ConversationPage>(`/api/tasks/${active}/conversation?before=${encodeURIComponent(older)}`);
      if (generation.current !== epoch) return;
      const top = el && [...el.querySelectorAll<HTMLElement>('[data-turn]')].find(node => node.getBoundingClientRect().bottom > el.getBoundingClientRect().top);
      if (el && top) anchor.current = { id: top.dataset.turn!, offset: top.getBoundingClientRect().top - el.getBoundingClientRect().top };
      follow.current = false;
      setEvents(rows => mergeEvents(rows, page.turns.flatMap(t => t.events))); setOlder(page.nextCursor);
      setDetails(old => ({ ...old, ...Object.fromEntries(page.turns.filter(t => t.hasMoreEvents).map(t => [t.id, { after: t.nextEventSequence!, snapshot: page.snapshotSequence }])) }));
    } catch (e) { if (generation.current === epoch) setError(errorText(e)); }
    finally { if (generation.current === epoch) { loadingRef.current = false; setLoading(false); } }
  };
  const expandTurn = async (id: string) => {
    const epoch = generation.current, detail = details[id]; if (!active || !detail) return;
    try {
      const result = await jsonFetch<Pick<StoredTurn, 'events' | 'hasMoreEvents' | 'nextEventSequence'>>(`/api/tasks/${active}/conversation/${id}/events?after=${detail.after}&snapshot=${detail.snapshot}`);
      if (epoch !== generation.current) return;
      setEvents(rows => mergeEvents(rows, result.events)); setDetails(old => { const next = { ...old }; if (result.hasMoreEvents) next[id] = { ...detail, after: result.nextEventSequence! }; else delete next[id]; return next; });
    } catch (e) { if (epoch === generation.current) setError(errorText(e)); }
  };
  const expandContent = async (event: StoredEvent) => {
    if (!active || expanding.current.has(event.id)) return;
    const epoch = generation.current, taskId = active;
    expanding.current.add(event.id);
    try {
      let offset: number | null = 0, content = '';
      while (offset !== null && epoch === generation.current) {
        const part: { content: string; nextOffset: number | null } = await jsonFetch(`/api/tasks/${taskId}/conversation-events/${event.id}/content?offset=${offset}`);
        content += part.content; offset = part.nextOffset;
      }
      if (epoch === generation.current) setEvents(rows => mergeEvents(rows, [{ ...event, content, truncated: false }]));
    } catch (e) { if (epoch === generation.current) setError(errorText(e)); }
    finally { expanding.current.delete(event.id); }
  };
  const send = async () => {
    if (!chatEnabled || !active || (!input.trim() && !attachmentIds.length) || attachmentBlocked || sending) return;
    const taskId = active, epoch = generation.current, content = input.trim() || '请查看附件。', controller = new AbortController();
    const fingerprint = JSON.stringify([taskId, content, attachmentIds]);
    if (pendingSend.current?.fingerprint !== fingerprint) pendingSend.current = { fingerprint, id: crypto.randomUUID() };
    const requestId = pendingSend.current.id;
    streams.current.add(controller); setSending(true); setError(''); follow.current = true;
    try {
      const response = await fetch(`/api/tasks/${taskId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}` }, body: JSON.stringify({ content, requestId, attachments: attachmentIds }), signal: controller.signal });
      if (!response.ok) throw new Error(((await response.json()) as { error: string }).error);
      if (pendingSend.current?.id === requestId) pendingSend.current = null;
      if (epoch === generation.current) { setInput(''); setAttachmentIds([]); setAttachmentBlocked(false); setAttachmentEpoch(v => v + 1); }
      if (response.status !== 202 && response.body) await readChatStream(response.body, () => { /* 只使用持久化追赶结果展示，避免流内容重复。 */ }, controller.signal);
    } catch (e) { if (epoch === generation.current) setError(errorText(e)); }
    finally { streams.current.delete(controller); setSending(false); void refreshTasks().catch(() => {}); }
  };
  const decide = async (id: string, decision: 'allow' | 'deny') => {
    const taskId = active, epoch = generation.current;
    try { await jsonFetch(`/api/tasks/${taskId}/permissions/${id}`, { method: 'POST', body: JSON.stringify({ decision, scope: 'once' }) }); if (epoch === generation.current) setPermissions(rows => rows.filter(p => p.id !== id)); }
    catch (e) { if (epoch === generation.current) setError(errorText(e)); }
  };
  if (!auth) return <div className="p-6">{error || '正在连接后台…'}<button className={button} onClick={reloadAuth}>重试</button></div>;
  if (!auth.authenticated) return <LoginView needsSetup={auth.needsSetup} setupTokenRequired={auth.setupTokenRequired} onAuthed={reloadAuth} />;
  if (auth.user?.mustChangePassword) return <RequiredPasswordChange onDone={reloadAuth} />;
  const task = tasks.find(t => t.id === active), busy = sending || ['running', 'queued', 'waiting'].includes(task?.status ?? '');
  if(trashPage)return <DatabaseTrash onBack={()=>{location.hash='';void refreshWorkspace();}}/>;
  if(automationPage)return <DatabaseAutomations username={auth.user?.username} onBack={()=>{location.hash='';}} onLogout={()=>{void api.logout().finally(()=>{clearToken();reloadAuth();});}}/>;
  return <div className="workspace-shell flex h-screen bg-neutral-950 text-neutral-100">
    <DatabaseWorkspaceNavigation onAutomations={()=>{location.hash='automations';}} projects={projects} tasks={tasks} active={active} username={auth.user?.username} onSelect={setActive} onRefresh={refreshWorkspace} onSettings={section => setSettings(section)} onError={setError} onLogout={() => { void api.logout().finally(() => { for (const c of streams.current) c.abort(); clearToken(); setActive(null); setTasks([]); reloadAuth(); }); }} />
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2 text-xs"><h1 className="min-w-0 flex-1 truncate text-left text-sm font-medium">{projects.find(p => p.id === task?.projectId)?.name ?? '临时任务'} / {task?.name ?? '选择任务'}</h1><button className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-100 hover:bg-neutral-800" aria-label={rightOpen ? '收起右侧任务侧栏' : '展开右侧任务侧栏'} aria-expanded={rightOpen} aria-controls="task-results-panel" onClick={() => { setRightOpen(!rightOpen); localStorage.setItem('wp-right-panel-open', String(!rightOpen)); }}><Icon name={rightOpen ? 'panelClose' : 'panelOpen'} size={19} /></button></header>
      {task && <ExpertSelector task={task} project={projects.find(p=>p.id===task.projectId)} onChanged={refreshWorkspace}/>}
      {error && <div role="alert" className="px-6 py-2 text-sm text-red-400">{error}<button className="ml-3 underline" onClick={() => { setError(''); if (!ready) { setAuth({ ...auth }); } else void loadOlder(); }}>重试</button></div>}
      <div ref={viewport} aria-label="聊天记录" className="min-h-0 flex-1 overflow-y-auto px-6 py-4" onWheel={e => { if (e.deltaY < 0 && e.currentTarget.scrollTop < 32) { follow.current = false; void loadOlder(); } }} onScroll={e => { const el = e.currentTarget; const upward = el.scrollTop < previousTop.current; previousTop.current = el.scrollTop; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; if (upward && el.scrollTop < 32) void loadOlder(); }}>
        {!active && <p className="mt-10 text-center text-sm text-neutral-500">选择或新建一个任务，发送第一条消息开始工作</p>}
        {active && <AutomationDraftNotice taskId={active}/>}
        {active && <p className="mb-3 text-center text-xs text-neutral-500">{loading ? '正在加载…' : !ready ? '正在读取对话…' : older ? '向上滚动查看更早对话' : '已到最早消息'}</p>}
        {active && <ExpertSuggestions key={"expert-"+active} task={active}/>} 
        {groupEvents(events).map(group => <section key={group.id} data-turn={group.id} className="mb-6">
          {group.events.map(e => e.kind === 'meta' ? null : <div key={e.id} className={`mb-3 ${e.kind === 'user' ? 'workspace-message ml-auto max-w-[75%] rounded-lg bg-neutral-800 px-3 py-2 text-sm' : 'message-body workspace-message max-w-none text-sm'}`}>
            {e.kind === 'thinking' || e.kind.startsWith('tool_') ? <details><summary className="cursor-pointer whitespace-nowrap text-sm text-neutral-400">{e.kind === 'thinking' ? '思考' : '工具调用'}</summary><pre className="whitespace-pre-wrap break-words text-xs">{e.content}</pre></details> : <ReactMarkdown remarkPlugins={[remarkGfm]} components={e.kind==='assistant'?citationComponents:undefined}>{e.content}</ReactMarkdown>}
            {e.kind==='tool_result'&&retrievalStatus(e.content)&&<p role="status" className="my-2 text-xs text-neutral-400">{retrievalStatus(e.content)}</p>}
            {e.truncated && <button className={button} onClick={() => { void expandContent(e); }}>展开完整内容</button>}
            {!!e.attachments?.length && <div className="mt-2 flex flex-wrap gap-2">{e.attachments.map(a => <AttachmentLabel key={a.id} attachment={a} />)}</div>}
          </div>)}
          {details[group.id] && <button className={button} onClick={() => { void expandTurn(group.id); }}>查看本次对话的更多过程</button>}
        </section>)}
        {active && <DatabaseSummary key={'summary-'+active} taskId={active} busy={busy} />}
        {active && <DatabaseParsing key={"parse-"+active} taskId={active} />}
        {active && <DatabaseExecutionStatus key={active} taskId={active} />}
        {active && <DatabaseSkillBuilds key={'skills-'+active} taskId={active} autoOpen />}
        {permissions.map(p => <div key={p.id} className="mb-3 rounded border border-neutral-700 p-4"><strong>{p.request.tool === 'execute_skill' ? '确认隔离执行' : '确认外部工具调用'}</strong>{p.request.tool === 'execute_skill' && <p className="mt-2 text-sm text-neutral-400">在无网络隔离环境处理所选文件，仅保存指定成果。本次允许不会变成永久授权。</p>}<pre className="my-3 whitespace-pre-wrap break-words text-sm">{p.request.command ?? p.request.tool}</pre><button className={button} onClick={() => { void decide(p.id, 'deny'); }}>拒绝</button><button className={button + ' ml-2'} onClick={() => { void decide(p.id, 'allow'); }}>允许本次</button></div>)}
      </div>
      {newMessages && <button className={button} onClick={() => { follow.current = true; if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; setNewMessages(false); }}>查看新消息</button>}
      <form className="workspace-composer mx-4 mb-4 rounded-2xl border border-neutral-700 bg-neutral-900/50 p-3" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); attachmentControl.current?.addFiles(Array.from(e.dataTransfer.files)); } }} onPaste={e => { if (e.clipboardData.files.length) { e.preventDefault(); attachmentControl.current?.addFiles(Array.from(e.clipboardData.files)); } }} onSubmit={e => { e.preventDefault(); void send(); }}>
        {filesEnabled && active && <DatabaseAttachments ref={attachmentControl} key={`${active}:${attachmentEpoch}`} taskId={active} disabled={busy || !ready} onChange={attachmentChange} />}
        <textarea aria-label="消息" value={input} disabled={!chatEnabled || !active || busy || !ready} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} placeholder={chatEnabled ? active ? '输入消息，Enter 发送，Shift + Enter 换行' : '请先新建/选择任务' : '后台尚未启用对话执行'} className="message-input max-h-48 min-h-[88px] w-full resize-none bg-transparent px-1 py-1 text-sm outline-none" />
        <div className="composer-footer"><div className="flex shrink-0 items-center gap-2">{filesEnabled && <button type="button" aria-label="添加文件" title="添加文件（最多10个，单个10MB）；也可拖拽或粘贴" disabled={!active || busy || !ready || attachmentBlocked || attachmentIds.length >= 10} className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40" onClick={() => attachmentControl.current?.open()}><Icon name="plus" size={22} /></button>}<DatabaseExecutionMode /></div><div className="composer-actions"><DatabaseModelStatus />{busy && <button type="button" className={button} onClick={() => { void jsonFetch(`/api/tasks/${active}/stop`, { method: 'POST' }).catch(e => setError(errorText(e))); }}>停止</button>}<button title="发送" aria-label="发送" className="composer-send flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-950 hover:opacity-80 disabled:opacity-40" disabled={!chatEnabled || !active || busy || !ready || attachmentBlocked || (!input.trim() && !attachmentIds.length)}><Icon name="up" size={18} /></button></div></div>
      </form>
    </main>
    {rightOpen && <DatabaseWorkspaceSidebar active={active} tasks={tasks} onSelect={setActive} onSettings={() => setSettings('mcp')} />}
    {settings && <DatabaseSettings initialSection={settings} configurationEnabled={chatEnabled} onClose={() => setSettings(null)} onChanged={refreshWorkspace} />}
  </div>;
}
