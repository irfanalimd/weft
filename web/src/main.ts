// App entry. Owner: D (UI). Boots the Shell (auth + routing + views) with a session opener from
// src/sync (or the ?mock session; ?mock also swaps the HTTP API for an in-browser fake).

import './styles/tokens.css';
import './styles/app.css';
import './styles/editor.css';
import './styles/wall.css';

import { openSession } from './sync/index';
import type { SessionOpener } from './ui/app';
import { Shell } from './ui/shell';
import { initTheme } from './ui/theme';

initTheme();

const params = new URLSearchParams(location.search);
const useMock = params.has('mock');

const opener: SessionOpener = useMock
  ? async (docId, kind) => {
      // The mock is a separate chunk so it costs nothing in normal use.
      const m = await import('./dev/mockSession');
      const opts = m.mockOptionsFromUrl(location.search);
      // Private notes are yours alone: no fake collaborators, no flaky network.
      return m.openMockSession(docId, kind === 'note' ? { peers: 0, empty: true, flaky: false } : opts);
    }
  : (docId, kind) => openSession(docId, { kind });

const shell = new Shell(document.querySelector<HTMLElement>('#app')!, opener);
void shell.boot();

// Offline app shell. Only in production builds: in dev, Vite serves modules that shouldn't be cached.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('[weft] service worker failed', err));
  });
}
