import { useEffect, useState } from 'react';
import { type MobileClient, type Project, type Task, type User } from './client';
import { Conversation } from './Conversation';
import { Capabilities, TaskResources } from './Capabilities';
import { Memories } from './MemoryEditor';
import { BusinessFacts } from './BusinessFacts';
import { readChatStream } from '@workpivot/shared';

interface WorkspaceEvent {
  type: 'workspace';
  value: { revision: string; projects: Project[]; tasks: Task[] };
}

export function Workspace({ client, user, theme, onTheme, onLogout, onError }: {
  client: MobileClient; user: User; theme: string; onTheme: () => void; onLogout: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]), [tasks, setTasks] = useState<Task[]>([]);
  const selectionKey = `wp-mobile-task:${client.server}:${user.id}`;
  const [active, setActive] = useState<string | null>(() => localStorage.getItem(selectionKey));
  const [drawer, setDrawer] = useState(false), [settings, setSettings] = useState(false), [error, setError] = useState('');
  const [creating, setCreating] = useState<'project' | 'task' | null>(null), [name, setName] = useState(''), [project, setProject] = useState('');
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<'home' | 'capabilities' | 'resources' | 'memories' | 'business'>('home');
  const task = tasks.find(row => row.id === active);
  const fail = (reason: unknown) => { setError(reason instanceof Error ? reason.message : '操作失败'); onError(reason); };
  const load = async (signal?: AbortSignal) => {
    const [p, t] = await Promise.all([client.json<{ projects: Project[] }>('/api/projects', { signal }), client.json<{ tasks: Task[] }>('/api/tasks', { signal })]);
    if (signal?.aborted) return;
    setProjects(p.projects); setTasks(t.tasks);
    setActive(id => t.tasks.some(row => row.id === id) ? id : null);
  };
  useEffect(() => { const c = new AbortController(); void load(c.signal).catch(reason => { if (!c.signal.aborted) fail(reason); }); return () => c.abort(); }, [client]);
  useEffect(() => {
    let stopped = false, after = '0', delay = 1000;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    const connect = async () => {
      try {
        const response = await client.response(`/api/workspace/stream?after=${after}`, { signal: controller.signal }, 60 * 60 * 1000);
        if (!response.body) throw new Error('工作区同步不可用');
        await readChatStream<WorkspaceEvent | { type: 'unavailable'; status: number }>(response.body, event => {
          if (stopped) return;
          if (event.type === 'unavailable') {
            if (event.status !== 401) after = '0';
            throw new Error(event.status === 401 ? '登录已失效，请重新登录' : '工作区同步已中断');
          }
          after = event.value.revision;
          setProjects(event.value.projects);
          setTasks(event.value.tasks);
          setActive(current => current && event.value.tasks.some(row => row.id === current) ? current : null);
          delay = 1000;
        }, controller.signal, 60000);
      } catch (reason) {
        if (stopped || controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : '工作区同步中断');
        retry = setTimeout(() => { void connect(); }, delay);
        delay = Math.min(delay * 2, 10000);
      }
    };
    void connect();
    return () => { stopped = true; clearTimeout(retry); controller.abort(); };
  }, [client, user.id]);
  useEffect(() => { if (active) localStorage.setItem(selectionKey, active); else localStorage.removeItem(selectionKey); }, [active, selectionKey]);
  const select = (id: string) => { setActive(id); setDrawer(false); setSettings(false); setError(''); };
  const start = (kind: 'project' | 'task') => { setName(''); setProject(task?.projectId ?? projects[0]?.id ?? ''); setCreating(kind); setDrawer(false); };
  const create = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (creating === 'project') { await client.json('/api/projects', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }); await load(); setDrawer(true); }
      else {
        if (!project) throw new Error('请先选择项目');
        const value = await client.json<{ task: Task }>('/api/tasks', { method: 'POST', body: JSON.stringify({ name: name.trim(), projectId: project }) });
        await load(); select(value.task.id);
      }
      setCreating(null);
    } catch (reason) { fail(reason); }
    finally { setBusy(false); }
  };
  return <main className="mobile-workspace">
    <header className="topbar"><button aria-label="打开侧栏" onClick={() => setDrawer(true)}><svg viewBox="0 0 24 24"><path d="M4 7h16M4 17h16" /></svg></button>
      <div><strong>{settings ? '设置' : task?.name ?? 'WorkPivot'}</strong><small>{settings ? user.username : projects.find(p => p.id === task?.projectId)?.name ?? '项目工作空间'}</small></div>
      <button aria-label="新建任务" onClick={() => start(projects.length ? 'task' : 'project')}><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></button></header>
    {settings && <div className="settings-page">
      {panel !== 'home' ? <><button onClick={() => setPanel('home')}>‹ 返回设置</button>
        {panel === 'capabilities' ? <Capabilities client={client} onError={onError} /> : task ? panel === 'memories' ? <Memories key={task.id} client={client} task={task} onError={onError} /> : panel === 'business' ? <BusinessFacts key={task.id} client={client} task={task} onError={onError} /> : <TaskResources key={task.id} client={client} task={task} onError={onError} /> : <p>请先选择一个任务。</p>}
      </> : <><div className="profile"><span>{user.username.slice(0, 1).toUpperCase()}</span><h1>{user.username}</h1></div>
      <section><button onClick={onTheme}>界面主题 <span>{theme === 'dark' ? '黑色' : '白色'} ›</span></button>
        <div className="settings-row">服务器地址<small>{client.server}</small></div></section>
      <section><button onClick={() => setPanel('capabilities')}>技能与 MCP <span>›</span></button>
        <button disabled={!task} onClick={() => setPanel('memories')}>三层记忆 <span>›</span></button>
        <button disabled={!task?.projectId} onClick={() => setPanel('business')}>项目业务事实 <span>›</span></button>
        <button disabled={!task} onClick={() => setPanel('resources')}>任务专家、资料与知识 <span>›</span></button></section>
      <section><button disabled={busy} onClick={() => { setBusy(true); void onLogout().catch(fail).finally(() => setBusy(false)); }}>退出登录 / 更换服务器</button></section>
      <p className="muted">WorkPivot Mobile · 开发预览</p></>}
      <button onClick={() => setSettings(false)}>返回对话</button></div>}
    <div className="chat-content" hidden={settings}>{task ? <Conversation key={task.id} client={client} task={task} onError={onError} />
        : <div className="empty"><h1>你的项目工作空间</h1><p>选择一个任务继续，或开始新的项目。</p><button className="primary" onClick={() => setDrawer(true)}>查看项目</button><button onClick={() => start('project')}>创建项目</button></div>}</div>
    {error && <p className="error" role="alert">{error}</p>}
    {drawer && <div className="drawer-layer"><button className="shade" aria-label="关闭侧栏" onClick={() => setDrawer(false)} /><aside className="drawer" aria-label="项目导航">
      <h1>WorkPivot</h1><button onClick={() => start(projects.length ? 'task' : 'project')}>＋ 新建任务</button><button onClick={() => start('project')}>＋ 新建项目</button>
      <button onClick={() => { setSettings(true); setPanel('capabilities'); setDrawer(false); }}>技能与 MCP</button>
      <div className="project-list">{projects.map(p => <details key={p.id} open={p.id === task?.projectId || undefined}><summary>{p.name}</summary>{tasks.filter(t => t.projectId === p.id).map(t => <button className={active === t.id ? 'selected' : ''} key={t.id} onClick={() => select(t.id)}>{t.name}</button>)}</details>)}
        <p className="muted">最近任务</p>{tasks.slice(0, 15).map(t => <button key={t.id} onClick={() => select(t.id)}>{t.name}<small>{projects.find(p => p.id === t.projectId)?.name ?? '未归属项目'}</small></button>)}</div>
      <footer><button onClick={() => { setSettings(true); setPanel('home'); setDrawer(false); }}>{user.username}</button><button aria-label="设置" onClick={() => { setSettings(true); setPanel('home'); setDrawer(false); }}><svg viewBox="0 0 24 24"><path d="M4 7h16M4 17h16M9 4v6M16 14v6" /></svg></button></footer>
    </aside></div>}
    {creating && <div className="modal-layer"><form className="create-dialog" role="dialog" aria-modal="true" aria-label={creating === 'project' ? '新建项目' : '新建任务'} onSubmit={e => { e.preventDefault(); void create(); }}>
      <h2>{creating === 'project' ? '新建项目' : '新建任务'}</h2><label>名称<input required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>
      {creating === 'task' && <label>所属项目<select required value={project} onChange={e => setProject(e.target.value)}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      {error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy || !name.trim()}>创建</button><button type="button" disabled={busy} onClick={() => setCreating(null)}>取消</button>
    </form></div>}
  </main>;
}
