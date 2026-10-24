import { useState } from 'react';
import { MobileClient, saveSession, type Auth } from './client';
import workpivotIcon from '../../web/public/favicon.png';

export function Login({ onLogin }: { onLogin: (client: MobileClient, auth: Auth) => void }) {
  const [server, setServer] = useState(() => localStorage.getItem('wp-mobile-server') ?? '');
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [configure, setConfigure] = useState(!server);
  const login = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      // 不继承预览环境的旧令牌；健康探测不携带用户凭据。
      const client = new MobileClient(server, null);
      await client.health();
      const state = await client.json<Auth>('/api/auth/state');
      if (state.needsSetup) throw new Error('服务器尚未初始化，请联系管理员先完成后台设置');
      const result = await client.json<{ token: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: username.trim(), password }) });
      client.token = result.token;
      const authenticated = await client.json<Auth>('/api/auth/state');
      if (!authenticated.authenticated || !authenticated.user) throw new Error('登录会话无效，请重试');
      try { await saveSession(client.server, result.token); } catch {
        await client.json('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
        throw new Error('无法安全保存登录状态，请重试');
      }
      localStorage.setItem('wp-mobile-server', client.server);
      setPassword(''); onLogin(client, authenticated);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败'); }
    finally { setBusy(false); }
  };
  return <main className="login-page"><form onSubmit={event => { event.preventDefault(); void login(); }}>
    <img className="brand-mark" src={workpivotIcon} alt="" /><h1>WorkPivot</h1><p className="muted">连接你的工作空间</p>
    <label>用户名<input required autoComplete="username" autoCapitalize="none" value={username} disabled={busy} onChange={e => setUsername(e.target.value)} /></label>
    <label>密码<span className="password-field"><input required type={visible ? 'text' : 'password'} autoComplete="current-password" value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /><button type="button" aria-label={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(!visible)}>{visible ? '隐藏' : '显示'}</button></span></label>
    <button className="primary" disabled={busy}>{busy ? '正在连接…' : '登录'}</button>
    <button type="button" className="connection-toggle" aria-expanded={configure} disabled={busy} onClick={() => setConfigure(!configure)}>服务器设置</button>
    {configure && <><label>后台地址<input type="url" required placeholder="https://服务器地址" autoCapitalize="none" autoCorrect="off" value={server} disabled={busy} onChange={e => setServer(e.target.value)} /><small>由部署管理员提供，首次使用需要填写。</small></label><button type="button" disabled={busy || !server} onClick={() => { setServer(''); localStorage.removeItem('wp-mobile-server'); }}>清除地址</button></>}
    {error && <p role="alert" className="error">{error}</p>}
    <p className="version">WorkPivot Mobile · 开发预览</p>
  </form></main>;
}
