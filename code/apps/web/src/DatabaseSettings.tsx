import {DatabasePersonalData} from './DatabasePersonalData';
import { DatabaseSessions } from './DatabaseSessions';
import { DatabaseUsage } from './DatabaseUsage';
import { DatabaseSkillBuilds } from './DatabaseSkillBuilds';
import {DatabaseExperts} from './DatabaseExperts';
import { DatabaseSkillMarket } from './DatabaseSkillMarket';
import { useEffect, useRef, useState } from 'react';
import { jsonFetch } from './api';


type Section = 'projects' | 'providers' | 'mcp';
export type SettingsSection = 'mcp' | 'skills' | 'experts' | 'usage' | 'sessions' | 'personal';
interface Row { id: string; name: string; revision: number }
interface Provider extends Row { inputPrice?:string|null; outputPrice?:string|null; currency?:string; contextBudget?: number; contextSource?: 'manual'|'api'; contextCheckedAt?: string|null; baseUrl: string; modelId: string; protocol: string; hasApiKey: boolean; active: boolean; shared?: boolean }
interface Mcp extends Row { url: string; hasToken: boolean; enabled: boolean; status: string; tools: { name: string; description?: string }[]; disabledTools: string[] }
interface Task extends Row { projectId: string | null; status: string }
const button = 'rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-40';
const field = 'block w-full rounded border border-neutral-700 bg-neutral-900 p-2';
const titles = { projects: '项目管理', providers: '模型配置', mcp: 'MCP 配置', skills: 'Skill', experts: '专家', usage: '用量与预算', sessions: '登录会话', personal: '个人数据' };

/** 配置草稿只保留在组件内存中，凭据不得回读或持久化到本地。 */
export function DatabaseSettings({ onClose, onChanged, configurationEnabled, initialSection = 'mcp' }: { initialSection?: SettingsSection; onClose: () => void; onChanged: () => Promise<void>; configurationEnabled: boolean }) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  return <dialog ref={dialog} aria-label="工作区设置" onCancel={onClose} className="m-auto w-[95vw] max-w-4xl bg-transparent p-0 backdrop:bg-black/40">
    <div className="flex h-[80vh] w-full max-w-4xl overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 text-neutral-100 shadow-xl">
      <nav aria-label="设置菜单" className="w-40 shrink-0 space-y-2 border-r border-neutral-800 p-3">{(['mcp', 'skills', 'experts', 'usage', 'sessions', 'personal'] as SettingsSection[]).map(key => <button key={key} className={`${button} w-full text-left ${section === key ? 'bg-neutral-800' : ''}`} onClick={() => setSection(key)}>{titles[key]}</button>)}</nav>
      <div className="min-w-0 flex-1 overflow-auto p-5"><header className="mb-4 flex items-center justify-between"><h2>{titles[section]}</h2><button className={button} onClick={onClose}>关闭</button></header>
        {section === 'personal' ? <DatabasePersonalData onChanged={onChanged} /> : section === 'sessions' ? <DatabaseSessions /> : section === 'usage' ? <DatabaseUsage /> : section === 'experts' ? <DatabaseExperts /> : section === 'skills' ? <><DatabaseSkillBuilds /><DatabaseSkillMarket /></> : !configurationEnabled ? <p>后台尚未启用模型与 MCP 配置。</p> : <Registry key={section} section={section} onChanged={onChanged} />}
      </div>
    </div>
  </dialog>;
}

