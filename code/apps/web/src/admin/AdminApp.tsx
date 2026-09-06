/**
 * F3 管理后台（左右布局：左侧功能菜单，右侧内容面板）。
 * 用户管理 / 模型管理 / Skill 管理。登录复用主应用令牌（同源 localStorage）。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, getToken, type Project, type PublicProvider } from '../api';

type Menu = 'users' | 'models' | 'skills';

interface UserInfo {
  id: string;
  username: string;
  role: 'admin' | 'member';
  createdAt?: string;
  lastLoginTime?: string;
}

export default function AdminApp(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [menu, setMenu] = useState<Menu>('users');

  // 用户管理状态
  const [users, setUsers] = useState<UserInfo[]>([]);

  // 模型管理状态
  const [providers, setProviders] = useState<PublicProvider[]>([]);

  // Skill 管理状态
  const [skills, setSkills] = useState<Array<{ name: string; description: string; source: string; disabled: boolean }>>([]);

  const refresh = useCallback(async (): Promise<void> => {
    if (getToken() === null) {
      setAuthed(false);
      return;
    }
    try {
      const state = await api.authState();
      if (state.authenticated && state.user && state.user.role === 'admin') {
        setAuthed(true);
      } else {
        setAuthed(false);
      }
    } catch {
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
      const r = await fetch('/api/skills', { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
      if (r.ok) setSkills(await r.json());
    } catch { /* 忽略 */ }
  }, []);

  useEffect(() => {
    if (authed !== true) return;
    void loadUsers();
    void loadProviders();
    void loadSkills();
  }, [authed]);

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
  ];

  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100">
      {/* 左侧功能菜单 */}
      <aside className="flex w-48 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900">
        <div className="px-4 py-3 text-sm font-semibold text-neutral-300">管理后台</div>
        <nav className="flex-1 space-y-0.5 px-2">
          {menus.map(([key, label]) => (
            <button
              key={key}
              className={`block w-full rounded px-3 py-1.5 text-left text-sm ${menu === key ? 'bg-neutral-800 font-medium text-white' : 'text-neutral-400 hover:bg-neutral-800'}`}
              onClick={() => setMenu(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* 右侧内容面板 */}
      <div className="flex-1 overflow-y-auto p-5">
        {menu === 'users' && <UsersPanel users={users} onRefresh={loadUsers} />}
        {menu === 'models' && <ModelsPanel providers={providers} onRefresh={loadProviders} />}
        {menu === 'skills' && <SkillsPanel skills={skills} onRefresh={loadSkills} />}
      </div>
    </div>
  );
}

// ---- 内联子组件 ----

function AdminLoginInline({ onOk }: { onOk: () => void }): React.JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    try {
      await api.login(username.trim(), password);
      onOk();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
        onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        className="w-full rounded bg-blue-600 py-2 hover:bg-blue-500 disabled:opacity-40"
        disabled={username.trim() === '' || password === ''}
        onClick={() => void submit()}
      >
        登录后台
      </button>
    </div>
  );
}

function UsersPanel({ users, onRefresh }: { users: UserInfo[]; onRefresh: () => void }): React.JSX.Element {
  const [form, setForm] = useState({ username: '', password: '', role: 'member' as 'admin' | 'member' });
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const toggleSelect = (id: string): void => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const deleteSelected = async (): Promise<void> => {
    for (const id of checkedIds) {
      await fetch(`/api/users/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${getToken() ?? ''}` } });
    }
    setCheckedIds(new Set());
    onRefresh();
  };

  const createUser = async (): Promise<void> => {
    setError(null);
    try {
      const resp = await fetch('/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken() ?? ''}` },
        body: JSON.stringify(form),
      });
      if (!resp.ok) { setError((await resp.json()).error ?? '创建失败'); return; }
      setForm({ username: '', password: '', role: 'member' });
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">用户管理</h2>
        <div className="flex gap-2">
          <button
            className="rounded bg-blue-600 px-3 py-1.5 text-xs hover:bg-blue-500"
            onClick={() => {}}
          >
            ＋ 新建用户
          </button>
          <button
            className="rounded bg-red-900 px-3 py-1.5 text-xs hover:bg-red-800 disabled:opacity-40"
            disabled={checkedIds.size === 0}
            onClick={() => void deleteSelected()}
          >
            删除选中
          </button>
        </div>
      </div>

      <div className="mb-3 rounded border border-neutral-700 bg-neutral-800 p-3 space-y-2">
          <input className="w-full rounded bg-neutral-900 px-2 py-1 text-sm" placeholder="用户名" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <input className="w-full rounded bg-neutral-900 px-2 py-1 text-sm" type="password" placeholder="密码（≥6 位）" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select className="rounded bg-neutral-800 px-2 py-1 text-xs" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'member' })}>
            <option value="member">成员</option>
            <option value="admin">管理员</option>
          </select>
          <button className="rounded bg-blue-600 px-3 py-1 text-xs hover:bg-blue-500" onClick={() => void createUser()}>
            创建
          </button>
        </div>

      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-neutral-700 text-neutral-500">
            <th className="w-8 py-1"><input type="checkbox" disabled /></th>
            <th className="py-1">用户名</th>
            <th className="py-1">角色</th>
            <th className="py-1">创建时间</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={`border-b border-neutral-800 ${checkedIds.has(u.id) ? 'bg-neutral-800' : ''}`}>
              <td className="py-1.5"><input type="checkbox" checked={checkedIds.has(u.id)} onChange={() => toggleSelect(u.id)} /></td>
              <td className="py-1.5">{u.username}</td>
              <td className="py-1.5">{u.role === 'admin' ? '管理员' : '成员'}</td>
              <td className="py-1.5">{u.createdAt?.slice(0, 10) ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModelsPanel({ providers, onRefresh }: { providers: PublicProvider[]; onRefresh: () => void }): React.JSX.Element {
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="max-w-[640px]">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">模型管理</h2>
        <button className="rounded bg-blue-600 px-3 py-1.5 text-xs hover:bg-blue-500" onClick={() => setCreateModalOpen(true)}>
          ＋ 添加供应商
        </button>
      </div>
      {createModalOpen && (
        <div className="mb-3 rounded border border-neutral-700 bg-neutral-800 p-3 space-y-2">
          <input className="w-full rounded bg-neutral-900 px-2 py-1 text-sm" placeholder="供应商名称" />
          <input className="w-full rounded bg-neutral-900 px-2 py-1 text-sm" placeholder="Base URL" />
          <input className="w-full rounded bg-neutral-900 px-2 py-1 text-sm" placeholder="模型 ID" />
          <input className="w-full rounded bg-neutral-900 px-2 py-1 text-sm" type="password" placeholder="API Key" />
          <button className="rounded bg-blue-600 px-3 py-1 text-xs hover:bg-blue-500" onClick={() => setCreateModalOpen(false)}>保存</button>
        </div>
      )}
      <div className="space-y-1">
        {providers.map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded bg-neutral-800 px-3 py-2 text-xs">
            <span>
              {p.active && <span className="mr-1 text-emerald-400">●</span>}
              {p.name} —— {p.baseUrl} / {p.modelId}
              {!p.hasApiKey && <span className="ml-1 text-neutral-500">（无 key）</span>}
            </span>
            <span className="flex items-center gap-1">
              {!p.active && (
                <button className="rounded bg-neutral-700 px-2 py-1 hover:bg-neutral-600" onClick={() => void api.setActiveProvider(p.id).then(onRefresh)}>
                  激活
                </button>
              )}
              {/* 修改（铅笔 SVG） */}
              <button className="p-1 text-neutral-400 hover:text-blue-400" title="修改">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              {/* 删除（垃圾箱 SVG） */}
              <button className="p-1 text-neutral-400 hover:text-red-400" title="删除">
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
function SkillsPanel({ skills, onRefresh }: { skills: Array<{ name: string; description: string; source: string; disabled: boolean }>; onRefresh: () => void }): React.JSX.Element {
  return (
    <div className="max-w-[640px]">
      <button className="mb-3 rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700" onClick={onRefresh}>
        刷新列表
      </button>
      <p className="text-sm text-neutral-400">Skill 管理面板（{skills.length} 个技能）</p>
      <p className="mt-2 text-xs text-neutral-600">技能发现/启停/配置功能将在后续版本中提供。</p>
    </div>
  );
}

// 占位引用避免未用导入
void ({} as Project | undefined);
