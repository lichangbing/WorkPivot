import {useEffect,useState} from 'react';
import {jsonFetch} from './api';
export interface ResourceSelection {scheduleIds?:string[];versionIds:string[];memoryScopes:('user'|'project'|'task')[];expert:boolean;baseRunId?:string|null}
interface ResourceFile {id:string;name:string;revision:number;sourceTaskId?:string}
export function DatabaseResourceScope({taskId,disabled,refresh,onChange}:{taskId:string;disabled:boolean;refresh:number;onChange:(value:ResourceSelection|null)=>void}){
  const [value,setValue]=useState<ResourceSelection|null>(null),[files,setFiles]=useState<ResourceFile[]>([]),[error,setError]=useState(''),[schedules,setSchedules]=useState<{id:string;name:string}[]>([]);
  useEffect(()=>{
    const controller=new AbortController();setValue(null);setError('');onChange(null);
    void jsonFetch<{scope:ResourceSelection;files:ResourceFile[];schedules:{id:string;name:string}[]}>(`/api/tasks/${taskId}/resource-scope`,{signal:controller.signal}).then(result=>{
      if(controller.signal.aborted)return;
      setSchedules(result.schedules??[]);const scope={scheduleIds:result.scope.scheduleIds??[],versionIds:result.scope.versionIds,memoryScopes:result.scope.memoryScopes,expert:result.scope.expert,baseRunId:result.scope.baseRunId};setValue(scope);setFiles(result.files);onChange(scope);
    }).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'读取范围失败，请刷新页面');});
    return()=>controller.abort();
  },[taskId,refresh,onChange]);
  const change=(next:ResourceSelection)=>{setValue(next);onChange(next);};
  return <details className="my-2 rounded border border-neutral-700 p-2 text-sm"><summary>读取范围：{value?`${value.versionIds.length} 个文件版本 · ${value.memoryScopes.length} 层记忆`:'加载中'}</summary>
    <p className="my-2 text-neutral-400">沿用上轮已确认范围，本次新增附件会加入。同项目文件需明确选中；候选区最多显示最近100个文件及已选版本。修改在下次发送时生效；范围变化后重新建立模型上下文，页面历史仍保留。正在运行时请先停止再修改。</p>
    {error&&<p role="alert">{error}</p>}
    {value&&<fieldset disabled={disabled}>
      <button type="button" className="mb-2 rounded border border-neutral-600 px-2 py-1" onClick={()=>change({...value,versionIds:[],scheduleIds:[],memoryScopes:[],expert:false})}>撤销全部读取范围（下次发送生效）</button>
      <div className="max-h-48 overflow-auto">{files.map(file=><label key={file.id} className="block"><input type="checkbox" checked={value.versionIds.includes(file.id)} onChange={e=>change({...value,versionIds:e.target.checked?[...value.versionIds,file.id]:value.versionIds.filter(id=>id!==file.id)})}/> {file.name}{file.sourceTaskId&&file.sourceTaskId!==taskId?'（项目内其他任务）':''} · 版本{file.revision}</label>)}{!files.length&&<p>当前任务和项目没有可选择的文件。</p>}</div>
      <div className="my-2">自动化读取范围：{schedules.map(plan=><label key={plan.id} className="block"><input type="checkbox" checked={(value.scheduleIds??[]).includes(plan.id)} onChange={e=>change({...value,scheduleIds:e.target.checked?[...(value.scheduleIds??[]),plan.id]:(value.scheduleIds??[]).filter(id=>id!==plan.id)})}/> {plan.name}</label>)}</div>
      <div className="my-2">{(['user','project','task'] as const).map(scope=><label key={scope} className="mr-3"><input type="checkbox" checked={value.memoryScopes.includes(scope)} onChange={e=>change({...value,memoryScopes:e.target.checked?[...value.memoryScopes,scope]:value.memoryScopes.filter(v=>v!==scope)})}/> {{user:'个人记忆',project:'项目记忆',task:'任务记忆'}[scope]}</label>)}</div>
      <label><input type="checkbox" checked={value.expert} onChange={e=>change({...value,expert:e.target.checked})}/> 允许加载当前专家设定及已确认经验</label>
    </fieldset>}
  </details>;
}
