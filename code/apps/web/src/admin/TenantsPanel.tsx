import { useEffect, useState } from 'react';
import { api } from '../api';

export function TenantsPanel(): React.JSX.Element {
  const [tenants, setTenants] = useState<Array<{ id: string; name: string }>>([]);
  const [form, setForm] = useState({ id: '', name: '', username: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { void api.listTenants().then((result) => setTenants(result.tenants)).catch((error: Error) => setMessage(error.message)); }, []);
  return <section className="max-w-2xl space-y-5">
    <div><h1 className="text-lg font-semibold">租户管理</h1><p className="mt-1 text-sm text-neutral-400">每个租户拥有独立的用户、项目、工作目录和模型配置。租户管理员只能管理所属租户。</p></div>
    <div className="space-y-2">{tenants.map((tenant) => <div key={tenant.id} className="flex justify-between rounded-lg border border-neutral-700 p-3 text-sm"><span>{tenant.name}</span><code>{tenant.id}</code></div>)}</div>
    <form className="space-y-3 rounded-xl border border-neutral-700 bg-neutral-900 p-4" onSubmit={(event) => {
      event.preventDefault(); if (busy) return; setBusy(true); setMessage('');
      void api.createTenant(form).then(async () => { setForm({ id: '', name: '', username: '', password: '' }); setTenants((await api.listTenants()).tenants); setMessage('租户已创建，可使用其租户标识和管理员账户登录。'); }).catch((error: Error) => setMessage(error.message)).finally(() => setBusy(false));
    }}><h2 className="font-medium">新建租户</h2>
      {([['id', '租户标识'], ['name', '租户名称'], ['username', '管理员用户名'], ['password', '管理员密码']] as const).map(([key, label]) => <label key={key} className="block text-sm">{label}<input required disabled={busy} type={key === 'password' ? 'password' : 'text'} minLength={key === 'password' ? 6 : 2} autoComplete={key === 'password' ? 'new-password' : 'off'} value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} className="mt-1 block w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2" /></label>)}
      <p className="text-xs text-neutral-500">租户标识使用小写字母、数字和连字符，创建后用于登录。</p>
      <button disabled={busy} className="rounded bg-blue-600 px-4 py-2 text-sm disabled:opacity-40">{busy ? '创建中…' : '创建租户'}</button>
    </form>
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
