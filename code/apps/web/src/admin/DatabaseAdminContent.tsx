import {DatabaseExperts} from '../DatabaseExperts';
import { DatabaseMemoryTemplates } from '../DatabaseMemoryControls';
import { SkillPackagesPanel } from './SkillPackagesPanel';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Registry } from '../DatabaseSettings';

/** Keep the established admin shell; only mount panels whose database contracts exist. */
export function DatabaseAdminContent({ menu, onDirty }: { menu: string; onDirty: (dirty: boolean) => void }) {
  const [capabilities, setCapabilities] = useState<{ providersEnabled?: boolean; mcpEnabled?: boolean } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { const c = new AbortController(); void fetch('/api/health', { signal: c.signal }).then(r => { if (!r.ok) throw Error('读取服务状态失败'); return r.json(); }).then(setCapabilities).catch(e => { if (!c.signal.aborted) setError(String(e)); }); return () => c.abort(); }, []);
  if (menu === 'experts') return <DatabaseExperts admin/>;
  if (menu === 'memory') return <DatabaseMemoryTemplates />;
  if (menu === 'skills') return <SkillPackagesPanel onDirty={onDirty} />;
  if (menu === 'users') return <DatabaseUsers />;
  if (error) return <p role="alert">{error}</p>;
  if (!capabilities) return <p>正在读取服务状态…</p>;
  if (menu === 'models' || menu === 'mcp' || menu === 'projects') {
    const section = menu === 'models' ? 'providers' : menu;
    const enabled = menu === 'models' ? capabilities.providersEnabled : menu === 'mcp' ? capabilities.mcpEnabled : true;
    return <section><h1 className="mb-4 text-lg font-medium">{menu === 'models' ? '模型管理' : menu === 'mcp' ? 'MCP 管理' : '我的项目'}</h1>{enabled ? <Registry key={section} section={section} onChanged={async () => {}} /> : <p className="text-sm text-neutral-400">当前联调服务未启用{menu === 'models' ? '模型配置' : 'MCP'}模块。</p>}</section>;
  }
  const titles: Record<string, string> = { skills: 'Skill 管理', memory: '默认记忆', templates: '我的模板', schedules: '定时任务', ops: '审计与回收站', permissions: '路径授权' };
  return <section><h1 className="mb-4 text-lg font-medium">{titles[menu]}</h1><p className="text-sm text-neutral-400">此功能的原管理页面仍保留在工程中，数据库接口尚未接入，暂不可操作。</p></section>;
}

function DatabaseUsers() {
  const [users, setUsers] = useState<Awaited<ReturnType<typeof api.listUsers>>['users']>([]);
  const [error, setError] = useState(''), [name, setName] = useState(''), [password, setPassword] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member'), [creating, setCreating] = useState(false), [busy, setBusy] = useState(false);
  const load = async () => { setUsers((await api.listUsers()).users); };
  useEffect(() => { void load().catch(e => setError(String(e))); }, []);
  return <section className="space-y-4"><h1 className="text-lg font-medium">用户管理</h1>{error && <p role="alert" className="text-sm text-red-400">{error}</p>}<button className="rounded bg-blue-600 px-3 py-2 text-sm text-white" onClick={() => setCreating(v => !v)}>创建用户</button>
    {creating && <form className="max-w-md space-y-3 rounded-lg border border-neutral-700 p-4" onSubmit={e => { e.preventDefault(); if (busy) return; setBusy(true); setError(''); void api.createUser(name.trim(), password, role).then(async () => { setPassword(''); setName(''); setCreating(false); await load(); }).catch(e => setError(String(e))).finally(() => setBusy(false)); }}><label className="block">用户名<input required value={name} onChange={e => setName(e.target.value)} className="block w-full rounded bg-neutral-800 p-2" /></label><label className="block">临时密码<input required type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} className="block w-full rounded bg-neutral-800 p-2" /></label><label className="block">角色<select value={role} onChange={e => setRole(e.target.value as 'member' | 'admin')} className="block w-full rounded bg-neutral-800 p-2"><option value="member">成员</option><option value="admin">管理员</option></select></label><button disabled={busy} className="rounded border border-neutral-700 px-3 py-2">保存</button></form>}
    <table className="w-full text-left text-sm"><thead><tr className="border-b border-neutral-700"><th className="p-3">用户名</th><th>角色</th></tr></thead><tbody>{users.map(user => <tr key={user.id} className="border-b border-neutral-800"><td className="p-3">{user.username}</td><td>{user.role === 'admin' ? '管理员' : '成员'}</td></tr>)}</tbody></table>
  </section>;
}
