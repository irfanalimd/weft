// The app shell: owns the chrome (top bar, palette, share, history, toasts) and swaps doc sessions in and out.

import type { ViewUpdate } from '@codemirror/view';
import { createEditor, type EditorHandle } from '../editor/setup';
import { scrollToAndFlash } from '../editor/focus';
import { randomUser, type DocSession, type Peer, type SyncState } from '../sync/index';
import { buildCommands, colorItems } from './commands';
import { h, isModKey, prefersReducedMotion, shortcut } from './dom';
import { renderEmptyState } from './emptyState';
import { copyHtml, copyText, downloadMarkdown } from './exportDoc';
import { HistoryPanel } from './history';
import { icon, logoSvg } from './icons';
import { Palette } from './palette';
import { Presence } from './presence';
import { docPath, docUrl, newSlug, parseRoute } from './router';
import { SharePopover } from './share';
import { touchRecent } from './storage';
import { SyncPill } from './syncPill';
import { countWords, deriveTitle, fileName, readingTime } from './text';
import { currentTheme, toggleTheme } from './theme';
import { dismiss, toast } from './toast';

const OFFLINE_TOAST = "You're offline · edits are saved on this device";

export type SessionOpener = (docId: string) => Promise<DocSession>;

interface OpenDoc {
  id: string;
  session: DocSession;
  editor: EditorHandle;
  unsubs: (() => void)[];
  title: string | null;
  peers: Peer[];
  sync: SyncState;
  words: number;
}

const finePointer = window.matchMedia('(pointer: fine)');

export class App {
  private root: HTMLElement;
  private titleEl = h('h1', { class: 'doc-title is-untitled' }, 'Untitled');
  private presence: Presence;
  private pill: SyncPill;
  private shareBtn: HTMLButtonElement;
  private column = h('div', { class: 'column' });
  private editorHost = h('div', { class: 'weft-editor editor-host' });
  private emptyEl = h('div', { class: 'empty-state', hidden: true });
  private footer = h('footer', { class: 'footer', 'aria-label': 'Document stats' });
  private palette = new Palette();
  private share = new SharePopover();
  private history: HistoryPanel;
  private doc: OpenDoc | null = null;
  private openSeq = 0;
  private focusMode = false;
  private metaTimer = 0;
  private lastRecentWrite = 0;
  private offlineSince: number | null = null;
  private maxUnsynced = 0;
  private everLive = false;
  private pointer = { x: 0, y: 0 };

