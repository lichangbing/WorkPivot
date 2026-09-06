/**
 * 管理后台：顶部通栏布局，左侧品牌区 + 功能页签，右侧用户下拉菜单（修改密码/退出）。
 * 用户管理：创建/修改/删除均走右侧按钮与弹窗；创建弹窗包含用户名/密码/确认密码/邮箱。
 * 登录复用主应用令牌（同一 localStorage）；后台登录成功后必须保存 token。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, clearToken, getToken, setToken, type PublicProvider, type PublicUser } from '../api';

type Menu = 'users' | 'models' | 'skills' | 'ops';
type Role = PublicUser['role'];

type UserDialogState =
  | { kind: 'create' }
  | { kind: 'edit'; user: PublicUser }
  | null;

const ROLE_TEXT: Record<Role, string> = {
  admin: '管理员',
  member: '成员',
};

export default function AdminApp(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [me, setMe] = useState<PublicUser | null>(null);
  const [menu, setMenu] = useState<Menu>('users');

  const [users, setUsers] = useState<PublicUser[]>([]);
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [skills, setSkills] = useState<Array<{ name: string; description: string; source: string; disabled: boolean }>>([]);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (getToken() === null) {
      setMe(null);
      setAuthed(false);
      return;
    }
    try {
      const state = await api.authState();
      if (state.authenticated && state.user && state.user.role === 'admin') {
        setMe(state.user);
        setAuthed(true);
      } else {
        setMe(null);
        setAuthed(false);
      }
    } catch {
      setMe(null);
      setAuthed(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadUsers = useCallback(async (): Promise<void> => {
    try {
      setUsers((await api.listUsers()).users);
    } catch { /* 403 → 非 admin */ }
  }, []);
  const loadProviders = useCallback(async (): Promise<void> => {
    setProviders((await api.listProviders()).providers);
  }, []);
  const loadSkills = useCallback(async (): Promise<void> => {
    try {
      setSkills((await api.listSkillsAdmin()).skills);
    } catch { /* 403 → 非 admin */ }
  }, []);

  useEffect(() => {
    if (authed !== true) return;
    void loadUsers();
    void loadProviders();
    void loadSkills();
  }, [authed, loadUsers, loadProviders, loadSkills]);

  const logout = useCallback(async (): Promise<void> => {
    await api.logout().catch(() => undefined);
    clearToken();
    setMe(null);
    setAuthed(false);
  }, []);

  if (authed === null) {
    return <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-500">加载中…</div>;
  }
  if (!authed) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-100">
        <div className="w-[380px] rounded-xl border border-neutral-800 bg-neutral-900 p-6">
          <h1 className="mb-1 text-xl font-semibold">WorkPivot 管理后台</h1>
          <p className="mb-4 text-xs text-neutral-500">请使用管理员账户登录（非管理员无法进入后台）</p>
          <AdminLoginInline onOk={() => void refresh()} />
        </div>
      </div>
    );
  }

  const menus: Array<[Menu, string]> = [
    ['users', '用户管理'],
    ['models', '模型管理'],
    ['skills', 'Skill 管理'],
    ['ops', '审计与回收站'],
  ];

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      {/* 顶部通栏 */}
      <header className="relative z-40 flex h-14 shrink-0 items-center justify-between border-b border-neutral-800 bg-neutral-900 px-5">
        <div className="flex items-center gap-8">
          <div className="text-sm font-semibold tracking-wide text-neutral-100">管理后台</div>
          <nav className="flex items-center gap-1 text-sm">
            {menus.map(([key, label]) => (
              <button
                key={key}
                className={`rounded px-3 py-1.5 ${menu === key ? 'bg-neutral-800 font-medium text-white' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}`}
                onClick={() => setMenu(key)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
        {me && (
          <UserMenu
            username={me.username}
            onModifyPassword={() => setPasswordOpen(true)}
            onLogout={() => void logout()}
          />
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-5">
        {menu === 'users' && <UsersPanel users={users} me={me} onRefresh={loadUsers} />}
        {menu === 'models' && <ModelsPanel providers={providers} onRefresh={loadProviders} />}
        {menu === 'skills' && <SkillsPanel skills={skills} onRefresh={loadSkills} />}
        {menu === 'ops' && <OpsPanel />}
      </main>

      {passwordOpen && <ChangePasswordModal onClose={() => setPasswordOpen(false)} />}
    </div>
  );
}

// ---- 认证 / 用户菜单 / 弹窗 ----

function AdminLoginInline({ onOk }: { onOk: () => void }): React.JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const result = await api.login(username.trim(), password);
      setToken(result.token);
      onOk();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <input
        autoFocus
        className="w-full rounded border border-neutral-700 bg-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
        placeholder="管理员用户名"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        className="w-full rounded border border-neutral-700 bg-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
        type="password"
        placeholder="密码"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        className="w-full rounded bg-blue-600 py-2 hover:bg-blue-500 disabled:opacity-40"
        disabled={busy || username.trim() === '' || password === ''}
        onClick={() => void submit()}
      >
        {busy ? '登录中…' : '登录后台'}
      </button>
    </div>
  );
}

function UserMenu({
  username,
  onModifyPassword,
  onLogout,
}: {
  username: string;
  onModifyPassword: () => void;
  onLogout: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-700 text-xs font-semibold text-white">
          {username.slice(0, 1).toUpperCase()}
        </span>
        <span>{username}</span>
        <svg className="h-3 w-3 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-40 overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl">
            <button
              className="block w-full px-4 py-2 text-left text-xs text-neutral-200 hover:bg-neutral-800"
              onClick={() => {
                setOpen(false);
                onModifyPassword();
              }}
            >
              修改密码
            </button>
            <button
              className="block w-full px-4 py-2 text-left text-xs text-red-400 hover:bg-neutral-800"
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
            >
              退出
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    if (next.length < 6) {
      setError('新密码至少 6 位');
      return;
    }
    if (next !== confirm) {
      setError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-[380px] rounded-xl border border-neutral-700 bg-neutral-900 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">修改密码</h2>
          <button className="text-neutral-500 hover:text-neutral-200" onClick={onClose}>
            ×
          </button>
        </div>
        {done ? (
          <div className="space-y-4">
            <p className="text-sm text-emerald-400">密码修改成功。</p>
            <button className="w-full rounded bg-blue-600 py-2 text-sm hover:bg-blue-500" onClick={onClose}>
              完成
            </button>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <label className="block text-xs text-neutral-400">
              当前密码
              <input
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-neutral-100 outline-none focus:border-neutral-500"
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </label>
            <label className="block text-xs text-neutral-400">
              新密码
              <input
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-neutral-100 outline-none focus:border-neutral-500"
                type="password"
                placeholder="至少 6 位"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </label>
            <label className="block text-xs text-neutral-400">
              确认新密码
              <input
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-neutral-100 outline-none focus:border-neutral-500"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700" onClick={onClose}>
                取消
              </button>
              <button
                className="rounded bg-blue-600 px-3 py-1.5 text-xs hover:bg-blue-500 disabled:opacity-40"
                disabled={busy || current === '' || next === '' || confirm === ''}
                onClick={() => void submit()}
              >
                保存
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- 用户管理 ----

function UsersPanel({
  users,
  me,
  onRefresh,
}: {
  users: PublicUser[];
  me: PublicUser | null;
  onRefresh: () => void;
}): React.JSX.Element {
  const [dialog, setDialog] = useState<UserDialogState>(null);
  const [error, setError] = useState<string | null>(null);

  const removeUser = async (user: PublicUser): Promise<void> => {
    if (!window.confirm(`确认删除用户「${user.username}」？`)) return;
    setError(null);
    try {
      await api.deleteUser(user.id);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="max-w-[900px]">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">用户管理</h2>
          <p className="mt-0.5 text-xs text-neutral-500">管理员分配账户制：用户由管理员创建后才能登录</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="rounded bg-blue-600 px-3 py-1.5 text-xs hover:bg-blue-500"
            onClick={() => {
              setDialog({ kind: 'create' });
              setError(null);
            }}
          >
            ＋ 创建用户
          </button>
        </div>
      </div>

      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}

      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-neutral-700 text-neutral-500">
            <th className="py-2">用户名</th>
            <th className="py-2">邮箱</th>
            <th className="py-2">角色</th>
            <th className="py-2">创建时间</th>
            <th className="py-2">最近登录</th>
            <th className="w-28 py-2 text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b border-neutral-800">
              <td className="py-2 font-medium text-neutral-100">{u.username}</td>
              <td className="py-2 text-neutral-400">{u.email || '—'}</td>
              <td className="py-2 text-neutral-300">{ROLE_TEXT[u.role]}</td>
              <td className="py-2 text-neutral-400">{u.createdAt?.slice(0, 10) ?? '—'}</td>
              <td className="py-2 text-neutral-400">
                {u.lastLoginTime ? u.lastLoginTime.slice(0, 16).replace('T', ' ') : '从未登录'}
              </td>
              <td className="py-2">
                <div className="flex items-center justify-end gap-1">
                  <button
                    className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700"
                    onClick={() => {
                      setDialog({ kind: 'edit', user: u });
                      setError(null);
                    }}
                  >
                    修改
                  </button>
                  <button
                    className="rounded bg-red-900/70 px-2 py-1 hover:bg-red-900 disabled:opacity-30"
                    disabled={me !== null && me.id === u.id}
                    title={me !== null && me.id === u.id ? '不能删除自己的账户' : undefined}
                    onClick={() => void removeUser(u)}
                  >
                    删除
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {users.length === 0 && (
            <tr>
              <td className="py-6 text-center text-neutral-500" colSpan={6}>
                暂无用户
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {dialog && (
        <UserDialog
          state={dialog}
          me={me}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            onRefresh();
          }}
        />
      )}
    </div>
  );
}

function UserDialog({
  state,
  me,
  onClose,
  onSaved,
}: {
  state: Exclude<UserDialogState, null>;
  me: PublicUser | null;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const isEdit = state.kind === 'edit';
  const editUser = isEdit ? state.user : null;
  const [username, setUsername] = useState(editUser?.username ?? '');
  const [email, setEmail] = useState(editUser?.email ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [role, setRole] = useState<Role>(editUser?.role ?? 'member');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    const emailValue = email.trim() || undefined;
    if (isEdit && editUser) {
      if (role === editUser.role && emailValue === editUser.email) {
        onSaved();
        return;
      }
      setBusy(true);
      try {
        if (emailValue !== editUser.email) await api.updateUserEmail(editUser.id, emailValue);
        if (role !== editUser.role) await api.updateUserRole(editUser.id, role);
        onSaved();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (username.trim() === '') {
      setError('用户名必填');
      return;
    }
    if (password.length < 6) {
      setError('密码至少 6 位');
      return;
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    try {
      await api.createUser(username.trim(), password, role, emailValue);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const isSelf = me !== null && editUser !== null && me.id === editUser.id;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-[420px] rounded-xl border border-neutral-700 bg-neutral-900 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{isEdit ? '修改用户' : '创建用户'}</h2>
          <button className="text-neutral-500 hover:text-neutral-200" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="space-y-3 text-sm">
          <label className="block text-xs text-neutral-400">
            用户名
            <input
              className={`mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-neutral-100 outline-none focus:border-neutral-500 ${isEdit ? 'opacity-60' : ''}`}
              disabled={isEdit}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            {isEdit && <span className="mt-1 block text-[10px] text-neutral-600">用户名创建后不可修改</span>}
          </label>
          {!isEdit && (
            <>
              <label className="block text-xs text-neutral-400">
                密码
                <input
                  className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-neutral-100 outline-none focus:border-neutral-500"
                  type="password"
                  placeholder="至少 6 位"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <label className="block text-xs text-neutral-400">
                确认密码
                <input
                  className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-neutral-100 outline-none focus:border-neutral-500"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </label>
            </>
          )}
          <label className="block text-xs text-neutral-400">
            邮箱
            <input
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-neutral-100 outline-none focus:border-neutral-500"
              type="email"
              placeholder="选填"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="block text-xs text-neutral-400">
            角色
            <select
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-neutral-100 outline-none disabled:opacity-60"
              value={role}
              disabled={isSelf}
              onChange={(e) => setRole(e.target.value as Role)}
            >
              <option value="member">成员</option>
              <option value="admin">管理员</option>
            </select>
            {isSelf && <span className="mt-1 block text-[10px] text-neutral-600">不能修改自己的角色</span>}
          </label>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700" onClick={onClose}>
              取消
            </button>
            <button
              className="rounded bg-blue-600 px-3 py-1.5 text-xs hover:bg-blue-500 disabled:opacity-40"
              disabled={busy || (isEdit ? false : username.trim() === '' || password === '' || confirm === '')}
              onClick={() => void submit()}
            >
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- 模型管理 ----

const EMPTY_PROVIDER_FORM = { name: '', baseUrl: '', modelId: '', apiKey: '', protocol: 'openai' as 'openai' | 'anthropic', verify: true };

const PROTOCOL_LABELS: Record<'openai' | 'anthropic', string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
};

function ModelsPanel({ providers, onRefresh }: { providers: PublicProvider[]; onRefresh: () => void }): React.JSX.Element {
  const [formOpen, setFormOpen] = useState<null | 'new' | string>(null);
  const [form, setForm] = useState(EMPTY_PROVIDER_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openCreate = (): void => {
    setForm(EMPTY_PROVIDER_FORM);
    setFormOpen('new');
    setError(null);
  };
  const openEdit = (p: PublicProvider): void => {
    setForm({ name: p.name, baseUrl: p.baseUrl, modelId: p.modelId, apiKey: '', protocol: p.protocol, verify: false });
    setFormOpen(p.id);
    setError(null);
  };

  const submit = async (): Promise<void> => {
    setError(null);
    if (form.name.trim() === '' || form.baseUrl.trim() === '' || form.modelId.trim() === '') {
      setError('名称 / Base URL / 模型 ID 为必填项');
      return;
    }
    if (formOpen === 'new' && form.verify) {
      try {
        const v = await api.verifyProvider({
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey.trim() === '' ? undefined : form.apiKey,
          protocol: form.protocol,
        });
        if (!v.ok) {
          setError(`验活失败：${v.detail}`);
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    setBusy(true);
    try {
      const payload = {
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        modelId: form.modelId.trim(),
        apiKey: form.apiKey.trim() === '' ? undefined : form.apiKey,
        protocol: form.protocol,
      };
      if (formOpen === 'new') await api.saveProvider(payload);
      else if (formOpen !== null) await api.updateProvider(formOpen, payload);
      setFormOpen(null);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: PublicProvider): Promise<void> => {
    const tip = p.active ? '该供应商当前激活中，删除后自动切换到剩余第一个，确认删除？' : `确认删除供应商「${p.name}」？`;
    if (!window.confirm(tip)) return;
    try {
      await api.deleteProvider(p.id);
      if (formOpen === p.id) setFormOpen(null);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const editing = formOpen !== null;

  return (
    <div className="max-w-[720px]">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">模型管理</h2>
          <p className="mt-0.5 text-xs text-neutral-500">管理员唯一配置入口；保存前可选连通性测试</p>
        </div>
        <button
          className="rounded bg-blue-600 px-3 py-1.5 text-xs hover:bg-blue-500"
          onClick={() => (editing ? setFormOpen(null) : openCreate())}
        >
          {editing ? '取消' : '＋ 添加供应商'}
        </button>
      </div>
      {editing && (
        <div className="mb-3 space-y-2 rounded border border-neutral-700 bg-neutral-800 p-3">
          <label className="block text-xs text-neutral-400">
            协议
            <select
              className="mt-1 w-full rounded bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 outline-none"
              value={form.protocol}
              onChange={(e) => setForm({ ...form, protocol: e.target.value as 'openai' | 'anthropic' })}
            >
              <option value="openai">OpenAI 兼容（DeepSeek / Qwen / GLM / Ollama…）</option>
              <option value="anthropic">Anthropic（Claude 官方 Messages 协议）</option>
            </select>
          </label>
          <label className="block text-xs text-neutral-400">
            名称 <span className="text-red-400">*</span>
            <input className="mt-1 w-full rounded bg-neutral-900 px-2 py-1 text-sm text-neutral-100" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="block text-xs text-neutral-400">
            Base URL <span className="text-red-400">*</span>
            <input
              className="mt-1 w-full rounded bg-neutral-900 px-2 py-1 text-sm text-neutral-100"
              placeholder={form.protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com/v1'}
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
          </label>
          <label className="block text-xs text-neutral-400">
            模型 ID <span className="text-red-400">*</span>
            <input className="mt-1 w-full rounded bg-neutral-900 px-2 py-1 text-sm text-neutral-100" placeholder="deepseek-chat" value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })} />
          </label>
          <label className="block text-xs text-neutral-400">
            API Key{formOpen !== 'new' && <span className="ml-1 text-neutral-600">（留空 = 保留原 key）</span>}
            <input className="mt-1 w-full rounded bg-neutral-900 px-2 py-1 text-sm text-neutral-100" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          </label>
          {formOpen === 'new' && (
            <label className="flex items-center gap-1.5 text-xs text-neutral-400">
              <input type="checkbox" checked={form.verify} onChange={(e) => setForm({ ...form, verify: e.target.checked })} />
              保存前先验活（连通性测试）
            </label>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button className="rounded bg-blue-600 px-3 py-1 text-xs hover:bg-blue-500 disabled:opacity-40" disabled={busy} onClick={() => void submit()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      )}
      {!editing && error && <p className="mb-2 text-xs text-red-400">{error}</p>}
      <div className="space-y-1">
        {providers.length === 0 && <p className="text-xs text-neutral-500">尚未配置供应商，点击右上角「添加供应商」。</p>}
        {providers.map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded bg-neutral-800 px-3 py-2 text-xs">
            <span>
              {p.active && <span className="mr-1 text-emerald-400">●</span>}
              {p.name} — {p.baseUrl} / {p.modelId}
              <span className="ml-1.5 rounded bg-neutral-700 px-1 py-0.5 text-[10px] text-neutral-300">{PROTOCOL_LABELS[p.protocol] ?? p.protocol}</span>
              {!p.hasApiKey && <span className="ml-1 text-neutral-500">（无 key）</span>}
            </span>
            <span className="flex items-center gap-1">
              {!p.active && (
                <button className="rounded bg-neutral-700 px-2 py-1 hover:bg-neutral-600" onClick={() => void api.setActiveProvider(p.id).then(onRefresh)}>
                  激活
                </button>
              )}
              <button className="p-1 text-neutral-400 hover:text-blue-400" title="修改" onClick={() => openEdit(p)}>
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button className="p-1 text-neutral-400 hover:text-red-400" title="删除" onClick={() => void remove(p)}>
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Skill 管理 ----

function SkillsPanel({
  skills,
  onRefresh,
}: {
  skills: Array<{ name: string; description: string; source: string; disabled: boolean }>;
  onRefresh: () => void;
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const sourceLabels: Record<string, string> = { builtin: '内置', global: '全局', project: '项目' };

  const toggle = async (name: string, disabled: boolean): Promise<void> => {
    setError(null);
    setToggling(name);
    try {
      await api.toggleSkill(name, disabled);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggling(null);
    }
  };

  return (
    <div className="max-w-[720px]">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Skill 管理</h2>
          <p className="mt-0.5 text-xs text-neutral-500">禁用后的技能不再注入技能目录，模型无法激活（共 {skills.length} 个）</p>
        </div>
        <button className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700" onClick={onRefresh}>
          刷新列表
        </button>
      </div>
      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
      <div className="space-y-1">
        {skills.length === 0 && <p className="text-xs text-neutral-500">未发现任何技能（内置/全局/项目三层均为空）。</p>}
        {skills.map((s) => (
          <div key={s.name} className={`flex items-center justify-between rounded px-3 py-2 text-xs ${s.disabled ? 'bg-neutral-900 text-neutral-500' : 'bg-neutral-800'}`}>
            <span className="min-w-0">
              <span className="font-medium text-neutral-100">{s.name}</span>
              <span className="ml-2 rounded bg-neutral-700 px-1 py-0.5 text-[10px] text-neutral-300">{sourceLabels[s.source] ?? s.source}</span>
              <span className="ml-2 block truncate text-neutral-500">{s.description}</span>
            </span>
            <button
              className={`ml-3 shrink-0 rounded px-2 py-1 ${s.disabled ? 'bg-emerald-800 hover:bg-emerald-700' : 'bg-neutral-700 hover:bg-neutral-600'} disabled:opacity-40`}
              disabled={toggling === s.name}
              onClick={() => void toggle(s.name, !s.disabled)}
            >
              {toggling === s.name ? '切换中…' : s.disabled ? '启用' : '停用'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- 审计与回收站（M1-10：I03 审计导出 + B03 回收站清单） ----

interface AuditRow {
  ts?: string;
  user?: string;
  taskId?: string;
  event?: string;
  tool?: string;
  decision?: string;
  detail?: string;
}

interface TrashItem {
  name: string;
  originalPath?: string;
  deletedAt?: string;
}

function OpsPanel(): React.JSX.Element {
  const [tab, setTab] = useState<'audit' | 'trash'>('audit');
  const [auditRows, setAuditRows] = useState<AuditRow[] | null>(null);
  const [trash, setTrash] = useState<TrashItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAudit = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const r = await fetch('/api/audit', { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setAuditRows(((await r.json()) as { rows: AuditRow[] }).rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadTrash = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const r = await fetch('/api/trash', { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setTrash(((await r.json()) as { items: TrashItem[] }).items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (tab === 'audit' && auditRows === null) void loadAudit();
    if (tab === 'trash' && trash === null) void loadTrash();
  }, [tab, auditRows, trash, loadAudit, loadTrash]);

  // I03：带令牌导出（<a download> 无法携带 Authorization 头，走 fetch+blob）
  const exportAudit = async (): Promise<void> => {
    setError(null);
    try {
      const r = await fetch('/api/audit/export', { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `workpivot-audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="max-w-[900px]">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">审计与回收站</h2>
          <p className="mt-0.5 text-xs text-neutral-500">操作审计（最近 500 条，按天 JSONL 落盘）｜删除内容移入回收站（~/.workpivot/trash）</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <button
              className={`rounded px-3 py-1.5 text-xs ${tab === 'audit' ? 'bg-neutral-800 font-medium text-white' : 'text-neutral-400 hover:bg-neutral-800'}`}
              onClick={() => setTab('audit')}
            >
              审计日志
            </button>
            <button
              className={`rounded px-3 py-1.5 text-xs ${tab === 'trash' ? 'bg-neutral-800 font-medium text-white' : 'text-neutral-400 hover:bg-neutral-800'}`}
              onClick={() => setTab('trash')}
            >
              回收站
            </button>
          </div>
          {tab === 'audit' && (
            <>
              <button className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700" onClick={() => void loadAudit()}>
                刷新
              </button>
              <button
                className="rounded bg-blue-600 px-3 py-1.5 text-xs text-neutral-100 hover:bg-blue-500"
                onClick={() => void exportAudit()}
              >
                导出全部
              </button>
            </>
          )}
          {tab === 'trash' && (
            <button className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700" onClick={() => void loadTrash()}>
              刷新
            </button>
          )}
        </div>
      </div>

      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}

      {tab === 'audit' && (
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-neutral-700 text-neutral-500">
              <th className="py-1.5">时间</th>
              <th className="py-1.5">用户</th>
              <th className="py-1.5">事件</th>
              <th className="py-1.5">工具/决定</th>
              <th className="py-1.5">详情</th>
            </tr>
          </thead>
          <tbody>
            {(auditRows ?? []).slice().reverse().slice(0, 200).map((row, i) => (
              <tr key={i} className="border-b border-neutral-800">
                <td className="py-1.5 text-neutral-400">{row.ts?.slice(0, 19).replace('T', ' ') ?? '—'}</td>
                <td className="py-1.5 text-neutral-300">{row.user ?? '—'}</td>
                <td className="py-1.5 text-neutral-100">{row.event ?? '—'}</td>
                <td className="py-1.5 text-neutral-400">{[row.tool, row.decision].filter(Boolean).join(' / ') || '—'}</td>
                <td className="max-w-[280px] truncate py-1.5 text-neutral-500" title={row.detail}>{row.detail ?? '—'}</td>
              </tr>
            ))}
            {auditRows !== null && auditRows.length === 0 && (
              <tr>
                <td className="py-6 text-center text-neutral-500" colSpan={5}>
                  暂无审计记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {tab === 'trash' && (
        <div className="space-y-1">
          {(trash ?? []).map((item) => (
            <div key={item.name} className="rounded bg-neutral-800 px-3 py-2 text-xs">
              <p className="text-neutral-200">{item.name}</p>
              <p className="mt-0.5 text-neutral-500">
                原路径：{item.originalPath ?? '—'}
                {item.deletedAt ? ` ｜ 删除于 ${item.deletedAt.slice(0, 19).replace('T', ' ')}` : ''}
              </p>
            </div>
          ))}
          {trash !== null && trash.length === 0 && <p className="py-6 text-center text-xs text-neutral-500">回收站为空</p>}
          <p className="pt-2 text-[10px] text-neutral-600">恢复方式：关闭应用后，将 trash 目录下的 payload 移回 manifest.json 记录的原路径。</p>
        </div>
      )}
    </div>
  );
}
