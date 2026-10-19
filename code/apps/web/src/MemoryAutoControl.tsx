import { useEffect, useState } from 'react';
import { jsonFetch } from './api';

export function MemoryAutoControl() {
  const [setting, setSetting] = useState<{ value: boolean; revision: number } | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { const c = new AbortController();
    void jsonFetch<{ setting: { value: boolean; revision: number } | null }>('/api/preferences/memory.auto-extraction', { signal: c.signal }).then(r => { if (!c.signal.aborted) setSetting(r.setting ?? { value: true, revision: 0 }); }).catch(() => { if (!c.signal.aborted) setError('无法读取自动整理设置'); });
    return () => { c.abort(); };
  }, []);
  return <div className="mt-2 space-y-2"><label className="flex items-center gap-2 text-neutral-400"><input type="checkbox" disabled={!setting || busy} checked={setting?.value ?? false} onChange={e => { if (!setting) return; const value = e.target.checked; setBusy(true); setError(''); void jsonFetch<{ revision: number }>('/api/preferences/memory.auto-extraction', { method: 'PUT', body: JSON.stringify({ value, revision: setting.revision }) }).then(r => setSetting({ value, revision: r.revision })).catch(e => setError(String(e))).finally(() => setBusy(false)); }} />自动整理记忆建议</label>{error && <p role="alert" className="text-red-400">{error}</p>}</div>;
}
