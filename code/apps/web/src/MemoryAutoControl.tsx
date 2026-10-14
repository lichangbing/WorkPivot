import { useEffect, useState } from 'react';
import { jsonFetch } from './api';

export function MemoryAutoControl() {
  const [setting, setSetting] = useState<{ value: boolean; revision: number } | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [jobs, setJobs] = useState<{ id: string; task: string; status: string; error?: string; suggestions?: number }[]>([]);
  useEffect(() => { const c = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    void jsonFetch<{ setting: { value: boolean; revision: number } | null }>('/api/preferences/memory.auto-extraction', { signal: c.signal }).then(r => { if (!c.signal.aborted) setSetting(r.setting ?? { value: true, revision: 0 }); }).catch(() => { if (!c.signal.aborted) setError('无法读取自动整理设置'); });
    const poll = async () => { try { const r = await jsonFetch<{ jobs: typeof jobs }>('/api/memory-jobs', { signal: c.signal }); if (!c.signal.aborted) setJobs(r.jobs); } catch { /* Next poll retries. */ } finally { if (!c.signal.aborted) timer = setTimeout(() => { void poll(); }, 10000); } }; void poll();
    return () => { c.abort(); clearTimeout(timer); };
  }, []);
  return <div className="mt-2 space-y-2"><label className="flex items-center gap-2 text-neutral-400"><input type="checkbox" disabled={!setting || busy} checked={setting?.value ?? false} onChange={e => { if (!setting) return; const value = e.target.checked; setBusy(true); setError(''); void jsonFetch<{ revision: number }>('/api/preferences/memory.auto-extraction', { method: 'PUT', body: JSON.stringify({ value, revision: setting.revision }) }).then(r => setSetting({ value, revision: r.revision })).catch(e => setError(String(e))).finally(() => setBusy(false)); }} />自动整理记忆建议</label>{error && <p role="alert" className="text-red-400">{error}</p>}{jobs.length > 0 && <details><summary>记忆整理作业（{jobs.length}）</summary>{jobs.map(j => <p key={j.id} className="mt-1 break-words text-neutral-500">{j.task}：{j.status === 'pending' ? '等待整理' : j.status === 'running' ? '整理中' : j.status === 'completed' ? `整理完成 · ${j.suggestions ? '已产生 '+j.suggestions+' 条建议' : '暂无新建议'}` : j.error || '整理失败'}{j.status === 'failed' && <button disabled={busy} className="ml-2 underline" onClick={() => { setBusy(true); void jsonFetch(`/api/memory-jobs/${j.id}/retry`, { method: 'POST' }).then(() => setJobs(rows => rows.map(row => row.id === j.id ? { ...row, status: 'pending' } : row))).catch(e => setError(String(e))).finally(() => setBusy(false)); }}>重试</button>}</p>)}</details>}</div>;
}
