import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'monero-gui-theme';
const listeners = new Set<() => void>();
export function storedTheme(): Theme {
  try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}
/** Call before the first render so a light-theme user never sees a dark flash. */
export function applyTheme(theme: Theme = storedTheme()) { document.documentElement.dataset.theme = theme; }
export function setTheme(theme: Theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* presentation preference only */ }
  applyTheme(theme); listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  // Keep the popup, wallet tab and onboarding page in step.
  const storage = (event: StorageEvent) => { if (event.key === KEY) { applyTheme(); listener(); } };
  addEventListener('storage', storage);
  return () => { listeners.delete(listener); removeEventListener('storage', storage); };
}
export function useTheme(): [Theme, (theme: Theme) => void] { return [useSyncExternalStore(subscribe, storedTheme), setTheme]; }
