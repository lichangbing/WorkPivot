import { useEffect,useState } from 'react';
import { jsonFetch } from './api';
export function DatabaseModelStatus() {
  const [model,setModel]=useState<{available:boolean;name?:string;modelId?:string}|null>(null);
  useEffect(()=>{const c=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{try{const value=await jsonFetch<{available:boolean;name?:string;modelId?:string}>('/api/model-status',{signal:c.signal});if(!c.signal.aborted)setModel(value);}catch{if(!c.signal.aborted)setModel(null);}finally{if(!c.signal.aborted)timer=setTimeout(()=>{void refresh();},5000);}};
    void refresh();return()=>{c.abort();clearTimeout(timer);};},[]);
  return <span className="composer-model min-w-0 truncate self-center text-neutral-400" title={model?.modelId}>{model ? model.available ? `模型：${model.name}` : '暂无可用模型，请联系管理员启用' : '正在读取模型状态…'}</span>;
}