  constructor(
    mount: HTMLElement,
    private openSession: SessionOpener,
  ) {
    this.presence = new Presence({
      onJump: (p) => this.jumpTo(p),
      onSelf: () => this.rename(),
      lineOf: (pos) => {
        const view = this.doc?.editor.view;
        if (!view) return null;
        return view.state.doc.lineAt(Math.min(pos, view.state.doc.length)).number;
      },
    });
    this.pill = new SyncPill(() => this.doc?.session.reconnect());
    this.shareBtn = h(
      'button',
      {
        class: 'btn btn--outline',
        type: 'button',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        onclick: () => this.openShare(),
      },
      icon('share'),
      h('span', { class: 'hide-narrow' }, 'Share'),
    );
    const paletteBtn = h(
      'button',
      {
        class: 'btn btn--icon',
        type: 'button',
        'aria-label': `Commands (${shortcut('K')})`,
        'data-tip': `Commands  ${shortcut('K')}`,
        'data-tip-align': 'end',
        onclick: () => this.openPalette(),
      },
      icon('command'),
    );
    const brand = h('a', { class: 'brand', href: '/', 'aria-label': 'Weft: new document', 'data-tip': 'New doc' });
    brand.innerHTML = logoSvg;
    brand.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      this.newDoc();
    });
    this.titleEl.addEventListener('click', () =>
      window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }),
    );

    const topbar = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'topbar__left' }, brand, this.titleEl),
      h('div', { class: 'topbar__right' }, this.presence.el, this.pill.el, this.shareBtn, paletteBtn),
    );
    const surface = h('main', { class: 'surface', id: 'main' }, this.column);
    this.column.append(this.editorHost, this.emptyEl);

    this.history = new HistoryPanel({
      previewParent: surface,
      onOpenChange: (open) => {
        // On <body> so the toasts (appended to body) can move out of the scrubber's way too.
        document.body.classList.toggle('has-history', open);
        if (open) window.scrollTo({ top: 0 });
      },
      onRestored: (step) => toast(`Restored version from step ${step}`, { icon: 'restore' }),
    });

    this.root = h('div', { class: 'app' }, topbar, surface, this.footer, this.history.bar, this.share.el, this.palette.el);
    mount.replaceChildren(this.root);

    this.bindGlobalKeys();
    window.addEventListener('popstate', () => this.route());
    window.addEventListener('scroll', () => this.root.classList.toggle('is-scrolled', window.scrollY > 4), {
      passive: true,
    });
    window.addEventListener('mousemove', (e) => this.onPointerMove(e), { passive: true });
  }

  // ---------- Routing / doc lifecycle ----------

  route(): void {
    const r = parseRoute(location.pathname);
    if (r.kind === 'new') {
      const id = newSlug();
      history.replaceState(null, '', docPath(id));
      void this.openDoc(id);
    } else if (r.kind === 'doc') {
      if (this.doc?.id !== r.id) void this.openDoc(r.id);
    } else {
      this.closeDoc();
      this.showError(
        "This link doesn't lead to a doc",
        'Doc links look like /d/ followed by letters, numbers, - or _. Check the link, or start a fresh doc.',
        `"${r.raw.slice(0, 80)}"`,
        false,
      );
    }
  }

  newDoc(): void {
    const id = newSlug();
    history.pushState(null, '', docPath(id));
    void this.openDoc(id);
  }

  goTo(id: string): void {
    if (this.doc?.id === id) return;
    history.pushState(null, '', docPath(id));
    void this.openDoc(id);
  }

  private closeDoc(): void {
    this.history.close();
    this.share.close(false);
    this.palette.close();
    const d = this.doc;
    this.doc = null;
    if (!d) return;
    this.flushMeta(d);
    d.unsubs.forEach((u) => u());
    d.editor.destroy();
    d.session.destroy();
  }

  async openDoc(id: string): Promise<void> {
    this.closeDoc();
    const seq = ++this.openSeq;
    this.offlineSince = null;
    this.maxUnsynced = 0;
    this.everLive = false;
    this.setTitle(null);
    this.footer.replaceChildren();
    this.presence.render([]);
    this.pill.update({ status: 'connecting', unsyncedEdits: 0, lastSyncedAt: null });
    this.pill.el.hidden = false;
    this.emptyEl.hidden = true;
    this.editorHost.replaceChildren(h('div', { class: 'loading' }, 'Opening…'));

    let session: DocSession;
    try {
      session = await this.openSession(id);
    } catch (err) {
      if (seq !== this.openSeq) return;
      console.error('[weft] could not open session', err);
      this.showError(
        "Weft can't open this doc right now",
        'The sync engine failed to start in this browser. Nothing you wrote is lost: anything saved here stays on this device.',
        err instanceof Error ? err.message : String(err),
        true,
      );
      return;
    }
    if (seq !== this.openSeq) {
      session.destroy();
      return;
    }

    this.editorHost.replaceChildren();
    const editor = createEditor({
      parent: this.editorHost,
      doc: session.getText(),
      sessionExtensions: session.editorExtensions(),
      placeholder: 'Start writing…',
      onUpdate: (u) => this.onEditorUpdate(u),
    });
    const doc: OpenDoc = {
      id,
      session,
      editor,
      unsubs: [],
      title: null,
      peers: [],
      sync: { status: 'connecting', unsyncedEdits: 0, lastSyncedAt: null },
      words: 0,
    };
    this.doc = doc;
    doc.unsubs.push(session.onSyncState((s) => this.onSync(doc, s)));
    doc.unsubs.push(
      session.onPeers((peers) => {
        doc.peers = peers;
        this.presence.render(peers);
        this.renderFooter(doc);
      }),
    );
    editor.setFocusMode(this.focusMode);
    this.flushMeta(doc);
    if (finePointer.matches) editor.view.focus();
  }

  private showError(title: string, body: string, detail: string, canRetry: boolean): void {
    this.setTitle(null);
    this.emptyEl.hidden = true;
    const mockHref = `${location.pathname}?mock`;
    this.editorHost.replaceChildren(
      h(
        'section',
        { class: 'error-state', role: 'alert' },
        h('h2', null, title),
        h('p', null, body),
        detail ? h('p', { class: 'error-state__detail' }, detail) : null,
        h(
          'div',
          { class: 'error-state__actions' },
          canRetry
            ? h(
                'button',
                {
                  class: 'btn btn--primary',
                  type: 'button',
                  onclick: () => {
                    const r = parseRoute(location.pathname);
                    if (r.kind === 'doc') void this.openDoc(r.id);
                  },
                },
                'Try again',
              )
            : null,
          h('button', { class: 'btn btn--outline', type: 'button', onclick: () => this.newDoc() }, icon('plus'), 'New doc'),
          canRetry && !location.search.includes('mock')
            ? h('a', { class: 'btn', href: mockHref }, 'Try the offline demo')
            : null,
        ),
      ),
    );
    this.pill.el.hidden = true;
    this.presence.render([]);
  }

  // ---------- Editor + session events ----------

  private onEditorUpdate(u: ViewUpdate): void {
    if (!u.docChanged) return;
    const local = u.transactions.some(
      (tr) => tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move') || tr.isUserEvent('undo') || tr.isUserEvent('redo'),
    );
    // Chrome fades while typing, and comes back when the mouse moves. Touch screens have no hover, so skip it there.
    if (local && finePointer.matches && !this.root.classList.contains('is-typing')) this.root.classList.add('is-typing');
    clearTimeout(this.metaTimer);
    this.metaTimer = window.setTimeout(() => this.doc && this.flushMeta(this.doc), 150);
  }

  private onPointerMove(e: MouseEvent): void {
    const dx = e.clientX - this.pointer.x;
    const dy = e.clientY - this.pointer.y;
    this.pointer = { x: e.clientX, y: e.clientY };
    if (dx * dx + dy * dy > 16) this.root.classList.remove('is-typing');
  }

  /** Recompute everything derived from the text: title, stats, empty state, recents. */
  private flushMeta(doc: OpenDoc): void {
    const text = doc.editor.view.state.doc.toString();
    const title = deriveTitle(text);
    if (doc === this.doc) {
      if (title !== doc.title || this.titleEl.classList.contains('is-untitled') !== !title) this.setTitle(title);
      doc.words = countWords(text);
      this.renderFooter(doc);
      const empty = text.trim() === '';
      if (empty && this.emptyEl.hidden) renderEmptyState(this.emptyEl, doc.id, (id) => this.goTo(id));
      this.emptyEl.hidden = !empty;
    }
    doc.title = title;
    const now = Date.now();
    if (text.trim() && (now - this.lastRecentWrite > 2000 || doc !== this.doc)) {
      this.lastRecentWrite = now;
      touchRecent(doc.id, title ?? 'Untitled');
    }
  }

  private setTitle(title: string | null): void {
    this.titleEl.textContent = title ?? 'Untitled';
    this.titleEl.classList.toggle('is-untitled', !title);
    this.titleEl.title = title ?? '';
    document.title = title ? `${title} · Weft` : 'Weft';
  }

  private renderFooter(doc: OpenDoc): void {
    const words = doc.words;
    const others = doc.peers.filter((p) => !p.isSelf).length;
    if (words === 0 && others === 0) {
      this.footer.replaceChildren();
      return;
    }
    const parts: string[] = [`${words.toLocaleString()} word${words === 1 ? '' : 's'}`];
    const rt = readingTime(words);
    if (rt) parts.push(rt);
    if (others > 0) parts.push(`${others + 1} here`);
    const nodes: (Node | string)[] = [];
    parts.forEach((p, i) => {
      if (i) nodes.push(h('span', { class: 'footer__sep', 'aria-hidden': 'true' }, '·'));
      nodes.push(h('span', null, p));
    });
    this.footer.replaceChildren(...nodes);
  }

  private onSync(doc: OpenDoc, s: SyncState): void {
    const prev = doc.sync;
    doc.sync = s;
    this.pill.update(s);
    const disconnected = s.status === 'offline' || s.status === 'reconnecting' || s.status === 'error';
    if (s.status === 'live' && s.unsyncedEdits === 0) {
      if (this.offlineSince !== null && this.everLive) {
        const n = this.maxUnsynced;
        dismiss(OFFLINE_TOAST);
        toast(n > 0 ? `Back online · synced ${n} edit${n === 1 ? '' : 's'}` : 'Back online', { icon: 'check' });
      }
      this.offlineSince = null;
      this.maxUnsynced = 0;
      this.everLive = true;
    } else if (disconnected) {
      if (this.offlineSince === null && this.everLive) {
        this.offlineSince = Date.now();
        if (s.status === 'offline' && prev.status === 'live') {
          toast(OFFLINE_TOAST, { icon: 'wifiOff', duration: 3600 });
        }
      }
    }
    if (this.offlineSince !== null) this.maxUnsynced = Math.max(this.maxUnsynced, s.unsyncedEdits);
  }

  // ---------- Commands ----------

  openPalette(): void {
    if (this.palette.isOpen) {
      this.palette.close();
      return;
    }
    this.share.close(false);
    this.palette.open(buildCommands(this));
  }

  get currentId(): string | null {
    return this.doc?.id ?? null;
  }

  get peers(): Peer[] {
    return this.doc?.peers ?? [];
  }

  get isFocusMode(): boolean {
    return this.focusMode;
  }

  get theme() {
    return currentTheme();
  }

  get hasDoc(): boolean {
    return this.doc !== null;
  }

  async copyLink(): Promise<void> {
    if (!this.doc) return;
    try {
      await copyText(docUrl(this.doc.id));
      toast('Link copied', { icon: 'check' });
    } catch {
      this.openShare();
    }
  }

  openShare(): void {
    if (!this.doc) return;
    this.palette.close();
    this.share.toggle(this.shareBtn, docUrl(this.doc.id));
  }

  exportMarkdown(): void {
    if (!this.doc) return;
    const text = this.doc.editor.view.state.doc.toString();
    const name = fileName(this.doc.title);
    downloadMarkdown(text, name);
    toast(`Downloaded ${name}`, { icon: 'download' });
  }

  async copyAsHtml(): Promise<void> {
    if (!this.doc) return;
    try {
      await copyHtml(this.doc.editor.view.state.doc.toString());
      toast('HTML copied', { icon: 'check' });
    } catch {
      toast("Couldn't access the clipboard");
    }
  }

  toggleTheme(): void {
    toggleTheme();
  }

  toggleFocus(): void {
    this.focusMode = !this.focusMode;
    this.root.classList.toggle('is-focus', this.focusMode);
    this.doc?.editor.setFocusMode(this.focusMode);
    if (this.focusMode) toast('Focus mode · Esc to exit', { icon: 'focus', duration: 2000 });
    this.doc?.editor.view.focus();
  }

  openHistory(): void {
    if (!this.doc) return;
    this.palette.close();
    this.share.close(false);
    this.history.toggle(this.doc.session);
  }

  rename(): void {
    const session = this.doc?.session;
    if (!session) return;
    const user = session.getUser();
    this.palette.ask({
      placeholder: 'Your name, as others see it',
      initial: user.name,
      action: (v) => `Rename yourself to “${v}”`,
      onSubmit: (name) => {
        session.setUser({ ...session.getUser(), name: name.slice(0, 40) });
        toast(`You're now ${name.slice(0, 40)}`, { icon: 'user' });
      },
    });
  }

  changeColor(): void {
    const session = this.doc?.session;
    if (!session) return;
    this.palette.open(
      colorItems(session.getUser().color, (color) => {
        session.setUser({ ...session.getUser(), color });
      }),
      'Pick your cursor color…',
    );
  }

  shuffleIdentity(): void {
    const session = this.doc?.session;
    if (!session) return;
    const user = randomUser();
    session.setUser(user);
    toast(`You're now ${user.name}`, { icon: 'user' });
  }

  jumpTo(peer: Peer): void {
    const view = this.doc?.editor.view;
    if (!view) return;
    if (this.history.isOpen) this.history.close();
    // Palette items capture a peer snapshot; use the freshest cursor we know.
    peer = this.peers.find((p) => p.clientId === peer.clientId) ?? peer;
    if (peer.cursor === null) {
      toast(`${peer.name} hasn't placed a cursor yet`);
      return;
    }
    scrollToAndFlash(view, peer.cursor, peer.color);
  }

  // ---------- Keyboard ----------

  private bindGlobalKeys(): void {
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.defaultPrevented && e.key !== 'Escape') return;
        const key = e.key.toLowerCase();
        if (isModKey(e) && !e.altKey && key === 'k') {
          e.preventDefault();
          this.openPalette();
        } else if (isModKey(e) && !e.altKey && e.shiftKey && key === 'f') {
          e.preventDefault();
          this.toggleFocus();
        } else if (isModKey(e) && !e.altKey && !e.shiftKey && key === 's') {
          e.preventDefault();
          const s = this.doc?.sync;
          toast(
            s?.status === 'live' ? 'Weft saves as you type · everything is synced' : 'Weft saves as you type · stored on this device',
            { icon: 'check' },
          );
        } else if (key === 'escape' && !this.palette.isOpen) {
          // The share popover and history bar handle their own Escape (e.g. cancel a confirm first).
          const t = e.target as Node;
          if (this.share.el.contains(t) || this.history.bar.contains(t)) return;
          if (this.share.isOpen) this.share.close(true);
          else if (this.history.isOpen) this.history.close();
          else if (this.focusMode) this.toggleFocus();
          else this.root.classList.remove('is-typing');
        }
      },
      true,
    );
  }
}
