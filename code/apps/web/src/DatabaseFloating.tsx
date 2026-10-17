import { useEffect, useRef, useState } from 'react';
import { DatabaseWorkspaceSidebar } from './DatabaseWorkspaceNavigation';
import { Icon } from './Icon';

export function DatabaseFloating({ active, tasks, onSelect, onSettings, user }: {
  active: string | null; tasks: { id: string; name: string; revision: number; projectId: string | null; status: string }[];
  onSelect: (id: string) => void; onSettings: () => void; user: string;
}) {
  const prefix = 'wp-floating-' + user;
  const [hidden, setHidden] = useState(() => localStorage.getItem(prefix + '-hidden') === 'true');
  const [pinned, setPinned] = useState(() => localStorage.getItem(prefix + '-pinned') === 'true');
  const [open, setOpen] = useState(pinned), root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!pinned && !root.current?.contains(event.target as Node) && !document.querySelector('dialog[open]')) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !pinned && !document.querySelector('dialog[open]')) setOpen(false); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [pinned]);
  const count = tasks.filter(task => ['running','waiting','queued'].includes(task.status)).length;
  if (hidden) return <button className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-800" aria-label="显示悬浮工具区" title="显示悬浮工具区" onClick={() => { setHidden(false); setOpen(true); localStorage.setItem(prefix + '-hidden', 'false'); }}><Icon name="pin" size={17} /></button>;
  return <div ref={root} className="relative shrink-0">
    <button aria-label="展开悬浮工具区" aria-expanded={open} aria-controls="floating-tools" className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800" onClick={() => setOpen(value => !value)}><Icon name="pin" size={16} /><span>动态与资料{count ? ` · ${count}` : ''}</span><Icon name={open ? 'up' : 'down'} size={12} /></button>
    {open && <section id="floating-tools" aria-label="悬浮工具区" className="absolute right-0 top-full z-30 mt-2 flex w-80 max-w-[80vw] flex-col overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-950 shadow-2xl" style={{ height: 'min(72vh,680px)' }}>
      <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-3 py-2"><span className="text-xs font-medium">动态与资料</span><div className="flex gap-1"><button className={`rounded p-1.5 hover:bg-neutral-800 ${pinned ? 'text-blue-400' : 'text-neutral-500'}`} aria-label={pinned ? '取消固定悬浮区' : '固定悬浮区'} aria-pressed={pinned} onClick={() => { setPinned(!pinned); localStorage.setItem(prefix + '-pinned', String(!pinned)); }}><Icon name="pin" size={15} /></button><button className="rounded p-1.5 text-neutral-500 hover:bg-neutral-800" aria-label="隐藏悬浮工具区" onClick={() => { setHidden(true); setOpen(false); localStorage.setItem(prefix + '-hidden', 'true'); }}><Icon name="close" size={15} /></button></div></div>
      <DatabaseWorkspaceSidebar floating active={active} tasks={[...tasks.filter(t => t.id === active), ...tasks.filter(t => t.id !== active)]} onSelect={onSelect} onSettings={onSettings} />
    </section>}
  </div>;
}
