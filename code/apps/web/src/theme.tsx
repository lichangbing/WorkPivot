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
try { current = localStorage.getItem(key) === 'dark' ? 'dark' : 'light'; } catch { /* Storage may be unavailable in private contexts. */ }
apply(current);
window.addEventListener('storage', (event) => {
  if (event.key === key || event.key === null) apply(event.newValue === 'dark' ? 'dark' : 'light');
});
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener); };

export function ThemeSwitch(): React.JSX.Element {
  const theme = useSyncExternalStore(subscribe, () => current);
  return <div className="theme-switch" role="group" aria-label="界面风格">
    {(['light', 'dark'] as const).map((value) => <button key={value} type="button" aria-pressed={theme === value} onClick={() => {
      apply(value);
      try { localStorage.setItem(key, value); } catch { /* The selection still applies for this session. */ }
    }}><Icon name={value === 'light' ? 'sun' : 'moon'} />{value === 'light' ? '浅色' : '深色'}</button>)}
  </div>;
}
