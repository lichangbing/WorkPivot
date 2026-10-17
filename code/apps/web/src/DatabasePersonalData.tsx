import {useState} from 'react';
import {getToken,jsonFetch} from './api';
type Preview={fingerprint:string;counts:{kind:string;label:string;count:number}[];active:number;kept:string[]};
const button='rounded border border-neutral-600 px-3 py-2 disabled:opacity-40';
export function DatabasePersonalData({onChanged}:{onChanged:()=>Promise<void>}){
 const [preview,setPreview]=useState<Preview|null>(null),[confirmation,setConfirmation]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const run=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}};
 const download=()=>run(async()=>{
  const response=await fetch('/api/personal-data/export',{headers:{authorization:'Bearer '+getToken()},signal:AbortSignal.timeout(120000)});
  if(!response.ok){const body=await response.json().catch(()=>null);throw Error(body?.error??'导出失败');}
  const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download='workpivot-personal.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);setNotice('归档已生成并开始下载，请确认浏览器下载完成。');
 });
 return <section className="space-y-4">
  <p>管理自己的项目、对话和文件、记忆、私人技能、私人专家及自动化任务。</p>
  <article className="space-y-3 rounded border border-neutral-700 p-4"><h3>导出个人资料</h3><p className="text-sm text-neutral-400">下载 ZIP，包含可读 JSON、文件原件和回收站资料。不含系统保存的密码、模型密钥和登录令牌。单次上限100MB，每类最多1万条；不支持直接导入此归档。</p><button className={button} disabled={busy} onClick={()=>void download()}>下载个人资料</button></article>
  <article className="space-y-3 rounded border border-neutral-700 p-4"><h3>清空个人业务数据</h3><p className="text-sm text-neutral-400">移入回收站，保留30天后仍需手动确认永久删除。账号、登录会话、模型/MCP配置、个人偏好及用量审计保留。恢复技能、专家和自动化后需重新确认启用。</p>
   <button className={button} disabled={busy} onClick={()=>void run(async()=>{setPreview(await jsonFetch<Preview>('/api/personal-data'));setConfirmation('');})}>预览清空范围</button>
   {preview&&<div className="space-y-3 rounded border border-amber-800 p-3" aria-label="清空确认"><dl className="grid grid-cols-2 gap-2">{preview.counts.map(c=><div key={c.kind}><dt className="text-neutral-400">{c.label}</dt><dd>{c.count}</dd></div>)}</dl><p className="text-sm">保留：{preview.kept.join('、')}。</p>{preview.active>0&&<p role="alert">尚有未结束的任务或技能试运行，请先停止或等待结束后重新预览。</p>}<label className="block">输入“清空个人数据”确认<input className="mt-2 block w-full rounded border border-neutral-600 bg-neutral-900 p-2" value={confirmation} onChange={e=>setConfirmation(e.target.value)} disabled={busy}/></label><div className="flex gap-2"><button className={button} disabled={busy||preview.active>0||confirmation!=='清空个人数据'||!preview.counts.some(c=>c.count)} onClick={()=>void run(async()=>{const result=await jsonFetch<{notice:string}>('/api/personal-data/clear',{method:'POST',body:JSON.stringify({fingerprint:preview.fingerprint,confirmation})},120000);setPreview(null);setConfirmation('');setNotice(result.notice);await onChanged();})}>确认移入回收站</button><button className={button} disabled={busy} onClick={()=>{setPreview(null);setConfirmation('');}}>取消</button></div></div>}
  </article>
  {busy&&<p role="status">正在处理，请稍候…</p>}{error&&<p role="alert" className="text-red-400">{error}</p>}{notice&&<p role="status">{notice}</p>}
 </section>;
}
