// The real DocSession: glues WeftClient (wasm) to the WebSocket, IndexedDB, other tabs and
// CodeMirror. See docs/ARCHITECTURE.md §5 and ./types.ts.

import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { DocSession, OpenSessionOptions, Peer, SessionKind, SyncState, User } from './types';
import { initWasm, WeftClient, type ChangeJs, type ClientOutputJs } from './wasm';
import { loadUser, newClientId, saveUser } from './identity';
import { DocStorage } from './storage';
import { Transport } from './transport';
import { CrossTab } from './crossTab';
import { diffText } from './diff';
import {
  collabExtension,
  remoteChangesSpec,
  safeColor,
  safeName,
  paletteColor,
  setRemoteCursors,
  type CollabHost,
  type LocalEdit,
  type RemoteCursor,
} from './collab';

const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;
const AWARENESS_THROTTLE_MS = 50;
const AWARENESS_HEARTBEAT_MS = 20_000;
const PEERS_THROTTLE_MS = 80;

interface CursorAnchors {
  anchor: string;
  head: string;
}
interface PeerInfo {
  name: string;
  color: string;
  cursor: CursorAnchors | null;
  lastActive: number;
}

type Listener<T> = (v: T) => void;

class Emitter<T> {
  private readonly ls = new Set<Listener<T>>();
  constructor(private value: T) {}
  get(): T {
    return this.value;
  }
  set(v: T, same: (a: T, b: T) => boolean): void {
    if (same(this.value, v)) return;
    this.value = v;
    for (const l of this.ls) l(v);
  }
  on(l: Listener<T>): () => void {
    this.ls.add(l);
    l(this.value);
    return () => this.ls.delete(l);
  }
}

