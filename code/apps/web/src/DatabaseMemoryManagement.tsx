import {useEffect,useState} from 'react';
import {jsonFetch} from './api';
import {MemorySuggestions} from './MemorySuggestions';
import {MemoryAutoControl} from './MemoryAutoControl';
import {DatabaseMemoryControls} from './DatabaseMemoryControls';
import {MemoryEditor} from './DatabaseMemory';
import {Icon} from './Icon';
type Scope='user'|'project'|'task';
interface Entry{id:string;revision:number;content:string;locked:boolean;legacyPersonal?:boolean;projectId?:string|null;taskName?:string;projectName?:string}
interface Analysis{progress:{scope:Scope;scopeId:string;projectName:string|null;pending:number;total:number}[];batches:{id:string;scope:Scope;status:string;error:string|null;createdAt:string;finishedAt:string|null;projectName:string|null;suggestions:number}[]}
const labels={user:'个人记忆',project:'项目记忆',task:'任务记忆'};
const button='rounded-lg border border-neutral-700 px-3 py-2 text-xs hover:bg-neutral-800 disabled:opacity-40';
export function DatabaseMemoryManagement(){
 const [tab,setTab]=useState<'saved'|'suggestions'|'analysis'>('saved'),[scope,setScope]=useState<Scope>('user');
 const [projectFilter,setProjectFilter]=useState('all'),[assignProject,setAssignProject]=useState('');
 const [rows,setRows]=useState<Entry[]>([]),[cursor,setCursor]=useState<string|null>(null),[analysis,setAnalysis]=useState<Analysis>();
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[generation,setGeneration]=useState(0);
 const [editing,setEditing]=useState<Entry|null>(null),[draft,setDraft]=useState(''),[removing,setRemoving]=useState<Entry|null>(null);
 const [create,setCreate]=useState(false),[scopeId,setScopeId]=useState(''),[options,setOptions]=useState<{id:string;name:string}[]>([]);
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setRows([]);setCursor(null);setEditing(null);setRemoving(null);setError('');
  void jsonFetch<{memories:Entry[];nextCursor:string|null}>('/api/memory-management?'+new URLSearchParams({scope,project:scope==='user'?projectFilter:'all'}),{signal:controller.signal}).then(result=>{if(!controller.signal.aborted){setRows(result.memories);setCursor(result.nextCursor);}}).catch(e=>{if(!controller.signal.aborted)setError(String(e));}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[scope,projectFilter,generation]);
 useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const result=await jsonFetch<Analysis>('/api/memory-analysis',{signal:controller.signal});if(!controller.signal.aborted)setAnalysis(result);}catch(e){if(!controller.signal.aborted)setError(String(e));}finally{if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),10000);}};void poll();return()=>{controller.abort();clearTimeout(timer);};},[generation]);
 useEffect(()=>{const controller=new AbortController();setOptions([]);setScopeId('');void jsonFetch<Record<string,{id:string;name:string}[]>>(scope!=='task'?'/api/projects':'/api/tasks',{signal:controller.signal}).then(result=>{if(!controller.signal.aborted)setOptions(result[scope!=='task'?'projects':'tasks']??[]);}).catch(e=>{if(!controller.signal.aborted)setError(String(e));});return()=>controller.abort();},[scope]);
 const run=async(action:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await action();setEditing(null);setRemoving(null);setGeneration(n=>n+1);}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}};
 const states:Record<string,string>={pending:'等待分析',running:'分析中',completed:'分析完成',failed:'分析失败',stale:'来源失效'};
 return <div className="space-y-5">
  <nav aria-label="记忆管理分类" className="flex flex-wrap gap-2">{([['saved','已保存记忆'],['suggestions','待确认建议'],['analysis','分析与设置']] as const).map(([value,label])=><button type="button" key={value} aria-pressed={tab===value} className={button+(tab===value?' bg-neutral-800':'')} onClick={()=>setTab(value)}>{label}</button>)}</nav>
  {error&&<p role="alert" className="text-sm text-red-400">{error}</p>}
  {tab==='saved'&&<>
   <div className="flex flex-wrap items-center gap-2">{(['user','project','task'] as const).map(value=><button type="button" key={value} className={button+(scope===value?' bg-neutral-800':'')} aria-pressed={scope===value} disabled={busy} onClick={()=>setScope(value)}>{labels[value]}</button>)}<button type="button" className={button} disabled={busy||loading} onClick={()=>setGeneration(n=>n+1)}><Icon name="refresh"/> 刷新</button></div>
   <p className="text-xs leading-6 text-neutral-400">{scope==='user'?'个人记忆只在所属项目内跨任务使用；临时任务范围独立，旧全局记忆须确认归属后启用。':scope==='project'?'这里列出各项目已保存的背景、目标与约定。':'这里列出所有任务已保存的结论与要求，不必逐个打开任务。'}只有确认保存的内容才会出现在这里，整理完成不代表已经保存。</p>
   {scope==='user'&&<label className="block text-sm">项目筛选 <select aria-label="个人记忆项目筛选" className="rounded border border-neutral-700 bg-neutral-900 p-2" value={projectFilter} onChange={e=>setProjectFilter(e.target.value)}><option value="all">全部归属</option><option value="temporary">临时任务范围</option><option value="legacy">待指定归属</option>{options.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
   <div className="flex flex-wrap items-center gap-2">{<select aria-label="新增记忆归属" className="max-w-full rounded-lg border border-neutral-700 bg-neutral-900 p-2 text-sm" value={scopeId} onChange={e=>setScopeId(e.target.value)}><option value="">选择{scope!=='task'?'项目':'任务'}</option>{scope==='user'&&<option value="temporary">临时任务范围</option>}{options.map(option=><option key={option.id} value={option.id}>{option.name}</option>)}</select>}<button type="button" className={button} disabled={busy||!scopeId} onClick={()=>setCreate(true)}>新增{labels[scope]}</button></div>
   {loading?<p className="text-sm text-neutral-400">正在读取记忆…</p>:!rows.length?<div className="rounded-xl border border-dashed border-neutral-700 p-6 text-sm text-neutral-400">暂无已保存的{labels[scope]}。可查看“待确认建议”，或切换到其他记忆层级。</div>:<p className="text-xs text-neutral-500">当前已显示 {rows.length} 条{cursor?'，下方可加载更多':''}</p>}
   {rows.map(row=><article key={row.id} className="space-y-3 rounded-xl border border-neutral-800 p-4"><header className="flex items-center justify-between gap-2 text-xs text-neutral-400"><span>{row.legacyPersonal?'待指定归属 · 暂不加载':row.projectName??row.taskName??'临时任务范围'} · v{row.revision}{row.locked?' · 已锁定':''}</span></header>
    {row.legacyPersonal&&<div className="space-y-2 rounded border border-amber-700 p-3 text-sm"><p>旧全局个人记忆已暂停加载，选择归属后确认启用。</p><select aria-label="旧个人记忆归属" className="rounded bg-neutral-900 p-2" value={assignProject} onChange={e=>setAssignProject(e.target.value)}><option value="">请选择归属</option><option value="temporary">临时任务范围</option>{options.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><button className={button} disabled={busy||!assignProject} onClick={()=>void run(()=>jsonFetch('/api/memories/'+row.id+'/assign-project',{method:'POST',body:JSON.stringify({revision:row.revision,projectId:assignProject==='temporary'?null:assignProject})}))}>确认归属并启用</button></div>}
    {editing?.id===row.id?<div className="space-y-2"><textarea aria-label="修改记忆内容" className="min-h-32 w-full rounded-lg border border-neutral-700 bg-neutral-900 p-3 text-sm" maxLength={20000} value={draft} onChange={e=>setDraft(e.target.value)}/><button className={button} disabled={busy||!draft.trim()} onClick={()=>void run(()=>jsonFetch('/api/memories/'+row.id,{method:'PUT',body:JSON.stringify({content:draft.trim(),revision:row.revision})}))}>保存修改</button><button className={button+' ml-2'} disabled={busy} onClick={()=>setEditing(null)}>取消</button></div>:<p className="whitespace-pre-wrap break-words text-sm leading-7">{row.content}</p>}
    <div className="flex gap-2"><button className={button} disabled={busy} onClick={()=>{setEditing(row);setDraft(row.content);setRemoving(null);}}>修改</button><button className={button} disabled={busy} onClick={()=>{setRemoving(row);setEditing(null);}}>删除</button></div>
    {removing?.id===row.id&&<div role="alertdialog" aria-label="确认删除记忆" className="space-y-3 rounded-lg border border-amber-700 p-3 text-sm"><p>将此记忆移入回收站，保留30天后需手动确认永久删除。旧模型上下文会失效，进行中的生成会停止；可见聊天记录保留。</p><button className={button} disabled={busy} onClick={()=>void run(()=>jsonFetch('/api/memories/'+row.id,{method:'DELETE',body:JSON.stringify({revision:row.revision})}))}>确认移入回收站</button><button className={button+' ml-2'} disabled={busy} onClick={()=>setRemoving(null)}>保留记忆</button></div>}
   </article>)}
   {cursor&&<button className={button} disabled={busy} onClick={()=>{setBusy(true);void jsonFetch<{memories:Entry[];nextCursor:string|null}>('/api/memory-management?'+new URLSearchParams({scope,after:cursor,project:scope==='user'?projectFilter:'all'})).then(result=>{setRows(previous=>[...previous,...result.memories]);setCursor(result.nextCursor);}).catch(e=>setError(String(e))).finally(()=>setBusy(false));}}>加载更多</button>}
  </>}
  {tab==='suggestions'&&<MemorySuggestions showEmpty onChanged={()=>setGeneration(n=>n+1)}/>}
  {tab==='analysis'&&<>
   <p className="text-sm leading-7 text-neutral-400">个人与项目记忆均在各自项目内跨任务累计，个人临时任务范围单独累计。每10轮完成的用户对话自动分析一次，只生成待确认建议；任务记忆仍逐轮整理。新计数从本功能升级后开始，自动化执行不计入对话轮次。</p>
   <MemoryAutoControl/>
   <h3 className="text-sm font-medium">周期进度</h3>
   {!analysis?.progress.some(row=>row.scope==='user')&&<p className="text-sm text-neutral-400">个人记忆：0 / 10 轮</p>}
   {analysis?.progress.map(row=><div key={row.scope+row.scopeId} className="rounded-xl border border-neutral-800 p-3 text-sm"><span>{row.scope==='user'?'个人 · '+(row.projectName??'临时任务范围'):row.projectName??'项目记忆'}</span><span className="float-right">{row.pending} / 10 轮{row.pending>=10?' · 等待分批':''}</span><p className="mt-2 text-xs text-neutral-500">累计计数 {row.total} 轮 · 约每10秒更新</p></div>)}
   <details><summary className="cursor-pointer text-sm">各层记忆开关</summary>{(['user','project','task'] as const).map(value=><div key={value} className="mt-4 space-y-2 rounded-xl border border-neutral-800 p-3"><h4>{labels[value]}</h4><DatabaseMemoryControls scope={value}/></div>)}</details>
   <h3 className="text-sm font-medium">最近50次周期分析</h3>{!analysis?.batches.length&&<p className="text-sm text-neutral-400">暂无分析记录，满10轮后自动开始。</p>}
   {analysis?.batches.map(batch=><article key={batch.id} className="space-y-2 rounded-xl border border-neutral-800 p-3 text-sm"><p>{batch.scope==='user'?'个人 · '+(batch.projectName??'临时任务范围'):batch.projectName??'项目记忆'} · {states[batch.status]??batch.status}</p><p className="text-xs text-neutral-500">{new Date(batch.createdAt).toLocaleString('zh-CN')} · {batch.suggestions} 条建议{batch.status==='completed'&&!batch.suggestions?' · 无需新增或修改记忆':''}</p>{batch.error&&<p role="status" className="text-xs text-amber-600">{batch.error}</p>}{batch.status==='failed'&&<button className={button} disabled={busy} onClick={()=>void run(()=>jsonFetch('/api/memory-analysis/'+batch.id+'/retry',{method:'POST'}))}>重试分析</button>}</article>)}
  </>}
  {create&&<MemoryEditor scope={scope} scopeId={scopeId==='temporary'?undefined:scopeId} onClose={()=>{setCreate(false);setGeneration(n=>n+1);}}/>}
 </div>;
}
