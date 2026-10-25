// App entry. Owner: D (UI). Composes src/ui with a session from src/sync (or the ?mock session).

import './styles/tokens.css';
import './styles/app.css';
import './styles/editor.css';

import { openSession } from './sync/index';
import { App, type SessionOpener } from './ui/app';
import { initTheme } from './ui/theme';

initTheme();

const params = new URLSearchParams(location.search);
const useMock = params.has('mock');

const opener: SessionOpener = useMock
  ? async (docId) => {
      // The mock is a separate chunk so it costs nothing in normal use.
      const m = await import('./dev/mockSession');
      return m.openMockSession(docId, m.mockOptionsFromUrl(location.search));
    }
  : (docId) => openSession(docId);

const app = new App(document.querySelector<HTMLElement>('#app')!, opener);
app.route();

// Offline app shell. Only in production builds: in dev, Vite serves modules that shouldn't be cached.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('[weft] service worker failed', err));
  });
}
