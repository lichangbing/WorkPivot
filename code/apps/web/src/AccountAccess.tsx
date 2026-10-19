import { useState } from 'react';
import { api, clearToken } from './api';

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
