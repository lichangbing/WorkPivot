import { RequiredPasswordChange, ServerConnection } from '../AccountAccess';
import { ThemeSwitch } from '../theme';
import { Icon } from '../Icon';
/**
 * 管理后台：顶部通栏布局，左侧品牌区 + 功能页签，右侧用户下拉菜单（修改密码/退出）。
 * 用户管理：创建/修改/删除均走右侧按钮与弹窗；创建弹窗包含用户名/密码/确认密码/邮箱。
 * 登录复用主应用令牌（同一 localStorage）；后台登录成功后必须保存 token。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, clearToken, getToken, setToken, type PublicProvider, type PublicUser } from '../api';
import { PermissionsPanel } from './PermissionsPanel';
import { ProjectsPanel } from './ProjectsPanel';
import { SkillPackagesPanel } from './SkillPackagesPanel';
import { McpPanel } from './McpPanel';
import { DatabaseAdminContent } from './DatabaseAdminContent';
import { MemoryTemplatesPanel } from './MemoryTemplatesPanel';

type Menu = 'network-targets' | 'request-audit' | 'experts' | 'users' | 'models' | 'skills' | 'mcp' | 'memory' | 'templates' | 'schedules' | 'ops' | 'permissions' | 'projects';
type Role = PublicUser['role'];

type UserDialogState =
  | { kind: 'create' }
  | { kind: 'edit'; user: PublicUser }
  | null;

const ROLE_TEXT: Record<Role, string> = {
  admin: '管理员',
  member: '成员',
};

export default function AdminApp({ database = false }: { database?: boolean }): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [me, setMe] = useState<PublicUser | null>(null);
  const [menu, setMenu] = useState<Menu>('users');

  const [users, setUsers] = useState<PublicUser[]>([]);
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [skillDirty, setSkillDirty] = useState(false);
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
  useEffect(() => {
    if (authed !== true || me?.mustChangePassword) return;
    void loadUsers();
    if (!database) void loadProviders();

  }, [authed, me?.mustChangePassword, loadUsers, loadProviders, database]);

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
          <ServerConnection />
          <AdminLoginInline onOk={() => void refresh()} />
        </div>
      </div>
    );
  }

  if (me?.mustChangePassword) return <RequiredPasswordChange onDone={() => void refresh()} />;

  const menus: Array<[Menu, string]> = [
    ['users', '用户管理'],
    ['models', '模型管理'],
    ['experts', '专家模板'],
    ['skills', 'Skill 管理'],
    ['mcp', 'MCP 管理'],
    ['memory', '默认记忆'],
    ['templates', '我的模板'],
    ['schedules', '定时任务'],
    ...(database ? [['request-audit', '请求安全审计'] as [Menu,string],['network-targets','内网地址授权'] as [Menu,string]] : []),
    ['ops', database ? '运行监控与用量' : '审计与回收站'],
    ['permissions', '路径授权'],
    ['projects', '我的项目'],
  ];


  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      {/* 顶部通栏 */}
      <header className="relative z-40 flex h-14 shrink-0 items-center justify-between border-b border-neutral-800 bg-neutral-900 px-5">
        <div className="flex items-center gap-8">
          <div className="whitespace-nowrap text-sm font-semibold tracking-wide text-neutral-100">管理后台</div>

        </div>
        <ThemeSwitch />
        {me && (
          <UserMenu
            username={me.username}
            onModifyPassword={() => setPasswordOpen(true)}
            onLogout={() => void logout()}
          />
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <aside className="w-full shrink-0 overflow-x-auto border-b border-neutral-800 bg-neutral-900 p-2 sm:w-48 sm:overflow-y-auto sm:border-b-0 sm:border-r sm:p-3" aria-label="后台菜单">
          <nav className="flex gap-1 text-sm sm:flex-col">
            {menus.map(([key, label]) => (
              <button
                key={key}
                className={`shrink-0 whitespace-nowrap rounded px-3 py-2.5 text-left ${menu === key ? 'bg-neutral-800 font-medium text-neutral-100' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}`}
                aria-current={menu === key ? "page" : undefined}
                onClick={() => { if (key === menu || !skillDirty || window.confirm('离开将放弃当前未保存的编辑，已保存草稿会保留。继续？')) setMenu(key); }}
              >
                {label}
              </button>
            ))}
          </nav>
        </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
        {database ? <DatabaseAdminContent menu={menu} onDirty={setSkillDirty} /> : <>
        {menu === 'users' && <UsersPanel users={users} me={me} onRefresh={loadUsers} />}
        {menu === 'models' && <ModelsPanel providers={providers} onRefresh={loadProviders} />}
        {menu === 'skills' && <SkillPackagesPanel onDirty={setSkillDirty} />}
        {menu === 'mcp' && <McpPanel onDirty={setSkillDirty} />}
        {menu === 'memory' && <MemoryTemplatesPanel onDirty={setSkillDirty} />}
        {menu === 'templates' && <TemplatesPanel />}
        {menu === 'schedules' && <SchedulesPanel />}
        {menu === 'ops' && <OpsPanel />}
        {menu === 'permissions' && <PermissionsPanel />}
        {menu === 'projects' && <ProjectsPanel />}
        </>}
      </main>
      </div>

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
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-700 text-xs font-semibold text-neutral-100">
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
      clearToken();
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
          <button className="text-neutral-500 hover:text-neutral-200" aria-label="关闭窗口" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {done ? (
          <div className="space-y-4">
            <p className="text-sm text-emerald-400">密码修改成功，所有旧会话已失效，请重新登录。</p>
            <button className="w-full rounded bg-blue-600 py-2 text-sm hover:bg-blue-500" onClick={() => window.location.reload()}>
              重新登录
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
              <button className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700" aria-label="关闭窗口" onClick={onClose}>
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
  const [resetResult, setResetResult] = useState<{ username: string; password: string } | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const resetPassword = async (user: PublicUser): Promise<void> => {
    if (resetBusy || !window.confirm(`重置「${user.username}」的密码？旧登录将失效，运行中的任务将停止，下次登录必须修改临时密码。`)) return;
    setResetBusy(true); setError(null);
    try { const result = await api.resetUserPassword(user.id); setResetResult({ username: user.username, password: result.temporaryPassword }); onRefresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setResetBusy(false); }
  };
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

  const revokeSessions = async (user: PublicUser): Promise<void> => {
    if (!window.confirm(`让「${user.username}」的所有登录会话失效并停止其运行中的任务？`)) return;
    setError(null);
    try { await api.revokeUserSessions(user.id); window.alert('会话已撤销'); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div className="max-w-[900px]">
      {resetResult && <div role="dialog" aria-modal="true" aria-label="临时密码" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"><div className="max-w-md space-y-4 rounded-xl border border-neutral-700 bg-neutral-900 p-6">
        <h3 className="font-semibold">{resetResult.username} 的临时密码</h3><p className="text-sm text-neutral-400">请复制并交给该用户。关闭后不再展示，用户登录后需要修改。</p>
        <input aria-label="临时密码" readOnly value={resetResult.password} onFocus={(e) => e.target.select()} className="w-full rounded bg-neutral-800 p-3 font-mono" />
        <button className="rounded bg-blue-600 px-4 py-2" onClick={() => setResetResult(null)}>已保存，关闭</button>
      </div></div>}

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
            <Icon name="plus" /> 创建用户
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
            <th className="w-48 py-2 text-right">操作</th>
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
                  <button className="whitespace-nowrap rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700" onClick={() => void revokeSessions(u)}>撤销登录</button>
                  {!u.platformAdmin && u.id !== me?.id && <button disabled={resetBusy} className="whitespace-nowrap rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700 disabled:opacity-40" onClick={() => void resetPassword(u)}>重置密码</button>}
                  {u.mustChangePassword && <span className="text-xs text-amber-400">待修改密码</span>}
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
          <button className="text-neutral-500 hover:text-neutral-200" aria-label="关闭窗口" onClick={onClose}>
            <Icon name="close" />
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
            <button className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700" aria-label="关闭窗口" onClick={onClose}>
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
          {editing ? '取消' : <><Icon name="plus" /> 添加供应商</>}
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
              {p.active && <span aria-label="当前启用" className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />}
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

// ---- 企业模板（M1-07/H01：上传含 {{占位符}} 的 .docx，设默认，删除） ----

interface WordTemplate {
  id: string;
  name: string;
  kind: string;
  fileName: string;
  isDefault: boolean;
  uploadedAt: string;
}

function TemplatesPanel(): React.JSX.Element {
  const [templates, setTemplates] = useState<WordTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [uploadKind, setUploadKind] = useState('general');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const r = await fetch('/api/templates', { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setTemplates(((await r.json()) as { templates: WordTemplate[] }).templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (templates === null) void load();
  }, [templates, load]);

  const upload = async (file: File): Promise<void> => {
    setError(null);
    if (!file.name.toLowerCase().endsWith('.docx')) {
      setError('只支持 .docx 模板文件');
      return;
    }
    if (uploadName.trim() === '') {
      setError('请先填写模板名称');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(
        `/api/templates?name=${encodeURIComponent(uploadName.trim())}&kind=${encodeURIComponent(uploadKind)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${getToken() ?? ''}` },
          body: await file.arrayBuffer(),
        },
      );
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`);
      setUploadName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const setDefault = async (id: string): Promise<void> => {
    setError(null);
    try {
      const r = await fetch(`/api/templates/${id}/default`, { method: 'PUT', headers: { authorization: `Bearer ${getToken() ?? ''}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (t: WordTemplate): Promise<void> => {
    if (!window.confirm(`确认删除模板「${t.name}」？`)) return;
    setError(null);
    try {
      const r = await fetch(`/api/templates/${t.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${getToken() ?? ''}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="max-w-[720px]">
      <div className="mb-3">
        <h2 className="text-base font-semibold">企业模板</h2>
        <p className="mt-0.5 text-xs text-neutral-500">
          上传含 {'{{占位符}}'}（如 {'{{标题}}/{{日期}}/{{正文}}'}）的 .docx；生成 Word 时优先走模板替换（默认模板用于未指定的请求）
        </p>
      </div>
      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}

      <div className="mb-3 space-y-2 rounded border border-neutral-700 bg-neutral-800 p-3">
        <div className="flex gap-2">
          <input
            className="flex-1 rounded bg-neutral-900 px-2 py-1 text-sm"
            placeholder="模板名称（如：公司报告模板）"
            value={uploadName}
            onChange={(e) => setUploadName(e.target.value)}
          />
          <select
            className="rounded bg-neutral-900 px-2 py-1 text-xs"
            value={uploadKind}
            onChange={(e) => setUploadKind(e.target.value)}
          >
            <option value="general">通用</option>
            <option value="report">报告</option>
            <option value="minutes">纪要</option>
            <option value="proposal">方案</option>
          </select>
        </div>
        <label className="block">
          <input
            type="file"
            accept=".docx"
            disabled={busy}
            className="w-full text-xs text-neutral-400 file:mr-2 file:rounded file:border-0 file:bg-neutral-700 file:px-3 file:py-1 file:text-xs file:text-neutral-100 hover:file:bg-neutral-600"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void upload(f);
            }}
          />
          <span className="mt-1 block text-[10px] text-neutral-600">{busy ? '上传中…' : '选择文件后立即上传'}</span>
        </label>
      </div>

      <div className="space-y-1">
        {(templates ?? []).map((t) => (
          <div key={t.id} className="flex items-center justify-between rounded bg-neutral-800 px-3 py-2 text-xs">
            <span>
              {t.isDefault && <span aria-label="当前启用" className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />}
              {t.name}
              <span className="ml-2 rounded bg-neutral-700 px-1 py-0.5 text-[10px] text-neutral-300">{t.kind}</span>
              <span className="ml-2 text-neutral-600">{t.uploadedAt.slice(0, 10)}</span>
            </span>
            <span className="flex items-center gap-1">
              {!t.isDefault && (
                <button className="rounded bg-neutral-700 px-2 py-1 hover:bg-neutral-600" onClick={() => void setDefault(t.id)}>
                  设为默认
                </button>
              )}
              <button className="rounded bg-red-900/70 px-2 py-1 hover:bg-red-900" onClick={() => void remove(t)}>
                删除
              </button>
            </span>
          </div>
        ))}
        {templates !== null && templates.length === 0 && (
          <p className="py-6 text-center text-xs text-neutral-500">暂无模板——未上传时 Word 生成走内置排版（docx 库）</p>
        )}
      </div>
    </div>
  );
}

// ---- 定时任务（M1-09/F06：cron 触发 + 错过补跑 + 通知） ----

interface Schedule {
  id: string;
  name: string;
  cron: string;
  content: string;
  taskName: string;
  taskId?: string;
  enabled: boolean;
  catchup: boolean;
  lastRunAt?: string;
  lastResult?: string;
}

interface ScheduleNote {
  ts: string;
  scheduleId: string;
  name: string;
  event: string;
  detail: string;
}

const SCHEDULE_FORM_EMPTY = { name: '', cron: '', taskName: '', content: '', catchup: true };

function SchedulesPanel(): React.JSX.Element {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [notes, setNotes] = useState<ScheduleNote[] | null>(null);
  const [form, setForm] = useState(SCHEDULE_FORM_EMPTY);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const [s, n] = await Promise.all([
        fetch('/api/schedules', { headers: { authorization: `Bearer ${getToken() ?? ''}` } }),
        fetch('/api/schedules/notifications', { headers: { authorization: `Bearer ${getToken() ?? ''}` } }),
      ]);
      if (!s.ok || !n.ok) throw new Error(`HTTP ${s.status}/${n.status}`);
      setSchedules(((await s.json()) as { schedules: Schedule[] }).schedules);
      setNotes(((await n.json()) as { notifications: ScheduleNote[] }).notifications);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (schedules === null) void load();
  }, [schedules, load]);

  const create = async (): Promise<void> => {
    setError(null);
    if (form.name.trim() === '' || form.cron.trim() === '' || form.taskName.trim() === '' || form.content.trim() === '') {
      setError('名称 / cron / 任务名 / 提示词均为必填');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken() ?? ''}` },
        body: JSON.stringify({
          name: form.name.trim(), cron: form.cron.trim(), taskName: form.taskName.trim(),
          content: form.content, catchup: form.catchup,
        }),
      });
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`);
      setForm(SCHEDULE_FORM_EMPTY);
      setFormOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const mutate = async (path: string, init: RequestInit, tip: string | null): Promise<void> => {
    if (tip && !window.confirm(tip)) return;
    setError(null);
    try {
      const r = await fetch(path, { ...init, headers: { authorization: `Bearer ${getToken() ?? ''}`, ...(init.headers ?? {}) } });
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const eventLabels: Record<string, string> = {
    run_ok: '运行成功', run_error: '运行失败', missed_catchup: '错过补跑', skipped_running: '跳过（运行中）',
  };

  return (
    <div className="max-w-[820px]">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">定时任务</h2>
          <p className="mt-0.5 text-xs text-neutral-500">cron（分 时 日 月 周）到点自动触发对话；停机期间错过的触发在下次启动补跑一次（可关）</p>
        </div>
        <button
          className="rounded bg-blue-600 px-3 py-1.5 text-xs hover:bg-blue-500"
          onClick={() => { setFormOpen(!formOpen); setError(null); }}
        >
          {formOpen ? '取消' : <><Icon name="plus" /> 新建定时任务</>}
        </button>
      </div>
      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}

      {formOpen && (
        <div className="mb-3 space-y-2 rounded border border-neutral-700 bg-neutral-800 p-3">
          <div className="flex gap-2">
            <input className="flex-1 rounded bg-neutral-900 px-2 py-1 text-sm" placeholder="名称（如：每日站会纪要）" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input className="w-36 rounded bg-neutral-900 px-2 py-1 text-sm font-mono" placeholder="*/30 9-18 * * 1-5" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
          </div>
          <input className="w-full rounded bg-neutral-900 px-2 py-1 text-sm" placeholder="承载任务名（如：站会纪要任务——复用同一任务，转写连续）" value={form.taskName} onChange={(e) => setForm({ ...form, taskName: e.target.value })} />
          <textarea className="h-20 w-full rounded bg-neutral-900 px-2 py-1 text-sm" placeholder="触发时发送的提示词（如：请汇总今天的站立会议要点，生成 纪要-今天日期.docx）" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
          <label className="flex items-center gap-1.5 text-xs text-neutral-400">
            <input type="checkbox" checked={form.catchup} onChange={(e) => setForm({ ...form, catchup: e.target.checked })} />
            停机期间错过的触发在下次启动时补跑一次
          </label>
          <button className="rounded bg-blue-600 px-3 py-1 text-xs hover:bg-blue-500 disabled:opacity-40" disabled={busy} onClick={() => void create()}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      )}

      <div className="space-y-1">
        {(schedules ?? []).map((s) => (
          <div key={s.id} className="rounded bg-neutral-800 px-3 py-2 text-xs">
            <div className="flex items-center justify-between">
              <span>
                <span className={`mr-1 inline-block h-2 w-2 rounded-full ${s.enabled ? 'bg-emerald-500' : 'bg-neutral-600'}`} />
                <span className="font-medium text-neutral-100">{s.name}</span>
                <code className="ml-2 rounded bg-neutral-700 px-1.5 py-0.5 text-[10px]">{s.cron}</code>
                {s.catchup && <span className="ml-1.5 text-[10px] text-neutral-500">补跑</span>}
              </span>
              <span className="flex items-center gap-1">
                <button
                  className={`rounded px-2 py-1 ${s.enabled ? 'bg-neutral-700 hover:bg-neutral-600' : 'bg-emerald-800 hover:bg-emerald-700'}`}
                  onClick={() => void mutate(`/api/schedules/${s.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !s.enabled }) }, null)}
                >
                  {s.enabled ? '停用' : '启用'}
                </button>
                <button className="rounded bg-neutral-700 px-2 py-1 hover:bg-neutral-600" onClick={() => void mutate(`/api/schedules/${s.id}/run`, { method: 'POST' }, null)}>
                  立即运行
                </button>
                <button className="rounded bg-red-900/70 px-2 py-1 hover:bg-red-900" onClick={() => void mutate(`/api/schedules/${s.id}`, { method: 'DELETE' }, `确认删除定时任务「${s.name}」？`)}>
                  删除
                </button>
              </span>
            </div>
            <p className="mt-1 text-neutral-500">
              {s.lastRunAt ? `上次运行 ${s.lastRunAt.slice(0, 19).replace('T', ' ')}（${s.lastResult ?? '?'}）` : '从未运行'}
            </p>
          </div>
        ))}
        {schedules !== null && schedules.length === 0 && <p className="py-6 text-center text-xs text-neutral-500">暂无定时任务</p>}
      </div>

      {notes !== null && notes.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold">运行通知</h3>
          <div className="space-y-0.5">
            {[...notes].reverse().slice(0, 30).map((n, i) => (
              <div key={i} className="rounded bg-neutral-900 px-3 py-1.5 text-xs">
                <span className="text-neutral-400">{n.ts.slice(0, 19).replace('T', ' ')}</span>
                <span className="ml-2 text-neutral-200">{n.name}</span>
                <span className="ml-2">{eventLabels[n.event] ?? n.event}</span>
                <span className="ml-2 text-neutral-600">{n.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}
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
              className={`rounded px-3 py-1.5 text-xs ${tab === 'audit' ? 'bg-neutral-800 font-medium text-neutral-100' : 'text-neutral-400 hover:bg-neutral-800'}`}
              onClick={() => setTab('audit')}
            >
              审计日志
            </button>
            <button
              className={`rounded px-3 py-1.5 text-xs ${tab === 'trash' ? 'bg-neutral-800 font-medium text-neutral-100' : 'text-neutral-400 hover:bg-neutral-800'}`}
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
