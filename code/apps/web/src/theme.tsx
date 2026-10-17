import { useSyncExternalStore } from 'react';
import { Icon } from './Icon';

type Theme = 'light' | 'dark';
const key = 'wp_theme';
const listeners = new Set<() => void>();
let current: Theme = 'light';
function apply(theme: Theme): void {
  current = theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  listeners.forEach((listener) => listener());
}
try { current = localStorage.getItem(key) === 'dark' ? 'dark' : 'light'; } catch { /* 隐私模式可能无法使用存储。 */ }
apply(current);
window.addEventListener('storage', (event) => {
  if (event.key === key || event.key === null) apply(event.newValue === 'dark' ? 'dark' : 'light');
});
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener); };

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => current);
  return { theme, setTheme: (value: Theme) => {
    apply(value);
    try { localStorage.setItem(key, value); } catch { /* 当前会话主题仍可使用。 */ }
  } };
}

export function ThemeSwitch({ single = false }: { single?: boolean } = {}): React.JSX.Element {
  const theme = useSyncExternalStore(subscribe, () => current);
  if (single) return <button type="button" className="flex w-full items-center gap-2 rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800" aria-label={`切换为${theme === 'light' ? '深色' : '浅色'}风格`} onClick={() => {
    const next = theme === 'light' ? 'dark' : 'light';
    apply(next);
    try { localStorage.setItem(key, next); } catch { /* 当前会话仍使用所选项。 */ }
  }}><Icon name={theme === 'light' ? 'sun' : 'moon'} /><span>风格：{theme === 'light' ? '浅色' : '深色'}</span></button>;
  return <div className="theme-switch" role="group" aria-label="界面风格">
    {(['light', 'dark'] as const).map((value) => <button key={value} type="button" aria-pressed={theme === value} onClick={() => {
      apply(value);
      try { localStorage.setItem(key, value); } catch { /* 当前会话仍使用所选项。 */ }
    }}><Icon name={value === 'light' ? 'sun' : 'moon'} />{value === 'light' ? '浅色' : '深色'}</button>)}
  </div>;
}
