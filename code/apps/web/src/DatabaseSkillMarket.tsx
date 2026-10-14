import { useEffect, useState } from 'react';
import { jsonFetch } from './api';
import { Icon } from './Icon';

export function LoadedDatabaseSkills() {
  const [names, setNames] = useState<string[]>([]), [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const result = await jsonFetch<{ skills: { name: string; loaded: boolean }[] }>('/api/skill-market', { signal: c.signal }); if (!c.signal.aborted) { setNames(result.skills.filter(s => s.loaded).map(s => s.name)); setError(''); } }
      catch { if (!c.signal.aborted) setError('技能清单暂不可用'); }
      finally { if (!c.signal.aborted) timer = setTimeout(() => { void load(); }, 5000); }
    };
    void load(); return () => { c.abort(); clearTimeout(timer); };
  }, []);
  return <div className="min-h-0 flex-1 overflow-y-auto">{error ? <p className="text-neutral-500">{error}</p> : names.length ? names.map(name => <p key={name} className="flex items-center gap-2 py-1 text-neutral-300"><Icon name="skill" /><span className="truncate">{name}</span></p>) : <p className="text-neutral-500">尚未加载技能</p>}</div>;
}

export function DatabaseSkillMarket() {
  const [rows, setRows] = useState<{ name: string; description: string; version: string; loaded: boolean }[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const load = async (signal?: AbortSignal) => { const result = await jsonFetch<{ skills: typeof rows }>('/api/skill-market', { signal }); if (!signal?.aborted) { setRows(result.skills); setReady(true); } };
  useEffect(() => { const c = new AbortController(); void load(c.signal).catch(e => { if (!c.signal.aborted) setError(String(e)); }); return () => c.abort(); }, []);
  return <section aria-label="技能市场" className="space-y-3"><p className="text-sm text-neutral-400">选择加载后台已发布的技能，后续任务可按需读取说明和资源。</p>{error && <p role="alert" className="text-sm text-red-400">{error}</p>}{!ready && !error && <p>正在加载…</p>}{ready && !rows.length && <p className="text-sm text-neutral-500">暂无已发布技能</p>}{rows.map(row => <article key={row.name} className="rounded-lg border border-neutral-800 p-3"><div className="flex items-center justify-between gap-3"><h3 className="flex min-w-0 items-center gap-2 text-sm font-medium"><Icon name="skill" /><span className="truncate">{row.name}</span></h3><button className="shrink-0 rounded border border-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-800 disabled:opacity-40" disabled={busy} onClick={() => { setBusy(true); setError(''); void jsonFetch(`/api/skill-market/${encodeURIComponent(row.name)}`, { method: 'PUT', body: JSON.stringify({ loaded: !row.loaded }) }).then(() => load()).catch(e => setError(String(e))).finally(() => setBusy(false)); }}>{row.loaded ? '卸载' : '加载'}</button></div><p className="mt-2 whitespace-pre-wrap break-words text-xs text-neutral-400">{row.description}</p></article>)}</section>;
}
