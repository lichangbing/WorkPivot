import {AutomaticResourceScope,type ResourceSelection} from './DatabaseResourceScope';
import { WorkspaceRightPanel } from './WorkspaceRightPanel';
import { DatabaseFloating } from './DatabaseFloating';
import type {ReactNode} from 'react';
import {DatabaseCitation} from './DatabaseCitation';
import {DatabaseTurnProcess,isProcessEvent} from './DatabaseTurnProcess';
import {DatabaseTrash} from './DatabaseTrash';
import {DatabaseAutomations,AutomationDraftNotice} from './DatabaseAutomations';
import { BusinessFactsPanel } from './BusinessFactsPanel';
import { DatabaseSkillBuilds } from './DatabaseSkillBuilds';
import {ExpertSelector,ExpertSuggestions} from './DatabaseExperts';
import { DatabaseParsing } from './DatabaseParsing';
import { DatabaseSummary } from './DatabaseSummary';
import { DatabaseExecutionMode } from './DatabaseExecutionMode';
import { DatabaseModelStatus } from './DatabaseModelStatus';
import { DatabaseExecutionStatus } from './DatabaseExecutionStatus';
import { MemorySuggestions } from './MemorySuggestions';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DatabaseAttachments, AttachmentLabel, type AttachmentActions } from './DatabaseAttachments';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, clearToken, getToken, jsonFetch, setToken } from './api';
import { LoginView } from './LoginView';
import { RequiredPasswordChange } from './AccountAccess';
import { Icon } from './Icon';
import { DatabaseWorkspaceNavigation } from './DatabaseWorkspaceNavigation';
import { readChatStream } from './chat-stream';
import { DatabaseSettings, type SettingsSection } from './DatabaseSettings';
import { mergeEvents, groupEvents, type StoredEvent, type ConversationPage, type StoredTurn } from './database-chat-state';
import { displayUserMessageContent } from './chat-content';
import { InteractionDock } from './InteractionDock';
import type { InteractionEnvelope, InteractionResponse, SteeringMessage } from '@workpivot/shared';

