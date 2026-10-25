// Light/dark theme: follows the OS until the user picks one; the choice is persisted.

import { readString, writeString } from './storage';

export type Theme = 'light' | 'dark';
const KEY = 'weft:theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<(t: Theme) => void>();

function stored(): Theme | null {
  const t = readString(KEY);
  return t === 'light' || t === 'dark' ? t : null;
}

export function currentTheme(): Theme {
  return stored() ?? (media.matches ? 'dark' : 'light');
}

function apply(): void {
  const explicit = stored();
  if (explicit) document.documentElement.dataset.theme = explicit;
  else delete document.documentElement.dataset.theme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  // A manual choice overrides the media-scoped theme-color hints in index.html; "system" restores them.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    m.dataset.original ??= m.content;
    m.content = explicit && bg ? bg : m.dataset.original;
  });
  const t = currentTheme();
  listeners.forEach((cb) => cb(t));
}

export function initTheme(): void {
  apply();
  media.addEventListener('change', () => {
    if (!stored()) apply();
  });
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  // Picking the OS's own theme returns to "follow the system".
  const system: Theme = media.matches ? 'dark' : 'light';
  if (next === system) {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  } else {
    writeString(KEY, next);
  }
  apply();
  return next;
}

export function onThemeChange(cb: (t: Theme) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
