import { useEffect, useState } from 'react';

/** 部署新版本后只提示刷新；不会自动打断运行中任务或丢弃未提交输入。 */
export function UpdateNotice() {
  const [loadedVersion, setLoadedVersion] = useState('');
  const [serverVersion, setServerVersion] = useState('');
  useEffect(() => {
    let stopped = false;
    let baseline = '';
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      clearTimeout(timer);
      try {
        const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (!response.ok) return;
        const value = await response.json() as { version?: unknown };
        if (stopped || typeof value.version !== 'string' || !value.version) return;
        if (!baseline) { baseline = value.version; setLoadedVersion(value.version); }
        setServerVersion(value.version);
      } catch {
        // 更新检查失败不打断使用，下一次可见或周期检查继续。
      } finally {
        if (!stopped) timer = setTimeout(() => { void check(); }, 30 * 60 * 1000);
      }
    };
    const resume = () => { if (document.visibilityState === 'visible') void check(); };
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    void check();
    return () => {
      stopped = true; clearTimeout(timer);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  if (!loadedVersion || !serverVersion || loadedVersion === serverVersion) return null;
  return <aside className="update-notice" role="status">
    <span>WorkPivot 已更新到 {serverVersion}</span>
    <button onClick={() => location.reload()}>刷新页面</button>
    <button aria-label="稍后更新" onClick={(event) => { event.currentTarget.closest('aside')?.remove(); }}>稍后</button>
  </aside>;
}
