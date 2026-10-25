// Weft service worker: caches the app shell (HTML, JS, CSS, WASM, icons) so the app opens offline.
// Docs themselves live in IndexedDB (src/sync); this only makes sure the code is there to read them.
//
// This file is a template: the build (vite.config.ts) replaces the two placeholders below with the
// build's asset list and a version hash, so every deploy installs a fresh cache.

const VERSION = '__WEFT_VERSION__';
const PRECACHE = __WEFT_PRECACHE__;
const CACHE = `weft-shell-${VERSION}`;
const SHELL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('weft-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Network first with a short timeout, so a flaky connection never blocks opening the app. */
async function navigate(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    if (response.ok) cache.put(SHELL, response.clone());
    return response;
  } catch {
    return (await cache.match(SHELL)) || Response.error();
  }
}

/** Hashed assets never change: cache first, and remember anything new (e.g. lazy chunks). */
async function asset(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/') || url.pathname === '/healthz') return;
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
  } else if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(asset(request));
  }
});
