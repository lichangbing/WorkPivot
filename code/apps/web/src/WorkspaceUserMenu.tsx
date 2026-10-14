import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useTheme } from './theme';
import type { SettingsSection } from './DatabaseSettings';

export function WorkspaceUserMenu({ username, onLogout, onSettings }: { username?: string; onLogout: () => void; onSettings: (section: SettingsSection) => void }) {
  const [open, setOpen] = useState<'user' | 'settings' | null>(null);
  const [themes, setThemes] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const userButton = useRef<HTMLButtonElement>(null), settingsButton = useRef<HTMLButtonElement>(null), themeButton = useRef<HTMLButtonElement>(null);
  const { theme, setTheme } = useTheme();
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setOpen(null); setThemes(false); } };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  const item = 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-neutral-200 hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500';
  const popup = 'absolute bottom-full z-40 mb-2 rounded-xl border border-neutral-700 bg-neutral-900 p-1.5 shadow-xl';
  return <div ref={root} className="relative flex items-center gap-2 p-3" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) { setOpen(null); setThemes(false); } }} onKeyDown={e => {
    if (e.key === 'Escape') { e.stopPropagation(); if (themes) { setThemes(false); themeButton.current?.focus(); } else { (open === 'user' ? userButton : settingsButton).current?.focus(); setOpen(null); } }
  }}>
    <button ref={userButton} type="button" aria-label="用户菜单" aria-expanded={open === 'user'} aria-controls="workspace-user-menu" className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1 py-1 text-left hover:bg-neutral-800" onClick={() => { setOpen(open === 'user' ? null : 'user'); setThemes(false); }}><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-base">{(username || 'U').slice(0, 1).toUpperCase()}</span><span className="truncate text-sm font-medium">{username || '用户'}</span></button>
    {open === 'user' && <div id="workspace-user-menu" aria-label="用户选项" className={`${popup} left-3 w-56`}>
      <div className="relative"><button ref={themeButton} type="button" className={item} aria-expanded={themes} aria-controls="workspace-theme-menu" onClick={() => setThemes(v => !v)} onKeyDown={e => { if (e.key === 'ArrowRight') { e.preventDefault(); setThemes(true); } }}><Icon name="sun" /><span className="flex-1">界面主题</span><Icon name="right" size={14} /></button>
        {themes && <div id="workspace-theme-menu" aria-label="界面主题" className="absolute left-full top-0 z-50 ml-1 w-32 rounded-xl border border-neutral-700 bg-neutral-900 p-1.5 shadow-xl" onKeyDown={e => { if (e.key === 'ArrowLeft') { e.preventDefault(); setThemes(false); themeButton.current?.focus(); } }}>{(['dark', 'light'] as const).map(value => <button key={value} type="button" aria-pressed={theme === value} className={item} onClick={() => { setTheme(value); setThemes(false); themeButton.current?.focus(); }}><Icon name={value === 'dark' ? 'moon' : 'sun'} /><span className="flex-1">{value === 'dark' ? '黑色' : '白色'}</span>{theme === value && <Icon name="check" size={14} />}</button>)}</div>}
      </div>
      <div className="my-1 border-t border-neutral-700" /><button type="button" className={item} onClick={() => { setOpen(null); onLogout(); }}><Icon name="arrow" /><span>退出登录</span></button>
    </div>}
    <button ref={settingsButton} type="button" aria-label="设置" title="设置" aria-expanded={open === 'settings'} aria-controls="workspace-settings-menu" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-neutral-300 hover:bg-neutral-800" onClick={() => { setOpen(open === 'settings' ? null : 'settings'); setThemes(false); }}><Icon name="settings" size={20} /></button>
    {open === 'settings' && <div id="workspace-settings-menu" aria-label="设置选项" className={`${popup} right-3 w-48`}>{([['mcp', 'MCP', 'skill'], ['skills', 'Skill', 'skill'], ['experts', '专家', 'skill']] as const).map(([section, label, icon]) => <button key={section} type="button" className={item} onClick={() => { setOpen(null); onSettings(section); }}><Icon name={icon} /><span>{label}</span></button>)}</div>}
  </div>;
}
