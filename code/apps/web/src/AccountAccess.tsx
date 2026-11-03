import { useState } from 'react';
import { api, clearToken } from './api';
import { Icon } from './Icon';

export function ServerConnection(): React.JSX.Element | null {
  const [error, setError] = useState('');
  const desktop = window.workpivotDesktop;
  if (!desktop) return null;
  return <div className="mb-4 rounded border border-neutral-800 p-3 text-xs text-neutral-400">
    <p className="break-all">当前服务器：{location.origin}</p>
    {desktop && <button className="mt-2 text-blue-400 hover:underline" onClick={() => {
      if (!desktop.changeServer) { setError('请更新客户端后更换服务器，或使用托盘中的服务器设置。'); return; }
      void desktop.changeServer().catch(() => setError('无法打开服务器设置，请重试或使用托盘中的服务器设置。'));
    }}>更换服务器</button>}
    {error && <p className="mt-2" role="alert">{error}</p>}
  </div>;
}

export function RequiredPasswordChange({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const leave = async (): Promise<void> => { await api.logout().catch(() => undefined); clearToken(); onDone(); };
  return <div className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-100">
    <form className="w-[380px] max-w-[95vw] space-y-4 rounded-xl border border-neutral-800 bg-neutral-900 p-6" onSubmit={(event) => {
      event.preventDefault(); if (busy) return;
      if (next !== confirm) { setError('两次输入的新密码不一致'); return; }
      setBusy(true); setError('');
      void api.changePassword(current, next).then(() => { clearToken(); setSaved(true); setCurrent(''); setNext(''); setConfirm(''); })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false));
    }}>
      <h1 className="text-xl font-semibold">{saved ? '密码已更新' : '设置个人密码'}</h1>
      {saved ? <><p className="text-sm text-neutral-400">请使用新密码重新登录。</p><button type="button" onClick={onDone} className="rounded bg-blue-600 px-4 py-2">返回登录</button></> : <>
        <p className="text-sm text-neutral-400">当前使用的是临时密码，请先修改后继续使用。</p>
        {[['临时密码', current, setCurrent, 'current-password'], ['新密码（至少 6 位）', next, setNext, 'new-password'], ['确认新密码', confirm, setConfirm, 'new-password']].map(([label, value, setter, autocomplete]) =>
          <label key={String(label)} className="block text-sm">{String(label)}<input type="password" required minLength={6} autoComplete={String(autocomplete)} value={String(value)} onChange={(e) => (setter as (v: string) => void)(e.target.value)} className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 p-2" /></label>)}
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-between"><button type="button" disabled={busy} onClick={() => void leave()}>退出登录</button><button disabled={busy} className="rounded bg-blue-600 px-4 py-2 disabled:opacity-40">{busy ? '保存中…' : '保存新密码'}</button></div>
      </>}
    </form>
  </div>;
}

/** 已登录用户主动修改密码；成功后当前令牌及全部旧会话失效。 */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    if (next.length < 6) { setError('新密码至少 6 位'); return; }
    if (next !== confirmation) { setError('两次输入的新密码不一致'); return; }
    if (next === current) { setError('新密码不能与当前密码相同'); return; }
    setBusy(true); setError('');
    try {
      await api.changePassword(current, next);
      clearToken();
      setCurrent(''); setNext(''); setConfirmation(''); setDone(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '修改密码失败');
    } finally {
      setBusy(false);
    }
  };
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form role="dialog" aria-modal="true" aria-label="修改密码" className="w-[400px] max-w-full rounded-xl border border-neutral-700 bg-neutral-900 p-5 text-neutral-100 shadow-2xl" onSubmit={event => void submit(event)} onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose(); }}>
      <div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">修改密码</h2><p className="mt-1 text-xs text-neutral-500">修改成功后所有旧登录会话都会失效。</p></div><button type="button" disabled={busy} aria-label="关闭修改密码" className="text-neutral-500 hover:text-neutral-100" onClick={onClose}><Icon name="close" /></button></div>
      {done ? <div className="space-y-4"><p role="status" className="text-sm text-emerald-400">密码已修改，请使用新密码重新登录。</p><button type="button" className="w-full rounded bg-blue-600 py-2 text-sm hover:bg-blue-500" onClick={() => window.location.reload()}>重新登录</button></div> : <div className="space-y-3">
        <label className="block text-xs text-neutral-400">当前密码<input autoFocus aria-label="当前密码" required autoComplete="current-password" type="password" className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm" value={current} onChange={event => setCurrent(event.target.value)} /></label>
        <label className="block text-xs text-neutral-400">新密码<input aria-label="新密码" required minLength={6} autoComplete="new-password" type="password" className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm" value={next} onChange={event => setNext(event.target.value)} /></label>
        <label className="block text-xs text-neutral-400">确认新密码<input aria-label="确认新密码" required minLength={6} autoComplete="new-password" type="password" className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-1"><button type="button" disabled={busy} className="rounded bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700" onClick={onClose}>取消</button><button disabled={busy || !current || !next || !confirmation} className="rounded bg-blue-600 px-3 py-1.5 text-sm hover:bg-blue-500 disabled:opacity-40">{busy ? '正在保存…' : '保存新密码'}</button></div>
      </div>}
    </form>
  </div>;
}
