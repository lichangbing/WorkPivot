import { Icon } from './Icon';
/** T2-01：管理员创建用户（管理员分配制，无自主注册）。 */
import { useCallback, useEffect, useState } from 'react';
import { api, type PublicUser } from './api';

/** T2-01：管理员创建用户（管理员分配制，无自主注册）。 */
export function UsersModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }): React.JSX.Element {
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

  const create = async (): Promise<void> => {
    setError(null);
    try {
      await api.createUser(username.trim(), password, role);
      setUsername('');
      setPassword('');
      await refresh();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[460px] rounded-xl border border-neutral-700 bg-neutral-900 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">用户管理</h2>
          <button className="text-neutral-500 hover:text-neutral-200" aria-label="关闭窗口" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <div className="mb-4 space-y-1">
          {users.map((u) => (
            <div key={u.id} className="flex items-center justify-between rounded bg-neutral-800 px-3 py-1.5 text-xs">
              <span>
                {u.username} <span className="text-neutral-500">（{u.role === 'admin' ? '管理员' : '成员'}）</span>
              </span>
            </div>
          ))}
        </div>

        <div className="space-y-2 text-sm">
          <p className="text-xs text-neutral-500">创建新用户（管理员分配制，无自主注册）</p>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-xs outline-none focus:border-neutral-500"
              placeholder="用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              className="flex-1 rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-xs outline-none focus:border-neutral-500"
              type="password"
              placeholder="密码（≥6 位）"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <select
              className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-xs"
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
            onClick={() => void create()}
          >
            创建用户
          </button>
        </div>
      </div>
    </div>
  );
}
