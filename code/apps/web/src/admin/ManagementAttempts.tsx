import {useEffect,useState} from 'react';
import {jsonFetch} from '../api';
type Attempt={id:string;actorId:string;targetId:string|null;category:string;createdAt:string};
type Result={attempts:Attempt[];next:{at:string;id:string}|null};
const categories:Record<string,string>={permission_denied:'权限拒绝',invalid_input:'参数错误',conflict:'版本或请求冲突',not_found:'目标不存在',internal_error:'服务执行失败'};
export function ManagementAttempts({owner,users}:{owner:string;users:{id:string;username:string}[]}){
 const [category,setCategory]=useState(''),[data,setData]=useState<Result|null>(null),[error,setError]=useState(''),[reload,setReload]=useState(0),[busy,setBusy]=useState(false);
 useEffect(()=>{const controller=new AbortController();setData(null);setError('');setBusy(true);
  void jsonFetch<Result>('/api/admin/automation-attempts?userId='+owner+(category?'&category='+category:''),{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setData(value);}).catch(e=>{if(!controller.signal.aborted)setError(String(e));}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});return()=>controller.abort();
 },[owner,category,reload]);
 async function more(){if(!data?.next||busy)return;setBusy(true);setError('');try{const query=new URLSearchParams({userId:owner,...(category?{category}:{}),at:data.next.at,id:data.next.id});const value=await jsonFetch<Result>('/api/admin/automation-attempts?'+query);setData({...value,attempts:[...data.attempts,...value.attempts]});}catch(e){setError(String(e));}finally{setBusy(false);}}
 const name=(id:string|null)=>id?(users.find(u=>u.id===id)?.username??id):'无有效目标';
 return <section className="space-y-3 rounded-lg border border-neutral-700 p-4"><h2>额度修改失败与拒绝记录</h2><p className="text-sm text-neutral-400">仅覆盖已认证用户的额度修改尝试，不展示原始请求或错误正文。目标无效或不存在的记录归入操作人名下。服务故障时请先刷新额度核对实际结果。</p><div className="flex flex-wrap gap-3"><label>失败分类<select aria-label="失败分类" className="ml-2 rounded bg-neutral-800 p-2" value={category} disabled={busy} onChange={e=>setCategory(e.target.value)}><option value="">全部</option>{Object.entries(categories).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><button disabled={busy} onClick={()=>setReload(n=>n+1)}>刷新失败审计</button></div>{error&&<p role="alert">{error}</p>}{busy&&<p role="status">正在读取失败审计…</p>}{data&&!data.attempts.length&&<p>暂无额度修改失败记录</p>}<ol className="space-y-2">{data?.attempts.map(row=><li className="break-words rounded bg-neutral-800 p-3 text-sm" key={row.id}><p>{new Date(row.createdAt).toLocaleString()} · {categories[row.category]??'未知分类'}</p><p>操作人：{name(row.actorId)}；目标：{name(row.targetId)}</p></li>)}</ol>{data?.next&&<button disabled={busy} onClick={()=>void more()}>加载更早失败记录</button>}</section>;
}
