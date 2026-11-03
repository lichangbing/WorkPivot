import { useState } from 'react';
import { jsonFetch } from './api';
import { useVisiblePolling } from './use-visible-polling';
export function DatabaseModelStatus() {
  const [model,setModel]=useState<{available:boolean;name?:string;modelId?:string}|null>(null);
  useVisiblePolling(async signal=>{try{const value=await jsonFetch<{available:boolean;name?:string;modelId?:string}>('/api/model-status',{signal});if(!signal.aborted)setModel(value);}catch{if(!signal.aborted)setModel(null);}},5000);
  return <span className="composer-model min-w-0 truncate self-center text-neutral-400" title={model?.modelId}>{model ? model.available ? `模型：${model.name}` : '暂无可用模型，请联系管理员启用' : '正在读取模型状态…'}</span>;
}
