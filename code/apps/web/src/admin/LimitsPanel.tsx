import { useCallback, useEffect, useState } from 'react';
import { api, type LimitOverview, type LimitValues } from '../api';

const MB = 1024 * 1024;
const button = 'rounded-lg border border-neutral-700 px-3 py-2 text-xs hover:bg-neutral-800 disabled:opacity-40';
const input = 'mt-1 block w-full rounded border border-neutral-700 bg-neutral-950 px-2.5 py-2 text-sm';
type UserLimit = LimitOverview['users'][number];
type AccessPolicy = Awaited<ReturnType<typeof api.accessPolicy>>['policy'];

const sourceLabel: Record<UserLimit['provisioningSource'], string> = {
  first_admin: '平台管理员',
  self: '自助注册',
  admin: '管理员创建',
  legacy: '历史账户',
};

function formatBytes(value: number): string {
  if (value >= 1024 * MB) return `${(value / 1024 / MB).toFixed(value % (1024 * MB) ? 1 : 0)} GB`;
  if (value >= MB) return `${(value / MB).toFixed(value % MB ? 1 : 0)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function LimitSummary({ limits }: { limits: LimitValues }) {
  return <div className="grid grid-cols-2 gap-2 text-xs text-neutral-400">
    <span>对话 {limits.messageQuota || '不限'}</span>
    <span>Token {limits.tokenQuota ? limits.tokenQuota.toLocaleString('zh-CN') : '不限'}</span>
    <span>上传 {limits.uploadQuotaBytes ? formatBytes(limits.uploadQuotaBytes) : '不限'}</span>
    <span>并发 {limits.concurrentTaskLimit || '不限'}</span>
  </div>;
}

function UserLimitsCard({ user, busy, onSave, onReset }: {
  user: UserLimit;
  busy: boolean;
  onSave: (values: LimitValues) => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const [values, setValues] = useState({
    messageQuota: user.limits.messageQuota,
    tokenQuota: user.limits.tokenQuota,
    uploadMb: user.limits.uploadQuotaBytes / MB,
    concurrentTaskLimit: user.limits.concurrentTaskLimit,
  });
  const readonly = user.platformAdmin;
  const change = (key: keyof typeof values) => (event: React.ChangeEvent<HTMLInputElement>) => setValues(current => ({ ...current, [key]: Number(event.target.value) }));
  return <article className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{user.username}</h3><span className="rounded-full border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-400">{sourceLabel[user.provisioningSource]}</span>{user.disabled && <span className="text-xs text-red-400">已停用</span>}</div>
        <p className="mt-1 text-xs text-neutral-500">当前周期：对话 {user.usage.messages} · Token {user.usage.tokens.toLocaleString('zh-CN')} · 上传 {formatBytes(user.usage.uploadBytes)} · 并发 {user.usage.concurrentTasks}</p>
      </div>
      <LimitSummary limits={user.limits} />
    </header>
    {readonly ? <p className="mt-4 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-400">平台管理员始终不限额度。</p> : <>
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <label className="text-xs text-neutral-400">每日对话<input className={input} type="number" min={0} max={100000} value={values.messageQuota} onChange={change('messageQuota')} /></label>
        <label className="text-xs text-neutral-400">每日 Token<input className={input} type="number" min={0} max={1000000000} step={1000} value={values.tokenQuota} onChange={change('tokenQuota')} /></label>
        <label className="text-xs text-neutral-400">每日上传 MB<input className={input} type="number" min={0} max={1048576} step={1} value={values.uploadMb} onChange={change('uploadMb')} /></label>
        <label className="text-xs text-neutral-400">并发任务<input className={input} type="number" min={0} max={100} value={values.concurrentTaskLimit} onChange={change('concurrentTaskLimit')} /></label>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-neutral-500">0 表示不限。每日额度统一按北京时间 12:00 刷新。</p>
        <div className="flex gap-2"><button className={button} disabled={busy} onClick={() => void onReset()}>重置当前用量</button><button className={button + ' bg-neutral-800'} disabled={busy || values.uploadMb < 0 || !Number.isSafeInteger(values.uploadMb)} onClick={() => void onSave({ messageQuota: values.messageQuota, tokenQuota: values.tokenQuota, uploadQuotaBytes: values.uploadMb * MB, concurrentTaskLimit: values.concurrentTaskLimit })}>保存限额</button></div>
      </div>
    </>}
  </article>;
}

export function LimitsPanel() {
  const [overview, setOverview] = useState<LimitOverview | null>(null);
  const [policy, setPolicy] = useState<AccessPolicy | null>(null);
  const [defaults, setDefaults] = useState({ messageQuota: 10, tokenQuota: 200000, uploadMb: 50, concurrentTaskLimit: 1 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const [limits, access] = await Promise.all([api.limitOverview(), api.accessPolicy()]);
    setOverview(limits);
    setPolicy(access.policy);
    setDefaults({
      messageQuota: access.policy.defaultMessageQuota,
      tokenQuota: access.policy.defaultTokenQuota,
      uploadMb: access.policy.defaultUploadQuotaBytes / MB,
      concurrentTaskLimit: access.policy.defaultConcurrentTaskLimit,
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load().catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [load]);

  const run = async (action: () => Promise<unknown>, message: string) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); await load(); setNotice(message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const saveDefaults = () => {
    if (!policy) return;
    void run(() => api.updateAccessPolicy({
      registrationMode: policy.registrationMode,
      defaultMessageQuota: defaults.messageQuota,
      defaultTokenQuota: defaults.tokenQuota,
      defaultUploadQuotaBytes: defaults.uploadMb * MB,
      defaultConcurrentTaskLimit: defaults.concurrentTaskLimit,
      revision: policy.revision,
    }), '自助注册默认限额已保存');
  };

  return <section className="space-y-6">
    <header>
      <h1 className="text-lg font-semibold">限额管理</h1>
      <p className="mt-1 text-sm text-neutral-400">分别限制每日对话、Token、上传和并发任务。管理员创建的账户默认不限，平台管理员始终不受限。</p>
    </header>
    {error && <p role="alert" className="rounded border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">{error}</p>}
    {notice && <p role="status" className="rounded border border-emerald-800 bg-emerald-950/30 p-3 text-sm text-emerald-300">{notice}</p>}

    <section className="rounded-xl border border-neutral-700 bg-neutral-900 p-4">
      <h2 className="font-medium">自助注册默认限额</h2>
      <p className="mt-1 text-xs text-neutral-500">只影响之后新增的自助注册用户，不覆盖现有用户或管理员创建的账户。</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <label className="text-xs text-neutral-400">每日对话<input className={input} type="number" min={0} max={100000} value={defaults.messageQuota} onChange={event => setDefaults({ ...defaults, messageQuota: Number(event.target.value) })} /></label>
        <label className="text-xs text-neutral-400">每日 Token<input className={input} type="number" min={0} max={1000000000} step={1000} value={defaults.tokenQuota} onChange={event => setDefaults({ ...defaults, tokenQuota: Number(event.target.value) })} /></label>
        <label className="text-xs text-neutral-400">每日上传 MB<input className={input} type="number" min={0} max={1048576} value={defaults.uploadMb} onChange={event => setDefaults({ ...defaults, uploadMb: Number(event.target.value) })} /></label>
        <label className="text-xs text-neutral-400">并发任务<input className={input} type="number" min={0} max={100} value={defaults.concurrentTaskLimit} onChange={event => setDefaults({ ...defaults, concurrentTaskLimit: Number(event.target.value) })} /></label>
      </div>
      <button className={button} disabled={busy || !policy || defaults.uploadMb < 0 || !Number.isSafeInteger(defaults.uploadMb)} onClick={saveDefaults}>保存默认限额</button>
    </section>

    {!overview ? <p className="text-sm text-neutral-400">正在读取限额…</p> : <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2"><div><h2 className="font-medium">用户限额</h2><p className="mt-1 text-xs text-neutral-500">{overview.notice}</p></div><button className={button} disabled={busy} onClick={() => void run(load, '限额用量已刷新')}>刷新</button></div>
      {overview.users.map(user => <UserLimitsCard
        key={`${user.id}:${user.revision}`}
        user={user}
        busy={busy}
        onSave={values => run(() => api.updateUserLimits(user.id, { ...values, revision: user.revision }), `已更新「${user.username}」的限额`)}
        onReset={() => {
          if (!window.confirm(`重置「${user.username}」当前周期的对话、Token 和上传用量？`)) return Promise.resolve();
          return run(() => api.resetUserQuota(user.id), `已重置「${user.username}」当前用量`);
        }}
      />)}
    </section>}
  </section>;
}
