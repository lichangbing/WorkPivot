import { useEffect, useState } from 'react';
import { jsonFetch } from './api';
import { Icon } from './Icon';
import { dailyUsage } from './usage-days';
type Total={requests:number;inputTokens:string;outputTokens:string;estimated:number;unfinished:number;day?:string};
type Data={days:Total[];recent:{id:string;model:string;source:string;status:string;measurement:string|null;inputTokens:string|null;outputTokens:string|null;startedAt:string}[]};
const sources:Record<string,string>={chat:'对话与技能',automation:'自动化',memory:'记忆整理',expert:'专家整理',summary:'历史摘要',diagnostic:'模型诊断'};
const states:Record<string,string>={pending:'未结算',completed:'完成',failed:'失败',cancelled:'取消'};
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const number=(value:string|bigint|number)=>BigInt(value).toLocaleString('zh-CN');
export function DatabaseUsage(){
 const [month,setMonth]=useState(()=>today().slice(0,7)),[data,setData]=useState<Data>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();setBusy(true);setError('');setData(undefined);
  void jsonFetch<Data>('/api/usage?'+new URLSearchParams({month}),{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setData(value);}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'读取用量失败');}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
  return()=>controller.abort();
 },[month,refresh]);
 const days=dailyUsage(month,data?.days??[],today());
 const totals=days.reduce((sum,row)=>({requests:sum.requests+row.requests,input:sum.input+BigInt(row.inputTokens),output:sum.output+BigInt(row.outputTokens),unfinished:sum.unfinished+row.unfinished}),{requests:0,input:0n,output:0n,unfinished:0});
 return <section className="space-y-5" aria-label="用量统计">
  <div className="flex flex-wrap items-center justify-between gap-3"><label className="flex items-center gap-3 text-sm">统计月份<input aria-label="用量月份" className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2" type="month" min="2020-01" max={today().slice(0,7)} value={month} onChange={e=>{if(e.target.value)setMonth(e.target.value);}}/></label><button type="button" className="flex items-center gap-2 rounded-lg border border-neutral-700 px-3 py-2 text-sm hover:bg-neutral-800 disabled:opacity-40" disabled={busy} onClick={()=>setRefresh(n=>n+1)}><Icon name="refresh"/>{busy?'加载中…':'刷新'}</button></div>
  <p className="text-xs leading-6 text-neutral-400">按北京时间（UTC+8）和请求开始日期统计。一次模型调用计为一次请求，重试单独计数；技能脚本本身不消耗模型 Token。无供应商用量时采用估算，未结算请求不计入已记录 Token。</p>
  {error&&<p role="alert" className="text-sm text-red-400">{error}</p>}
  {data&&<>
   <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{[['请求次数',totals.requests],['输入 Token',totals.input],['输出 Token',totals.output]].map(([label,value])=><div key={String(label)} className="rounded-xl border border-neutral-800 bg-neutral-900 p-4"><p className="mb-2 text-xs text-neutral-400">{String(label)}</p><strong className="text-xl font-semibold tabular-nums">{number(value!)}</strong></div>)}</div>
   <div><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">每日用量</h3><span className="text-xs text-neutral-500">{month} · 最新日期在前</span></div>{totals.unfinished>0&&<p className="mb-3 text-xs text-amber-600">有 {totals.unfinished} 次请求尚未结算，用量可能继续更新。</p>}
   <div className="overflow-auto rounded-xl border border-neutral-800"><table className="w-full whitespace-nowrap text-left text-sm"><thead className="bg-neutral-900 text-xs text-neutral-400"><tr>{['日期','请求次数','输入 Token','输出 Token','总 Token','估算请求','未结算'].map(label=><th key={label} className="px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{days.map(row=><tr key={row.day} className="border-t border-neutral-800 tabular-nums hover:bg-neutral-900"><td className="px-3 py-3">{row.day}</td>{[row.requests,row.inputTokens,row.outputTokens,BigInt(row.inputTokens)+BigInt(row.outputTokens),row.estimated,row.unfinished].map((value,index)=><td key={index} className="px-3 py-3">{number(value)}</td>)}</tr>)}</tbody></table></div>{totals.requests===0&&<p className="mt-3 text-sm text-neutral-400">该月暂无模型请求记录。</p>}</div>
   <details className="rounded-xl border border-neutral-800 p-4"><summary className="cursor-pointer text-sm">最近 100 次请求明细</summary><div className="mt-4 overflow-auto"><table className="w-full whitespace-nowrap text-left text-xs"><thead><tr>{['时间 / 模型','来源 / 状态','输入 / 输出 Token','计数依据'].map(label=><th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{data.recent.map(row=><tr key={row.id} className="border-t border-neutral-800"><td className="p-2">{new Date(row.startedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}<br/>{row.model}</td><td className="p-2">{sources[row.source]??'其他'} / {states[row.status]??row.status}</td><td className="p-2">{row.inputTokens===null?'待结算':number(row.inputTokens)} / {row.outputTokens===null?'待结算':number(row.outputTokens)}</td><td className="p-2">{row.measurement==='provider'?'供应商返回':row.measurement==='estimated'?'估算':'未结算'}</td></tr>)}</tbody></table>{!data.recent.length&&<p className="p-2 text-neutral-400">暂无请求记录</p>}</div></details>
  </>}
 </section>;
}
