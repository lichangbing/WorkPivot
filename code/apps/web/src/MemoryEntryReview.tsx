export function MemoryEntryReview({entries,onChange,busy,replacing,onSave,onCancel}:{entries:string[];onChange:(rows:string[])=>void;busy:boolean;replacing:boolean;onSave:()=>void;onCancel:()=>void}) {
  const button='rounded border border-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40';
  return <section aria-label="逐条确认记忆" className="space-y-3 rounded-lg border border-neutral-700 p-3">
    <h3>{replacing?'拆分已有记忆':'从模板新增记忆'} · {entries.length} 条</h3>
    <p className="text-xs text-neutral-400">每条只保留一个可以独立调整的事实，可修改、移除或补充。{replacing?'确认后替换原条目，保留来源与锁定状态；原条目正文和历史将清除，旧上下文失效。':'确认后才保存，不影响其他记忆。'}</p>
    {entries.map((entry,index)=><div key={index} className="flex items-start gap-2"><label className="flex-1 text-xs">条目 {index+1}<textarea aria-label={'记忆条目 '+(index+1)} disabled={busy} rows={3} maxLength={20000} className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-sm" value={entry} onChange={e=>onChange(entries.map((v,i)=>i===index?e.target.value:v))}/></label><button className={button} disabled={busy} onClick={()=>onChange(entries.filter((_,i)=>i!==index))}>移除</button></div>)}
    <div className="flex flex-wrap gap-2"><button className={button} disabled={busy||entries.length>=100} onClick={()=>onChange([...entries,''])}>新增一条</button><button className={button} disabled={busy||!entries.length||entries.length>100||entries.some(v=>!v.trim())} onClick={onSave}>确认保存 {entries.length} 条</button><button className={button} disabled={busy} onClick={onCancel}>取消</button></div>
  </section>;
}
