import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { getToken } from './api';
interface MarketSkill { name: string; description: string; version?: string; source: string }
export function SkillMarket({ canLoad, onLoad, onClose }: { canLoad: boolean; onLoad: (name: string) => void; onClose: () => void }) {
  const [skills, setSkills] = useState<MarketSkill[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/skill-market', { headers: { authorization: 'Bearer ' + (getToken() ?? '') }, signal: controller.signal })
      .then(async response => { if (!response.ok) throw Error('无法读取技能市场，请关闭后重试'); return response.json() as Promise<{ skills: MarketSkill[] }>; })
      .then(result => setSkills(result.skills)).catch(e => { if (!controller.signal.aborted) setError(String(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  const shown = skills.filter(s => (s.name + ' ' + s.description).toLowerCase().includes(query.toLowerCase()));
  return <dialog ref={dialog} onCancel={onClose} className="m-auto w-[760px] max-w-[95vw] rounded-xl border border-neutral-700 bg-neutral-950 p-5 text-neutral-100 backdrop:bg-black/60" aria-label="技能市场">
    <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">技能市场</h2><button onClick={onClose} aria-label="关闭技能市场"><Icon name="close" /></button></div>
    <p className="mb-3 text-xs text-neutral-500">选择已发布的技能，将其加入输入框，发送任务时加载。草稿不会出现在这里。</p>
    <input autoFocus value={query} onChange={e => setQuery(e.target.value)} aria-label="搜索技能" placeholder="搜索技能名称或描述" className="mb-4 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm" />
    {!canLoad && <p className="mb-3 text-xs text-neutral-500">请先选择一个空闲任务，再加载技能。</p>}
    {loading ? <p className="text-sm text-neutral-500">正在加载…</p> : error ? <p role="alert" className="text-sm text-red-400">{error}</p> : <div className="max-h-[60vh] space-y-2 overflow-auto">
      {!shown.length && <p className="text-sm text-neutral-500">{query ? '没有匹配的技能' : '暂无已发布的可用技能'}</p>}
      {shown.map(s => <section key={s.name} className="rounded border border-neutral-800 p-3"><div className="flex items-center gap-3"><Icon name="skill" /><h3 className="min-w-0 flex-1 break-all text-sm font-medium">{s.name}</h3><button disabled={!canLoad} onClick={() => onLoad(s.name)} className="shrink-0 rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700 disabled:opacity-40">加载</button></div><p className="mt-2 whitespace-pre-wrap break-words text-xs text-neutral-400">{s.description}</p><p className="mt-2 text-[10px] text-neutral-500">{s.source === 'builtin' ? '内置技能' : '已发布技能'}</p></section>)}
    </div>}
  </dialog>;
}
