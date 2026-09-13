import { useCallback, useEffect, useState } from 'react';
import { getToken } from '../api';
interface McpConnection { id: string; revision: string; name: string; url: string; hasToken: boolean; enabled: boolean; disabledTools?: string[]; status: 'untested' | 'ready' | 'error'; error?: string; checkedAt?: string; tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }
type Draft = { id?: string; revision?: string; name: string; url: string; token: string; clearToken: boolean };
const button = 'rounded border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs hover:bg-neutral-700 disabled:opacity-40';
const input = 'w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm';
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/mcp' + path, { method, headers: { authorization: `Bearer ${getToken() ?? ''}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const result = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(result.error ?? 'MCP 操作失败'); return result;
}
export function McpPanel({ onDirty }: { onDirty: (dirty: boolean) => void }): React.JSX.Element {
  const [rows, setRows] = useState<McpConnection[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [original, setOriginal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dirty = draft !== null && JSON.stringify(draft) !== original;
  const load = useCallback(async () => { setRows((await request<{ connections: McpConnection[] }>('')).connections); }, []);
  useEffect(() => { void load().catch(e => setError(String(e))); }, [load]);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  useEffect(() => { const listener = (e: BeforeUnloadEvent) => { if (dirty || busy) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', listener); return () => window.removeEventListener('beforeunload', listener); }, [dirty, busy]);
  const work = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { await load().catch(() => undefined); setBusy(false); } };
  const edit = (row?: McpConnection) => {
    if (dirty && !window.confirm('放弃尚未保存的 MCP 配置？')) return;
    const value: Draft = { ...(row ? { id: row.id, revision: row.revision } : {}), name: row?.name ?? '', url: row?.url ?? '', token: '', clearToken: false }; setDraft(value); setOriginal(JSON.stringify(value)); setError('');
  };
  return <div className="max-w-[1000px] space-y-4">
    <div className="flex items-center justify-between"><h2 className="font-semibold">MCP 接入与管理</h2><div className="flex gap-2"><button className={button} disabled={busy} onClick={() => edit()}>添加服务</button><button className={button} disabled={busy} onClick={() => void work(load)}>刷新</button></div></div>
    <p className="text-xs text-neutral-500">连接当前账号的 Streamable HTTP 工具服务。保存 → 测试连接 → 启用，任务即可发现工具。每次调用都会请求确认。</p>
    {error && <p role="alert" className="rounded border border-red-500/40 p-3 text-sm text-red-400">{error}</p>}
    {notice && <p role="status" className="text-sm text-emerald-500">{notice}</p>}
    {draft && <form className="space-y-3 rounded-lg border border-neutral-700 bg-neutral-900 p-4" onSubmit={e => { e.preventDefault(); void work(async () => { await request(draft.id ? '/' + draft.id : '', draft.id ? 'PUT' : 'POST', draft); setDraft(null); setNotice('配置已保存，请测试连接并启用。'); }); }}>
      <h3 className="text-sm font-medium">{draft.id ? '编辑服务' : '添加服务'}</h3>
      <label className="block text-xs">名称<input required maxLength={80} aria-label="MCP 服务名称" disabled={busy} className={input} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className="block text-xs">服务地址<input required type="url" aria-label="MCP 服务地址" placeholder="https://example.com/mcp" disabled={busy} className={input} value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} /></label>
      <p className="text-xs text-neutral-500">填写后台服务器能访问的 MCP 地址。后台运行在容器中时，127.0.0.1 指向该容器。HTTP 地址不加密传输。</p>
      <label className="block text-xs">Bearer 访问令牌（可选）<input type="password" autoComplete="new-password" aria-label="MCP 访问令牌" placeholder={draft.id ? '留空保留原凭据；更换地址时不会沿用原凭据' : '服务无鉴权可留空'} disabled={busy} className={input} value={draft.token} onChange={e => setDraft({ ...draft, token: e.target.value })} /></label>
      {draft.id && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.clearToken} disabled={busy} onChange={e => setDraft({ ...draft, clearToken: e.target.checked })} />清除原凭据</label>}
      <p className="text-xs text-neutral-500">保存或重新测试后需再次启用。当前支持 HTTP 工具服务与 Bearer 令牌，不启动本地命令，也不提供 OAuth 登录。</p>
      <div className="flex gap-2"><button type="submit" className={button} disabled={busy || !draft.name.trim() || !draft.url.trim()}>保存配置</button><button type="button" className={button} disabled={busy} onClick={() => { if (!dirty || window.confirm('放弃尚未保存的修改？')) setDraft(null); }}>取消</button></div>
    </form>}
    {!rows.length && <p className="text-sm text-neutral-500">尚未配置 MCP 服务。</p>}
    {rows.map(row => <section key={row.id} className="rounded-lg border border-neutral-800 p-4">
      <div className="flex flex-wrap items-center gap-2"><h3 className="mr-auto font-medium">{row.name}</h3><span className="text-xs text-neutral-500">{row.enabled ? '已启用' : '未启用'} · {row.status === 'ready' ? '最近测试通过' : row.status === 'error' ? '最近测试失败' : '待测试'}</span>
        <button className={button} disabled={busy} onClick={() => edit(row)}>编辑</button>
        <button className={button} disabled={busy} onClick={() => void work(async () => { const result = await request<McpConnection>('/' + row.id + '/test', 'POST', { revision: row.revision }); setNotice(`连接测试通过，发现 ${result.tools.length} 个工具。${result.tools.length ? '可启用此服务。' : '此服务未提供工具。'}`); })}>测试连接</button>
        <button className={button} disabled={busy || (!row.enabled && (row.status !== 'ready' || !row.tools.length))} onClick={() => void work(async () => { await request('/' + row.id + '/toggle', 'POST', { enabled: !row.enabled, revision: row.revision }); })}>{row.enabled ? '禁用' : '启用'}</button>
        <button className={button} disabled={busy} onClick={() => { if (window.confirm('删除此 MCP 连接配置？')) void work(async () => { await request('/' + row.id, 'DELETE', { revision: row.revision }); if (draft?.id === row.id) setDraft(null); }); }}>删除</button>
      </div>
      <p className="mt-2 break-all text-xs text-neutral-500">{row.url} · {row.hasToken ? '已配置凭据' : '无凭据'}{row.checkedAt ? ' · ' + new Date(row.checkedAt).toLocaleString() : ''}</p>
      {row.error && <p className="mt-2 text-xs text-red-400">{row.error}</p>}
      <details className="mt-3 text-xs"><summary>工具清单（{row.tools.length}）</summary>{row.tools.map(tool => <details key={tool.name} className="mt-2 rounded bg-neutral-900 p-2"><summary>{tool.name} · {row.disabledTools?.includes(tool.name) ? '已禁用' : row.enabled ? '可用' : '已开放，服务未启用'}</summary><button type="button" className={button + ' mt-2'} disabled={busy} onClick={() => void work(async () => { await request('/' + row.id + '/tools/toggle', 'POST', { name: tool.name, enabled: Boolean(row.disabledTools?.includes(tool.name)), revision: row.revision }); setNotice('工具设置已保存，下轮任务使用新清单；当前服务的进行中调用已取消。'); })}>{row.disabledTools?.includes(tool.name) ? '启用工具' : '禁用工具'}</button><p className="mt-1 whitespace-pre-wrap">{tool.description || '无描述'}</p><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>)}</details>
    </section>)}
  </div>;
}
