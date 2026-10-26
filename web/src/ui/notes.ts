// The Wall's data: a local cache of note metadata (localStorage["weft:wall:<userId>"]) that paints
// instantly and works offline, optimistic create/patch/delete, and a queue of creates made offline.
// Note *content* lives in the CRDT (src/sync); this only holds titles, previews, colors and flags.

import { api, ApiError, normalizeNote, NOTE_ID, type Note, type NoteFilter, type NotePatch } from '../api';
import { readJson, writeJson } from './storage';
import { deriveTitle, stripInline } from './text';

interface PendingCreate {
  id: string;
  text?: string;
  from_doc?: string;
}

/** Local title/preview from an edit we just made, preferred over the server's (debounced) copy for a while. */
interface Override {
  title: string;
  preview: string;
  at: number;
}

const OVERRIDE_MS = 15_000;
const UNDO_MS = 6_000;
/** How far ahead of the server's copy a local edit may be and still win (covers the server's debounce, tolerates small clock skew). */
const FRESH_MS = 60_000;

/** One Markdown line as plain card text: bullets become •, tasks ☐/☑, heading and quote markers go. */
function prettyLine(line: string): string {
  return line
    .replace(/^ {0,3}#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+\[([ xX])\]\s+/, (_m, x: string) => (x === ' ' ? '☐ ' : '☑ '))
    .replace(/^\s*[-*+]\s+/, '• ')
    .replace(/^\s*>\s?/, '')
    .replace(/^(```|~~~).*$/, '');
}

/** Card preview from note text: everything after the title line, lightly de-Markdowned. */
export function previewFromText(text: string, title: string | null): string {
  const lines = text.split('\n');
  let i = 0;
  if (title) {
    while (i < lines.length && !lines[i].trim()) i++;
    i++; // the title line itself
  }
  const out: string[] = [];
  let len = 0;
  for (; i < lines.length && len < 280; i++) {
    const t = stripInline(prettyLine(lines[i]));
    out.push(t);
    len += t.length + 1;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 280);
}

/** The preview to show on a card: the server's may start with the title line, so drop it. */
export function cardPreview(n: Note): string {
  let p = n.preview.trim();
  const t = n.title.trim();
  if (t) {
    const first = p.split('\n', 1)[0];
    if (stripInline(first.replace(/^ {0,3}#{1,6}\s+/, '')).trim() === t) p = p.slice(first.length).trim();
  }
  return p
    .split('\n')
    .map((l) => stripInline(prettyLine(l)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sortNotes(list: Note[]): Note[] {
  return list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at);
}

export class NotesStore {
  private notes = new Map<string, Note>();
  private pending: PendingCreate[];
  private overrides = new Map<string, Override>();
  private deleting = new Map<string, { note: Note; timer: number }>();
  private listeners = new Set<() => void>();
  private flushing: Promise<void> | null = null;
  private readonly key: string;
  private readonly pendingKey: string;
  /** null = never refreshed in this page load; false = last refresh failed because we're offline. */
  online: boolean | null = null;

  private readonly onOnline = () => void this.flush().then(() => this.refresh());
  private readonly onPageHide = () => this.commitDeletes(true);

  constructor(readonly userId: number) {
    this.key = `weft:wall:${userId}`;
    this.pendingKey = `weft:wall:${userId}:pending`;
    const cached = readJson<unknown>(this.key, []);
    if (Array.isArray(cached)) {
      for (const n of cached) if (n && typeof n.id === 'string' && NOTE_ID.test(n.id)) this.notes.set(n.id, normalizeNote(n));
    }
    const p = readJson<unknown>(this.pendingKey, []);
    this.pending = Array.isArray(p) ? p.filter((x) => x && typeof x.id === 'string' && NOTE_ID.test(x.id)) : [];
    window.addEventListener('online', this.onOnline);
    window.addEventListener('pagehide', this.onPageHide);
    if (this.pending.length) void this.flush();
  }

  dispose(): void {
    this.commitDeletes(true);
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('pagehide', this.onPageHide);
    this.listeners.clear();
  }

  /** Forget everything stored on this device for this user (sign-out). */
  wipe(): void {
    this.dispose();
    try {
      localStorage.removeItem(this.key);
      localStorage.removeItem(this.pendingKey);
    } catch {
      /* ignore */
    }
  }

  on(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    writeJson(this.key, [...this.notes.values()]);
    for (const l of this.listeners) l();
  }

  get(id: string): Note | undefined {
    return this.notes.get(id);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  isPending(id: string): boolean {
    return this.pending.some((p) => p.id === id);
  }

  /** Cached notes for a filter, pinned first then most recently edited. */
  list(filter: NoteFilter): Note[] {
    const all = [...this.notes.values()].map((n) => this.withOverride(n));
    const shown = all.filter((n) =>
      filter === 'archived' ? n.archived : filter === 'pinned' ? n.pinned && !n.archived : !n.archived,
    );
    return sortNotes(shown);
  }

  /** Instant, local-only search over cached titles and previews. */
  searchLocal(q: string, filter: NoteFilter): Note[] {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return this.list(filter).filter((n) => {
      const hay = `${n.title}\n${n.preview}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  private withOverride(n: Note): Note {
    const o = this.overrides.get(n.id);
    if (!o) return n;
    if (Date.now() - o.at > OVERRIDE_MS) {
      this.overrides.delete(n.id);
      return n;
    }
    return { ...n, title: o.title, preview: o.preview, updated_at: Math.max(n.updated_at, o.at) };
  }

  /** Merge a server list for `filter` into the cache. Server data wins, except over our fresh local edits. */
  private merge(filter: 'all' | 'archived', server: Note[]): void {
    const seen = new Set(server.map((n) => n.id));
    for (const [id, n] of this.notes) {
      if (n.archived !== (filter === 'archived') || seen.has(id) || this.isPending(id)) continue;
      this.notes.delete(id); // deleted (or moved) elsewhere
    }
    for (const n of server) {
      if (this.deleting.has(n.id)) continue;
      this.notes.set(n.id, this.keepFresh(this.notes.get(n.id), n));
    }
  }

  /**
   * The server refreshes titles/previews at most every 2 s (and when the room unloads), so a list fetched
   * right after typing can be stale. If our cached copy was edited just after the server's, keep its text.
   */
  private keepFresh(local: Note | undefined, server: Note): Note {
    if (!local) return server;
    const ahead = local.updated_at - server.updated_at;
    if (ahead > 0 && ahead < FRESH_MS && (local.title !== server.title || local.preview !== server.preview)) {
      return { ...server, title: local.title, preview: local.preview, updated_at: local.updated_at };
    }
    return server;
  }

  async refresh(filter: NoteFilter = 'all'): Promise<void> {
    const which = filter === 'archived' ? 'archived' : 'all';
    try {
      const list = await api.listNotes(which);
      this.online = true;
      this.merge(which, list);
      this.changed();
    } catch (e) {
      if (e instanceof ApiError && e.offline) {
        this.online = false;
        for (const l of this.listeners) l();
        return;
      }
      throw e;
    }
  }

  /** Full-text search on the server (falls back to the local cache when offline). */
  async search(q: string, filter: NoteFilter): Promise<{ notes: Note[]; local: boolean }> {
    try {
      const list = await api.listNotes(filter, q);
      const fresh = list.filter((n) => !this.deleting.has(n.id)).map((n) => this.keepFresh(this.notes.get(n.id), n));
      for (const n of fresh) if (this.notes.has(n.id)) this.notes.set(n.id, n);
      return { notes: fresh.map((n) => this.withOverride(n)), local: false };
    } catch (e) {
      if (e instanceof ApiError && e.offline) return { notes: this.searchLocal(q, filter), local: true };
      throw e;
    }
  }

  // ---------- create ----------

  /** Insert the note locally right away and create it on the server in the background (queued if offline). */
  create(id: string, extra: { text?: string; from_doc?: string } = {}): Note {
    const t = Date.now();
    const title = extra.text ? deriveTitle(extra.text, 120) : null;
    const note: Note = {
      id,
      title: title ?? '',
      preview: extra.text ? previewFromText(extra.text, title) : '',
      color: 'default',
      pinned: false,
      archived: false,
      created_at: t,
      updated_at: t,
    };
    this.notes.set(id, note);
    this.pending.push({ id, ...extra });
    writeJson(this.pendingKey, this.pending);
    this.changed();
    void this.flush();
    return note;
  }

  /** Send queued creates, oldest first. Stops at the first network failure. */
  flush(): Promise<void> {
    this.flushing ??= (async () => {
      while (this.pending.length) {
        const p = this.pending[0];
        try {
          const n = await api.createNote(p);
          const local = this.notes.get(p.id);
          // Keep whatever we've typed since; take the server's timestamps and flags.
          this.notes.set(p.id, local ? { ...n, title: local.title || n.title, preview: local.preview || n.preview } : n);
        } catch (e) {
          if (e instanceof ApiError && (e.offline || e.status >= 500 || e.status === 429 || e.status === 401)) break;
          // 409: the id exists, i.e. an earlier attempt got through. Anything else: the server refused it for good.
          if (!(e instanceof ApiError && e.status === 409)) {
            console.warn('[weft] note create refused', e);
            this.notes.delete(p.id);
          }
        }
        this.pending.shift();
        writeJson(this.pendingKey, this.pending);
        this.changed();
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Before opening a note's socket: make sure the server knows it (briefly, so offline never blocks). */
  async ensureCreated(id: string, waitMs = 2500): Promise<boolean> {
    if (!this.isPending(id)) return true;
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, waitMs))]);
    return !this.isPending(id);
  }

  /** A note the server created for us (e.g. "Save to my wall"). */
  adopt(n: Note): void {
    this.notes.set(n.id, n);
    this.changed();
  }

  // ---------- edit ----------

  /** The editor reports fresh text: update the card's title and preview locally. */
  noteEdited(id: string, text: string): void {
    const n = this.notes.get(id);
    if (!n) return;
    const title = deriveTitle(text, 120) ?? '';
    const preview = previewFromText(text, title || null);
    const at = Date.now();
    this.overrides.set(id, { title, preview, at });
    this.notes.set(id, { ...n, title, preview, updated_at: Math.max(n.updated_at, at) });
    this.changed();
  }

  async patch(id: string, patch: NotePatch): Promise<void> {
    const before = this.notes.get(id);
    if (!before) return;
    this.notes.set(id, { ...before, ...patch });
    this.changed();
    if (this.isPending(id)) await this.ensureCreated(id);
    try {
      const n = await api.patchNote(id, patch);
      const cur = this.notes.get(id);
      if (cur) this.notes.set(id, { ...n, title: cur.title, preview: cur.preview, updated_at: Math.max(n.updated_at, cur.updated_at) });
      this.changed();
    } catch (e) {
      this.notes.set(id, before);
      this.changed();
      throw e;
    }
  }

  /** Hide the note now; really delete it after the undo window. Returns `undo`. */
  remove(id: string, onFail: (e: unknown) => void): () => void {
    const note = this.notes.get(id);
    if (!note) return () => undefined;
    this.notes.delete(id);
    this.changed();
    const timer = window.setTimeout(() => this.commitDelete(id, false, onFail), UNDO_MS);
    this.deleting.set(id, { note, timer });
    return () => {
      const d = this.deleting.get(id);
      if (!d) return;
      clearTimeout(d.timer);
      this.deleting.delete(id);
      this.notes.set(id, d.note);
      this.changed();
    };
  }

  private commitDelete(id: string, keepalive: boolean, onFail?: (e: unknown) => void): void {
    const d = this.deleting.get(id);
    if (!d) return;
    clearTimeout(d.timer);
    this.deleting.delete(id);
    const pendingIdx = this.pending.findIndex((p) => p.id === id);
    if (pendingIdx >= 0 && !this.flushing) {
      // Never reached the server: just drop it from the queue.
      this.pending.splice(pendingIdx, 1);
      writeJson(this.pendingKey, this.pending);
      return;
    }
    api.deleteNote(id, keepalive).catch((e) => {
      if (e instanceof ApiError && e.status === 404) return;
      this.notes.set(id, d.note);
      this.changed();
      onFail?.(e);
    });
  }

  private commitDeletes(keepalive: boolean): void {
    for (const id of [...this.deleting.keys()]) this.commitDelete(id, keepalive);
  }
}