function defaultServerUrl(): string {
  const { protocol, host } = location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}`;
}

export class Session implements DocSession {
  readonly clientId: string;
  private readonly wc: WeftClient;
  private readonly storage: DocStorage;
  private readonly transport: Transport;
  private readonly tabs: CrossTab;
  private readonly views = new Set<EditorView>();
  private readonly peers = new Map<string, PeerInfo>();
  private user: User;
  private connected = false; // onConnected() called for the current socket
  private everLive = false;
  private fatal: string | null = null;
  private fatalStatus: SyncState['fatalStatus'];
  /** Consecutive sockets that closed before opening (a refused upgrade looks like this). */
  private refused = 0;
  private probing = false;
  private destroyed = false;
  private lastSyncedAt: number | null = null;
  /** Last state vector the server confirmed, persisted so unsynced edits from earlier sessions count after a reload. */
  private confirmedSv: Uint8Array = new Uint8Array();
  private confirmedSavedAt = 0;
  private confirmedTimer: ReturnType<typeof setTimeout> | null = null;
  private selfActive = Date.now();

  private readonly syncState: Emitter<SyncState>;
  private readonly peerList: Emitter<Peer[]>;

  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAwarenessSent = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private peersTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorsQueued = false;
  private readonly onPageHide = () => {
    this.storage.flush();
    if (this.wc.isSynced()) this.saveConfirmed();
  };
  private readonly onVisibility = () => {
    if (document.visibilityState === 'hidden') this.storage.flush();
  };

  static async open(docId: string, opts: OpenSessionOptions = {}): Promise<Session> {
    if (!DOC_ID.test(docId)) throw new Error(`invalid doc id: ${docId}`);
    await initWasm();
    const id = newClientId();
    const kind: SessionKind = opts.kind ?? 'doc';
    // Notes and anonymous docs never share local state: notes live under "note:<id>".
    const storeKey = kind === 'note' ? `note:${docId}` : docId;
    const { value: wc, storage } = await DocStorage.open(storeKey, id.toString(), (states) => {
      const wc = states.length ? WeftClient.fromStates(docId, id, states) : new WeftClient(docId, id);
      return { value: wc, encode: () => wc.encodeState() };
    });
    return new Session(docId, kind, storeKey, wc, storage, opts.serverUrl ?? defaultServerUrl());
  }

  private constructor(
    readonly docId: string,
    private readonly kind: SessionKind,
    private readonly storeKey: string,
    wc: WeftClient,
    storage: DocStorage,
    serverUrl: string,
  ) {
    this.wc = wc;
    this.storage = storage;
    this.clientId = wc.clientId.toString();
    const u = loadUser();
    this.user = { name: safeName(u.name, 'Anonymous'), color: safeColor(u.color) };
    this.confirmedSv = loadConfirmed(storeKey);
    this.syncState = new Emitter<SyncState>({
      status: 'connecting',
      unsyncedEdits: this.unsyncedEdits(),
      lastSyncedAt: null,
    });
    this.peerList = new Emitter<Peer[]>(this.computePeers());

    this.tabs = new CrossTab(storeKey, this.clientId, {
      onFrame: (f) => this.handleFrame(f, 'tab'),
      diffFor: (sv) => {
        try {
          return this.wc.encodeDiffFrame(sv);
        } catch {
          return undefined;
        }
      },
    });
    this.tabs.hello(wc.stateVector());

    const path = kind === 'note' ? `/ws/n/${docId}` : `/ws/${docId}`;
    this.transport = new Transport(`${serverUrl.replace(/\/$/, '')}${path}`, {
      onOpen: () => this.handleOpen(),
      onFrame: (f) => this.handleFrame(f, 'server'),
      onClose: (attempt, code) => this.handleClose(attempt, code),
    });
    this.transport.start();

    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.heartbeat = setInterval(() => this.sendAwareness(), AWARENESS_HEARTBEAT_MS);
  }

  // ---- DocSession ----

  editorExtensions(): Extension[] {
    return collabExtension(this.host);
  }

  getText(): string {
    return this.wc.text();
  }

  onSyncState(cb: (s: SyncState) => void): () => void {
    return this.syncState.on(cb);
  }

  onPeers(cb: (peers: Peer[]) => void): () => void {
    return this.peerList.on(cb);
  }

  getUser(): User {
    return { ...this.user };
  }

  setUser(user: User): void {
    const name = safeName(user.name, this.user.name);
    this.user = { name, color: safeColor(user.color, this.user.color) };
    saveUser(this.user);
    this.sendAwareness();
    this.schedulePeers();
  }

  historyLength(): number {
    return this.wc.opCount();
  }

  textAtStep(step: number): string {
    return this.wc.textAtStep(Math.max(0, Math.floor(step)));
  }

  restoreStep(step: number): void {
    if (this.destroyed) return;
    const edit = diffText(this.wc.text(), this.textAtStep(step));
    if (!edit) return;
    const view = this.views.values().next().value as EditorView | undefined;
    if (view) {
      // Goes through the collab plugin like typing, so it's a normal, undoable local edit.
      view.dispatch({ changes: edit, userEvent: 'input.restore', scrollIntoView: true });
    } else {
      this.applyLocal([{ pos: edit.from, del: edit.to - edit.from, text: edit.insert }], null);
    }
  }

  reconnect(): void {
    if (this.destroyed) return;
    this.fatal = null;
    this.fatalStatus = undefined;
    this.refused = 0;
    this.transport.reconnect();
    this.updateSync();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.storage.close();
    this.destroyed = true;
    this.transport.destroy();
    this.tabs.close();
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer);
    if (this.peersTimer) clearTimeout(this.peersTimer);
    this.views.clear();
    this.wc.free();
  }

  // ---- transport ----

  private handleOpen(): void {
    if (this.destroyed) return;
    this.connected = true;
    this.refused = 0;
    this.sendAll(this.wc.onConnected());
    this.updateSync();
  }

  private handleClose(attempt: number, code?: number): void {
    if (this.destroyed) return;
    if (code === 4001 && this.kind === 'note') {
      // The server revoked our session (signed out elsewhere, password changed, account disabled).
      this.fatalStatus = 401;
      this.fatal = 'Signed out';
      this.transport.stop();
    }
    if (this.connected) {
      this.connected = false;
      this.wc.onDisconnected();
    } else if (attempt > 0 && this.kind === 'note' && navigator.onLine !== false) {
      // The browser hides the HTTP status of a refused upgrade, so after two refusals in a row ask
      // the API why (signed out? not ours? deleted?) instead of retrying forever.
      if (++this.refused >= 2) void this.probeAccess();
    }
    // The session forgets peers on disconnect; the server replays them after the next handshake.
    if (this.peers.size) {
      this.peers.clear();
      this.schedulePeers();
      this.queueCursors();
    }
    this.updateSync(attempt);
  }

  private handleFrame(frame: Uint8Array, source: 'server' | 'tab'): void {
    if (this.destroyed) return;
    const wasLive = this.wc.isLive();
    let out: ClientOutputJs;
    try {
      out = this.wc.onMessage(frame);
    } catch (e) {
      console.warn(`[weft] bad frame from ${source}:`, e);
      return;
    }
    if (source === 'server') this.sendAll(out.send);
    if (out.error) {
      this.fatal = out.error.message || `server error ${out.error.code}`;
      this.transport.stop();
      if (this.kind === 'note') void this.probeAccess();
    }
    if (out.changes.length) this.applyRemote(out.changes, null);
    let peersChanged = false;
    for (const a of out.awareness) {
      peersChanged = true;
      const id = a.clientId.toString();
      if (id === this.clientId) continue;
      if (a.payload === null) this.peers.delete(id);
      else this.peers.set(id, parsePeer(id, a.payload, this.peers.get(id)));
    }
    if (peersChanged) {
      this.schedulePeers();
      this.queueCursors();
    }
    if (!wasLive && this.wc.isLive()) {
      this.everLive = true;
      this.sendAwareness();
    }
    this.updateSync();
  }

  private async probeAccess(): Promise<void> {
    if (this.probing || this.destroyed) return;
    this.probing = true;
    let status = 0;
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(this.docId)}/export.md`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      status = res.status;
      void res.body?.cancel();
    } catch {
      // Network trouble: keep retrying normally.
    } finally {
      this.probing = false;
    }
    if (this.destroyed || (status !== 401 && status !== 403 && status !== 404)) return;
    this.fatalStatus = status as 401 | 403 | 404;
    this.fatal =
      status === 401 ? 'Signed out' : status === 403 ? "This note isn't yours" : "This note doesn't exist";
    this.transport.stop();
    this.updateSync();
  }

  private sendAll(frames: Uint8Array[]): void {
    for (const f of frames) this.transport.send(f);
  }

  // ---- editor binding ----

  private readonly host: CollabHost = {
    text: () => (this.destroyed ? null : this.wc.text()),
    applyLocal: (edits, origin) => this.applyLocal(edits, origin),
    selectionChanged: () => {
      this.touchSelf();
      this.scheduleAwareness();
    },
    attach: (view) => {
      this.views.add(view);
      this.queueCursors();
      this.scheduleAwareness();
    },
    detach: (view) => {
      this.views.delete(view);
    },
  };

  private applyLocal(edits: LocalEdit[], origin: EditorView | null): void {
    if (this.destroyed) return;
    const changes: ChangeJs[] = [];
    for (const e of edits) {
      if (e.del > 0) {
        this.sendAll(this.wc.delete(e.pos, e.del));
        changes.push({ delete: { pos: e.pos, len: e.del } });
      }
      if (e.text) {
        this.sendAll(this.wc.insert(e.pos, e.text));
        changes.push({ insert: { pos: e.pos, text: e.text } });
      }
    }
    const frame = this.wc.takeLocalUpdate();
    if (frame) this.tabs.update(frame);
    this.applyRemote(changes, origin); // mirror into any other editors on this session
    this.touchSelf();
    this.storage.schedule();
    this.updateSync();
  }

  /** Apply CRDT changes to every attached view except `skip`. */
  private applyRemote(changes: ChangeJs[], skip: EditorView | null): void {
    if (skip === null) this.storage.schedule();
    if (!this.views.size) return;
    const cursors = skip === null ? this.remoteCursors() : null;
    const len = this.wc.lenUtf16();
    for (const view of this.views) {
      if (view === skip) continue;
      const spec = remoteChangesSpec(view.state, changes, () => this.wc.text(), len);
      if (!spec && !cursors) continue;
      view.dispatch({
        ...(spec ?? {}),
        ...(cursors ? { effects: setRemoteCursors.of(cursors) } : {}),
      });
    }
    if (skip === null) this.schedulePeers();
  }

  private remoteCursors(): RemoteCursor[] {
    const out: RemoteCursor[] = [];
    for (const [clientId, p] of this.peers) {
      if (!p.cursor) continue;
      const anchor = this.wc.resolveAnchor(p.cursor.anchor);
      const head = this.wc.resolveAnchor(p.cursor.head);
      if (head === undefined) continue;
      out.push({ clientId, name: p.name, color: p.color, anchor: anchor ?? head, head });
    }
    return out;
  }

  /** Push fresh remote cursor decorations to all views, outside any CodeMirror update. */
  private queueCursors(): void {
    if (this.cursorsQueued) return;
    this.cursorsQueued = true;
    queueMicrotask(() => {
      this.cursorsQueued = false;
      if (this.destroyed) return;
      const cursors = this.remoteCursors();
      for (const v of this.views) v.dispatch({ effects: setRemoteCursors.of(cursors) });
    });
  }

  /** Coarse (5 s) self activity stamp, so the peers list doesn't re-emit on every keystroke. */
  private touchSelf(): void {
    const now = Date.now();
    if (now - this.selfActive > 5000) {
      this.selfActive = now;
      this.schedulePeers();
    }
  }

  // ---- awareness ----

  private scheduleAwareness(): void {
    if (this.awarenessTimer) return;
    const wait = Math.max(0, this.lastAwarenessSent + AWARENESS_THROTTLE_MS - Date.now());
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = null;
      this.sendAwareness();
    }, wait);
  }

  private sendAwareness(): void {
    if (this.destroyed) return;
    this.lastAwarenessSent = Date.now();
    const view = this.views.values().next().value as EditorView | undefined;
    let cursor: CursorAnchors | null = null;
    if (view) {
      const sel = view.state.selection.main;
      cursor = { anchor: this.wc.anchorAt(sel.anchor), head: this.wc.anchorAt(sel.head) };
    }
    const payload = JSON.stringify({ name: this.user.name, color: this.user.color, cursor });
    this.sendAll(this.wc.setAwareness(payload));
  }

  // ---- peers + sync state ----

  private schedulePeers(): void {
    if (this.peersTimer || this.destroyed) return;
    this.peersTimer = setTimeout(() => {
      this.peersTimer = null;
      if (!this.destroyed) this.peerList.set(this.computePeers(), samePeers);
    }, PEERS_THROTTLE_MS);
  }

  private computePeers(): Peer[] {
    const view = this.views.values().next().value as EditorView | undefined;
    const list: Peer[] = [
      {
        clientId: this.clientId,
        name: this.user.name,
        color: this.user.color,
        isSelf: true,
        cursor: view ? view.state.selection.main.head : null,
        lastActive: this.selfActive,
      },
    ];
    for (const [clientId, p] of this.peers) {
      list.push({
        clientId,
        name: p.name,
        color: p.color,
        isSelf: false,
        cursor: p.cursor ? (this.wc.resolveAnchor(p.cursor.head) ?? null) : null,
        lastActive: p.lastActive,
      });
    }
    return list;
  }

  private unsyncedEdits(): number {
    try {
      return Math.max(this.wc.unsyncedOpCount(), this.wc.countNotIn(this.confirmedSv));
    } catch {
      return this.wc.unsyncedOpCount();
    }
  }

  private saveConfirmed(): void {
    this.confirmedSv = this.wc.stateVector();
    this.confirmedSavedAt = Date.now();
    try {
      localStorage.setItem(CONFIRMED_KEY + this.storeKey, toBase64(this.confirmedSv));
    } catch {
      // Storage full or blocked: the count just stays conservative after a reload.
    }
  }

  private updateSync(attempt?: number): void {
    if (this.destroyed) return;
    const live = this.connected && this.wc.isLive();
    const synced = live && this.wc.isSynced();
    if (synced) {
      this.lastSyncedAt = Date.now();
      if (this.lastSyncedAt - this.confirmedSavedAt > 1000) {
        this.saveConfirmed();
      } else {
        // Trailing save, so edits from peers that arrive just after a save are still recorded.
        this.confirmedTimer ??= setTimeout(() => {
          this.confirmedTimer = null;
          if (!this.destroyed && this.connected && this.wc.isLive() && this.wc.isSynced()) this.saveConfirmed();
        }, 1000);
      }
    }
    let status: SyncState['status'];
    if (this.fatal) status = 'error';
    else if (live) status = 'live';
    else if (typeof navigator !== 'undefined' && navigator.onLine === false) status = 'offline';
    else if (this.connected) status = this.everLive ? 'reconnecting' : 'connecting';
    else {
      const prev = this.syncState.get().status;
      const a = attempt ?? (prev === 'offline' ? 99 : 1);
      if (a >= 3) status = 'offline';
      else status = this.everLive ? 'reconnecting' : 'connecting';
    }
    const next: SyncState = {
      status,
      unsyncedEdits: synced ? 0 : this.unsyncedEdits(),
      lastSyncedAt: this.lastSyncedAt,
      ...(this.fatal ? { error: this.fatal } : {}),
      ...(this.fatal && this.fatalStatus ? { fatalStatus: this.fatalStatus } : {}),
    };
    this.syncState.set(next, (a, b) =>
      a.status === b.status &&
      a.unsyncedEdits === b.unsyncedEdits &&
      a.error === b.error &&
      a.fatalStatus === b.fatalStatus &&
      // Only re-emit lastSyncedAt when we transition into synced, not on every keystroke.
      (a.lastSyncedAt === b.lastSyncedAt || (a.lastSyncedAt !== null && b.lastSyncedAt !== null)),
    );
  }
}

function parsePeer(id: string, payload: string, prev: PeerInfo | undefined): PeerInfo {
  let j: { name?: unknown; color?: unknown; cursor?: unknown } = {};
  try {
    j = JSON.parse(payload);
  } catch {
    /* keep defaults */
  }
  const c = j.cursor as Partial<CursorAnchors> | null | undefined;
  const cursor =
    c && typeof c.anchor === 'string' && typeof c.head === 'string'
      ? { anchor: c.anchor, head: c.head }
      : null;
  return {
    name: safeName(j.name, prev?.name ?? 'Anonymous'),
    color: safeColor(j.color, prev?.color ?? paletteColor(id)),
    cursor,
    lastActive: Date.now(),
  };
}

function samePeers(a: Peer[], b: Peer[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i];
    return (
      p.clientId === q.clientId &&
      p.name === q.name &&
      p.color === q.color &&
      p.cursor === q.cursor &&
      p.lastActive === q.lastActive
    );
  });
}

const CONFIRMED_KEY = 'weft:confirmed:';

function loadConfirmed(key: string): Uint8Array {
  try {
    const b64 = localStorage.getItem(CONFIRMED_KEY + key);
    if (b64) return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    // Fall through: nothing confirmed.
  }
  return new Uint8Array();
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
