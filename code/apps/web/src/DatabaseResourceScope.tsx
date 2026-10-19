import {useEffect,useState} from 'react';
import {jsonFetch} from './api';
export interface ResourceSelection {scheduleIds?:string[];versionIds:string[];memoryScopes:('user'|'project'|'task')[];expert:boolean;baseRunId?:string|null}

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
