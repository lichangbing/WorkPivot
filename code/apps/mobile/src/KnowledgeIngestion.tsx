import { useState } from 'react';
import type { MobileClient, Task } from './client';
import { FileLabel } from './Attachments';
import { useResource } from './useResource';

interface FileVersion {
  id: string;
  documentId: string;
  name: string;
  revision: number;
  size: number;
  current?: boolean;
  knowledgeStatus?: 'none'|'pending'|'confirmed'|'rejected';
}
interface Candidate {
  id: string;
  ordinal: number;
  location: string;
  sourceOffset: number;
  content: string;
  suggested: boolean;
  reason: string | null;
}
interface CandidatePage {
  versionId: string;
  name: string;
  versionRevision: number;
  status: 'pending'|'confirmed'|'rejected';
  revision: number;
  selectedOrdinals: number[];
  nextOffset: number | null;
  candidates: Candidate[];
}

const labels={none:'未提交入库',pending:'待确认',confirmed:'已入库',rejected:'已拒绝'};

export function KnowledgeFiles({ client, task, onError }: { client: MobileClient; task: Task; onError:(error:unknown)=>void }) {
  const files=useResource<{files:FileVersion[]}>(client,`/api/tasks/${task.id}/files`,onError,4000);
  const [versions,setVersions]=useState<Record<string,FileVersion[]>>({});
  const [review,setReview]=useState<CandidatePage|null>(null);
  const [selected,setSelected]=useState<Set<number>>(new Set());
  const [removing,setRemoving]=useState<FileVersion|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const loadVersions=async(file:FileVersion)=>{
    try{
      const value=await client.json<{versions:FileVersion[]}>(`/api/tasks/${task.id}/files/${file.documentId}/versions`,{signal:files.signal()});
      setVersions(old=>({...old,[file.documentId]:value.versions}));
    }catch(reason){setError(reason instanceof Error?reason.message:'版本加载失败');onError(reason);}
  };
  const openReview=async(file:FileVersion)=>{
    setBusy(true);setError('');setNotice('');
    try{
      const page=await client.json<CandidatePage>(`/api/tasks/${task.id}/knowledge-ingestions/${file.id}?offset=0&limit=50`,{signal:files.signal()});
      setReview(page);
      setSelected(new Set(page.status==='pending'?page.candidates.filter(row=>row.suggested).map(row=>row.ordinal):page.selectedOrdinals));
    }catch(reason){setError(reason instanceof Error?reason.message:'知识候选加载失败');onError(reason);}
    finally{setBusy(false);}
  };
  const loadMore=async()=>{
    if(!review?.nextOffset||busy)return;
    setBusy(true);
    try{
      const page=await client.json<CandidatePage>(`/api/tasks/${task.id}/knowledge-ingestions/${review.versionId}?offset=${review.nextOffset}&limit=50`,{signal:files.signal()});
      setReview({...page,candidates:[...review.candidates,...page.candidates]});
      setSelected(current=>{const next=new Set(current);for(const row of page.candidates)if(page.status==='pending'&&row.suggested)next.add(row.ordinal);return next;});
    }catch(reason){setError(reason instanceof Error?reason.message:'候选加载失败');onError(reason);}
    finally{setBusy(false);}
  };
  const act=async(action:'confirm'|'reject'|'reopen')=>{
    if(!review||busy)return;
    setBusy(true);setError('');setNotice('');
    try{
      const body=action==='confirm'?{revision:review.revision,selected:[...selected].sort((a,b)=>a-b)}:{revision:review.revision};
      await client.json(`/api/tasks/${task.id}/knowledge-ingestions/${review.versionId}/${action}`,{method:'POST',body:JSON.stringify(body),signal:files.signal()});
      setNotice(action==='confirm'?'已确认入库':action==='reject'?'已拒绝入库':'已撤销旧索引，可重新审核');
      setReview(null);setSelected(new Set());await files.refresh();
    }catch(reason){setError(reason instanceof Error?reason.message:'知识入库操作失败');onError(reason);}
    finally{setBusy(false);}
  };
  const removeVersion=async()=>{
    if(!removing||busy)return;
    setBusy(true);setError('');
    try{
      await client.json(`/api/tasks/${task.id}/files/${removing.documentId}/versions/${removing.id}`,{method:'DELETE',body:JSON.stringify({confirmation:'删除此版本'}),signal:files.signal()});
      setRemoving(null);setVersions({});await files.refresh();
      setNotice('版本及其知识索引已删除');
    }catch(reason){setError(reason instanceof Error?reason.message:'版本删除失败');onError(reason);}
    finally{setBusy(false);}
  };
  if(!task.projectId)return <section className="capabilities"><h2>项目知识</h2><p className="muted">临时任务资料不能进入项目知识库。</p></section>;
  return <section className="capabilities" aria-label="项目知识入库">
    <h2>上传资料与知识入库</h2><p className="muted">解析完成不代表已入库。这里按版本选择内容，确认后才建立项目知识索引。</p>
    {!files.value&&!files.error&&<p>正在读取资料…</p>}
    {files.value?.files.length===0&&<p className="muted">暂无上传资料</p>}
    {files.value?.files.map(file=><article key={file.id}>
      <strong><FileLabel name={file.name}/></strong>
      <p>当前版本 {file.revision} · {labels[file.knowledgeStatus??'none']}</p>
      <button disabled={busy} onClick={()=>void openReview(file)}>{file.knowledgeStatus==='confirmed'?'重新审核':'知识入库'}</button>
      <button disabled={busy} onClick={()=>void loadVersions(file)}>查看版本</button>
      {versions[file.documentId]?.map(version=><div key={version.id} className="artifact-row"><span>版本 {version.revision}{version.current?' · 当前':''} · {labels[version.knowledgeStatus??'none']}</span><button disabled={busy} onClick={()=>void openReview(version)}>审核</button><button disabled={busy} onClick={()=>setRemoving(version)}>删除版本</button></div>)}
    </article>)}
    {removing&&<div role="alertdialog" aria-label="确认删除文件版本"><p>{removing.name} 的版本 {removing.revision} 将从原件和知识索引中删除，此操作不可撤销。</p><button disabled={busy} onClick={()=>void removeVersion()}>确认删除版本</button><button disabled={busy} onClick={()=>setRemoving(null)}>取消</button></div>}
    {review&&<section className="approval memory-card" aria-label="知识候选审核"><h3>{review.name} · 版本 {review.versionRevision} · {labels[review.status]}</h3><p>仅勾选内容会进入检索。未确认前不会产生知识分片。</p>
      {review.candidates.map(row=><label key={row.id} className="memory-card"><input type="checkbox" checked={selected.has(row.ordinal)} disabled={busy||review.status!=='pending'} onChange={()=>setSelected(current=>{const next=new Set(current);if(next.has(row.ordinal))next.delete(row.ordinal);else next.add(row.ordinal);return next;})}/> <strong>{row.location}</strong>{row.reason&&<small> {row.reason}</small>}<p>{row.content}</p></label>)}
      {review.nextOffset!==null&&<button disabled={busy} onClick={()=>void loadMore()}>加载更多候选</button>}
      <div><button disabled={busy||review.status!=='pending'||!selected.size} onClick={()=>void act('confirm')}>确认入库（{selected.size}）</button><button disabled={busy||review.status!=='pending'} onClick={()=>void act('reject')}>拒绝入库</button>{review.status!=='pending'&&<button disabled={busy} onClick={()=>void act('reopen')}>重新审核</button>}<button disabled={busy} onClick={()=>setReview(null)}>关闭</button></div>
    </section>}
    {notice&&<p role="status">{notice}</p>}
    {(error||files.error)&&<p role="alert" className="error">{error||files.error}</p>}
  </section>;
}
