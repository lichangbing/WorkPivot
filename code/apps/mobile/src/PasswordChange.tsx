import { useState } from 'react';
import { type MobileClient } from './client';

export function PasswordChange({ client, onDone }: { client: MobileClient; onDone: () => Promise<void> }) {
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [confirm, setConfirm] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <main className="login-page"><form onSubmit={event => {
    event.preventDefault(); if (busy) return;
    if (next !== confirm) { setError('两次输入的新密码不一致'); return; }
    setBusy(true); setError('');
    void client.json('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: next }) })
      .then(onDone).catch(reason => setError(reason instanceof Error ? reason.message : '修改失败')).finally(() => setBusy(false));
  }}><h1>设置个人密码</h1><p className="muted">请先修改临时密码，再进入工作空间。</p>
    <label>临时密码<input required type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} /></label>
    <label>新密码<input required minLength={6} type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} /></label>
    <label>确认新密码<input required minLength={6} type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /></label>
    {error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy}>保存并重新登录</button>
    <button type="button" disabled={busy} onClick={() => void onDone().catch(reason => setError(String(reason)))}>退出登录</button>
  </form></main>;
}