interface Task { expertId?:string|null; id: string; name: string; status: string; revision: number; projectId: string | null }
interface Project { id: string; name: string; revision: number }
const errorText = (e: unknown) => e instanceof Error ? e.message : '操作失败，请重试';
const button = 'rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-40';
const rightPanelMinimum = 320, rightPanelMaximum = 900;
const navigationWidth = 256, conversationMinimum = 360, separatorWidth = 8;
function rightPanelViewportLimit() {
  if (typeof window === 'undefined') return rightPanelMaximum;
  return Math.min(rightPanelMaximum, window.innerWidth - navigationWidth - conversationMinimum - separatorWidth);
}
function defaultRightPanelWidth() {
  return typeof window === 'undefined' ? 520 : Math.max(rightPanelMinimum, Math.min(760, Math.round(window.innerWidth * 0.42)));
}
function boundedRightPanelWidth(value: number) {
  return Math.max(rightPanelMinimum, Math.min(rightPanelViewportLimit(), Math.round(value)));
}
function rememberRightPanelWidth(value: number) {
  try { localStorage.setItem('wp-right-panel-width', String(value)); } catch { /* 存储被禁用时仍保留当前会话内的宽度。 */ }
}
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
  const [resourceSelection,setResourceSelection]=useState<ResourceSelection|null>(null);
  const resourceChange=useCallback((value:ResourceSelection|null)=>setResourceSelection(value),[]);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]), [attachmentBlocked, setAttachmentBlocked] = useState(false), [attachmentEpoch, setAttachmentEpoch] = useState(0);
  const attachmentChange = useCallback((ids: string[], blocked: boolean) => { setAttachmentIds(ids); setAttachmentBlocked(blocked); }, []);
  const [auth, setAuth] = useState<Awaited<ReturnType<typeof api.authState>> | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]), [projects, setProjects] = useState<Project[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // 保持渲染器身份稳定，后台事件刷新不能卸载已经打开的引用窗口。
  const citationComponents=useMemo(()=>({a:({href,children}:{href?:string;children?:ReactNode})=>{const match=href?.match(/^#citation\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);return match&&active?<DatabaseCitation taskId={active} chunkId={match[1]!}>{children}</DatabaseCitation>:<a href={href}>{children}</a>;}}),[active]);
  const selectionOwner = useRef<string | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]), [interactions, setInteractions] = useState<InteractionEnvelope[]>([]), [steering, setSteering] = useState<SteeringMessage[]>([]);
  const [interactionBusy, setInteractionBusy] = useState<string | null>(null);
  const groupedEvents = useMemo(() => groupEvents(events), [events]);
  const latestTurnId = groupedEvents.at(-1)?.id;
  const [older, setOlder] = useState<string | null>(null), [details, setDetails] = useState<Record<string, { after: string; snapshot: string }>>({});
  const [loading, setLoading] = useState(false), [ready, setReady] = useState(false), [sending, setSending] = useState(false);
  const [error, setError] = useState(''), [input, setInput] = useState('');
  const [newMessages, setNewMessages] = useState(false);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [businessFactsOpen, setBusinessFactsOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(() => localStorage.getItem('wp-right-panel-open') !== 'false');
  const [rightWidth, setRightWidth] = useState(() => {
    const stored = Number(localStorage.getItem('wp-right-panel-width'));
    return Number.isFinite(stored) && stored > 0 ? boundedRightPanelWidth(stored) : defaultRightPanelWidth();
  });
  useEffect(() => {
    const resize = () => setRightWidth(width => boundedRightPanelWidth(width));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const generation = useRef(0);
  const pendingSend = useRef<{ fingerprint: string; id: string } | null>(null);
  const expanding = useRef(new Set<string>());
  const viewport = useRef<HTMLDivElement>(null), follow = useRef(true), loadingRef = useRef(false);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const streams = useRef(new Set<AbortController>());
  const watermark = useRef('0');
  const [cacheNotice,setCacheNotice]=useState('');
  const cacheLease=useRef<{handle:string;epoch:number;task:string}|null>(null);
  useEffect(()=>{const clear=()=>{cacheLease.current=null;setCacheNotice('本地副本已清空，重新打开任务后恢复本地保存');};window.addEventListener('wp:conversation-cache-cleared',clear);return()=>window.removeEventListener('wp:conversation-cache-cleared',clear);},[]);
  useEffect(()=>{
    const bridge=window.workpivotDesktop?.conversationCache;
    if(!bridge||!auth?.authenticated)return;
    let cancelled=false;
    const reconcile=async()=>{try{const token=getToken();if(!token)return;const handle=await bridge.open(token);const allowed=await bridge.reconcile(handle,token);if(!cancelled)setTasks(rows=>rows.filter(task=>allowed.includes(task.id)));}catch{if(!cancelled)setCacheNotice('本地记录暂未完成权限与删除同步');}};
    void reconcile();const timer=setInterval(()=>{void reconcile();},30000);
    return()=>{cancelled=true;clearInterval(timer);};
  },[auth, tasks.map(task=>task.id).sort().join(',')]);
  useEffect(()=>{
    const bridge=window.workpivotDesktop?.conversationCache,lease=cacheLease.current;
    if(!bridge||!lease||lease.task!==active||!ready)return;
    const snapshot:LocalConversationSnapshot={events,details,older,sequence:watermark.current,savedAt:new Date().toISOString()};
    void bridge.write(lease.handle,lease.task,lease.epoch,snapshot).catch(reason=>{if(cacheLease.current===lease)setCacheNotice(reason instanceof Error?reason.message:'本地会话保存失败');});

  },[events,details,older,ready,active]);

  const previousTop = useRef(0);
  const reloadAuth = () => {
    void (async () => {
      const params = new URLSearchParams(location.search), ticket = params.get('oidc_ticket');
      if (ticket) {
        try {
          const result = await jsonFetch<{ token: string }>('/api/auth/oidc/complete', {
            method: 'POST', body: JSON.stringify({ ticket }),
          });
          setToken(result.token);
        } finally {
          params.delete('oidc_ticket');
          const query = params.toString();
          history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
        }
      }
      setAuth(await api.authState());
    })().catch(e => setError(errorText(e)));
  };
  useEffect(() => {
    const resetsAt = auth?.quota?.resetsAt;
    if (!resetsAt) return;
    const delay = Date.parse(resetsAt) - Date.now();
    if (!Number.isFinite(delay)) return;
    const timer = setTimeout(reloadAuth, Math.max(1000, delay + 500));
    return () => clearTimeout(timer);
  }, [auth?.quota?.resetsAt]);
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
    if (!auth?.authenticated || auth.user?.mustChangePassword || !auth.user?.id) return;
    let stopped = false, after = '0', delay = 1000;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    const connect = async () => {
      try {
        const response = await fetch(`/api/workspace/stream?after=${after}`, {
          headers: { Authorization: `Bearer ${getToken() ?? ''}` },
          signal: controller.signal,
        });
        if (response.status === 401) { window.dispatchEvent(new Event('wp:unauthorized')); return; }
        if (!response.ok || !response.body) throw Error('工作区同步连接不可用');
        await readChatStream<{ type: 'workspace'; value: { tasks: Task[]; projects: Project[]; revision: string } } | { type: 'unavailable'; status: number }>(response.body, event => {
          if (stopped) return;
          if (event.type === 'unavailable') {
            if (event.status === 401) window.dispatchEvent(new Event('wp:unauthorized'));
            else after = '0';
            throw Error('工作区同步已中断');
          }
          after = event.value.revision;
          setTasks(event.value.tasks);
          setProjects(event.value.projects);
          setActive(current => current && event.value.tasks.some(task => task.id === current) ? current : null);
          delay = 1000;
        }, controller.signal, 60000);
      } catch {
        if (!stopped && !controller.signal.aborted) retry = setTimeout(() => { void connect(); }, delay);
        delay = Math.min(delay * 2, 10000);
      }
    };
    void connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      controller.abort();
    };
  }, [auth?.authenticated, auth?.user?.id, auth?.user?.mustChangePassword]);
  useEffect(()=>{if(active&&selectionOwner.current===auth?.user?.id&&!tasks.some(task=>task.id===active))setActive(null);},[tasks,active,auth]);
  useEffect(() => {
    const owner = auth?.user?.id;
    // 取得已认证任务列表后，再持久化或恢复当前选择。
    if (auth?.authenticated && owner && selectionOwner.current === owner) rememberTask(owner, active);
  }, [active, auth]);
  useEffect(() => {
    const epoch = ++generation.current, controller = new AbortController();
    cacheLease.current=null;setCacheNotice('');
    setResourceSelection(null);setAttachmentIds([]); setAttachmentBlocked(false);
    setEvents([]); setInteractions([]); setSteering([]); setOlder(null); setDetails({}); setReady(false); setError(''); setNewMessages(false); setInput('');
    follow.current = true; anchor.current = null; loadingRef.current = false; setLoading(false);
    if (!active || !auth?.authenticated) return () => controller.abort();
    const current = () => generation.current === epoch && !controller.signal.aborted;
    const options = { signal: controller.signal };
    let timer: ReturnType<typeof setTimeout>;
    let initialRetry: ReturnType<typeof setTimeout>;
    type Changes = { events: StoredEvent[]; nextSequence: string; snapshotSequence: string; hasMore: boolean };
    type State = { tasks: Task[]; interactions?: InteractionEnvelope[]; steering?: SteeringMessage[]; expertSuggestions?:unknown[] };
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
        const [p, t, s] = await Promise.all([
          chatEnabled ? jsonFetch<{ interactions: InteractionEnvelope[] }>(`/api/tasks/${active}/interactions`, options) : Promise.resolve({ interactions: [] }),
          jsonFetch<{ tasks: Task[] }>('/api/tasks', options),
          chatEnabled ? jsonFetch<{ steering: SteeringMessage[] }>(`/api/tasks/${active}/steering`, options) : Promise.resolve({ steering: [] }),
        ]);
        if (current()) { setInteractions(p.interactions); setTasks(t.tasks); setSteering(s.steering ?? []); }
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
          else if(event.type==='state'){if(event.value.interactions)setInteractions(event.value.interactions);if(event.value.steering)setSteering(event.value.steering);setTasks(event.value.tasks);if(event.value.expertSuggestions)window.dispatchEvent(new CustomEvent('wp:expert-suggestions',{detail:{task:active,rows:event.value.expertSuggestions}}));}
          else {if(event.status===401)window.dispatchEvent(new Event('wp:unauthorized'));throw Error('实时连接已失效');}
        },controller.signal);
      } catch { if(current()) await catchup(); }
      finally { if(current()){timer=setTimeout(()=>{void subscribe();},retry);retry=Math.min(retry*2,10000);} }
    };
    const initialize = async () => {
      let cached:LocalConversationSnapshot|null=null;
      const bridge=window.workpivotDesktop?.conversationCache;
      if(bridge){
        try{const token=getToken();if(token){const handle=await bridge.open(token);const local=await bridge.read(handle,active);if(!current())return;cacheLease.current={handle,epoch:local.epoch,task:active};cached=local.snapshot;
          if(cached){setEvents(cached.events);setDetails(cached.details);setOlder(cached.older);setCacheNotice('已读取本地会话，正在与服务端同步…');}
        }}catch(reason){if(current())setCacheNotice(reason instanceof Error?reason.message:'本地记录不可用，改从服务端读取');}
      }
      try{
        const page=await jsonFetch<ConversationPage>(`/api/tasks/${active}/conversation`,options);
        if(!current())return;
        const retain=cached&&BigInt(cached.sequence)<=BigInt(page.snapshotSequence)?cached:null;
        if(cached&&!retain&&bridge&&cacheLease.current){const lease=cacheLease.current;await bridge.discard(lease.handle,active);const local=await bridge.read(lease.handle,active);if(!current())return;cacheLease.current={...lease,epoch:local.epoch};}

        setEvents(mergeEvents(retain?.events??[],page.turns.flatMap(t=>t.events)));
        setOlder(retain?retain.older:page.nextCursor);
        setDetails({...retain?.details,...Object.fromEntries(page.turns.filter(t=>t.hasMoreEvents).map(t=>[t.id,{after:t.nextEventSequence!,snapshot:page.snapshotSequence}]))});
        watermark.current=retain?.sequence??page.snapshotSequence;
        // 从本地水位补齐离开期间的全部事件，不能只拼接最新五轮。
        if(retain){let more=true;while(more&&current()){
          const changes=await jsonFetch<Changes>(`/api/tasks/${active}/conversation-changes?after=${watermark.current}&through=${page.snapshotSequence}`,options);
          if(!current())return;
          if(changes.hasMore&&BigInt(changes.nextSequence)<=BigInt(watermark.current))throw Error('会话同步未前进，请重试');
          apply(changes);more=changes.hasMore;
        }}
        if(!current())return;
        setReady(true);setError('');if(cacheLease.current)setCacheNotice('会话已与服务端同步，自动保存到本机');void subscribe();
      }catch(reason){if(current()){setError(errorText(reason));if(cached)setCacheNotice('正在显示本地会话，服务端尚未确认；恢复连接后自动同步');initialRetry=setTimeout(()=>{void initialize();},5000);}}
    };
    void initialize();
    return () => { controller.abort(); clearTimeout(timer); clearTimeout(initialRetry); };

  }, [active, auth, chatEnabled]);
  useLayoutEffect(() => {
    const el = viewport.current; if (!el) return;
    if (anchor.current) {
      const target = el.querySelector<HTMLElement>(`[data-turn="${anchor.current.id}"]`);
      if (target) el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.current.offset;
      anchor.current = null;
    } else if (follow.current) el.scrollTop = el.scrollHeight;
  }, [events, interactions]);
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
      if (result.hasMoreEvents && (!result.nextEventSequence || BigInt(result.nextEventSequence) <= BigInt(detail.after))) throw Error('过程分页未前进，请重试');
      setEvents(rows => mergeEvents(rows, result.events)); setDetails(old => { const next = { ...old }; if (result.hasMoreEvents) next[id] = { ...detail, after: result.nextEventSequence! }; else delete next[id]; return next; });
    } catch (e) { if (epoch === generation.current) throw e; }
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
    } catch (e) { if (epoch === generation.current) throw e; }
    finally { expanding.current.delete(event.id); }
  };
  const send = async (override?: string, options?: { scope?: ResourceSelection; answerOnly?: boolean }) => {
    const text = (override ?? input).trim();
    const scope = options?.scope ?? resourceSelection;
    const attachments = options?.answerOnly ? [] : attachmentIds;
    const currentTask = tasks.find(item => item.id === active);
    const running = ['running', 'waiting', 'queued'].includes(currentTask?.status ?? '');
    if (!running && quotaBlocked) { setError('演示额度已用完，每日北京时间 12:00 刷新'); return; }
    if (!chatEnabled || !active || !scope || (!text && !attachments.length) || (!options?.answerOnly && attachmentBlocked) || sending) return;
    if (running && !text) return;
    const taskId = active, epoch = generation.current, content = text || '请查看附件。', controller = new AbortController();
    const fingerprint = JSON.stringify([taskId, content, attachments, scope]);
    if (pendingSend.current?.fingerprint !== fingerprint) pendingSend.current = { fingerprint, id: crypto.randomUUID() };
    const requestId = pendingSend.current.id;
    streams.current.add(controller); setSending(true); setError(''); follow.current = true;
    try {
      if (running && !options?.answerOnly) {
        if (attachments.length) throw new Error('任务运行中暂不支持新增附件，请作为新任务发送或在当前步骤结束后再补充。');
        const steeringResponse = await fetch(`/api/tasks/${taskId}/steering`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}` },
          body: JSON.stringify({ content, requestId }),
          signal: controller.signal,
        });
        if (!steeringResponse.ok) throw new Error(((await steeringResponse.json()) as { error: string }).error);
        const result = await steeringResponse.json() as { steering: SteeringMessage };
        pendingSend.current = null;
        if (epoch === generation.current) { setInput(''); setSteering(rows => [...rows.filter(row => row.id !== result.steering.id), result.steering]); }
        return;
      }
      const response = await fetch(`/api/tasks/${taskId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}` }, body: JSON.stringify({ content, requestId, attachments, resourceScope: scope }), signal: controller.signal });
      if (!response.ok) throw new Error(((await response.json()) as { error: string }).error);
      if (pendingSend.current?.id === requestId) pendingSend.current = null;
      if (epoch === generation.current && !options?.answerOnly) { setInput(''); setAttachmentIds([]); setAttachmentBlocked(false); setAttachmentEpoch(v => v + 1); }
      await response.body?.cancel().catch(() => undefined);
    } catch (e) { if (epoch === generation.current) setError(errorText(e)); }
    finally { streams.current.delete(controller); setSending(false); void refreshTasks().catch(() => {}); reloadAuth(); }
  };
  const beginRightResize = useCallback((event: {clientX:number; preventDefault:()=>void}) => {
    event.preventDefault();
    const startX = event.clientX, startWidth = rightWidth;
    const move = (next: PointerEvent) => setRightWidth(boundedRightPanelWidth(startWidth + startX - next.clientX));
    const stop = (next: PointerEvent) => {
      const width = boundedRightPanelWidth(startWidth + startX - next.clientX);
      setRightWidth(width);
      rememberRightPanelWidth(width);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }, [rightWidth]);
  const respondToInteraction = async (interaction: InteractionEnvelope, response: InteractionResponse) => {
    if (!active || interactionBusy || !ready) return;
    const taskId = active, epoch = generation.current;
    const controller = new AbortController();
    streams.current.add(controller);
    setInteractionBusy(interaction.id); setError('');
    try {
      let scope = resourceSelection;
      if (!scope) {
        const result = await jsonFetch<{ scope: ResourceSelection }>(`/api/tasks/${taskId}/resource-scope`);
        scope = { scheduleIds: result.scope.scheduleIds ?? [], versionIds: result.scope.versionIds, memoryScopes: result.scope.memoryScopes, expert: result.scope.expert, baseRunId: result.scope.baseRunId };
      }
      const result = await api.respondToInteraction(taskId, interaction.id, { revision: interaction.revision, response, requestId: crypto.randomUUID(), resourceScope: scope });
      if (!result.ok) throw new Error(((await result.json()) as { error?: string }).error ?? '交互提交失败');
      if (result.headers.get('content-type')?.includes('text/event-stream') && result.body) {
        setSending(true); follow.current = true;
        await readChatStream(result.body, () => { /* 通过持久事件追赶展示。 */ }, controller.signal);
      }
      if (epoch === generation.current) {
        setInteractions(rows => rows.filter(row => row.id !== interaction.id));
        const latest = await api.listInteractions(taskId);
        if (epoch === generation.current) setInteractions(latest.interactions);
      }
    } catch (reason) {
      if (epoch === generation.current) setError(errorText(reason));
    } finally {
      streams.current.delete(controller);
      if (epoch === generation.current) { setInteractionBusy(null); setSending(false); void refreshTasks().catch(() => {}); reloadAuth(); }
    }
  };
  const cancelSteering = async (id: string) => {
    if (!active) return;
    try {
      await jsonFetch(`/api/tasks/${active}/steering/${id}`, { method: 'DELETE' });
      setSteering(rows => rows.filter(row => row.id !== id));
    } catch (reason) { setError(errorText(reason)); }
  };
  // R006：中断后一键续跑，继承检查点与剩余步数。
  const resume = async () => {
    if (!active || !ready || busy) return;
    const taskId = active, epoch = generation.current, controller = new AbortController();
    streams.current.add(controller); setSending(true); setError(''); follow.current = true;
    try {
      const response = await fetch(`/api/tasks/${taskId}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}` }, body: JSON.stringify({ requestId: crypto.randomUUID() }), signal: controller.signal });
      if (!response.ok) throw new Error(((await response.json()) as { error: string }).error);
      if (response.status !== 202 && response.body) await readChatStream(response.body, () => { /* 事件通过持久化追赶展示。 */ }, controller.signal);
    } catch (e) { if (epoch === generation.current) setError(errorText(e)); }
    finally { streams.current.delete(controller); setSending(false); void refreshTasks().catch(() => {}); void reloadAuth(); }
  };
  if (!auth) return <div className="p-6">{error || '正在连接后台…'}<button className={button} onClick={reloadAuth}>重试</button></div>;
  if (!auth.authenticated) return <LoginView needsSetup={auth.needsSetup} setupTokenRequired={auth.setupTokenRequired} registrationEnabled={auth.registrationEnabled} defaultMessageQuota={auth.defaultMessageQuota} defaultTokenQuota={auth.defaultTokenQuota} oidcProviders={auth.oidcProviders} onAuthed={reloadAuth} />;
  if (auth.user?.mustChangePassword) return <RequiredPasswordChange onDone={reloadAuth} />;
  const quotaRemaining = auth.quota?.remaining ?? null;
  const quotaBlocked = quotaRemaining !== null && quotaRemaining <= 0;
  const task = tasks.find(t => t.id === active), taskBusy = ['running', 'queued', 'waiting'].includes(task?.status ?? ''), busy = sending || taskBusy;
  const pendingInteractions = interactions.filter(item => item.state === 'pending');
  const activeInteraction = pendingInteractions.find(item => item.blocking) ?? pendingInteractions[0];
  const queuedInteractions = Math.max(0, pendingInteractions.filter(item => item.blocking).length - 1);
  const leaveTrash = () => { setTrashPage(false); if (location.hash === '#trash') location.hash = ''; };
  const selectTask = (id: string) => { leaveTrash(); setActive(id); };
  if(automationPage)return <DatabaseAutomations username={auth.user?.username} onBack={()=>{location.hash='';}} onLogout={()=>{void api.logout().finally(()=>{clearToken();reloadAuth();});}}/>;
  return <div className="workspace-shell flex h-screen bg-neutral-950 text-neutral-100">
    <DatabaseWorkspaceNavigation onAutomations={()=>{location.hash='automations';}} trashActive={trashPage} onProjectSelect={id => { if (trashPage) { leaveTrash(); setActive(current => tasks.some(t => t.id === current && t.projectId === id) ? current : tasks.find(t => t.projectId === id)?.id ?? null); } }} projects={projects} tasks={tasks} active={trashPage ? null : active} username={auth.user?.username} onSelect={selectTask} onRefresh={refreshWorkspace} onSettings={section => setSettings(section)} onError={setError} onLogout={() => { void api.logout().finally(() => { for (const c of streams.current) c.abort(); clearToken(); setActive(null); setTasks([]); reloadAuth(); }); }} />
    {trashPage && <DatabaseTrash onBack={leaveTrash} onChanged={refreshWorkspace} />}
    <main style={trashPage ? { display: 'none' } : undefined} className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2 text-xs"><h1 className="min-w-0 flex-1 truncate text-left text-sm font-medium">{projects.find(p => p.id === task?.projectId)?.name ?? '临时任务'} / {task?.name ?? '选择任务'}</h1><button disabled={!task?.projectId} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-neutral-300 hover:bg-neutral-800 disabled:text-neutral-600" title={task?.projectId?'查看项目对象、事实、版本、证据和冲突':'临时任务不生成业务事实'} onClick={()=>setBusinessFactsOpen(true)}><Icon name="chart" size={15}/>业务事实</button><DatabaseFloating key={auth.user?.id} user={auth.user?.id??'user'} active={active} tasks={tasks} onSelect={setActive} onSettings={()=>setSettings('mcp')} /><button className="rounded-lg p-2 text-neutral-400 hover:bg-neutral-800" aria-label={rightOpen?'隐藏右侧工作区':'显示右侧工作区'} onClick={()=>{setRightOpen(!rightOpen);localStorage.setItem('wp-right-panel-open',String(!rightOpen));}}><Icon name={rightOpen?'panelClose':'panelOpen'} size={19}/></button></header>
      {task && <ExpertSelector task={task} project={projects.find(p=>p.id===task.projectId)} onChanged={refreshWorkspace}/>}
      {error && <div role="alert" className="px-6 py-2 text-sm text-red-400">{error}<button className="ml-3 underline" onClick={() => { setError(''); if (!ready) { setAuth({ ...auth }); } else void loadOlder(); }}>重试</button></div>}
      <div ref={viewport} aria-label="聊天记录" className="min-h-0 flex-1 overflow-y-auto px-6 py-4" onWheel={e => { if (e.deltaY < 0 && e.currentTarget.scrollTop < 32) { follow.current = false; void loadOlder(); } }} onScroll={e => { const el = e.currentTarget; const upward = el.scrollTop < previousTop.current; previousTop.current = el.scrollTop; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; if (upward && el.scrollTop < 32) void loadOlder(); }}>
        {active && cacheNotice && <p role="status" className="mb-2 text-center text-xs text-neutral-500">{cacheNotice}</p>}
        {!active && <p className="mt-10 text-center text-sm text-neutral-500">选择或新建一个任务，发送第一条消息开始工作</p>}
        {active && <AutomationDraftNotice taskId={active}/>}
        {active && <p className="mb-3 text-center text-xs text-neutral-500">{loading ? '正在加载…' : !ready ? '正在读取对话…' : older ? '向上滚动查看更早对话' : '已到最早消息'}</p>}
        {active && <ExpertSuggestions key={"expert-"+active} task={active}/>} 
        {groupedEvents.map(group => <section key={group.id} data-turn={group.id} className="mb-6">
          {group.events.map((e, index) => {
            const firstProcess = group.events.findIndex(isProcessEvent);
            const process = index === firstProcess ? <DatabaseTurnProcess key={'process-'+group.id} events={group.events.filter(isProcessEvent)} cursor={details[group.id]?.after} live={busy && group.id === latestTurnId} onMore={() => expandTurn(group.id)} onContent={expandContent} onInteract={() => { follow.current = false; }} /> : null;
            if (isProcessEvent(e)) return process;
            if (e.kind === 'meta') return null;
            return <div key={e.id} className={`mb-3 ${e.kind === 'user' ? 'workspace-message workspace-user-message ml-auto w-fit max-w-[75%] rounded-lg bg-neutral-800 px-3 py-2 text-sm' : 'message-body workspace-message max-w-none text-sm'}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={e.kind==='assistant'?citationComponents:undefined}>{e.kind === 'user' ? displayUserMessageContent(e.content) : e.content}</ReactMarkdown>
              {e.truncated && <button className={button} onClick={() => { void expandContent(e).catch(reason => setError(errorText(reason))); }}>展开完整内容</button>}
              {!!e.attachments?.length && <div className="mt-2 flex flex-wrap gap-2">{e.attachments.map(a => <AttachmentLabel key={a.id} attachment={a} />)}</div>}
            </div>;
          })}
          {details[group.id] && !group.events.some(isProcessEvent) && <DatabaseTurnProcess key={'process-'+group.id} events={[]} cursor={details[group.id]?.after} live={busy && group.id === latestTurnId} onMore={() => expandTurn(group.id)} onContent={expandContent} onInteract={() => { follow.current = false; }} />}

        </section>)}
        {active && <DatabaseSummary key={'summary-'+active} taskId={active} busy={busy} />}
        <MemorySuggestions key={'memory-'+auth.user?.id} />
        {active && <DatabaseParsing key={"parse-"+active} taskId={active} />}
        {active && <DatabaseExecutionStatus key={active} taskId={active} />}
        {active && <DatabaseSkillBuilds key={'skills-'+active} taskId={active} autoOpen />}
      </div>
      {active && activeInteraction && <InteractionDock key={activeInteraction.id} interaction={activeInteraction} busy={interactionBusy === activeInteraction.id} queued={queuedInteractions} onRespond={response => respondToInteraction(activeInteraction, response)} />}
      {active && steering.length > 0 && <section aria-label="待应用的运行中补充" className="mx-4 mb-2 rounded-xl border border-blue-900 bg-blue-950/20 px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-3"><span className="text-blue-200">{steering.some(item => item.status === 'deferred') ? '系统已区分当前任务纠正与后续请求' : `已收到 ${steering.length} 条运行中消息，正在等待安全边界分类`}</span><span className="text-blue-300/70">不会替代当前授权</span></div>
        <ul className="mt-2 space-y-1">{steering.map(item => <li key={item.id} className="flex items-start gap-2 text-neutral-300"><span className="min-w-0 flex-1"><span className="block">{item.content}</span><span className="text-[10px] text-blue-300/70">{item.status === 'deferred' ? '与当前任务无关，已排到当前任务完成后执行' : item.status === 'pending' ? '已实时收到，等待当前步骤结束后判断关联' : item.relation === 'related' ? '已更新当前任务' : '已进入后续队列'}</span></span><button type="button" className="shrink-0 text-blue-300 hover:underline" onClick={() => { void cancelSteering(item.id); }}>撤销</button></li>)}</ul>
      </section>}
      {newMessages && <button className={button} onClick={() => { follow.current = true; if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; setNewMessages(false); }}>查看新消息</button>}
      {task?.status === 'interrupted' && <div className="mx-4 mb-2 flex flex-wrap items-center gap-2 text-xs text-amber-400">上一轮执行被中断，历史已补齐为合法状态，可继续完成。<button className={button} onClick={() => { void resume(); }}>继续</button></div>}
      {quotaRemaining !== null && <p className={`mx-4 mb-1 text-xs ${quotaBlocked ? 'text-amber-400' : 'text-neutral-500'}`}>{quotaBlocked ? `演示额度已用完（${auth.quota?.limit ?? 10} 次提问），每日北京时间 12:00 刷新` : `剩余 ${quotaRemaining} 次提问 · 每日北京时间 12:00 刷新`}</p>}
      <form className="workspace-composer mx-4 mb-4 rounded-2xl border border-neutral-700 bg-neutral-900/50 p-3" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); attachmentControl.current?.addFiles(Array.from(e.dataTransfer.files)); } }} onPaste={e => { if (e.clipboardData.files.length) { e.preventDefault(); attachmentControl.current?.addFiles(Array.from(e.clipboardData.files)); } }} onSubmit={e => { e.preventDefault(); void send(); }}>
        {filesEnabled && active && <DatabaseAttachments ref={attachmentControl} key={`${active}:${attachmentEpoch}`} taskId={active} disabled={busy || !ready} onChange={attachmentChange} />}
        <textarea aria-label="消息" value={input} disabled={!chatEnabled || !active || !resourceSelection || sending || !ready || (!taskBusy && quotaBlocked)} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} placeholder={chatEnabled ? active ? taskBusy ? '任务正在执行：输入补充或纠正，将在当前步骤完成后应用' : '输入消息，Enter 发送，Shift + Enter 换行' : '请先新建/选择任务' : '后台尚未启用对话执行'} className="message-input max-h-48 min-h-[88px] w-full resize-none bg-transparent px-1 py-1 text-sm outline-none" />
        {active&&<AutomaticResourceScope taskId={active} refresh={attachmentEpoch} onChange={resourceChange}/> }<div className="composer-footer"><div className="flex shrink-0 items-center gap-2">{filesEnabled && <button type="button" aria-label="添加文件" title="添加文件（最多10个，单个10MB）；也可拖拽或粘贴" disabled={!active || busy || !ready || attachmentBlocked || attachmentIds.length >= 10} className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40" onClick={() => attachmentControl.current?.open()}><Icon name="plus" size={22} /></button>}<DatabaseExecutionMode /></div><div className="composer-actions"><DatabaseModelStatus />{taskBusy && <button type="button" className={button} onClick={() => { void jsonFetch(`/api/tasks/${active}/stop`, { method: 'POST' }).catch(e => setError(errorText(e))); }}>停止</button>}<button title={taskBusy ? '发送补充要求' : '发送'} aria-label={taskBusy ? '发送补充要求' : '发送'} className="composer-send flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-950 hover:opacity-80 disabled:opacity-40" disabled={!chatEnabled || !active || !resourceSelection || sending || !ready || attachmentBlocked || (!taskBusy && quotaBlocked) || (taskBusy ? !input.trim() : (!input.trim() && !attachmentIds.length))}><Icon name="up" size={18} /></button></div></div>
      </form>
    </main>
    {rightOpen && !trashPage && <>
      <div
        role="separator"
        aria-label="调整对话区与右侧窗口宽度"
        aria-orientation="vertical"
        aria-valuemin={rightPanelMinimum}
        aria-valuemax={rightPanelMaximum}
        aria-valuenow={rightWidth}
        tabIndex={0}
        title="拖动调整对话区与右侧窗口；双击恢复默认宽度"
        className="group relative w-2 shrink-0 cursor-col-resize touch-none bg-neutral-800 outline-none transition-colors hover:bg-blue-600 focus-visible:bg-blue-600"
        onPointerDown={beginRightResize}
        onDoubleClick={() => {
          const width = defaultRightPanelWidth();
          setRightWidth(width);
          rememberRightPanelWidth(width);
        }}
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const width = boundedRightPanelWidth(rightWidth + (event.key === 'ArrowLeft' ? 20 : -20));
          setRightWidth(width);
          rememberRightPanelWidth(width);
        }}
      ><span className="pointer-events-none absolute left-1/2 top-1/2 h-10 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-neutral-500 group-hover:bg-blue-200" /></div>
      <WorkspaceRightPanel key={active??'empty'} width={rightWidth} taskId={active} owner={auth.user?.id??'user'} onHide={()=>{setRightOpen(false);localStorage.setItem('wp-right-panel-open','false');}} />
    </>}
    {settings && <DatabaseSettings initialSection={settings} configurationEnabled={chatEnabled} onClose={() => setSettings(null)} onChanged={refreshWorkspace} />}
    {businessFactsOpen && task?.projectId && <BusinessFactsPanel key={task.projectId} projectId={task.projectId} taskId={task.id} onClose={() => setBusinessFactsOpen(false)} />}
  </div>;
}
