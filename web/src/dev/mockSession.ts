// A fake DocSession for UI development (enable with ?mock).
//
// Fake collaborators move their cursors, select words and type; the connection flips between
// live and offline so every sync state can be seen. While "offline", peers keep typing into a
// buffer that merges in on reconnect, like the real thing.
//
// URL flags:  ?mock           3 peers, flaky network, sample doc
//             ?mock=5         number of fake peers (0-7)
//             &empty          start from an empty doc
//             &stable         never go offline on its own

import { Annotation, StateEffect, Transaction, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { minimalChange } from '../editor/diff';
import type { DocSession, Peer, SyncState, User } from '../sync/index';

export interface MockOptions {
  peers: number;
  empty: boolean;
  flaky: boolean;
}

export function mockOptionsFromUrl(search: string): MockOptions {
  const q = new URLSearchParams(search);
  const n = parseInt(q.get('mock') ?? '', 10);
  return {
    peers: Number.isFinite(n) ? Math.max(0, Math.min(7, n)) : 3,
    empty: q.has('empty'),
    flaky: !q.has('stable'),
  };
}

const CAST: User[] = [
  { name: 'Ada Lovelace', color: '#e5484d' },
  { name: 'Linus', color: '#30a46c' },
  { name: 'Grace Hopper', color: '#f76b15' },
  { name: 'Alan Kay', color: '#8e4ec6' },
  { name: 'Margaret H.', color: '#12a594' },
  { name: 'Ken', color: '#d6409f' },
  { name: 'Barbara Liskov', color: '#0091ff' },
];

const PHRASES = [
  ' This should stay under 100 ms on localhost.',
  ' Agreed.',
  ' (needs a benchmark)',
  ' Let us keep it boring and fast.',
  ' I tried this offline on the train and it merged cleanly.',
  ' Maybe we can measure first paint too?',
  '\n- [ ] Write the reconnect test',
  ' Nice.',
  ' See the simulator results below.',
];

const SAMPLE = `# Weft design notes

Weft is a **real-time**, *offline-first* Markdown editor. Every keystroke lands in a local replica first, then syncs to everyone else. Try going offline: the pill in the corner always tells you the truth.

## Goals

- Open a link and start typing, with no accounts
- Merge concurrent edits without conflicts
- Look calm enough to write in all day

## This week

- [x] Pick a sequence CRDT
- [x] Sketch the sync handshake
- [ ] Ship the history scrubber
- [ ] Measure the WASM size

> Simple beats clever. Clever data structures go behind a small, boring API.

## The handshake

\`\`\`rust
fn on_connected(&mut self) -> Vec<Message> {
    vec![Message::Hello { protocol: 1, state_vector: self.doc.state_vector().encode() }]
}
\`\`\`

Press \`⌘K\` for commands, or read more at [the repo](https://example.com/weft).
`;

const remoteEdit = Annotation.define<boolean>();
const repaint = StateEffect.define<null>();

interface FakePeer extends User {
  clientId: string;
  present: boolean;
  head: number;
  anchor: number;
  lastActive: number;
  mode: 'idle' | 'typing';
  phrase: string;
  charIdx: number;
  nextAt: number;
  /** Text typed while we were "offline"; merged in on reconnect. */
  buffer: string;
}

class CursorWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly color: string,
    readonly idle: boolean,
  ) {
    super();
  }
  eq(o: CursorWidget) {
    return o.name === this.name && o.color === this.color && o.idle === this.idle;
  }
  toDOM() {
    const caret = document.createElement('span');
    caret.className = 'weft-remote-cursor' + (this.idle ? ' is-idle' : '');
    caret.style.setProperty('--weft-peer-color', this.color);
    caret.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'weft-remote-label';
    label.textContent = this.name;
    caret.append(label);
    return caret;
  }
  ignoreEvent() {
    return true;
  }
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

/** Build a believable edit history by "typing" the text a few words at a time. */
function seedHistory(text: string): string[] {
  const steps = [''];
  const re = /\S+\s*/g;
  let m: RegExpExecArray | null;
  let words = 0;
  while ((m = re.exec(text))) {
    words++;
    if (words % 2 === 0 || /\n/.test(m[0])) steps.push(text.slice(0, m.index + m[0].length));
  }
  if (steps[steps.length - 1] !== text) steps.push(text);
  return steps;
}

