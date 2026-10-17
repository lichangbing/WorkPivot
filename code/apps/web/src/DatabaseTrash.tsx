import {useEffect,useRef,useState} from 'react';
import {jsonFetch} from './api';
import {Icon,type IconName} from './Icon';
import './automations.css';
import './trash.css';
type Entry={id:string;kind:string;entityId:string;name:string;revision:string;parentId:string|null;deletedAt:string;purgeAfter:string;canPurge:boolean;fileCount:number};
const names:Record<string,string>={project:'项目',task:'任务',document:'文件 / 成果',memory:'记忆',skill:'私人 Skill',expert:'专家',automation:'自动化'};
const icons:Record<string,IconName>={project:'folder',task:'file',document:'archive',memory:'memory',skill:'skill',expert:'bot',automation:'bolt'};
const date=(s:string)=>new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
export function DatabaseTrash({onBack}:{onBack:()=>void}){
 const [entries,setEntries]=useState<Entry[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [filter,setFilter]=useState('all'),[status,setStatus]=useState('all'),[search,setSearch]=useState(''),[busy,setBusy]=useState(false);
 const [selected,setSelected]=useState<{entry:Entry;action:'restore'|'purge'}|null>(null),[phrase,setPhrase]=useState('');
 const dialog=useRef<HTMLDialogElement>(null);
 const load=async(signal?:AbortSignal)=>{const r=await jsonFetch<{entries:Entry[]}>('/api/trash',{signal});if(!signal?.aborted)setEntries(r.entries);};
 useEffect(()=>{const c=new AbortController();void load(c.signal).catch(e=>{if(!c.signal.aborted)setError(e.message);}).finally(()=>{if(!c.signal.aborted)setLoading(false);});return()=>c.abort();},[]);
 useEffect(()=>{setPhrase('');if(selected)dialog.current?.showModal();else dialog.current?.close();},[selected]);
 const refresh=async()=>{setLoading(true);setError('');try{await load();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setLoading(false);}};
 const submit=async()=>{if(!selected||busy)return;setBusy(true);setError('');setNotice('');try{
  const r=await jsonFetch<{cleanupPending?:boolean}>('/api/trash/'+selected.entry.id+'/'+selected.action,{method:'POST',body:JSON.stringify({revision:selected.entry.revision,confirmation:phrase})});
  setNotice(selected.action==='restore'?`已恢复「${selected.entry.name}」。关联子条目需分别恢复。`:`已永久删除「${selected.entry.name}」。`);
  setSelected(null);await load();if(r.cleanupPending)setError('记录已删除，磁盘清理暂未完成；请在保留规则中重试磁盘清理。');
 }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 const parent=(e:Entry)=>entries.find(p=>p.entityId===e.parentId);
 const children=(e:Entry)=>entries.filter(p=>p.parentId===e.entityId).length;
 const expired=entries.filter(e=>e.canPurge).length;
 const visible=entries.filter(e=>(filter==='all'||e.kind===filter)&&(status==='all'||(status==='expired'?e.canPurge:!e.canPurge))&&e.name.toLowerCase().includes(search.trim().toLowerCase()));
 const reset=()=>{setSearch('');setFilter('all');setStatus('all');};
 return <div className="automation-ui trash-ui"><div className="shell">
  <aside className="sidebar"><div className="brand"><span className="mark">W</span>WorkPivot</div><div className="nav-label">工作空间</div><button className="nav" onClick={onBack}>项目与任务</button><button className="nav" onClick={()=>{location.hash='automations';}}>自动化</button><button className="nav active" aria-current="page"><Icon name="trash"/> 回收站</button></aside>
  <main className="main"><header className="topbar">工作空间 / 回收站</header><div className="content">
   <div className="page-title"><div><h1>回收站</h1><p className="sub">误删的内容，仍有机会找回来。</p></div><button className="btn" disabled={busy||loading} onClick={()=>{void refresh();}}>{loading?'正在加载…':'刷新列表'}</button></div>
   <div className="trash-summary" aria-label="回收站统计">{[['全部条目',entries.length],['保留中',entries.length-expired],['保留期已满',expired],['保留文件版本',entries.reduce((n,e)=>n+e.fileCount,0)]].map(([label,value])=><div key={label}><span>{label}</span><strong>{loading?'—':value}</strong></div>)}</div>
   <div className="trash-policy"><Icon name="shield" size={22}/><div><strong>保留30天，到期不自动删除</strong><p>到期后仍可恢复。永久删除需你手动确认，回收站中的文件仍占用存储空间。</p><details><summary>恢复顺序与保留规则</summary><p>先恢复项目，再恢复任务及文件；永久删除父条目前，需先处理子条目。资料恢复后重建知识索引，技能、专家与自动化需重新确认启用。旧版已彻底清除的内容无法找回。时间统一显示为北京时间。</p><button className="btn" disabled={busy} onClick={()=>{setBusy(true);setError('');setNotice('');void jsonFetch('/api/files/cleanup',{method:'POST',body:'{}'}).then(()=>setNotice('磁盘清理完成，回收站保留文件不受影响。')).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>重试磁盘清理</button></details></div></div>
   <div className="trash-tabs" aria-label="回收站类型">{[['all','全部'],...Object.entries(names)].map(([key,label])=><button key={key} aria-pressed={filter===key} className={filter===key?'selected':''} onClick={()=>setFilter(key!)}>{label}<span>{key==='all'?entries.length:entries.filter(e=>e.kind===key).length}</span></button>)}</div>
   <div className="toolbar"><input type="search" className="search" aria-label="搜索回收站" placeholder="搜索条目名称…" value={search} onChange={e=>setSearch(e.target.value)}/><select aria-label="保留状态" className="btn" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">全部保留状态</option><option value="retained">保留中</option><option value="expired">保留期已满</option></select><span className="hint" aria-live="polite">{loading?'正在读取':`显示 ${visible.length} 条`}</span></div>
   {notice&&<p className="trash-success" role="status"><Icon name="check"/>{notice}</p>}{error&&!selected&&<p className="notice" role="alert">{error}</p>}
   {loading?<div className="trash-empty" role="status">正在读取回收站…</div>:visible.length?<div className="cards">{visible.map(e=>{const p=parent(e),childCount=children(e),days=Math.max(1,Math.ceil((new Date(e.purgeAfter).getTime()-Date.now())/86400000));return <article className="card trash-card" key={e.id}>
    <div className="card-top"><span className={'trash-kind '+e.kind}><Icon name={icons[e.kind]??'file'} size={20}/>{names[e.kind]??e.kind}</span><span className={'trash-status '+(e.canPurge?'expired':'')}>{e.canPurge?'保留期已满':`保留期剩余 ${days} 天`}</span></div>
    <h3 title={e.name}>{e.name}</h3><dl><div><dt>删除时间</dt><dd>{date(e.deletedAt)}</dd></div><div><dt>可永久删除</dt><dd>{date(e.purgeAfter)}</dd></div></dl>
    <div className="trash-relations">{e.fileCount>0&&<span>保留 {e.fileCount} 个文件版本</span>}{childCount>0&&<span>关联 {childCount} 个待处理子条目</span>}{p&&<p><Icon name="lock"/>请先恢复「{p.name}」</p>}{e.canPurge&&!p&&<p>仍可恢复，或确认后永久删除。</p>}</div>
    <footer className="card-bottom"><button className="btn primary" disabled={busy||loading||!!p} title={p?'请先恢复所属项目或任务':undefined} onClick={()=>{setError('');setSelected({entry:e,action:'restore'});}}>恢复条目</button><button className="btn trash-danger" disabled={busy||loading||!e.canPurge||childCount>0} title={childCount?'请先处理关联子条目':!e.canPurge?'保留满30天后可永久删除':undefined} onClick={()=>{setError('');setSelected({entry:e,action:'purge'});}}>永久删除</button></footer>
   </article>;})}</div>:<div className="trash-empty"><Icon name={entries.length?'search':'trash'} size={40}/><h2>{error?'暂时无法显示回收站':entries.length?'没有符合条件的条目':'回收站是空的'}</h2><p>{error?'请刷新列表重试。':entries.length?'试试其他名称、类型或保留状态。':'删除的项目、任务、文件、记忆、私人 Skill、专家和自动化会显示在这里。'}</p>{entries.length>0&&<button className="btn" onClick={reset}>清除筛选条件</button>}</div>}
   {entries.length===1000&&<p className="hint">当前最多展示最近1000条，筛选仅作用于已加载条目。</p>}
  </div></main></div>
  <dialog ref={dialog} aria-labelledby="trash-confirm-title" onCancel={e=>{if(busy)e.preventDefault();else setSelected(null);}}><div className="trash-dialog-icon"><Icon name={selected?.action==='restore'?'archive':'warning'} size={28}/></div><h2 id="trash-confirm-title">{selected?.action==='restore'?'恢复这个条目？':'永久删除这个条目？'}</h2><p className="trash-confirm-name">{selected?.entry.name}</p>{selected?.action==='restore'?<p className="hint">恢复原资料。模型旧上下文和执行授权保持失效，关联子条目需分别恢复。</p>:<><p className="hint">将清除恢复数据及不再被引用的文件，此操作无法撤销。已有离线备份仍需单独保管。</p><label>请输入“永久删除”<input autoComplete="off" value={phrase} onChange={e=>setPhrase(e.target.value)}/></label></>}{error&&<p className="error" role="alert">{error}</p>}<div className="dialog-actions"><button className="btn" disabled={busy} onClick={()=>setSelected(null)}>取消</button><button className={'btn '+(selected?.action==='restore'?'primary':'trash-danger')} disabled={busy||(selected?.action==='purge'&&phrase!=='永久删除')} onClick={()=>{void submit();}}>{busy?'处理中…':selected?.action==='restore'?'确认恢复':'确认永久删除'}</button></div></dialog>
 </div>;
}