export function Registry({ section, onChanged }: { section: Section; onChanged: () => Promise<void> }) {
  const [rows, setRows] = useState<Array<Row | Provider | Mcp>>([]), [tasks, setTasks] = useState<Task[]>([]);
  const [editing, setEditing] = useState<Row | null>(null), [showForm, setShowForm] = useState(false);
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [model, setModel] = useState(''), [protocol, setProtocol] = useState('openai');
  const [secret, setSecret] = useState(''), [clearSecret, setClearSecret] = useState(false);
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [contextBudget,setContextBudget]=useState('65536');
  const [capacityAudit,setCapacityAudit]=useState<Record<string,Array<{beforeTokens:number|null;afterTokens:number;source:string;createdAt:string}>>>({});
  const [inputPrice,setInputPrice]=useState(''),[outputPrice,setOutputPrice]=useState(''),[currency,setCurrency]=useState('CNY');
  const endpoint = `/api/${section}`;
  const load = async (signal?: AbortSignal) => {
    const result = await jsonFetch<Record<string, Array<Row | Provider | Mcp>>>(endpoint, { signal });
    if (signal?.aborted) return;
    setRows(result[section === 'mcp' ? 'connections' : section] ?? []);
    if (section === 'projects') { const t = await jsonFetch<{ tasks: Task[] }>('/api/tasks', { signal }); if (!signal?.aborted) setTasks(t.tasks); }
    setLoaded(true);
  };
  useEffect(() => { const c = new AbortController(); void load(c.signal).catch(e => { if (!c.signal.aborted) setError(String(e.message)); }); return () => c.abort(); }, [section]);
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await operation(); await load(); await onChanged(); setNotice('已更新'); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const edit = (row?: Row | Provider | Mcp) => {
    setEditing(row ?? null); setShowForm(true); setName(row?.name ?? '');
    setUrl(row && 'baseUrl' in row ? row.baseUrl : row && 'url' in row ? row.url : '');
    setModel(row && 'modelId' in row ? row.modelId : ''); setProtocol(row && 'protocol' in row ? row.protocol : 'openai');
    setContextBudget(String(row && 'modelId' in row ? row.contextBudget ?? 65536 : 65536));
    setInputPrice(row&&'modelId' in row?row.inputPrice??'':'');setOutputPrice(row&&'modelId' in row?row.outputPrice??'':'');setCurrency(row&&'modelId' in row?row.currency??'CNY':'CNY');
    setSecret(''); setClearSecret(false); setError(''); setNotice('');
  };
  const save = () => run(async () => {
    const body = { name: name.trim(), ...(editing ? { revision: editing.revision } : {}), ...(section === 'providers' ? { baseUrl: url.trim(), modelId: model.trim(), protocol, contextBudget:Number(contextBudget),inputPrice:inputPrice||null,outputPrice:outputPrice||null,currency } : section === 'mcp' ? { url: url.trim() } : {}), ...(section !== 'projects' && (secret || clearSecret) ? { [section === 'mcp' ? 'token' : 'apiKey']: clearSecret ? null : secret } : {}) };
    await jsonFetch(endpoint + (editing ? `/${editing.id}` : ''), { method: editing ? section === 'projects' ? 'PATCH' : 'PUT' : 'POST', body: JSON.stringify(body) });
    setSecret(''); setShowForm(false); setEditing(null);
  });
  const remove = (row: Row, path = endpoint) => {
    const detail = section === 'projects' ? '关联对话及记忆会移入回收站。运行中的任务请先停止。' : '删除后无法撤销。';
    if (window.confirm(`删除「${row.name}」？${detail}`)) void run(() => jsonFetch(`${path}/${row.id}`, { method: 'DELETE', body: JSON.stringify({ revision: row.revision }) }));
  };
  const mutate = (path: string, body: object) => { void run(() => jsonFetch(path, { method: 'POST', body: JSON.stringify(body) }, 45000)); };
  return <div className="space-y-4">
    {error && <p role="alert" className="text-sm text-red-400">{error} <button className="underline" disabled={busy} onClick={() => { void run(() => Promise.resolve()); }}>刷新列表</button></p>}
    {notice && <p role="status" className="text-sm text-neutral-400">{notice}</p>}
    <button className={button} disabled={busy} onClick={() => edit()}>新建{section === 'projects' ? '项目' : section === 'providers' ? '模型' : 'MCP'}</button>
    {showForm && <form className="space-y-3 rounded border border-neutral-700 p-4" onSubmit={e => { e.preventDefault(); void save(); }}><fieldset disabled={busy} className="space-y-3">
      <label className="block">名称<input autoFocus required maxLength={section === 'projects' ? 120 : 80} className={field} value={name} onChange={e => setName(e.target.value)} /></label>
      {section !== 'projects' && <label className="block">服务地址<input required type="url" className={field} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" /></label>}
      {section === 'providers' && <><label className="block">模型名称<input required className={field} value={model} onChange={e => setModel(e.target.value)} /></label><label className="block">上下文容量（Token）<input required type="number" min={12000} max={2097152} step={1} className={field} value={contextBudget} onChange={e=>setContextBudget(e.target.value)} /><span className="text-xs text-neutral-400">输入与输出合计的Token窗口。保存后可从模型列表同步接口容量；接口不提供时按官方文档手动填写。系统以启发式Token估算并预留8192输出Token，另设16MiB请求限制。</span></label><label className="block">协议<select className={field} value={protocol} onChange={e => setProtocol(e.target.value)}><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></label></>}
      {section === 'providers' && <div className="space-y-2"><label className="block">计价币种<select className={field} value={currency} onChange={e=>setCurrency(e.target.value)}><option>CNY</option><option>USD</option></select></label><label className="block">输入单价（每百万Token）<input type="number" min="0" step="0.000001" className={field} value={inputPrice} onChange={e=>setInputPrice(e.target.value)}/></label><label className="block">输出单价（每百万Token）<input type="number" min="0" step="0.000001" className={field} value={outputPrice} onChange={e=>setOutputPrice(e.target.value)}/></label><p className="text-xs text-neutral-400">留空表示费用未知，0表示已确认免费。按实际服务填写，费用仅估算，不含缓存折扣；修改只影响后续请求。</p></div>}
      {section !== 'projects' && <><label className="block">{section === 'providers' ? 'API 密钥' : '访问令牌'}<input type="password" autoComplete="new-password" disabled={clearSecret} className={field} value={secret} onChange={e => setSecret(e.target.value)} placeholder={editing ? '留空保留原值' : '可选'} /></label>{editing && <label className="flex gap-2"><input type="checkbox" checked={clearSecret} onChange={e => { setClearSecret(e.target.checked); setSecret(''); }} />清除已保存的凭据</label>}<p className="text-xs text-neutral-400">更换服务地址后，请重新填写凭据，或勾选清除。MCP 修改后需要重新发现工具并启用。</p></>}
      <div className="flex gap-2"><button className={button}>保存</button><button type="button" className={button} onClick={() => { setShowForm(false); setSecret(''); }}>取消</button></div>
    </fieldset></form>}
    {!loaded && !error && <p>正在加载…</p>}{loaded && !rows.length && <p className="text-sm text-neutral-400">暂无配置</p>}
    {rows.map(row => <article key={row.id} className="space-y-2 rounded border border-neutral-800 p-3"><div className="flex flex-wrap items-center gap-2"><strong className="min-w-0 break-all">{row.name}</strong><button className={button} disabled={busy} onClick={() => edit(row)}>编辑</button><button className={button} disabled={busy} onClick={() => remove(row)}>删除</button></div>
      {'modelId' in row && <><button className={button} disabled={busy} onClick={()=>{void (async()=>{setBusy(true);setError('');try{const r=await jsonFetch<{ok:boolean;detail:string;durationMs:number}>(`/api/providers/${row.id}/test`,{method:'POST',body:JSON.stringify({revision:row.revision})},30000);setNotice(`${r.ok?'通过':'失败'}：${r.detail}（${r.durationMs}ms）`);}catch(e){setError(e instanceof Error?e.message:'诊断失败');}finally{setBusy(false);}})();}}>测试模型（会产生少量用量）</button><p className="break-all text-sm text-neutral-400">{row.modelId} · {row.hasApiKey ? '已设置密钥' : '未设置密钥'}</p><p className="text-sm text-neutral-400">上下文：{row.contextBudget?.toLocaleString()} tokens · {row.contextSource==='api'?'接口同步':'手动配置'}{row.contextCheckedAt?' · '+new Date(row.contextCheckedAt).toLocaleString():''}</p><button className={button} disabled={busy} onClick={()=>{void run(async()=>{await jsonFetch(`/api/providers/${row.id}/capacity/sync`,{method:'POST',body:JSON.stringify({revision:row.revision})},20000);setCapacityAudit({});setNotice('模型容量已按接口元数据同步；变更已记录审计。');});}}>同步模型容量</button><button className={button} disabled={busy} onClick={()=>{void run(async()=>{const result=await jsonFetch<{entries:Array<{beforeTokens:number|null;afterTokens:number;source:string;createdAt:string}>}>(`/api/providers/${row.id}/capacity/audit`);setCapacityAudit(v=>({...v,[row.id]:result.entries}));});}}>容量修改记录</button>{capacityAudit[row.id]&&<div className="space-y-1 text-xs text-neutral-400" aria-label="容量修改记录">{capacityAudit[row.id]!.length?capacityAudit[row.id]!.map((entry,i)=><p key={i}>{new Date(entry.createdAt).toLocaleString()} · {entry.beforeTokens??'新建'} → {entry.afterTokens} tokens · {entry.source==='api'?'接口同步':'手动配置'}</p>):<p>暂无容量修改记录</p>}</div>}<button className={button} disabled={busy || (row.active && row.shared)} onClick={() => mutate('/api/providers/active', { id: row.id, revision: row.revision })}>{row.active && row.shared ? '服务端默认模型' : '设为默认模型（用户可用）'}</button></>}
      {'tools' in row && <><p className="break-all text-sm text-neutral-400">{row.url} · {row.hasToken ? '已设置令牌' : '未设置令牌'} · {row.enabled ? '已启用' : '已禁用'}</p><div className="flex gap-2"><button className={button} disabled={busy} onClick={() => mutate(`${endpoint}/${row.id}/test`, { revision: row.revision })}>连接并发现工具</button><button className={button} disabled={busy || row.status !== 'ready'} onClick={() => mutate(`${endpoint}/${row.id}/toggle`, { revision: row.revision, enabled: !row.enabled })}>{row.enabled ? '禁用' : '启用'}</button></div><div className="space-y-2">{row.tools.map(tool => <label key={tool.name} className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={busy} checked={!row.disabledTools.includes(tool.name)} onChange={e => mutate(`${endpoint}/${row.id}/tools/toggle`, { revision: row.revision, name: tool.name, enabled: e.target.checked })} /><span className="break-all" title={tool.description}>{tool.name}</span></label>)}</div></>}
      {section === 'projects' && tasks.filter(t => t.projectId === row.id).map(t => <div key={t.id} className="flex items-center justify-between gap-2 border-t border-neutral-800 pt-2 text-sm"><span className="truncate">{t.name}</span><button className={button} disabled={busy || ['running', 'waiting', 'queued'].includes(t.status)} onClick={() => remove(t, '/api/tasks')}>删除任务</button></div>)}
    </article>)}
    {section === 'projects' && tasks.some(t => !t.projectId) && <section><h3>临时任务</h3>{tasks.filter(t => !t.projectId).map(t => <div key={t.id} className="my-2 flex justify-between gap-2"><span className="truncate">{t.name}</span><button className={button} disabled={busy || ['running', 'waiting', 'queued'].includes(t.status)} onClick={() => remove(t, '/api/tasks')}>删除任务</button></div>)}</section>}
  </div>;
}
