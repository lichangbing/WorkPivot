import { ThemeSwitch } from './theme';
/** T2-01 登录门：无用户时展示注册（首用户=管理员），否则登录。 */
import { useState } from 'react';
import { api, setToken } from './api';

interface Props {
  needsSetup: boolean;
  setupTokenRequired?: boolean;
  registrationEnabled?: boolean;
  defaultMessageQuota?: number;
  onAuthed: () => void;
}

/** T2-01 登录门：无用户时展示注册（首用户=管理员），否则登录。 */
export function LoginView({ needsSetup, registrationEnabled = false, defaultMessageQuota = 10, onAuthed }: Props): React.JSX.Element {
  const [serverUrl, setServerUrl] = useState(location.origin);
  const changingServer = Boolean(window.workpivotDesktop && serverUrl.trim().replace(/\/$/, '') !== location.origin);
  const [wantRegister, setWantRegister] = useState(false);
  const mode: 'login' | 'register' = (needsSetup && !changingServer) || (wantRegister && registrationEnabled) ? 'register' : 'login';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 大文件走已验证的直连入口，避免 Cloudflare 免费链路在中国大陆网络的吞吐瓶颈。
  const downloadOrigin = 'https://115-191-1-188.sslip.io:80';
  const desktopDownload = `${downloadOrigin}/downloads/WorkPivot-Windows-portable.zip`;
  const androidDownload = `${downloadOrigin}/downloads/WorkPivot-android-1.3.apk`;

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
        mode === 'register' ? await api.register(username.trim(), password) : await api.login(username.trim(), password);
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
      <div className="w-[430px] max-w-[calc(100vw-32px)] rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <div className="mb-4"><ThemeSwitch /></div>
        <h1 className="mb-1 text-xl font-semibold">WorkPivot</h1>
        <p className="mb-5 text-xs text-neutral-500">
          {mode === 'register' ? (needsSetup ? '首次使用：注册的第一个账户自动成为管理员' : `自助注册：默认每天 ${defaultMessageQuota === 0 ? '不限' : defaultMessageQuota + ' 次'}提问`) : '登录以继续；账号由管理员创建'}
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
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            className="w-full rounded bg-blue-600 py-2 hover:bg-blue-500 disabled:opacity-40"
            disabled={busy || username.trim() === '' || password === ''}
            onClick={() => void submit()}
          >
            {busy ? '正在连接…' : mode === 'register' ? (needsSetup ? '注册管理员' : '注册并进入') : '登录'}
          </button>
          {!needsSetup && registrationEnabled && (
            <button
              type="button"
              className="w-full text-center text-xs text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline"
              disabled={busy}
              onClick={() => { setError(null); setWantRegister(!wantRegister); }}
            >
              {mode === 'register' ? '已有账号？去登录' : '注册新账号'}
            </button>
          )}
        </div>
        <section aria-label="客户端下载" className="mt-5 border-t border-neutral-800 pt-4">
          <h2 className="text-sm font-medium text-neutral-200">客户端直接下载</h2>
          <p className="mt-1 text-xs text-neutral-500">无需登录，点击即可下载安装包。</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <a href={desktopDownload} download className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:border-blue-600 hover:bg-neutral-800">
              Windows 客户端（便携版）
              <span className="mt-1 block break-all text-[10px] text-neutral-500">{desktopDownload}</span>
            </a>
            <a href={androidDownload} download className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:border-blue-600 hover:bg-neutral-800">
              Android APK
              <span className="mt-1 block break-all text-[10px] text-neutral-500">{androidDownload}</span>
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}
