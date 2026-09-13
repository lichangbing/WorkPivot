import { useEffect, useState } from 'react';
import { CompatibilityError, checkServiceHealth } from '@workpivot/shared';

/** Poll connection health only. Never reload the app or replay a task after a disconnect. */
export function ConnectionStatus() {
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false, busy = false, wasOffline = false;
    let active: AbortController | undefined;
    const check = async () => {
      if (busy || disposed) return;
      busy = true; active = new AbortController();
      try {
        const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.any([active.signal, AbortSignal.timeout(8000)]) });
        if (!response.ok) throw new Error('服务暂不可用');
        checkServiceHealth(await response.json());
        if (disposed) return;
        setFailed(false);
        if (wasOffline) setMessage('连接已恢复。未自动重发任务，请确认任务状态后继续。');
        wasOffline = false;
      } catch (error) {
        if (disposed) return;
        wasOffline = true; setFailed(true);
        setMessage(error instanceof CompatibilityError ? error.message : '与后台连接中断，正在自动检查恢复。未发送的内容会保留。');
      } finally { busy = false; }
    };
    void check();
    const timer = setInterval(() => { void check(); }, 15000);
    window.addEventListener('online', check);
    return () => { disposed = true; active?.abort(); clearInterval(timer); window.removeEventListener('online', check); };
  }, []);
  if (!message) return null;
  return <aside role="status" aria-live="polite" className={`fixed top-3 left-1/2 -translate-x-1/2 z-[100] max-w-[90vw] rounded-lg border px-4 py-2 text-sm shadow-lg ${failed ? 'bg-amber-50 text-amber-900 border-amber-200' : 'bg-emerald-50 text-emerald-900 border-emerald-200'}`}>
    {message}{!failed && <button className="ml-3 underline" onClick={() => setMessage('')}>知道了</button>}
  </aside>;
}
