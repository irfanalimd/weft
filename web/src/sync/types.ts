// The contract between the UI (src/ui) and the session layer (src/sync).
// See docs/ARCHITECTURE.md §5. Frozen: add fields freely, change existing ones only via the change log.

import type { Extension } from '@codemirror/state';

export type ConnectionStatus = 'connecting' | 'live' | 'offline' | 'reconnecting' | 'error';

export interface SyncState {
  status: ConnectionStatus;
  /** Local edits the server hasn't confirmed yet. Shown as "Offline · N unsynced edits". */
  unsyncedEdits: number;
  /** ms epoch of the last moment we were fully synced, or null if never. */
  lastSyncedAt: number | null;
  /** Human-readable error when status === 'error'. */
  error?: string;
}

export interface User {
  name: string;
  /** CSS color, e.g. "#7c5cff". */
  color: string;
}

export interface Peer extends User {
  /** Stringified u64 client id. */
  clientId: string;
  isSelf: boolean;
  /** Resolved UTF-16 cursor head position in the current text, if known. */
  cursor: number | null;
  /** ms epoch of the last awareness message from this peer. */
  lastActive: number;
}

export interface DocSession {
  readonly docId: string;
  readonly clientId: string;

  /** CodeMirror extensions for the collaborative binding + remote cursors. Call once per editor. */
  editorExtensions(): Extension[];
  /** Document text at the time of the call. Use this to create the initial EditorState. */
  getText(): string;

  /** Subscribe to state changes. Callback fires immediately with the current value. Returns unsubscribe. */
  onSyncState(cb: (s: SyncState) => void): () => void;
  onPeers(cb: (peers: Peer[]) => void): () => void;

  getUser(): User;
  setUser(user: User): void;

  // History / time travel (step 0 = empty doc, historyLength() = now).
  historyLength(): number;
  textAtStep(step: number): string;
  /** Make the current document equal textAtStep(step) via new ops (does not rewrite history). */
  restoreStep(step: number): void;

  /** Force a reconnect attempt now (e.g. a "Retry" button). */
  reconnect(): void;
  destroy(): void;
}

export interface OpenSessionOptions {
  /** WebSocket base, e.g. "ws://localhost:5173". Defaults to the current origin. */
  serverUrl?: string;
}

export type OpenSession = (docId: string, opts?: OpenSessionOptions) => Promise<DocSession>;
