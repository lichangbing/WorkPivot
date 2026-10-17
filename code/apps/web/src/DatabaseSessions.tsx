import { useEffect, useState } from 'react';
import { clearToken, jsonFetch } from './api';

interface Session { id: string; createdAt: string; expiresAt: string; current: boolean }
const button = 'rounded border border-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40';
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export function DatabaseSessions() {
  const [rows, setRows] = useState<Session[]>([]), [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [selected, setSelected] = useState<Session | null>(null);
  const load = async (signal?: AbortSignal) => {
    const result = await jsonFetch<{ sessions: Session[] }>('/api/auth/sessions', { signal });
    if (!signal?.aborted) { setRows(result.sessions); setLoaded(true); }
  };
  useEffect(() => { const c = new AbortController(); void load(c.signal).catch(e => { if (!c.signal.aborted) setError(e.message); }); return () => c.abort(); }, []);
  const revoke = async () => {
    if (!selected || busy) return;
    setBusy(true); setError('');
    try {
      await jsonFetch(`/api/auth/sessions/${selected.id}`, { method: 'DELETE' });
      if (selected.current) { clearToken(); window.dispatchEvent(new CustomEvent('wp:unauthorized')); return; }
      setSelected(null); await load();
    } catch (e) { setError(e instanceof Error ? e.message : '撤销失败'); }
    finally { setBusy(false); }
  };
  return <section className="space-y-4">
    <p className="text-sm text-neutral-400">仅展示你的有效登录。时间为北京时间；登录24小时后到期。撤销后该登录不能继续访问。系统未记录设备和IP信息。</p>
    <button className={button} disabled={busy} onClick={()=>{setError('');void load().catch(e=>setError(e.message));}}>刷新</button>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {!loaded && !error && <p>正在加载…</p>}
    {loaded && !rows.length && <p>暂无有效会话</p>}
    {rows.map(row=><article key={row.id} className="space-y-2 rounded border border-neutral-700 p-3">
      <strong>{row.current ? '当前登录' : '其他登录'}</strong>
      <p className="text-sm">登录时间：{date(row.createdAt)}<br/>到期时间：{date(row.expiresAt)}</p>
      <button className={button} disabled={busy} onClick={()=>setSelected(row)}>{row.current?'退出当前登录':'撤销此登录'}</button>
    </article>)}
    {selected && <div role="alertdialog" aria-label="确认撤销登录" className="space-y-3 rounded border border-amber-600 p-3">
      <p>{selected.current?'确认退出当前登录？':'确认撤销该登录？对方需要重新输入密码才能登录。'}</p>
      <div className="flex gap-2"><button className={button} disabled={busy} onClick={()=>{void revoke();}}>确认撤销</button><button className={button} disabled={busy} onClick={()=>setSelected(null)}>取消</button></div>
    </div>}
  </section>;
}
