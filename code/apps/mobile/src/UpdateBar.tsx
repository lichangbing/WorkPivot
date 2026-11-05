import { useEffect, useState } from 'react';
import type { ClientUpdateManifest } from '@workpivot/shared';
import type { MobileClient } from './client';
import {
  checkAndroidUpdate,
  installAndroidUpdate,
  updateCheckDelay,
  updateDismissKey,
} from './updater';

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'permission' | 'installer';

export function UpdateBar({ client }: { client: MobileClient }) {
  const [manifest, setManifest] = useState<ClientUpdateManifest | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      clearTimeout(timer);
      if (controller.signal.aborted || document.visibilityState !== 'visible') return;
      setPhase(current => current === 'idle' || current === 'available' ? 'checking' : current);
      try {
        const value = await checkAndroidUpdate(client, controller.signal);
        if (controller.signal.aborted) return;
        if (value) {
          setManifest(value.manifest);
          const dismissed = !value.manifest.mandatory && localStorage.getItem(updateDismissKey(value.manifest)) === '1';
          setPhase(dismissed ? 'idle' : 'available');
        } else {
          setManifest(null); setPhase('idle');
        }
      } catch {
        if (!controller.signal.aborted) setPhase(manifest ? 'available' : 'idle');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void check(); }, updateCheckDelay());
      }
    };
    const resume = () => { if (document.visibilityState === 'visible') void check(); };
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    void check();
    return () => {
      controller.abort(); clearTimeout(timer);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [client]);
  if (!manifest || (phase === 'idle' && !manifest.mandatory)) return null;
  const install = async () => {
    setPhase('downloading'); setError('');
    try {
      const status = await installAndroidUpdate(manifest);
      setPhase(status === 'permission-required' ? 'permission' : 'installer');
    } catch {
      setPhase('available');
      setError('更新下载或校验失败，当前版本不受影响，请检查网络后重试。');
    }
  };
  return <section className="update-bar" aria-label="客户端更新">
    {phase === 'checking' ? <span>正在检查客户端更新…</span> : <>
      <div><strong>有新版本 {manifest.version}</strong><small>{manifest.mandatory ? '此版本要求更新。' : '更新不会清除登录态和已同步任务。'} 安装时应用会关闭，后台任务继续运行。</small></div>
      {phase === 'permission' ? <p role="status">请先在系统设置中允许 WorkPivot 安装更新，然后返回点击“继续安装”。</p> : null}
      {phase === 'installer' ? <p role="status">系统安装器已打开，请核对版本后确认安装。</p> : null}
      {phase === 'downloading' ? <p role="status">正在下载并校验签名，请保持网络连接…</p> : null}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="update-actions">
        <button className="primary" disabled={phase === 'downloading'} onClick={() => void install()}>{phase === 'permission' ? '继续安装' : phase === 'installer' ? '重新打开安装器' : '下载并安装'}</button>
        {!manifest.mandatory && phase !== 'installer' && <button disabled={phase === 'downloading'} onClick={() => { localStorage.setItem(updateDismissKey(manifest), '1'); setPhase('idle'); }}>稍后</button>}
        {manifest.releaseNotesUrl && <a href={manifest.releaseNotesUrl} target="_blank" rel="noreferrer">更新说明</a>}
      </div>
    </>}
  </section>;
}
