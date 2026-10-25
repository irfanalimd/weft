import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/**
 * Emits /sw.js from src/pwa/sw.js with the build's file list baked in, so the service worker can
 * precache the whole app shell (JS, CSS, WASM, lazy chunks, icons) and changes on every deploy.
 */
function serviceWorker(): Plugin {
  const publicFiles = ['/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'];
  return {
    name: 'weft-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => !f.endsWith('.map') && f !== 'index.html')
        .map((f) => `/${f}`);
      const precache = ['/', '/index.html', ...publicFiles, ...files];
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);
      const source = readFileSync(new URL('./src/pwa/sw.js', import.meta.url), 'utf8')
        .replace('__WEFT_VERSION__', version)
        .replace('__WEFT_PRECACHE__', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [serviceWorker()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:7878', ws: true },
      '/api': 'http://localhost:7878',
    },
  },
  build: { target: 'es2022' },
});
