import { DatabaseArtifacts } from './DatabaseArtifacts';
import { LoadedDatabaseSkills } from './DatabaseSkillMarket';
import { useState } from 'react';
import { DatabaseMemory } from './DatabaseMemory';
import { Icon } from './Icon';
import { WorkspaceUserMenu } from './WorkspaceUserMenu';
import type { SettingsSection } from './DatabaseSettings';

import { jsonFetch } from './api';

interface Row { id: string; name: string; revision: number }
interface Task extends Row { projectId: string | null; status: string }
const control = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-800';

/** 沿用工作区导航，通过数据库接口读取数据。 */
export function DatabaseWorkspaceNavigation({ projects, tasks, active, username, onSelect, onRefresh, onSettings, onLogout, onError, onAutomations }: {
  onAutomations:()=>void; projects: Row[]; tasks: Task[]; active: string | null; username?: string;
  onSelect: (id: string) => void; onRefresh: () => Promise<void>; onSettings: (section: SettingsSection) => void; onLogout: () => void; onError: (text: string) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false), [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [form, setForm] = useState<'projects' | 'tasks' | null>(null), [name, setName] = useState(''), [project, setProject] = useState('');
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const open = (kind: 'projects' | 'tasks', id = '') => { setForm(kind); setProject(id); setName(''); setError(''); };
  const create = async () => {
    if (saving || !name.trim()) return;
    setSaving(true); setError('');
    try {
      const result = await jsonFetch<{ task?: Task }>(`/api/${form}`, { method: 'POST', body: JSON.stringify({ name: name.trim(), ...(form === 'tasks' && project ? { projectId: project } : {}) }) });
      await onRefresh(); if (result.task) onSelect(result.task.id); setForm(null);
    } catch (e) { setError(e instanceof Error ? e.message : '创建失败'); } finally { setSaving(false); }
  };
  const remove = async (row: Row, kind: 'projects' | 'tasks') => {
    if (!window.confirm(`删除「${row.name}」？关联对话、文件与记忆将移入回收站，保留30天；关联执行授权失效，恢复后需重新确认。`)) return;
    try { await jsonFetch(`/api/${kind}/${row.id}`, { method: 'DELETE', body: JSON.stringify({ revision: row.revision }) }); await onRefresh(); }
    catch (e) { onError(e instanceof Error ? e.message : '删除失败'); }
  };
  const row = (task: Task) => <div key={task.id} className="flex items-center"><button className={`min-w-0 flex-1 truncate px-6 py-1.5 text-left text-sm hover:bg-neutral-900 ${active === task.id ? 'bg-neutral-900' : ''}`} onClick={() => onSelect(task.id)}><span className={`mr-2 inline-block h-2 w-2 rounded-full ${['running', 'waiting', 'queued'].includes(task.status) ? 'animate-pulse bg-amber-400' : 'bg-neutral-500'}`} /><span className="text-neutral-300">{task.name}</span></button><button title="删除任务" aria-label={`删除任务 ${task.name}`} className={control} onClick={() => { void remove(task, 'tasks'); }}><Icon name="trash" size={14} /></button></div>;
  return <>
    <aside aria-label="项目与任务" className="flex w-64 min-w-[200px] shrink-0 flex-col border-r border-neutral-800">
      <div className="space-y-0.5 px-3 py-3">
        <button className="block w-full rounded px-2 py-1.5 text-left text-sm font-medium hover:bg-neutral-900" onClick={() => open('tasks')}><Icon name="plus" /> 新建任务</button>
        <button className="block w-full rounded px-2 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-900" onClick={() => setSearchOpen(v => !v)}><Icon name="search" /> 搜索</button>
        <button className="block w-full rounded px-2 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-900" onClick={onAutomations}><Icon name="bolt" /> 自动化</button>
        <button className="block w-full rounded px-2 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-900" onClick={() => onSettings('skills')}><Icon name="skill" /> 技能市场</button>
        <button className="block w-full rounded px-2 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-900" onClick={()=>{location.hash='trash';}}><Icon name="trash" /> 回收站</button>
      </div>
      {searchOpen && <div className="px-3 pb-2"><input autoFocus aria-label="搜索任务或项目" placeholder="搜索任务/项目" value={search} onChange={e => setSearch(e.target.value)} className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs outline-none" /></div>}
      <div className="flex items-center justify-between px-4 py-2 text-xs text-neutral-500"><span>项目</span><button title="新建项目" aria-label="新建项目" className={control} onClick={() => open('projects')}><Icon name="folderPlus" /></button></div>
      <div className="min-h-0 flex-1 overflow-y-auto">{projects.filter(p => !search || p.name.includes(search) || tasks.some(t => t.projectId === p.id && t.name.includes(search))).map(p => <section key={p.id}><div className="flex items-center px-2"><button className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-neutral-900" aria-expanded={!collapsed.includes(p.id)} onClick={() => setCollapsed(v => v.includes(p.id) ? v.filter(id => id !== p.id) : [...v, p.id])}><Icon name={collapsed.includes(p.id) ? 'right' : 'down'} size={12} /><Icon name="folder" /><span className="truncate">{p.name}</span></button><button title="新建任务" aria-label={`在 ${p.name} 新建任务`} className={control} onClick={() => open('tasks', p.id)}><Icon name="plus" size={14} /></button><button title="删除项目" aria-label={`删除项目 ${p.name}`} className={control} onClick={() => { void remove(p, 'projects'); }}><Icon name="trash" size={14} /></button></div>{!collapsed.includes(p.id) && tasks.filter(t => t.projectId === p.id && (!search || p.name.includes(search) || t.name.includes(search))).map(row)}</section>)}
        {tasks.some(t => !t.projectId) && <p className="px-4 py-2 text-xs text-neutral-500">临时任务</p>}{tasks.filter(t => !t.projectId && (!search || t.name.includes(search))).map(row)}
        {!tasks.length && !projects.length && <p className="px-4 py-2 text-xs text-neutral-500">新建项目或任务，开始工作</p>}
      </div>
      <WorkspaceUserMenu username={username} onLogout={onLogout} onSettings={onSettings} />
    </aside>
    {form && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><form role="dialog" aria-modal="true" aria-label={form === 'projects' ? '新建项目' : '新建任务'} className="w-full max-w-md space-y-4 rounded-xl border border-neutral-700 bg-neutral-900 p-5 shadow-xl" onSubmit={e => { e.preventDefault(); void create(); }} onKeyDown={e => { if (e.key === 'Escape' && !saving) setForm(null); }}><h2 className="font-medium">{form === 'projects' ? '新建项目' : '新建任务'}</h2><label className="block text-sm">名称<input autoFocus required maxLength={120} value={name} onChange={e => setName(e.target.value)} className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 outline-none" /></label>{form === 'tasks' && <label className="block text-sm">所属项目<select value={project} onChange={e => setProject(e.target.value)} className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 p-2"><option value="">临时任务</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}{error && <p role="alert" className="text-sm text-red-400">{error}</p>}<div className="flex justify-end gap-2"><button type="button" className="rounded px-3 py-1.5 text-sm" disabled={saving} onClick={() => setForm(null)}>取消</button><button className="rounded bg-blue-600 px-3 py-1.5 text-sm disabled:opacity-40" disabled={saving || !name.trim()}>{saving ? '创建中…' : '创建'}</button></div></form></div>}
  </>;
}

export function DatabaseWorkspaceSidebar({ tasks, active, onSelect, onSettings, floating=false }: { floating?:boolean; active?: string | null; tasks: Task[]; onSelect: (id: string) => void; onSettings: () => void }) {
  return <aside id="task-results-panel" aria-label="任务侧栏" className={floating?"flex min-h-0 w-full flex-1 flex-col":"flex w-72 min-w-[232px] shrink-0 flex-col border-l border-neutral-800"}><div className="flex-1 space-y-5 overflow-y-auto p-4 text-xs">
    <section aria-label="任务监控" className={floating?"flex max-h-48 flex-col":"flex h-52 flex-col"}><h2 className="mb-2 font-medium text-neutral-300">任务监控</h2><div className="min-h-0 flex-1 space-y-2 overflow-y-auto">{tasks.map(t => <button key={t.id} className="flex w-full items-center gap-2 rounded p-1 text-left hover:bg-neutral-900" onClick={() => onSelect(t.id)}><span className={`h-2 w-2 shrink-0 rounded-full ${['running', 'waiting', 'queued'].includes(t.status) ? 'animate-pulse bg-amber-400' : t.status === 'completed' ? 'bg-emerald-500' : 'bg-neutral-500'}`} /><span className={`truncate ${t.status === 'completed' ? 'line-through text-neutral-500' : 'text-neutral-300'}`}>{t.name}</span></button>)}{!tasks.length && <p className="text-neutral-500">暂无任务</p>}</div></section>
    <DatabaseArtifacts compact={floating} key={'upload-'+active} taskId={active} purpose="upload" /><DatabaseArtifacts compact={floating} key={active} taskId={active} />
    <section aria-label="技能与MCP" className={floating?"flex max-h-48 flex-col":"flex h-40 flex-col"}><h2 className="mb-2 font-medium text-neutral-300">技能与 MCP</h2><LoadedDatabaseSkills /><button className="mt-2 text-left text-neutral-400 hover:text-neutral-200" onClick={onSettings}><Icon name="settings" /> MCP 配置</button></section>
    <DatabaseMemory taskId={active ?? undefined} projectId={tasks.find(t => t.id === active)?.projectId} />
  </div></aside>;
}