export class MockSession implements DocSession {
  readonly clientId = 'mock-self';
  private view: EditorView | null = null;
  private snapshots: string[];
  private user: User;
  private peers: FakePeer[];
  private sync: SyncState = { status: 'connecting', unsyncedEdits: 0, lastSyncedAt: null };
  private syncCbs = new Set<(s: SyncState) => void>();
  private peerCbs = new Set<(p: Peer[]) => void>();
  private timers = new Set<number>();
  private ticker = 0;
  private peersQueued = false;
  private destroyed = false;
  private readonly onOffline = () => this.goOffline();
  private readonly onOnline = () => this.reconnect();

  constructor(
    readonly docId: string,
    private opts: MockOptions,
  ) {
    const initial = opts.empty ? '' : SAMPLE;
    this.snapshots = opts.empty ? [''] : seedHistory(initial);
    this.user = loadMockUser();
    const others = CAST.filter((c) => c.name !== this.user.name);
    this.peers = others.slice(0, opts.peers).map((u, i) => ({
      ...u,
      clientId: `mock-${i + 1}`,
      present: i < Math.max(1, opts.peers - 1), // the last one joins a few seconds in
      head: 0,
      anchor: 0,
      lastActive: Date.now(),
      mode: 'idle',
      phrase: '',
      charIdx: 0,
      nextAt: Date.now() + rand(600, 2500) + i * 500,
      buffer: '',
    }));
    // Spread initial cursors through the sample.
    this.peers.forEach((p, i) => {
      p.head = p.anchor = Math.floor(((i + 1) / (this.peers.length + 1)) * initial.length);
    });

    this.later(() => this.setSync({ status: 'live', unsyncedEdits: 0, lastSyncedAt: Date.now() }), 450);
    this.later(() => {
      for (const p of this.peers) p.present = true;
      this.emitPeers();
    }, 3500);
    if (opts.flaky) this.scheduleFlap(rand(22000, 30000));
    this.ticker = window.setInterval(() => this.tick(), 60);
    window.addEventListener('offline', this.onOffline);
    window.addEventListener('online', this.onOnline);
  }

  // ---------- DocSession ----------

