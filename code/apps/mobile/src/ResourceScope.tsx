import { useEffect, useRef, useState } from 'react';
import type { MobileClient } from './client';
import { isTransientConnectionError } from './connection';
export interface ResourceSelection {
  scheduleIds?: string[]; versionIds: string[]; memoryScopes: ('user' | 'project' | 'task')[];
  expert: boolean; baseRunId?: string | null; epoch?: string; version?: 1;
}
interface Snapshot { scope: ResourceSelection; activeRun: {runId:string;turnId:string;scope:ResourceSelection & {epoch:string}} | null; files: { id: string; name: string; revision:number }[] }
export function ResourceScope({ client, taskId, refresh, disabled, onChange, onError }: {
  client: MobileClient; taskId: string; refresh: number; disabled: boolean;
  onChange: (value: ResourceSelection | null) => void; onError: (error: unknown) => void;
}) {
  const [data, setData] = useState<Snapshot>(), [scope, setScope] = useState<ResourceSelection>();
  const [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    const c = new AbortController(); onChange(null); setError('');
    void client.json<Snapshot>(`/api/tasks/${taskId}/resource-scope`, { signal: c.signal }).then(result => {
      if (c.signal.aborted) return;
      setData(result); setScope(result.scope); onChange(result.scope);
    }).catch(reason => {
      if (!c.signal.aborted) {
        onError(reason);
        if (!isTransientConnectionError(reason)) setError(reason instanceof Error ? reason.message : '资料范围读取失败');
      }
    });
    return () => c.abort();
  }, [client, taskId, refresh, retry, onChange]);
  const update = (value: ResourceSelection) => { setScope(value); onChange(value); };
  return <details className="resource-scope"><summary>本轮资料{scope ? ` · ${scope.memoryScopes.length} 层记忆 / ${scope.versionIds.length} 个文件` : ''}</summary>
    <p className="muted">本轮会自动加载所选层级中的相关已确认记忆；未选层级不会读取。后台自动整理由记忆设置控制，与本轮读取选择无关。本次添加的附件自动包含。</p>
    <button type="button" disabled={disabled} onClick={() => setRetry(value => value + 1)}>读取后台最新范围</button>
    {error ? <p className="error" role="alert">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>重新读取</button></p> : scope && <>
      {(['user', 'project', 'task'] as const).map(value => <label key={value}><input type="checkbox" disabled={disabled} checked={scope.memoryScopes.includes(value)} onChange={event => update({ ...scope, memoryScopes: event.target.checked ? [...scope.memoryScopes, value].sort() : scope.memoryScopes.filter(item => item !== value) })} />{({ user: '个人记忆', project: '项目记忆', task: '任务记忆' })[value]}</label>)}
      <label><input type="checkbox" disabled={disabled} checked={scope.expert} onChange={event => update({ ...scope, expert: event.target.checked })} />当前专家与经验</label>
      {data?.files.map(file => <label key={file.id}><input type="checkbox" disabled={disabled} checked={scope.versionIds.includes(file.id)} onChange={event => update({ ...scope, versionIds: event.target.checked ? [...scope.versionIds, file.id].sort() : scope.versionIds.filter(id => id !== file.id) })} />{file.name}</label>)}
    </>}
  </details>;
}

const labels={user:'个人记忆',project:'项目记忆',task:'任务记忆'} as const;

/** 移动端运行中增量调整：只添加文件或记忆层。 */
export function RuntimeResourceScope({client,taskId,attachmentIds,onScope,onApplied,onError}:{
  client:MobileClient;taskId:string;attachmentIds:string[];onScope:(value:ResourceSelection)=>void;onApplied:()=>void;onError:(error:unknown)=>void;
}) {
  const [open,setOpen]=useState(false),[data,setData]=useState<Snapshot>(),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [versions,setVersions]=useState<string[]>([]),[memory,setMemory]=useState<('user'|'project'|'task')[]>([]),[busy,setBusy]=useState(false);
  const pending=useRef<{fingerprint:string;id:string}|null>(null);
  const load=async()=>{
    setError('');
    try{
      const value=await client.json<Snapshot>(`/api/tasks/${taskId}/resource-scope`);setData(value);
      const current=value.activeRun?.scope;if(!current)throw new Error('当前没有可调整的运行');
      onScope(current);
      const available=new Set(value.files.map(file=>file.id));
      setVersions(attachmentIds.filter(id=>available.has(id)&&!current.versionIds.includes(id)));setMemory([]);
    }catch(reason){
      onError(reason);
      if(!isTransientConnectionError(reason)){setData(undefined);setError(reason instanceof Error?reason.message:'运行资料范围读取失败');}
    }
  };
  useEffect(()=>{void load();},[taskId,attachmentIds.join(',')]);
  const current=data?.activeRun?.scope;
  const fileOptions=(data?.files??[]).filter(file=>!current?.versionIds.includes(file.id));
  const memoryOptions=(['user','project','task'] as const).filter(scope=>!current?.memoryScopes.includes(scope));
  const apply=async()=>{
    if(!current||!data?.activeRun||busy)return;
    const payload={baseRunId:data.activeRun.runId,baseEpoch:current.epoch,addVersionIds:versions,addMemoryScopes:memory};
    if(!versions.length&&!memory.length){setError('请选择需要加入当前运行的新资料');return;}
    const fingerprint=JSON.stringify(payload);if(pending.current?.fingerprint!==fingerprint)pending.current={fingerprint,id:crypto.randomUUID()};
    setBusy(true);setError('');setNotice('');
    try{
      const response=await client.response(`/api/tasks/${taskId}/scope-changes`,{method:'POST',body:JSON.stringify({...payload,requestId:pending.current.id})});
      if(!response.ok)throw new Error((await response.json() as {error?:string}).error??'范围调整失败');
      const result=await response.json() as {scope:ResourceSelection&{epoch:string}};onScope(result.scope);
      pending.current=null;setNotice('已加入，将在下一个安全步骤应用。');setVersions([]);setMemory([]);onApplied();
    }catch(reason){
      onError(reason);
      if(!isTransientConnectionError(reason))setError(reason instanceof Error?reason.message:'范围调整失败');
    }
    finally{setBusy(false);}
  };
  return <details className="resource-scope runtime-scope" open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>运行中资料范围</summary>
    <p className="muted">运行中只允许增加文件或记忆层。范围变更会撤销旧计划和待处理审批。</p>
    {error?<p className="error" role="alert">{error}<button type="button" onClick={()=>void load()}>重新读取</button></p>:current&&<>
      <p className="muted">当前 {current.versionIds.length} 个文件 / {current.memoryScopes.length} 层记忆</p>
      {!!fileOptions.length&&<fieldset><legend>加入文件版本</legend>{fileOptions.map(file=><label key={file.id}><input type="checkbox" disabled={busy} checked={versions.includes(file.id)} onChange={event=>setVersions(values=>event.target.checked?[...values,file.id].sort():values.filter(id=>id!==file.id))}/>{file.name} · v{file.revision}</label>)}</fieldset>}
      {!!memoryOptions.length&&<fieldset><legend>加入记忆层</legend>{memoryOptions.map(scope=><label key={scope}><input type="checkbox" disabled={busy} checked={memory.includes(scope)} onChange={event=>setMemory(values=>event.target.checked?[...values,scope].sort():values.filter(item=>item!==scope))}/>{labels[scope]}</label>)}</fieldset>}
      <button type="button" disabled={busy} onClick={()=>void apply()}>确认加入当前运行</button>
      {notice&&<p role="status">{notice}</p>}
    </>}
  </details>;
}
