import { useEffect,useState } from 'react';
import { jsonFetch } from './api';
export function DatabaseExecutionMode() {
  const [setting,setSetting]=useState<{value:string;revision:number}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{const c=new AbortController();void jsonFetch<{setting:{value:string;revision:number}|null}>('/api/preferences/execution.mode',{signal:c.signal}).then(r=>{if(!c.signal.aborted)setSetting(r.setting??{value:'manual',revision:0});}).catch(()=>{if(!c.signal.aborted)setError('无法读取执行模式');});return()=>c.abort();},[]);
  const change=async(value:string)=>{if(!setting)return;setBusy(true);setError('');try{const r=await jsonFetch<{revision:number}>('/api/preferences/execution.mode',{method:'PUT',body:JSON.stringify({value,revision:setting.revision})});setSetting({value,revision:r.revision});}catch{setError('保存失败，请刷新后重试');}finally{setBusy(false);}};
  return <label className="composer-mode self-center" title="自动模式仅自动允许后续的隔离Skill执行；外部MCP仍需确认，已有确认请求不会自动放行。"><select aria-label="执行模式" disabled={!setting||busy} value={setting?.value??'manual'} className="h-9 rounded-lg border border-neutral-700 bg-transparent px-2 text-neutral-300" onChange={e=>{void change(e.target.value);}}><option value="manual">确认模式</option><option value="auto">自动模式</option></select>{error&&<span role="alert" className="ml-2 text-red-400">{error}</span>}</label>;
}
