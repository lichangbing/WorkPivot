import { ThemeSwitch } from './theme';
/** T2-01 登录门：无用户时展示注册（首用户=管理员），否则登录。 */
import { useState } from 'react';
import { api, setToken } from './api';

interface Props {
  needsSetup: boolean;
  setupTokenRequired?: boolean;
  onAuthed: () => void;
}

/** T2-01 登录门：无用户时展示注册（首用户=管理员），否则登录。 */
export function LoginView({ needsSetup, setupTokenRequired, onAuthed }: Props): React.JSX.Element {
  const [serverUrl, setServerUrl] = useState(location.origin);
  const changingServer = Boolean(window.workpivotDesktop && serverUrl.trim().replace(/\/$/, '') !== location.origin);
  const mode: 'login' | 'register' = needsSetup && !changingServer ? 'register' : 'login';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [initToken, setInitToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (window.workpivotDesktop && changingServer) {
        if (!window.workpivotDesktop.loginServer) throw Error('请更新桌面客户端以在此处连接服务器');
        const connection = await window.workpivotDesktop.loginServer(serverUrl,username,password);
        if (!connection.ok) throw Error(connection.error || '连接失败');
        return;
      }
      const result =
        mode === 'register' ? await api.register(username.trim(), password, initToken.trim()) : await api.login(username.trim(), password);
      setToken(result.token);
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-100">
      <div className="w-[360px] rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <div className="mb-4"><ThemeSwitch /></div>
        <h1 className="mb-1 text-xl font-semibold">WorkPivot</h1>
        <p className="mb-5 text-xs text-neutral-500">
          {mode === 'register' ? '首次使用：注册的第一个账户自动成为管理员' : '登录以继续'}
        </p>

        <div className="space-y-3 text-sm">
          {window.workpivotDesktop && <input aria-label="服务器地址" type="url" placeholder="服务器地址，例如 http://127.0.0.1:39800" value={serverUrl} disabled={busy} onChange={e=>setServerUrl(e.target.value)} className="w-full rounded border border-neutral-700 bg-neutral-800 px-3 py-2 outline-none focus:border-neutral-500" /> }
          <input
            autoFocus
            className="w-full rounded border border-neutral-700 bg-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
            placeholder="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className="w-full rounded border border-neutral-700 bg-neutral-800 px-3 py-2 outline-none focus:border-neutral-500"
            type="password"
            placeholder="密码（至少 6 位）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
          {mode === 'register' && setupTokenRequired && <div><input type="password" autoComplete="off" aria-label="初始化凭据" placeholder="首次注册说明中的初始化凭据" className="w-full rounded border border-neutral-700 bg-neutral-800 px-3 py-2" value={initToken} onChange={(e) => setInitToken(e.target.value)} /><p className="mt-2 text-xs text-neutral-400">请粘贴部署时提供的初始化凭据，不是服务器登录密码。用户名和密码由你自行设置。</p></div>}
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            className="w-full rounded bg-blue-600 py-2 hover:bg-blue-500 disabled:opacity-40"
            disabled={busy || username.trim() === '' || password === '' || (mode === 'register' && setupTokenRequired === true && initToken.trim() === '')}
            onClick={() => void submit()}
          >
            {busy ? '正在连接…' : mode === 'register' ? '注册管理员' : '登录'}
          </button>
        </div>
      </div>
    </div>
  );
}
