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

function WindowsIcon(): React.JSX.Element {
  return <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
    <path d="M2.5 4.6 10.6 3v8.1H2.5V4.6Zm9.2-1.8L21.5 1v10.1h-9.8V2.8ZM2.5 12.2h8.1V21l-8.1-1.7v-7.1Zm9.2 0h9.8V23l-9.8-1.8v-9Z" />
  </svg>;
}

function AndroidIcon(): React.JSX.Element {
  return <svg aria-hidden="true" width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="m7.2 5.4-1-1.8M16.8 5.4l1-1.8" />
    <path d="M5.5 8.2a6.8 6.8 0 0 1 13 0v8.9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V8.2Z" />
    <path d="M8.4 11h.01M15.6 11h.01M9 15.3h6M8 19.1v2M16 19.1v2" />
  </svg>;
}

function DownloadArrow(): React.JSX.Element {
  return <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v12m-5-5 5 5 5-5M5 20h14" />
  </svg>;
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
          {!needsSetup && !registrationEnabled && (
            <p className="rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2 text-center text-xs text-neutral-500">
              自助注册当前未开放；没有账号请联系管理员创建。
            </p>
          )}
        </div>
        <section aria-labelledby="download-title" className="mt-5 border-t border-neutral-800 pt-5">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h2 id="download-title" className="text-sm font-medium text-neutral-100">下载 WorkPivot 客户端</h2>
              <p className="mt-1 text-xs text-neutral-500">无需登录，选择你的设备</p>
            </div>
            <span className="rounded-full border border-emerald-800 bg-emerald-950/40 px-2 py-0.5 text-[10px] text-emerald-300">免费下载</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <a href={desktopDownload} download aria-label="下载 Windows 便携客户端" className="group flex min-h-40 flex-col rounded-xl border border-neutral-700 bg-neutral-950 p-4 text-neutral-100 transition hover:-translate-y-0.5 hover:border-blue-500 hover:bg-neutral-800/60">
              <div className="flex items-start justify-between">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-500/15 text-blue-300"><WindowsIcon /></span>
                <span className="text-[10px] uppercase tracking-wider text-neutral-500">Desktop</span>
              </div>
              <strong className="mt-4 text-sm">Windows 客户端</strong>
              <span className="mt-1 text-xs text-neutral-500">Windows 10/11 · 免安装便携版</span>
              <span className="mt-auto flex items-center justify-between pt-4 text-xs"><span className="text-neutral-500">约 118 MB</span><span className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 font-medium text-white group-hover:bg-blue-500">下载<DownloadArrow /></span></span>
            </a>
            <a href={androidDownload} download aria-label="下载 Android APK" className="group flex min-h-40 flex-col rounded-xl border border-neutral-700 bg-neutral-950 p-4 text-neutral-100 transition hover:-translate-y-0.5 hover:border-emerald-500 hover:bg-neutral-800/60">
              <div className="flex items-start justify-between">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300"><AndroidIcon /></span>
                <span className="text-[10px] uppercase tracking-wider text-neutral-500">Mobile</span>
              </div>
              <strong className="mt-4 text-sm">Android 客户端</strong>
              <span className="mt-1 text-xs text-neutral-500">Android 8+ · APK 安装包</span>
              <span className="mt-auto flex items-center justify-between pt-4 text-xs"><span className="text-neutral-500">约 3.3 MB</span><span className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 font-medium text-white group-hover:bg-emerald-500">下载<DownloadArrow /></span></span>
            </a>
          </div>
          <p className="mt-3 text-center text-[10px] text-neutral-600">Windows 版为内部测试构建，首次运行可能触发 SmartScreen 提示。</p>
        </section>
      </div>
    </div>
  );
}
