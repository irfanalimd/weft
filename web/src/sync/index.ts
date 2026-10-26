// Public entry point of the session layer. The UI imports only from here.
//
// Modules: wasm.ts (init) · identity.ts (client id, name/color) · storage.ts (IndexedDB) ·
// transport.ts (WebSocket) · crossTab.ts (BroadcastChannel) · collab.ts (CodeMirror binding +
// remote cursors) · session.ts (glue).

import type { OpenSession } from './types';
import { Session } from './session';
import { clearStates } from './storage';
import { initWasm } from './wasm';

export * from './types';
export { remoteEdit } from './collab';
export { randomUser, PALETTE } from './identity';

/**
 * Open a collaborative session for `docId`. Resolves once WASM is loaded and the local
 * IndexedDB copy is merged in (so `getText()` is ready for first paint); the WebSocket connects
 * in the background.
 */
export const openSession: OpenSession = (docId, opts) => Session.open(docId, opts);

/** Start loading the WASM engine early (e.g. on the Wall), so opening a note is instant. */
export function warmUp(): void {
  void initWasm().catch(() => undefined);
}

/** Forget every locally stored private note (IndexedDB + confirmed markers), e.g. on sign-out. */
export async function clearLocalNotes(): Promise<void> {
  await clearStates('note:');
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith('weft:confirmed:note:')) localStorage.removeItem(k);
    }
  } catch {
    /* storage blocked */
  }
}
