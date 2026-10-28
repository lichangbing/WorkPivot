import { useCallback, useEffect, useState } from 'react';
import { api, type PublicUser } from '../api';

type AccessPolicy = Awaited<ReturnType<typeof api.accessPolicy>>['policy'];
const button = 'rounded-lg border border-neutral-700 px-3 py-2 text-xs hover:bg-neutral-800 disabled:opacity-40';
const input = 'mt-1 block w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm';

export function DatabaseUsers() {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [policy, setPolicy] = useState<AccessPolicy | null>(null);
  const [me, setMe] = useState<PublicUser | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PublicUser | null>(null);
  const [temporary, setTemporary] = useState<{ username: string; password: string } | null>(null);

  const load = useCallback(async () => {
    const [userResult, policyResult, auth] = await Promise.all([api.listUsers(), api.accessPolicy(), api.authState()]);
    setUsers(userResult.users);
    setPolicy(policyResult.policy);
    setMe(auth.user);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load().catch(reason => { if (!controller.signal.aborted) setError(String(reason)); });
    return () => controller.abort();
  }, [load]);

  const run = async (action: () => Promise<unknown>, message?: string) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await action();
      await load();
      if (message) setNotice(message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = (event: React.FormEvent) => {
    event.preventDefault();
    if (!policy) return;
    void run(async () => {
      const result = await api.updateAccessPolicy(policy);
      setPolicy(result.policy);
    }, '访问与注册策略已保存');
  };

  const resetPassword = async (user: PublicUser) => {
    if (!window.confirm(`重置「${user.username}」密码？旧会话会立即失效，用户下次登录需修改临时密码。`)) return;
    await run(async () => {
      const result = await api.resetUserPassword(user.id);
      setTemporary({ username: user.username, password: result.temporaryPassword });
    });
  };

  return <section className="space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold">用户与访问安全</h1>
        <p className="mt-1 text-sm text-neutral-400">管理账户、登录状态和自助注册策略。对话、Token、上传与并发限制统一在“限额管理”中配置。</p>
      </div>
      <button className={button} disabled={busy} onClick={() => setCreating(true)}>创建用户</button>
    </header>

    {error && <p role="alert" className="rounded border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">{error}</p>}
    {notice && <p role="status" className="rounded border border-emerald-800 bg-emerald-950/30 p-3 text-sm text-emerald-300">{notice}</p>}

    {policy && <form onSubmit={savePolicy} className="space-y-4 rounded-xl border border-neutral-700 bg-neutral-900 p-4">
      <div>
        <h2 className="font-medium">注册与访问</h2>
        <p className="mt-1 text-xs text-neutral-500">首个管理员创建后默认关闭自助注册；管理员创建的账户默认不限，自助注册默认限额在“限额管理”中维护。</p>
      </div>
      <div className="max-w-sm">
        <label className="text-sm">注册方式
          <select className={input} value={policy.registrationMode} onChange={event => setPolicy({ ...policy, registrationMode: event.target.value as AccessPolicy['registrationMode'] })}>
            <option value="closed">仅管理员创建账户</option>
            <option value="open">允许自助注册</option>
          </select>
        </label>
      </div>
      <button className={button} disabled={busy}>保存访问策略</button>
    </form>}

    <div className="overflow-x-auto rounded-xl border border-neutral-800">
      <table className="min-w-[980px] w-full text-left text-sm">
        <thead className="bg-neutral-900 text-xs text-neutral-400">
          <tr>{['用户', '角色与状态', '登录会话', '创建 / 最近登录', '操作'].map(label => <th key={label} className="px-3 py-3">{label}</th>)}</tr>
        </thead>
        <tbody>
          {users.map(user => <tr key={user.id} className="border-t border-neutral-800 align-top">
            <td className="px-3 py-3"><p className="font-medium">{user.username}</p><p className="mt-1 text-xs text-neutral-500">{user.email || '未填写邮箱'}</p></td>
            <td className="px-3 py-3"><p>{user.role === 'admin' ? '管理员' : '成员'}{user.platformAdmin ? ' · 平台管理员' : ''}</p><p className={'mt-1 text-xs ' + (user.disabled ? 'text-red-400' : 'text-emerald-400')}>{user.disabled ? '已停用' : user.mustChangePassword ? '待修改临时密码' : '正常'}</p></td>
            <td className="px-3 py-3">{user.activeSessions ?? 0} 个活动会话</td>
            <td className="px-3 py-3 text-xs text-neutral-500"><p>{user.createdAt ? new Date(user.createdAt).toLocaleDateString('zh-CN') : '—'}</p><p className="mt-1">{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString('zh-CN') : '从未登录'}</p></td>
            <td className="px-3 py-3"><div className="flex max-w-72 flex-wrap justify-end gap-2">
              {!user.platformAdmin && <button className={button} disabled={busy} onClick={() => setEditing(user)}>修改</button>}
              {!user.platformAdmin && user.id !== me?.id && <button className={button} disabled={busy} onClick={() => void resetPassword(user)}>重置密码</button>}
              {!user.platformAdmin && user.id !== me?.id && <button className={button} disabled={busy} onClick={() => { if (window.confirm(`撤销「${user.username}」全部登录会话？`)) void run(() => api.revokeUserSessions(user.id), '登录会话已撤销'); }}>撤销登录</button>}
            </div></td>
          </tr>)}
          {!users.length && <tr><td colSpan={5} className="px-3 py-10 text-center text-neutral-500">暂无用户</td></tr>}
        </tbody>
      </table>
    </div>

    {creating && <CreateUserDialog busy={busy} onClose={() => setCreating(false)} onSave={async input => { await run(() => api.createUser(input.username, input.password, input.role, input.email), '用户已创建，默认不限额度'); setCreating(false); }} />}
    {editing && <EditUserDialog user={editing} busy={busy} onClose={() => setEditing(null)} onSave={async input => { await run(() => api.updateUser(editing.id, input), '用户资料已更新'); setEditing(null); }} />}
    {temporary && <div role="dialog" aria-modal="true" aria-label="临时密码" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"><div className="w-full max-w-md space-y-4 rounded-xl border border-neutral-700 bg-neutral-900 p-5"><h2 className="font-semibold">{temporary.username} 的临时密码</h2><p className="text-sm text-neutral-400">只显示一次。请通过安全渠道交付，用户登录后必须修改。</p><input aria-label="临时密码" readOnly value={temporary.password} onFocus={event => event.currentTarget.select()} className={input + ' font-mono'} /><button className={button} onClick={() => setTemporary(null)}>已保存并关闭</button></div></div>}
  </section>;
}

function CreateUserDialog({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: (input: { username: string; password: string; role: 'admin' | 'member'; email?: string }) => Promise<void> }) {
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [confirm, setConfirm] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member'), [email, setEmail] = useState('');
  const [error, setError] = useState('');
  return <div role="dialog" aria-modal="true" aria-label="创建用户" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"><form className="w-full max-w-md space-y-3 rounded-xl border border-neutral-700 bg-neutral-900 p-5" onSubmit={event => { event.preventDefault(); if (password !== confirm) { setError('两次密码不一致'); return; } void onSave({ username: username.trim(), password, role, email: email.trim() || undefined }); }}><h2 className="font-semibold">创建用户</h2><p className="text-xs text-neutral-500">创建后默认不限；如需限制，请到“限额管理”单独配置。</p><label className="block text-sm">用户名<input className={input} required minLength={2} maxLength={80} value={username} onChange={event => setUsername(event.target.value)} /></label><label className="block text-sm">邮箱（选填）<input className={input} type="email" value={email} onChange={event => setEmail(event.target.value)} /></label><label className="block text-sm">临时密码<input className={input} required type="password" minLength={6} value={password} onChange={event => setPassword(event.target.value)} /></label><label className="block text-sm">确认密码<input className={input} required type="password" value={confirm} onChange={event => setConfirm(event.target.value)} /></label><label className="block text-sm">角色<select className={input} value={role} onChange={event => setRole(event.target.value as 'admin' | 'member')}><option value="member">成员</option><option value="admin">管理员</option></select></label>{error && <p role="alert" className="text-sm text-red-400">{error}</p>}<div className="flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={onClose}>取消</button><button className={button} disabled={busy}>创建</button></div></form></div>;
}

function EditUserDialog({ user, busy, onClose, onSave }: { user: PublicUser; busy: boolean; onClose: () => void; onSave: (input: { email?: string | null; role?: 'admin' | 'member'; disabled?: boolean }) => Promise<void> }) {
  const [email, setEmail] = useState(user.email ?? ''), [role, setRole] = useState(user.role), [disabled, setDisabled] = useState(user.disabled ?? false);
  return <div role="dialog" aria-modal="true" aria-label="修改用户" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"><form className="w-full max-w-md space-y-3 rounded-xl border border-neutral-700 bg-neutral-900 p-5" onSubmit={event => { event.preventDefault(); void onSave({ email: email.trim() || null, role, disabled }); }}><h2 className="font-semibold">修改用户 · {user.username}</h2><label className="block text-sm">邮箱<input className={input} type="email" value={email} onChange={event => setEmail(event.target.value)} /></label><label className="block text-sm">角色<select className={input} value={role} onChange={event => setRole(event.target.value as 'admin' | 'member')}><option value="member">成员</option><option value="admin">管理员</option></select></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={disabled} onChange={event => setDisabled(event.target.checked)} /> 停用账户并撤销其全部登录会话</label><p className="text-xs text-neutral-500">限额在独立的“限额管理”页面修改。</p><div className="flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={onClose}>取消</button><button className={button} disabled={busy}>保存</button></div></form></div>;
}