  editorExtensions(): Extension[] {
    const session = this;
    const plugin = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          session.view = view;
          this.decorations = session.cursorDecorations(view);
        }
        update(u: ViewUpdate) {
          session.onViewUpdate(u);
          this.decorations = session.cursorDecorations(u.view);
        }
        destroy() {
          if (session.view) session.view = null;
        }
      },
      { decorations: (v) => v.decorations },
    );
    return [plugin];
  }

  getText(): string {
    return this.view ? this.view.state.doc.toString() : this.snapshots[this.snapshots.length - 1];
  }

  onSyncState(cb: (s: SyncState) => void): () => void {
    this.syncCbs.add(cb);
    cb({ ...this.sync });
    return () => this.syncCbs.delete(cb);
  }

  onPeers(cb: (peers: Peer[]) => void): () => void {
    this.peerCbs.add(cb);
    cb(this.peerList());
    return () => this.peerCbs.delete(cb);
  }

  getUser(): User {
    return { ...this.user };
  }

  setUser(user: User): void {
    this.user = { ...user };
    try {
      localStorage.setItem('weft:mock-user', JSON.stringify(this.user));
    } catch {
      /* ignore */
    }
    this.emitPeers();
  }

  historyLength(): number {
    return this.snapshots.length - 1;
  }

  textAtStep(step: number): string {
    const i = Math.max(0, Math.min(this.snapshots.length - 1, Math.round(step)));
    return this.snapshots[i];
  }

  restoreStep(step: number): void {
    const target = this.textAtStep(step);
    if (!this.view) return;
    const change = minimalChange(this.view.state.doc.toString(), target);
    if (change) this.view.dispatch({ changes: change, userEvent: 'input.restore' });
  }

  reconnect(): void {
    if (this.sync.status === 'live' || this.sync.status === 'connecting') return;
    this.setSync({ ...this.sync, status: 'reconnecting' });
    this.later(() => {
      if (!navigator.onLine) {
        this.setSync({ ...this.sync, status: 'offline' });
        return;
      }
      this.goLive();
    }, 1100);
  }

  destroy(): void {
    this.destroyed = true;
    clearInterval(this.ticker);
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    window.removeEventListener('offline', this.onOffline);
    window.removeEventListener('online', this.onOnline);
    this.syncCbs.clear();
    this.peerCbs.clear();
  }

  // ---------- internals ----------

  private later(fn: () => void, ms: number): void {
    const t = window.setTimeout(() => {
      this.timers.delete(t);
      if (!this.destroyed) fn();
    }, ms);
    this.timers.add(t);
  }

  private setSync(s: SyncState): void {
    this.sync = s;
    this.syncCbs.forEach((cb) => cb({ ...s }));
  }

  private peerList(): Peer[] {
    const self: Peer = {
      ...this.user,
      clientId: this.clientId,
      isSelf: true,
      cursor: this.view ? this.view.state.selection.main.head : null,
      lastActive: Date.now(),
    };
    const others = this.peers
      .filter((p) => p.present)
      .map<Peer>((p) => ({
        name: p.name,
        color: p.color,
        clientId: p.clientId,
        isSelf: false,
        cursor: p.head,
        lastActive: p.lastActive,
      }));
    return [self, ...others];
  }

  private emitPeers(): void {
    if (this.peersQueued) return;
    this.peersQueued = true;
    requestAnimationFrame(() => {
      this.peersQueued = false;
      if (this.destroyed) return;
      const list = this.peerList();
      this.peerCbs.forEach((cb) => cb(list));
    });
  }

  private scheduleFlap(ms: number): void {
    this.later(() => {
      if (this.sync.status === 'live') {
        this.goOffline();
        this.later(() => this.reconnect(), rand(8000, 12000));
      }
      this.scheduleFlap(rand(40000, 55000));
    }, ms);
  }

  private goOffline(): void {
    if (this.sync.status === 'offline') return;
    this.setSync({ ...this.sync, status: 'offline' });
  }

  private goLive(): void {
    // Merge what everyone typed while we were apart, then "upload" our own edits.
    for (const p of this.peers) {
      if (p.buffer && this.view) {
        const pos = Math.min(p.head, this.view.state.doc.length);
        this.remoteInsert(p, pos, p.buffer);
        p.buffer = '';
      }
    }
    const pending = this.sync.unsyncedEdits;
    this.setSync({ ...this.sync, status: 'live' });
    const steps = Math.min(6, pending);
    for (let i = 1; i <= steps; i++) {
      this.later(() => {
        const left = i === steps ? 0 : Math.round(pending * (1 - i / steps));
        this.setSync({ ...this.sync, unsyncedEdits: left, lastSyncedAt: left === 0 ? Date.now() : this.sync.lastSyncedAt });
      }, i * 110);
    }
    if (steps === 0) this.setSync({ ...this.sync, lastSyncedAt: Date.now() });
  }

  private onViewUpdate(u: ViewUpdate): void {
    if (u.docChanged) {
      for (const p of this.peers) {
        p.head = u.changes.mapPos(p.head, 1);
        p.anchor = u.changes.mapPos(p.anchor, -1);
      }
      this.snapshots.push(u.state.doc.toString());
      const isLocal = u.transactions.some((tr) => tr.docChanged && !tr.annotation(remoteEdit));
      if (isLocal) {
        const unsynced = this.sync.unsyncedEdits + 1;
        this.setSync({ ...this.sync, unsyncedEdits: unsynced });
        if (this.sync.status === 'live') this.scheduleAck();
      }
    }
    if (u.docChanged || u.selectionSet) this.emitPeers();
  }

  private ackQueued = false;
  private scheduleAck(): void {
    if (this.ackQueued) return;
    this.ackQueued = true;
    this.later(() => {
      this.ackQueued = false;
      if (this.sync.status === 'live') this.setSync({ ...this.sync, unsyncedEdits: 0, lastSyncedAt: Date.now() });
    }, 180);
  }

  private cursorDecorations(view: EditorView): DecorationSet {
    const len = view.state.doc.length;
    const now = Date.now();
    const ranges = [];
    for (const p of this.peers) {
      if (!p.present) continue;
      const head = Math.min(p.head, len);
      const anchor = Math.min(p.anchor, len);
      if (anchor !== head) {
        ranges.push(
          Decoration.mark({
            class: 'weft-remote-selection',
            attributes: { style: `--weft-peer-color: ${p.color}` },
          }).range(Math.min(anchor, head), Math.max(anchor, head)),
        );
      }
      ranges.push(
        Decoration.widget({ widget: new CursorWidget(p.name, p.color, now - p.lastActive > 5000), side: 1 }).range(head),
      );
    }
    return Decoration.set(ranges, true);
  }

  private remoteInsert(p: FakePeer, pos: number, text: string): void {
    if (!this.view) return;
    this.view.dispatch({
      changes: { from: pos, insert: text },
      annotations: [remoteEdit.of(true), Transaction.addToHistory.of(false), Transaction.remote.of(true)],
    });
    p.head = p.anchor = pos + text.length;
    p.lastActive = Date.now();
  }

  private repaint(): void {
    this.view?.dispatch({ effects: repaint.of(null) });
  }

  private tick(): void {
    const view = this.view;
    if (!view || this.destroyed) return;
    const now = Date.now();
    let moved = false;
    const connected = this.sync.status === 'live';
    for (const p of this.peers) {
      if (!p.present || now < p.nextAt) continue;
      const doc = view.state.doc;
      if (p.mode === 'typing') {
        const ch = p.phrase[p.charIdx++];
        if (connected) {
          this.remoteInsert(p, Math.min(p.head, doc.length), ch);
        } else {
          p.buffer += ch; // they keep writing; we'll see it when we're back
          p.lastActive = now;
        }
        if (p.charIdx >= p.phrase.length) {
          p.mode = 'idle';
          p.nextAt = now + rand(2500, 7000);
        } else {
          p.nextAt = now + (ch === ' ' ? rand(90, 320) : rand(45, 140));
        }
        continue;
      }
      // Idle: decide what to do next.
      if (!connected) {
        p.nextAt = now + rand(800, 2000);
        continue;
      }
      const lines = lineTargets(view);
      if (lines.length === 0 || (this.opts.empty && doc.length < 40)) {
        p.nextAt = now + rand(1500, 3000);
        continue;
      }
      const r = Math.random();
      const target = pick(lines);
      if (r < 0.5) {
        // Move to the end of a line, then type a phrase there.
        p.head = p.anchor = target.to;
        p.mode = 'typing';
        p.phrase = pick(PHRASES);
        p.charIdx = 0;
        p.nextAt = now + rand(500, 1200);
      } else if (r < 0.7) {
        // Select a word.
        const text = doc.sliceString(target.from, target.to);
        const words = [...text.matchAll(/[\p{L}\p{N}]{3,}/gu)];
        if (words.length) {
          const w = pick(words);
          p.anchor = target.from + (w.index ?? 0);
          p.head = p.anchor + w[0].length;
        }
        p.nextAt = now + rand(1500, 4000);
      } else {
        p.head = p.anchor = Math.round(rand(target.from, target.to));
        p.nextAt = now + rand(1500, 5000);
      }
      p.lastActive = now;
      moved = true;
    }
    if (moved) {
      this.repaint();
      this.emitPeers();
    }
    // Let labels fade once peers go quiet.
    if (now % 1000 < 60) this.repaint();
  }
}

/** Non-empty lines outside fenced code, as candidate places for fake peers to work. */
function lineTargets(view: EditorView): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const doc = view.state.doc;
  let fence = false;
  for (let i = 1; i <= doc.lines; i++) {
    const l = doc.line(i);
    if (/^\s*(```|~~~)/.test(l.text)) {
      fence = !fence;
      continue;
    }
    if (!fence && l.text.trim().length > 8 && !/^\s*#/.test(l.text)) out.push({ from: l.from, to: l.to });
  }
  return out;
}

function loadMockUser(): User {
  try {
    const raw = localStorage.getItem('weft:mock-user');
    if (raw) {
      const u = JSON.parse(raw) as User;
      if (u && typeof u.name === 'string' && typeof u.color === 'string') return u;
    }
  } catch {
    /* ignore */
  }
  return { name: 'Wren', color: '#5b5bd6' };
}

export async function openMockSession(docId: string, opts: MockOptions): Promise<DocSession> {
  return new MockSession(docId, opts);
}
