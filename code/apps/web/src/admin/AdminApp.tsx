/**
 * F3 管理后台（M01 形态变更：独立后台管理页面，浏览器访问，仅 admin 可进）。
 * 功能：用户管理 / 模型管理 / Skill 管理。登录复用主应用令牌（同源 localStorage）。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, clearToken, getToken, type Project, type PublicProvider, type PublicUser } from '../api';
import { ProviderModal } from '../ProviderModal';

type Tab = 'users' | 'models' | 'skills';

export default function AdminApp(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [me, setMe] = useState<PublicUser | null>(null);
  const [tab, setTab] = useState<Tab>('users');

  const refresh = useCallback(async (): Promise<void> => {
    if (getToken() === null) {
      setAuthed(false);
      return;
    }
    try {
      const state = await api.authState();
      if (state.authenticated && state.user && state.user.role === 'admin') {
        setMe(state.user);
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

  if (authed === null) {
    return <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-500">加载中…</div>;
  }
  if (!authed) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-100">
        <div className="w-[380px] rounded-xl border border-neutral-800 bg-neutral-900 p-6">
          <h1 className="mb-1 text-xl font-semibold">WorkPivot 管理后台</h1>
          <p className="mb-4 text-xs text-neutral-500">请使用管理员账户登录（非管理员无法进入后台）</p>
          <AdminLogin onOk={() => void refresh()} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
        <h1 className="text-base font-semibold">管理后台 {me ? `· ${me.username}` : ''}</h1>
        <div className="flex items-center gap-3 text-xs">
          <a className="text-blue-400 hover:text-blue-300" href="/" target="_blank" rel="noreferrer">
            打开主应用
          </a>
          <button
            className="text-neutral-500 hover:text-neutral-200"
            onClick={() => {
              void api.logout().catch(() => undefined);
              clearToken();
              setAuthed(false);
            }}
          >
            退出
          </button>
        </div>
      </header>
      <div className="flex gap-1 border-b border-neutral-800 px-5 pt-2 text-sm">
        {(
          [
            ['users', '用户管理'],
            ['models', '模型管理'],
            ['skills', 'Skill 管理'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            className={`rounded-t px-3 py-1.5 ${tab === key ? 'bg-neutral-800 font-medium' : 'text-neutral-400 hover:bg-neutral-900'}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-5">
        {tab === 'users' && <UsersTab />}
        {tab === 'models' && <ModelsTab />}
        {tab === 'skills' && <SkillsTab />}
      </div>
    </div>
  );
}

function AdminLogin({ onOk }: { onOk: () => void }): React.JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
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
          if (e.key === 'Enter') {
            void api
              .login(username.trim(), password)
              .then(() => onOk())
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
          }
        }}
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        className="w-full rounded bg-blue-600 py-2 hover:bg-blue-500"
        onClick={() => {
          void api
            .login(username.trim(), password)
            .then(() => onOk())
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
        }}
      >
        登录后台
      </button>
    </div>
  );
}

function UsersTab(): React.JSX.Element {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setUsers((await api.listUsers()).users);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="max-w-[560px]">
      <div className="mb-4 space-y-1">
        {users.map((u) => (
          <div key={u.id} className="flex items-center justify-between rounded bg-neutral-800 px-3 py-1.5 text-xs">
            <span>
              {u.username} <span className="text-neutral-500">（{u.role === 'admin' ? '管理员' : '成员'}）</span>
            </span>
          </div>
        ))}
      </div>
      <div className="space-y-2 rounded border border-neutral-800 p-3">
        <p className="text-xs text-neutral-500">创建用户</p>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs"
            placeholder="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs"
            type="password"
            placeholder="密码（≥6 位）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <select
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs"
            value={role}
            onChange={(e) => setRole(e.target.value as 'member' | 'admin')}
          >
            <option value="member">成员</option>
            <option value="admin">管理员</option>
          </select>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          className="rounded bg-blue-600 px-3 py-1.5 text-xs hover:bg-blue-500 disabled:opacity-40"
          disabled={username.trim() === '' || password.length < 6}
          onClick={() => {
            void api
              .createUser(username.trim(), password, role)
              .then(() => {
                setUsername('');
                setPassword('');
                void refresh();
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
          }}
        >
          创建用户
        </button>
      </div>
    </div>
  );
}

function ModelsTab(): React.JSX.Element {
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [modalOpen, setModalOpen] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setProviders((await api.listProviders()).providers);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="max-w-[640px]">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-neutral-500">已配置供应商（key 加密存储，接口打码）</p>
        <button className="rounded bg-blue-600 px-3 py-1.5 text-xs hover:bg-blue-500" onClick={() => setModalOpen(true)}>
          ＋ 添加供应商
        </button>
      </div>
      <div className="space-y-1">
        {providers.map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded bg-neutral-800 px-3 py-2 text-xs">
            <span>
              {p.active && <span className="mr-1 text-emerald-400">●</span>}
              {p.name} —— {p.baseUrl} / {p.modelId}
              {!p.hasApiKey && <span className="ml-1 text-neutral-500">（无 key）</span>}
              {p.verified && <span className="ml-1 text-emerald-500">已验活</span>}
            </span>
            {!p.active && (
              <button
                className="rounded bg-neutral-700 px-2 py-1 hover:bg-neutral-600"
                onClick={() => {
                  void api.setActiveProvider(p.id).then(refresh);
                }}
              >
                设为当前
              </button>
            )}
          </div>
        ))}
      </div>
      {modalOpen && (
        <ProviderModal
          providers={providers}
          onClose={() => setModalOpen(false)}
          onSaved={() => {
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function SkillsTab(): React.JSX.Element {
  const [skills, setSkills] = useState<Array<{ name: string; description: string; source: string; disabled: boolean }>>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSkills((await api.listSkillsAdmin()).skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sourceLabel = (s: string): string => (s === 'builtin' ? '内置' : s === 'global' ? '全局' : s === 'project' ? '项目' : s);

  return (
    <div className="max-w-[640px]">
      <p className="mb-3 text-xs text-neutral-500">停用的技能不会注入对话目录（内置技能不可停用则不会出现在此处）</p>
      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
      <div className="space-y-1">
        {skills.map((s) => (
          <div key={s.name} className="flex items-center justify-between rounded bg-neutral-800 px-3 py-2 text-xs">
            <span className="min-w-0 break-all">
              <span className="mr-1 rounded bg-neutral-700 px-1">{sourceLabel(s.source)}</span>
              <span className="font-medium">{s.name}</span>
              <span className="ml-2 text-neutral-400">{s.description.slice(0, 80)}</span>
            </span>
            <button
              className={`ml-2 shrink-0 rounded px-2 py-1 ${s.disabled ? 'bg-emerald-700 hover:bg-emerald-600' : 'bg-red-900 hover:bg-red-800'}`}
              onClick={() => {
                void api.toggleSkill(s.name, !s.disabled).then(refresh);
              }}
            >
              {s.disabled ? '启用' : '停用'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Project 类型占位引用（后台项目级 Skill 展示用，批次 3 启用）
void ({} as Project | undefined);
