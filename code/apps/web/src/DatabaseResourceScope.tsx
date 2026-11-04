import {useEffect,useRef,useState} from 'react';
import {jsonFetch} from './api';
export interface ResourceSelection {scheduleIds?:string[];versionIds:string[];memoryScopes:('user'|'project'|'task')[];expert:boolean;baseRunId?:string|null;version?:1;epoch?:string}
interface RuntimeSnapshot {
  scope: ResourceSelection;
  activeRun: {runId:string;turnId:string;scope:ResourceSelection & {epoch:string}} | null;
  files: {id:string;name:string;revision:number}[];
}

/** 自动沿用服务端返回的资料范围，不在输入区提供逐轮配置面板。 */
export function AutomaticResourceScope({taskId,refresh,onChange}:{taskId:string;refresh:number;onChange:(value:ResourceSelection|null)=>void}){
  const [error,setError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();setError('');onChange(null);
    void jsonFetch<{scope:ResourceSelection}>(`/api/tasks/${taskId}/resource-scope`,{signal:controller.signal}).then(result=>{
      if(controller.signal.aborted)return;
      const scope=result.scope;
      onChange({scheduleIds:scope.scheduleIds??[],versionIds:scope.versionIds,memoryScopes:scope.memoryScopes,expert:scope.expert,baseRunId:scope.baseRunId});
    }).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'资料关联暂不可用');});
    return()=>controller.abort();
  },[taskId,refresh,retry,onChange]);
  // 失败时保留发送门禁并提供重试，不能静默退化为读取全部资料。
  return error?<div role="alert" className="my-2 text-sm text-red-400">资料关联加载失败：{error}<button type="button" className="ml-2 underline" onClick={()=>setRetry(value=>value+1)}>重试关联资料</button></div>:null;
}

const memoryLabels={user:'个人记忆',project:'项目记忆',task:'任务记忆'} as const;

/** 运行中只允许增加文件版本和记忆层；减少范围或变更专家仍要求新运行。 */
export function RunningResourceScope({taskId,attachmentIds,onScope,onApplied,onError}:{
  taskId:string;attachmentIds:string[];onScope:(value:ResourceSelection)=>void;onApplied:()=>void;onError:(error:unknown)=>void;
}) {
  const [open,setOpen]=useState(false),[data,setData]=useState<RuntimeSnapshot|null>(null),[error,setError]=useState('');
  const [addVersions,setAddVersions]=useState<string[]>([]),[addMemory,setAddMemory]=useState<('user'|'project'|'task')[]>([]);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const pending=useRef<{fingerprint:string;id:string}|null>(null);
  const load=async()=>{
    setError('');
    try{
      const value=await jsonFetch<RuntimeSnapshot>(`/api/tasks/${taskId}/resource-scope`);
      setData(value);
      const current=value.activeRun?.scope;
      if(!current)throw new Error('当前没有可调整的运行');
      onScope(current);
      const available=new Set(value.files.map(file=>file.id));
      const initial=attachmentIds.filter(id=>available.has(id)&&!current.versionIds.includes(id));
      setAddVersions(initial);setAddMemory([]);
    }catch(reason){setData(null);setError(reason instanceof Error?reason.message:'运行资料范围读取失败');onError(reason);}
  };
  useEffect(()=>{void load();},[taskId,attachmentIds.join(',')]);
  const current=data?.activeRun?.scope;
  const availableFiles=(data?.files??[]).filter(file=>!current?.versionIds.includes(file.id));
  const availableMemory=(['user','project','task'] as const).filter(scope=>!current?.memoryScopes.includes(scope));
  const submit=async()=>{
    if(!current||busy)return;
    const payload={baseRunId:data!.activeRun!.runId,baseEpoch:current.epoch,addVersionIds:addVersions,addMemoryScopes:addMemory};
    if(!payload.addVersionIds.length&&!payload.addMemoryScopes.length){setError('请选择需要加入当前运行的新资料');return;}
    const fingerprint=JSON.stringify(payload);
    if(pending.current?.fingerprint!==fingerprint)pending.current={fingerprint,id:crypto.randomUUID()};
    setBusy(true);setError('');setNotice('');
    try{
      const result=await jsonFetch<{change:{addedVersionIds:string[];addedMemoryScopes:string[]};scope:ResourceSelection&{epoch:string}}>(`/api/tasks/${taskId}/scope-changes`,{method:'POST',body:JSON.stringify({...payload,requestId:pending.current.id})});
      pending.current=null;
      setNotice(`已加入${result.change.addedVersionIds.length?` ${result.change.addedVersionIds.length} 个文件版本`:''}${result.change.addedMemoryScopes.length?` ${result.change.addedMemoryScopes.length} 层记忆`:''}，将在下一个安全步骤应用。`);
      setData(old=>old?.activeRun?{...old,activeRun:{...old.activeRun,scope:result.scope}}:old);
      onScope(result.scope);
      setAddVersions([]);setAddMemory([]);
      onApplied();
    }catch(reason){setError(reason instanceof Error?reason.message:'运行资料范围调整失败');onError(reason);}
    finally{setBusy(false);}
  };
  return <div className="rounded-xl border border-blue-900/60 bg-blue-950/20 p-2 text-xs">
    <button type="button" className="flex w-full items-center justify-between gap-2 text-left text-blue-200" aria-expanded={open} onClick={()=>{setOpen(value=>!value);setNotice('');}}>
      <span>运行中资料范围</span><span className="text-neutral-400">{open?'收起':'可添加新文件或记忆层'}</span>
    </button>
    {open&&<div className="mt-3 space-y-3">
      <div className="flex flex-wrap gap-2"><span className="rounded bg-neutral-800 px-2 py-0.5 text-neutral-300">当前 {current?.versionIds.length??0} 个文件 / {current?.memoryScopes.length??0} 层记忆</span><button type="button" className="underline text-neutral-400" disabled={busy} onClick={()=>void load()}>刷新候选资料</button></div>
      {error&&<p role="alert" className="text-red-400">{error}</p>}
      {notice&&<p role="status" className="text-emerald-400">{notice}</p>}
      {current&&<>
        {!!availableFiles.length&&<fieldset><legend className="mb-1 text-neutral-300">加入文件版本</legend><div className="max-h-40 space-y-1 overflow-y-auto">{availableFiles.map(file=><label key={file.id} className="flex items-center gap-2"><input type="checkbox" disabled={busy} checked={addVersions.includes(file.id)} onChange={event=>setAddVersions(values=>event.target.checked?[...values,file.id].sort():values.filter(id=>id!==file.id))}/><span className="min-w-0 truncate">{file.name}<small className="ml-2 text-neutral-500">v{file.revision}</small></span></label>)}</div></fieldset>}
        {!!availableMemory.length&&<fieldset><legend className="mb-1 text-neutral-300">加入记忆层</legend><div className="flex flex-wrap gap-3">{availableMemory.map(scope=><label key={scope} className="flex items-center gap-1"><input type="checkbox" disabled={busy} checked={addMemory.includes(scope)} onChange={event=>setAddMemory(values=>event.target.checked?[...values,scope].sort():values.filter(item=>item!==scope))}/>{memoryLabels[scope]}</label>)}</div></fieldset>}
        <div className="flex items-center justify-between gap-2"><span className="text-neutral-500">范围只增不减；变更会撤销旧计划与待处理审批。</span><button type="button" className="rounded-lg bg-blue-600 px-3 py-1.5 text-white disabled:opacity-40" disabled={busy} onClick={()=>void submit()}>确认加入当前运行</button></div>
      </>}
    </div>}
  </div>;
}
