import { useSyncExternalStore } from 'react';

export type Appearance = 'light' | 'dark' | 'system';
const KEY = 'kurogane.appearance';
const listeners = new Set<() => void>();
const media = window.matchMedia('(prefers-color-scheme: dark)');
function read(): Appearance {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'dark' || value === 'system' ? value : 'light';
  } catch { return 'light'; }
}
let appearance = read();

function apply() {
  const theme = appearance === 'system' ? (media.matches ? 'dark' : 'light') : appearance;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.appearance = appearance;
  window.dispatchEvent(new CustomEvent('kurogane:appearance', { detail: { appearance, theme } }));
}
export function setAppearance(value: Appearance) {
  appearance = value;
  try { localStorage.setItem(KEY, value); } catch { /* still works for this session */ }
  apply();
  listeners.forEach((listener) => listener());
}
export function useAppearance() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => appearance);
}
media.addEventListener('change', apply);
window.addEventListener('storage', (event) => {
  if (event.key === KEY || event.key === null) {
    appearance = read(); apply(); listeners.forEach((listener) => listener());
  }
});
apply();
