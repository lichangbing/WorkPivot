import { useEffect, useState } from 'react';
import { jsonFetch } from './api';
type Total={currency:string;requests:number;inputTokens:string;outputTokens:string;cost:string|null;unknownCost:number;estimated:number;unfinished:number;day?:string;taskId?:string|null;taskName?:string|null};
type Data={month:string;notice:string;totals:Total[];days:Total[];tasks:Total[];recent:{id:string;model:string;source:string;status:string;measurement:string|null;inputTokens:string|null;outputTokens:string|null;currency:string;cost:string|null;startedAt:string}[];budgets:{currency:string;amount:string|null;revision:number}[];alerts:{currency:string;month:string;amount:string;readAt:string|null}[]};
const button='rounded border border-neutral-600 px-3 py-1 text-sm disabled:opacity-40';
const input='rounded border border-neutral-600 bg-neutral-900 p-2';
const money=(v:string|null)=>v===null?'未知':(v.includes('.')?v.replace(/0+$/,'').replace(/\.$/,''):v);
const sources:Record<string,string>={chat:'对话与Skill',automation:'自动化',memory:'记忆整理',expert:'专家整理',summary:'历史摘要',diagnostic:'模型诊断'};
const states:Record<string,string>={pending:'未结算',completed:'完成',failed:'失败',cancelled:'取消'};
const currentMonth=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date());
export function DatabaseUsage(){
 const [month,setMonth]=useState(currentMonth),[data,setData]=useState<Data>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[currency,setCurrency]=useState('CNY'),[amount,setAmount]=useState(''),[taskId,setTaskId]=useState('');
 const load=async(signal?:AbortSignal)=>{const d=await jsonFetch<Data>('/api/usage?'+new URLSearchParams({month,...(taskId?{taskId}:{})}),{signal});if(!signal?.aborted)setData(d);};
 useEffect(()=>{const c=new AbortController();void load(c.signal).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[month,taskId]);
 useEffect(()=>{setAmount(data?.budgets.find(b=>b.currency===currency)?.amount??'');},[data,currency]);
 const run=async(action:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await action();await load();}catch(e){setError(e instanceof Error?e.message:'请求失败');}finally{setBusy(false);}};
 const table=(rows:Total[],group:'total'|'day'|'task')=><div className="overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th>范围 / 币种</th><th>请求</th><th>输入 / 输出 Token</th><th>估算费用</th><th>估算 / 未结算 / 费用未知</th></tr></thead><tbody>{rows.map((r,i)=><tr key={i} className="border-t border-neutral-700"><td className="py-2">{group==='day'?r.day:group==='task'?r.taskName??(r.taskId?'已删除任务':'后台处理'):'月合计'} · {r.currency}</td><td>{r.requests}</td><td>{r.inputTokens} / {r.outputTokens}</td><td>{money(r.cost)}</td><td>{r.estimated} / {r.unfinished} / {r.unknownCost}</td></tr>)}</tbody></table></div>;
 return <section className="space-y-4" aria-label="用量与预算">
  <p className="text-sm text-neutral-400">{data?.notice??'仅显示当前用户从本功能启用后产生的模型请求；Skill脚本本身不消耗模型Token。'}未结算请求可能仍在运行或已经中断，不能当作免费请求。</p>
  {error&&<p role="alert" className="text-red-400">{error}</p>}
  <div className="flex flex-wrap gap-2"><label>月份 <input aria-label="用量月份" className={input} type="month" value={month} onChange={e=>setMonth(e.target.value)}/></label><label>任务 <select className={input} value={taskId} onChange={e=>setTaskId(e.target.value)}><option value="">全部任务</option>{[...new Map(data?.tasks.filter(t=>t.taskId).map(t=>[t.taskId,t])).values()].map(t=><option key={t.taskId!} value={t.taskId!}>{t.taskName??'已删除任务'}</option>)}</select></label><button className={button} disabled={busy} onClick={()=>void run(async()=>{})}>刷新</button></div>
  {data?.alerts.filter(a=>!a.readAt).map(a=><div role="status" key={a.month+a.currency} className="rounded border border-amber-700 p-3">{a.month} {a.currency} 已达到预算 {money(a.amount)}。提醒不停止任务。 <button className={button} disabled={busy} onClick={()=>void run(()=>jsonFetch('/api/usage/acknowledge',{method:'POST',body:JSON.stringify({currency:a.currency,month:a.month})}))}>已知晓</button></div>)}
  <h3>本月汇总</h3>{data&&table(data.totals,'total')}
  <form className="flex flex-wrap items-end gap-3" onSubmit={e=>{e.preventDefault();void run(()=>jsonFetch('/api/usage/budget',{method:'PUT',body:JSON.stringify({currency,amount:amount||null,revision:data?.budgets.find(b=>b.currency===currency)?.revision??0})}));}}><label>预算币种 <select className={input} value={currency} onChange={e=>setCurrency(e.target.value)}><option>CNY</option><option>USD</option></select></label><label>每月提醒金额 <input className={input} type="number" min="0.000001" step="0.000001" placeholder="留空关闭" value={amount} onChange={e=>setAmount(e.target.value)}/></label><button className={button} disabled={busy||!data}>保存预算</button></form>
  <h3>按日汇总</h3>{data&&table(data.days,'day')}<details><summary>按任务汇总（最多100项）</summary>{data&&table(data.tasks,'task')}</details>
  <details><summary>最近100次请求</summary><div className="overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th>时间 / 模型</th><th>来源 / 状态</th><th>输入 / 输出</th><th>计数依据</th><th>估算费用</th></tr></thead><tbody>{data?.recent.map(r=><tr key={r.id} className="border-t border-neutral-700"><td className="py-2">{new Date(r.startedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}<br/>{r.model}</td><td>{sources[r.source]??'其他'} / {states[r.status]??r.status}</td><td>{r.inputTokens??'未知'} / {r.outputTokens??'未知'}</td><td>{r.measurement==='provider'?'供应商返回':r.measurement==='estimated'?'估算':'未结算'}</td><td>{r.currency} {money(r.cost)}</td></tr>)}</tbody></table></div></details>
 </section>;
}
