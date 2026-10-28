import { useEffect, useState } from 'react';
import { jsonFetch, type PublicUser } from '../api';

interface Organization { id: string; name: string; status: string; revision: number }
interface Provider {
  id: string; organizationId: string; name: string; kind: string; issuer: string; clientId: string;
  redirectUri: string; enabled: boolean; revision: number;
}
interface Pending {
  id: string; providerId: string; organizationId: string; issuer: string; subject: string;
  email: string | null; displayName: string | null; revision: number;
}
interface Event { id: number; action: string; result: string; reason: string | null; createdAt: string }
interface Overview { organizations: Organization[]; providers: Provider[]; pending: Pending[]; events: Event[] }

const button='rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-40';
const input='w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-blue-600';

export function DatabaseIdentity() {
  const [data,setData]=useState<Overview|null>(null),[users,setUsers]=useState<PublicUser[]>([]);
  const [organizationName,setOrganizationName]=useState('');
  const [provider,setProvider]=useState({organizationId:'',name:'',issuer:'',clientId:'',clientSecret:'',redirectUri:`${location.origin}/api/auth/oidc/callback`});
  const [assignments,setAssignments]=useState<Record<string,string>>({});
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const load=async()=>{
    const [identity,accounts]=await Promise.all([
      jsonFetch<Overview>('/api/admin/identity'),
      jsonFetch<{users:PublicUser[]}>('/api/users'),
    ]);
    setData(identity);setUsers(accounts.users);
  };
  useEffect(()=>{void load().catch(reason=>setError(reason instanceof Error?reason.message:'身份配置读取失败'));},[]);
  const work=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');setNotice('');try{await action();await load();}catch(reason){setError(reason instanceof Error?reason.message:'操作失败');}finally{setBusy(false);}};
  const createOrganization=()=>void work(async()=>{
    await jsonFetch('/api/admin/identity/organizations',{method:'POST',body:JSON.stringify({name:organizationName.trim()})});
    setOrganizationName('');setNotice('企业已创建');
  });
  const createProvider=()=>void work(async()=>{
    await jsonFetch('/api/admin/identity/providers',{method:'POST',body:JSON.stringify(provider)});
    setProvider({...provider,name:'',issuer:'',clientId:'',clientSecret:''});setNotice('身份源已创建，请测试后启用');
  });
  const toggleProvider=(row:Provider)=>void work(async()=>{
    await jsonFetch(`/api/admin/identity/providers/${row.id}`,{method:'PATCH',body:JSON.stringify({revision:row.revision,enabled:!row.enabled})});
    setNotice(row.enabled?'身份源已停用':'身份源已启用');
  });
  const decidePending=(row:Pending,approve:boolean)=>{
    const userId=assignments[row.id];
    if(approve&&!userId){setError('请选择要绑定的本地账号');return;}
    void work(async()=>{
      await jsonFetch(`/api/admin/identity/pending/${row.id}/${approve?'approve':'reject'}`,{method:'POST',body:JSON.stringify(approve?{userId,revision:row.revision}:{revision:row.revision})});
      setNotice(approve?'外部身份已绑定并加入企业':'外部身份申请已拒绝');
    });
  };
  return <section className="space-y-5" aria-label="企业与身份源">
    <div><h1 className="text-lg font-medium">企业与身份源</h1><p className="mt-1 text-sm text-neutral-400">外部身份必须由管理员绑定本地账号后才可登录。issuer 与 subject 精确匹配，不按邮箱或姓名自动合并。</p></div>
    {error&&<p role="alert" className="rounded border border-red-800 bg-red-950/30 p-3 text-sm text-red-300">{error}</p>}
    {notice&&<p role="status" className="rounded border border-emerald-800 bg-emerald-950/30 p-3 text-sm text-emerald-300">{notice}</p>}
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-neutral-800 p-4"><h2 className="font-medium">企业</h2><div className="mt-3 flex gap-2"><input aria-label="企业名称" className={input} value={organizationName} onChange={event=>setOrganizationName(event.target.value)} placeholder="例如：星河科技" /><button className={button} disabled={busy||!organizationName.trim()} onClick={createOrganization}>创建</button></div><ul className="mt-3 space-y-2 text-sm">{data?.organizations.map(row=><li key={row.id} className="flex items-center justify-between rounded bg-neutral-900 p-2"><span>{row.name}</span><span className="text-xs text-neutral-500">{row.status} · r{row.revision}</span></li>)}</ul></div>
      <div className="rounded-xl border border-neutral-800 p-4"><h2 className="font-medium">新建 OIDC 身份源</h2><div className="mt-3 grid gap-2">
        <select aria-label="所属企业" className={input} value={provider.organizationId} onChange={event=>setProvider({...provider,organizationId:event.target.value})}><option value="">选择企业</option>{data?.organizations.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select>
        <input aria-label="身份源名称" className={input} value={provider.name} onChange={event=>setProvider({...provider,name:event.target.value})} placeholder="显示名称" />
        <input aria-label="OIDC issuer" className={input} value={provider.issuer} onChange={event=>setProvider({...provider,issuer:event.target.value})} placeholder="https://id.example.com/realms/main" />
        <input aria-label="OIDC client id" className={input} value={provider.clientId} onChange={event=>setProvider({...provider,clientId:event.target.value})} placeholder="client_id" />
        <input aria-label="OIDC client secret" className={input} type="password" value={provider.clientSecret} onChange={event=>setProvider({...provider,clientSecret:event.target.value})} placeholder="client_secret（加密保存）" />
        <input aria-label="OIDC 回调地址" className={input} value={provider.redirectUri} onChange={event=>setProvider({...provider,redirectUri:event.target.value})} />
        <button className={button} disabled={busy||!provider.organizationId||!provider.name.trim()||!provider.issuer.trim()||!provider.clientId||!provider.clientSecret} onClick={createProvider}>保存身份源</button>
      </div></div>
    </div>
    <div className="rounded-xl border border-neutral-800 p-4"><h2 className="font-medium">身份源</h2><div className="mt-3 space-y-2">{data?.providers.map(row=><div key={row.id} className="flex flex-wrap items-center gap-2 rounded bg-neutral-900 p-3 text-sm"><span className="min-w-0 flex-1"><strong>{row.name}</strong><span className="mt-1 block break-all text-xs text-neutral-500">{row.issuer} · {row.clientId}</span></span><span className={`text-xs ${row.enabled?'text-emerald-400':'text-neutral-500'}`}>{row.enabled?'已启用':'未启用'}</span><button className={button} disabled={busy} onClick={()=>toggleProvider(row)}>{row.enabled?'停用':'启用'}</button></div>)}</div></div>
    <div className="rounded-xl border border-neutral-800 p-4"><h2 className="font-medium">等待授权的企业身份</h2>{!data?.pending.length?<p className="mt-3 text-sm text-neutral-500">暂无待授权身份。</p>:<div className="mt-3 space-y-3">{data.pending.map(row=><div key={row.id} className="rounded border border-amber-800 bg-amber-950/20 p-3 text-sm"><p>{row.displayName||'未提供姓名'} · {row.email||'未提供邮箱'}</p><p className="mt-1 break-all text-xs text-neutral-500">{row.issuer} · {row.subject}</p><div className="mt-2 flex flex-wrap gap-2"><select aria-label={`绑定账号 ${row.id}`} className={input+' max-w-xs'} value={assignments[row.id]??''} onChange={event=>setAssignments({...assignments,[row.id]:event.target.value})}><option value="">选择本地账号</option>{users.filter(user=>!user.disabled).map(user=><option key={user.id} value={user.id}>{user.username}</option>)}</select><button className={button} disabled={busy} onClick={()=>decidePending(row,true)}>绑定并批准</button><button className={button} disabled={busy} onClick={()=>decidePending(row,false)}>拒绝</button></div></div>)}</div>}</div>
    <details className="rounded-xl border border-neutral-800 p-4"><summary className="cursor-pointer font-medium">最近身份审计</summary><ul className="mt-3 space-y-2 text-xs text-neutral-400">{data?.events.map(row=><li key={row.id}>{new Date(row.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · {row.action} · {row.result}{row.reason?` · ${row.reason}`:''}</li>)}</ul></details>
  </section>;
}
