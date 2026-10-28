import { useState } from 'react';
import type { MobileClient, Task } from './client';
import { useResource } from './useResource';
import { FileLabel } from './Attachments';
import { Capacitor } from '@capacitor/core';
import { exportArtifact } from './artifact-export';
import type { Artifact } from './artifact-data';
import { KnowledgeFiles } from './KnowledgeIngestion';

interface Props { client: MobileClient; onError: (error: unknown) => void }
interface Skill { name: string; displayName?: string; description: string; loaded: boolean; visibility?: string }
interface Connection { id: string; name: string; revision: number; enabled: boolean; status: string; disabledTools?: string[]; tools: { name: string; description: string }[] }
export function Capabilities({ client, onError }: Props) {
  const skills = useResource<{ skills: Skill[] }>(client, '/api/skill-market', onError);
  const mcp = useResource<{ connections: Connection[] }>(client, '/api/mcp', onError);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const change = async (path: string, method: string, body: unknown, refresh: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await client.json(path, { method, body: JSON.stringify(body), signal: skills.signal() }); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); onError(reason); await refresh(); }
    finally { setBusy(false); }
  };
  return <div className="capabilities">
    <h2>技能</h2><p className="muted">加载后台发布的技能，在后续任务中按需使用。</p>
    {!skills.value && !skills.error && <p>正在读取技能…</p>}
    {skills.value?.skills.length === 0 && <p>暂无已发布技能</p>}
    {skills.value?.skills.map(row => <article key={row.name}><strong>{row.displayName || row.name}</strong><p>{row.description}</p>
      <button disabled={busy || (row.visibility === 'private' && !row.loaded)} onClick={() => void change(`/api/skill-market/${encodeURIComponent(row.name)}`, 'PUT', { loaded: !row.loaded }, skills.refresh)}>{row.loaded ? '卸载' : row.visibility === 'private' ? '需在桌面端确认私人技能' : '加载'}</button></article>)}
    <h2>MCP</h2><p className="muted">使用已配置的服务，手机不启动本地命令。</p>
    {!mcp.value && !mcp.error && <p>正在读取 MCP…</p>}
    {mcp.value?.connections.length === 0 && <p>暂无已配置服务</p>}
    {mcp.value?.connections.map(row => <article key={row.id}><strong>{row.name}</strong><p>{row.enabled ? '已启用' : '已停用'} · {row.status === 'ready' ? '连接正常' : row.status === 'error' ? '连接异常' : '尚未测试'}</p>
      <button disabled={busy || (!row.enabled && row.status !== 'ready')} onClick={() => void change(`/api/mcp/${row.id}/toggle`, 'POST', { revision: row.revision, enabled: !row.enabled }, mcp.refresh)}>{row.enabled ? '停用' : '启用'}</button>
      <details><summary>工具（{row.tools.length}）</summary>{row.tools.map(tool => <div key={tool.name}><p>{tool.name}：{tool.description}</p><button disabled={busy} onClick={() => void change(`/api/mcp/${row.id}/tools/toggle`, 'POST', { revision: row.revision, name: tool.name, enabled: row.disabledTools?.includes(tool.name) ?? false }, mcp.refresh)}>{row.disabledTools?.includes(tool.name) ? '启用工具' : '停用工具'}</button></div>)}</details></article>)}
    {(error || skills.error || mcp.error) && <p className="error" role="alert">{error || skills.error || mcp.error}</p>}
  </div>;
}
interface Expert { id: string; name: string; disabled: boolean; settings: { role: string; startup: string } }
export function TaskResources({ client, task, onError }: Props & { task: Task }) {
  const experts = useResource<{ experts: Expert[] }>(client, '/api/experts', onError);
  const tasks = useResource<{ tasks: (Task & { revision: number; expertId?: string | null })[] }>(client, '/api/tasks', onError, 5000);
  const files = useResource<{ artifacts: Artifact[] }>(client, `/api/tasks/${task.id}/artifacts`, onError, 3000);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [exporting, setExporting] = useState<string | null>(null), [notice, setNotice] = useState('');
  const download = async (file: Artifact, action: 'open' | 'share') => {
    if (exporting) return;
    setExporting(file.id); setError(''); setNotice('');
    try {
      await exportArtifact(client, task.id, file, action, files.signal());
      if (!files.signal().aborted) setNotice(Capacitor.isNativePlatform() ? '已交给系统处理' : '已发起下载，请查看浏览器下载列表');
    } catch (reason) { if (!files.signal().aborted && !client.signal.aborted) { setError(reason instanceof Error ? reason.message : '下载失败'); onError(reason); } }
    finally { setExporting(null); }
  };
  const current = tasks.value?.tasks.find(row => row.id === task.id);
  const selected = experts.value?.experts.find(row => row.id === current?.expertId);
  const bind = async (expertId: string) => {
    if (!current || busy) return;
    setBusy(true); setError('');
    try { await client.json(`/api/tasks/${task.id}/expert`, { method: 'PUT', body: JSON.stringify({ revision: current.revision, expertId: expertId || null }), signal: tasks.signal() }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '专家选择失败'); onError(reason); }
    finally { await tasks.refresh(); setBusy(false); }
  };
  return <section className="capabilities"><h2>当前任务专家</h2><select aria-label="当前专家" disabled={busy || !current || ['running', 'queued', 'waiting'].includes(current.status)} value={current?.expertId ?? ''} onChange={event => void bind(event.target.value)}>
    <option value="">默认助手</option>{experts.value?.experts.filter(row => !row.disabled || row.id === current?.expertId).map(row => <option key={row.id} value={row.id} disabled={row.disabled}>{row.name}{row.disabled ? '（已停用）' : ''}</option>)}</select>
    {selected && <details><summary>角色与启动说明</summary><p>{selected.settings.role}</p><p>{selected.settings.startup}</p></details>}
    <h2>产物</h2>{files.value?.artifacts.map(file => <div key={file.id} className="artifact-row"><button disabled={!!exporting} aria-label={`${Capacitor.isNativePlatform() ? '打开' : '下载'} ${file.name}`} onClick={() => void download(file, 'open')}><FileLabel name={file.name} /></button>
      {Capacitor.isNativePlatform() && <button disabled={!!exporting} aria-label={`保存或分享 ${file.name}`} onClick={() => void download(file, 'share')}>保存/分享</button>}
      {exporting === file.id && <small role="status">正在处理…</small>}</div>)}
    {files.value?.artifacts.length === 0 && <p className="muted">暂无产物</p>}
    {notice && <p role="status">{notice}</p>}
    <p className="muted">点击名称{Capacitor.isNativePlatform() ? '打开文件，也可通过系统菜单保存或分享。临时副本在退出时清理；已保存或分享给其他应用的副本由你管理。' : '下载文件。'}</p>
    <KnowledgeFiles client={client} task={task} onError={onError}/>
    {(error || experts.error || tasks.error || files.error) && <p className="error" role="alert">{error || experts.error || tasks.error || files.error}</p>}
  </section>;
}
