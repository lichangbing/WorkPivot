import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Login } from './Login';
import { PasswordChange } from './PasswordChange';
import { Workspace } from './Workspace';
import { ApiError, MobileClient, savedSession, saveSession, type Auth } from './client';
import './mobile.css';
import { clearArtifactCache, initializeArtifactCache } from './artifact-export';

function App() {
  const [session, setSession] = useState<{ client: MobileClient; auth: Auth } | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem('wp-mobile-theme') === 'dark' ? 'dark' : 'light');
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('wp-mobile-theme', theme); }, [theme]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await initializeArtifactCache();
        const saved = await savedSession();
        if (!saved) return;
        const client = new MobileClient(saved.server, saved.token);
        const auth = await client.json<Auth>('/api/auth/state');
        if (!auth.authenticated) { await saveSession(saved.server, null); return; }
        if (alive) setSession({ client, auth });
      } catch (reason) { if (alive) setError(reason instanceof Error ? reason.message : '登录恢复失败'); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);
  const leave = async (expired = false) => {
    if (!session) return;
    if (!expired) await session.client.json('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    await saveSession(session.client.server, null);
    session.client.dispose(); setSession(null);
    try { await clearArtifactCache(); setError(expired ? '登录已失效，请重新登录' : ''); }
    catch { setError('已退出登录，但临时产物清理失败，请在系统设置中清除应用缓存'); }
  };
  if (loading) return <main className="login-page">正在恢复工作空间…</main>;
  if (!session) return <>{error && <p className="error global-error" role="alert">{error}</p>}<Login onLogin={(client, auth) => { setError(''); setSession({ client, auth }); }} /></>;
  if (session.auth.user?.mustChangePassword) return <PasswordChange client={session.client} onDone={() => leave(true)} />;
  return <Workspace client={session.client} user={session.auth.user!} theme={theme} onTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')} onLogout={() => leave()} onError={reason => { if (reason instanceof ApiError && reason.status === 401) void leave(true).catch(() => setError('无法清除安全凭据，请重试')); }} />;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
