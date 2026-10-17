import { useEffect, useRef, useState } from 'react';
import { jsonFetch, getToken } from './api';

interface SkillFile { path:string; content:string|null; previous:string|null; size:number; change:string }
interface Build { id:string; name:string; displayName:string; taskId:string; revision:string; draftRevision:string; hash:string; status:string; sourceInvalid:boolean; purpose:string; permissions:string; dismissed:boolean; deleted:boolean; disabled:boolean; workerAvailable:boolean; requiresTrial:boolean; published:string|null; files:SkillFile[]; removed:string[]; validation:{valid:boolean;errors:string[];warnings:string[]}|null; trial:{passed:boolean;command:string;output:string;error:string|null;previews:{path:string;size:number;content:string|null}[]}|null; versions:{id:string;label:string}[] }
const button='rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-40';
const field='w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-sm';
const labels:Record<string,string>={draft:'草稿',ready:'待确认',activated:'已确认启用',cancelled:'已取消',stale:'需要重新整理'};

/** 对话只产生草稿；发布加载必须由用户在此窗口明确操作。 */
export function DatabaseSkillBuilds({taskId,autoOpen=false}:{taskId?:string;autoOpen?:boolean}) {
  const [rows,setRows]=useState<Build[]>([]),[current,setCurrent]=useState<Build|null>(null),[error,setError]=useState('');
  const seen=useRef(new Set<string>()),opened=useRef(false);
  const load=async(signal?:AbortSignal)=>{
    const result=await jsonFetch<{builds:Build[]}>(`/api/skill-builds${taskId?'?taskId='+encodeURIComponent(taskId):''}`,{signal});
    if(signal?.aborted)return;setRows(result.builds);setError('');
    const pending=result.builds.find(b=>b.status==='ready'&&!b.deleted&&!b.dismissed&&!seen.current.has(b.id+':'+b.revision));
    if(autoOpen&&pending&&!opened.current){opened.current=true;seen.current.add(pending.id+':'+pending.revision);const detail=await jsonFetch<Build>(`/api/skill-builds/${pending.id}`,{signal});if(!signal?.aborted)setCurrent(detail);}
  };
  useEffect(()=>{const c=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{try{await load(c.signal);}catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:'技能草稿读取失败');}finally{if(!c.signal.aborted)timer=setTimeout(()=>void tick(),3000);}};
    void tick();return()=>{c.abort();clearTimeout(timer);};
  },[taskId,autoOpen]);
  const open=async(row:Build)=>{try{const b=await jsonFetch<Build>(`/api/skill-builds/${row.id}`);opened.current=true;setCurrent(b);}catch(e){setError(e instanceof Error?e.message:'读取失败');}};
  const close=()=>{opened.current=false;setCurrent(null);void load().catch(()=>undefined);};
  const latest=rows.filter((b,i)=>rows.findIndex(v=>v.name===b.name)===i);
  return <section aria-label="我的技能" className="space-y-2">
    {!taskId&&<p className="text-sm text-neutral-400">在对话中描述需求，或让助手将已验证的方法保存为技能。默认仅自己可见，确认后下一轮生效。</p>}
    {error&&<p role="alert" className="text-sm text-red-400">{error}</p>}
    {!latest.length&&!taskId&&<p className="text-sm text-neutral-500">暂无私人技能草稿</p>}
    {latest.map(b=><div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-neutral-800 p-2 text-sm"><span>{b.displayName} · {b.deleted?'已删除':b.disabled&&b.published?'已停用':labels[b.status]??b.status}</span><button className={button} onClick={()=>void open(b)}>查看技能{b.status==='ready'?'并确认':''}</button></div>)}
    {current&&<SkillReview key={current.id+':'+current.revision} initial={current} onClose={close} onUpdated={b=>{seen.current.add(b.id+':'+b.revision);setCurrent(b);void load().catch(()=>undefined);}}/>}
  </section>;
}

function SkillReview({initial,onClose,onUpdated}:{initial:Build;onClose:()=>void;onUpdated:(b:Build)=>void}) {
  const dialog=useRef<HTMLDialogElement>(null),[build,setBuild]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [selected,setSelected]=useState(initial.files[0]?.path??'SKILL.md'),[editing,setEditing]=useState(false);
  const [draft,setDraft]=useState(initial.files.map(f=>({path:f.path,content:f.content??''}))),[newPath,setNewPath]=useState('');
  let test:{command?:string;outputs?:string[]}={};try{test=JSON.parse(initial.files.find(f=>f.path==='skill-test.json')?.content??'{}') as typeof test;}catch{/* 非法清单由用户修正，不能伪造测试命令。 */}
  const [command,setCommand]=useState(test.command??''),[outputs,setOutputs]=useState(test.outputs?.join(',')??''),[inputs,setInputs]=useState<string[]>([]);
  const [deleteConfirm,setDeleteConfirm]=useState(false);
  const [inputFiles,setInputFiles]=useState<{id:string;name:string;revision:number}[]>([]),[fileError,setFileError]=useState('');
  useEffect(()=>{const c=new AbortController();void jsonFetch<{files:typeof inputFiles}>(`/api/tasks/${initial.taskId}/files`,{signal:c.signal}).then(result=>{if(!c.signal.aborted)setInputFiles(result.files);}).catch(()=>{if(!c.signal.aborted)setFileError('测试资料列表暂不可用；仍可使用合成样本。');});return()=>c.abort();},[initial.taskId]);
  useEffect(()=>{const node=dialog.current;node?.showModal();return()=>node?.close();},[]);
  const endpoint=`/api/skill-builds/${build.id}`;
  const refresh=async()=>{const b=await jsonFetch<Build>(endpoint);setBuild(b);onUpdated(b);};
  const run=async(action:()=>Promise<unknown>,reload=true)=>{if(busy)return;setBusy(true);setError('');setNotice('');try{await action();if(reload)await refresh();}catch(e){setError(e instanceof Error?e.message:'操作失败；请刷新后重试');}finally{setBusy(false);}};
  const post=(path:string,body:object,timeout=20000)=>jsonFetch(endpoint+path,{method:'POST',body:JSON.stringify(body)},timeout);
  const dismiss=()=>void run(async()=>{await post('/decision',{revision:build.revision,decision:'dismiss'});onClose();},false);
  const source=build.files.find(f=>f.path===selected),editFile=draft.find(f=>f.path===selected);
  return <dialog ref={dialog} aria-label="确认私人技能" onCancel={e=>{e.preventDefault();if(!busy)dismiss();}} className="m-auto w-[95vw] max-w-4xl rounded-xl border border-neutral-700 bg-neutral-950 p-5 text-neutral-100 backdrop:bg-black/50">
    <div className="max-h-[85vh] space-y-4 overflow-y-auto"><header className="flex justify-between gap-3"><h2>确认私人技能：{build.displayName}</h2><button className={button} disabled={busy} onClick={dismiss}>关闭</button></header>
      <p className="whitespace-pre-wrap text-sm">{build.purpose}</p><p className="text-sm text-neutral-400">仅创建者可用 · {build.permissions}。启用后下一轮生效，当前运行保持原版本。</p>
      <p className="text-xs text-neutral-500">内部名称：{build.name} · 状态：{labels[build.status]}{build.deleted?' · 已删除':''}</p>
      {error&&<p role="alert" className="text-red-400">{error}</p>}{notice&&<p role="status">{notice}</p>}
      <div className="flex flex-wrap gap-2">{(editing?draft:build.files).map(f=><button key={f.path} className={button+(selected===f.path?' bg-neutral-800':'')} onClick={()=>setSelected(f.path)}>{f.path}</button>)}</div>
      {editing?<><label className="block text-sm">编辑 {selected}<textarea aria-label="技能文件内容" className={field+' min-h-56 font-mono'} value={editFile?.content??''} onChange={e=>setDraft(v=>v.map(f=>f.path===selected?{...f,content:e.target.value}:f))}/></label><div className="flex gap-2"><input aria-label="新增技能文件路径" className={field} value={newPath} onChange={e=>setNewPath(e.target.value)} placeholder="tests/report.test.mjs"/><button className={button} disabled={!newPath||draft.some(f=>f.path===newPath)} onClick={()=>{setDraft(v=>[...v,{path:newPath,content:''}]);setSelected(newPath);setNewPath('');}}>新增文件</button><button className={button} disabled={selected==='SKILL.md'} onClick={()=>{setDraft(v=>v.filter(f=>f.path!==selected));setSelected('SKILL.md');}}>移除所选</button></div><button className={button} disabled={busy} onClick={()=>void run(()=>post('/revise',{revision:build.revision,files:draft,purpose:build.purpose}))}>保存修改草稿（需重新校验）</button></>:<><p className="text-xs">{source?.size} 字节 · {source?.change==='added'?'新增':source?.change==='modified'?'修改':'未变'}</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-900 p-3 text-xs">{source?.content??'此文件为二进制资源'}</pre>{source?.change==='modified'&&<details><summary>查看上一发布版本的内容</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">{source.previous}</pre></details>}</>}
      {!!build.removed.length&&<p className="text-sm">本次移除：{build.removed.join('、')}</p>}
      <section className="space-y-2 rounded border border-neutral-800 p-3"><h3>校验与测试</h3><p className="text-sm">结构校验：{build.validation?build.validation.valid?'通过':'失败':'尚未运行'}</p>{build.validation?.errors.map((e,i)=><p key={i} className="text-sm text-red-400">{e}</p>)}{build.validation?.warnings.map((e,i)=><p key={i} className="text-sm text-amber-300">{e}</p>)}
        <button className={button} disabled={busy||build.deleted||['activated','stale','cancelled'].includes(build.status)} onClick={()=>void run(()=>post('/validate',{revision:build.revision}))}>校验草稿</button>
        {build.requiresTrial&&<><p className="text-sm">脚本技能必须通过隔离测试。{build.workerAvailable?'已配置执行器':'未配置执行器，仅可保留草稿'}。测试命令应包含断言，错误须非零退出。</p><label className="block text-sm">测试命令<textarea className={field} value={command} onChange={e=>setCommand(e.target.value)} placeholder={`node /skills/${build.name}/tests/report.test.mjs`}/></label><fieldset className="space-y-2 text-sm"><legend>可选测试资料（不选择则只用合成样本）</legend>{fileError&&<p>{fileError}</p>}{inputFiles.map(f=><label key={f.id} className="flex gap-2"><input type="checkbox" checked={inputs.includes(f.id)} disabled={busy||(!inputs.includes(f.id)&&inputs.length>=10)} onChange={e=>setInputs(v=>e.target.checked?[...v,f.id]:v.filter(id=>id!==f.id))}/>{f.name} · 版本{f.revision}</label>)}{!inputFiles.length&&!fileError&&<p className="text-neutral-400">当前任务没有上传资料；测试脚本可自行创建合成样本。</p>}</fieldset><label className="block text-sm">预期产物文件名（可选，多个用逗号分隔）<input className={field} value={outputs} onChange={e=>setOutputs(e.target.value)}/></label><button className={button} disabled={busy||!command.trim()||!build.workerAvailable||!build.validation?.valid||build.status==='activated'||build.deleted||build.status==='stale'||build.status==='cancelled'} onClick={()=>void run(()=>post('/trial',{revision:build.revision,command,inputs,outputs:outputs.split(',').map(v=>v.trim()).filter(Boolean)},155000))}>确认执行本次隔离测试</button></>}
        {build.trial&&<div className="space-y-2 text-sm"><strong>试运行：{build.trial.passed?'通过（仅覆盖本次样例）':'失败'}</strong><pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words">{build.trial.command+'\n'+build.trial.output+'\n'+(build.trial.error??'')}</pre>{build.trial.previews.map(p=><details key={p.path}><summary>{p.path} · {p.size} 字节</summary><pre className="whitespace-pre-wrap break-words">{p.content??'二进制或大文件；测试脚本需验证内容。'}</pre></details>)}</div>}
      </section>
      <div className="flex flex-wrap gap-2"><button className={button} disabled={busy||build.sourceInvalid} onClick={()=>void run(async()=>{const response=await fetch(endpoint+'/export',{headers:{Authorization:'Bearer '+getToken()}});if(!response.ok)throw Error('技能导出失败，请刷新后重试');const url=URL.createObjectURL(await response.blob());const link=document.createElement('a');link.href=url;link.download=build.displayName+'.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},false)}>导出 ZIP</button><button className={button} disabled={busy||build.status!=='ready'||build.deleted} onClick={()=>void run(async()=>{await post('/decision',{revision:build.revision,hash:build.hash,decision:'activate'});setNotice('已保存并启用；下一轮对话可用。');})}>保存并启用</button><button className={button} disabled={busy} onClick={dismiss}>仅保存草稿 / 稍后处理</button><button className={button} disabled={busy||build.deleted||['stale','cancelled'].includes(build.status)} onClick={()=>setEditing(v=>!v)}>{editing?'返回预览':'继续修改'}</button><button className={button} disabled={busy||build.status==='activated'} onClick={()=>void run(async()=>{await post('/decision',{revision:build.revision,decision:'cancel'});onClose();},false)}>取消构建</button></div>
      {!!build.versions.length&&<section className="space-y-2"><h3>历史版本</h3><p className="text-xs text-neutral-400">回退或重新启用先建立草稿，重新校验、测试并确认。</p>{build.versions.map(v=><button key={v.id} className={button} disabled={busy||build.deleted||build.sourceInvalid} onClick={()=>void run(async()=>{const b=await post('/from-release',{revision:build.draftRevision,releaseId:v.id}) as Build;onUpdated(b);},false)}>从{v.label}建立草稿{v.id===build.published?'（当前版）':''}</button>)}</section>}
      {build.status==='stale'&&!build.deleted&&!build.sourceInvalid&&<button className={button} disabled={busy} onClick={()=>void run(async()=>{const b=await post('/from-release',{revision:build.draftRevision}) as Build;onUpdated(b);},false)}>从当前内容建立新草稿并重新确认</button>}
      <section className="space-y-2 border-t border-neutral-800 pt-3"><h3>停用与删除保护</h3><p className="text-xs text-neutral-400">删除进入回收站，阻止新执行及在途成果发布，历史版本保留；绑定专家需要处理。恢复后保持停用。</p>{build.deleted?<button className={button} disabled={busy} onClick={()=>void run(()=>post('/lifecycle',{revision:build.draftRevision,action:'restore'}))}>恢复为停用</button>:<><button className={button} disabled={busy} onClick={()=>void run(()=>post('/lifecycle',{revision:build.draftRevision,action:'disable'}))}>停用</button><button className={button+' ml-2'} disabled={busy} onClick={()=>setDeleteConfirm(true)}>删除技能…</button>{deleteConfirm&&<div role="alert" className="space-y-2 rounded border border-red-900 p-3"><p>确认将「{build.displayName}」移入回收站？使用它的专家将无法运行，正在执行的任务将不能发布成果。</p><button className={button} disabled={busy} onClick={()=>void run(()=>post('/lifecycle',{revision:build.draftRevision,action:'delete'}))}>确认移入回收站</button><button className={button+' ml-2'} onClick={()=>setDeleteConfirm(false)}>保留技能</button></div>}</>}</section>
    </div>
  </dialog>;
}
