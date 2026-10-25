// Public entry point of the session layer. The UI imports only from here.
//
// Modules: wasm.ts (init) · identity.ts (client id, name/color) · storage.ts (IndexedDB) ·
// transport.ts (WebSocket) · crossTab.ts (BroadcastChannel) · collab.ts (CodeMirror binding +
// remote cursors) · session.ts (glue).

import type { OpenSession } from './types';
import { Session } from './session';

export * from './types';
export { remoteEdit } from './collab';
export { randomUser, PALETTE } from './identity';

/**
 * Open a collaborative session for `docId`. Resolves once WASM is loaded and the local
 * IndexedDB copy is merged in (so `getText()` is ready for first paint); the WebSocket connects
 * in the background.
 */
export const openSession: OpenSession = (docId, opts) => Session.open(docId, opts);
