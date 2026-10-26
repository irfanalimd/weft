// The app shell: knows who is signed in, owns routing and swaps the views (Wall, editor, admin,
// sign-in/setup). Views talk back through the Host interface (host.ts).

import { api, errorMessage, onUnauthorized, type Note, type User } from '../api';
import { clearLocalNotes } from '../sync/index';
import { changePasswordDialog } from './account';
import { AdminView } from './admin';
import { App, type SessionOpener } from './app';
import { setupPage, signInPage } from './auth';
import { h } from './dom';
import type { Host } from './host';
import { confirmDialog } from './modal';
import { NotesStore } from './notes';
import { Palette } from './palette';
import { docPath, newNoteId, newSlug, notePath, parseRoute, withFlags } from './router';
import { readJson, writeJson } from './storage';
import { toast } from './toast';
import { WallView } from './wall';

const ME_KEY = 'weft:me';

interface CachedMe {
  user: User;
  anonymous_docs: boolean;
}

type ViewKind = 'app' | 'wall' | 'admin' | 'page';

export class Shell implements Host {
  me: User | null = null;
  anonymousDocs = true;
  private setupRequired = false;
  private notice: string | null = null;
  private store: NotesStore | null = null;
  private wall: WallView | null = null;
  private admin: AdminView | null = null;
  private app: App | null = null;
  private view: ViewKind | null = null;
  private palette = new Palette();
  private bridge: HTMLInputElement | null = null;
  private bridgeTimer = 0;
  private cameFromWall = false;
  private focusSearchNext = false;

  constructor(
    private mount: HTMLElement,
    private opener: SessionOpener,
  ) {
    document.body.append(this.palette.el);
    window.addEventListener('popstate', () => this.render());
    onUnauthorized(() => this.lostSession());
  }

  /** First paint: from the cached user if we have one (instant, works offline), then confirm with the server. */
  async boot(): Promise<void> {
    const cached = readJson<CachedMe | null>(ME_KEY, null);
    if (cached?.user && typeof cached.user.id === 'number') {
      this.setUser(cached.user);
      this.anonymousDocs = cached.anonymous_docs !== false;
      this.render();
      void this.checkStatus();
      return;
    }
    await this.checkStatus();
    this.render();
  }

  private async checkStatus(): Promise<void> {
    try {
      const s = await api.status();
      const before = JSON.stringify([this.me, this.anonymousDocs, this.setupRequired]);
      this.setupRequired = s.setup_required;
      this.anonymousDocs = s.anonymous_docs;
      this.setUser(s.user);
      if (JSON.stringify([this.me, this.anonymousDocs, this.setupRequired]) !== before) this.render();
    } catch (e) {
      // Offline (or the server is down): keep whatever we know.
      console.warn('[weft] status check failed', e);
      if (!this.me) this.notice = errorMessage(e);
    }
  }

  private setUser(user: User | null): void {
    const prevId = this.me?.id;
    this.me = user;
    if (user) writeJson(ME_KEY, { user, anonymous_docs: this.anonymousDocs } satisfies CachedMe);
    else {
      try {
        localStorage.removeItem(ME_KEY);
      } catch {
        /* ignore */
      }
    }
    if (user?.id !== prevId || !user) {
      if (user?.id !== this.store?.userId) {
        this.store?.dispose();
        this.store = user ? new NotesStore(user.id) : null;
      }
      this.wall?.unmount();
      this.wall = null;
      this.admin = null;
    }
  }

  // ---------- routing ----------

  navigate(path: string, opts: { replace?: boolean } = {}): void {
    const url = path.includes('?') ? path : withFlags(path);
    if (url === location.pathname + location.search && !opts.replace) return this.render();
    if (opts.replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
    this.render();
  }

  private render(): void {
    const r = parseRoute(location.pathname);
    const anon = r.kind === 'doc' || r.kind === 'new-doc';
    if (this.setupRequired && !anon && r.kind !== 'setup') return this.navigate('/setup', { replace: true });
    switch (r.kind) {
      case 'setup':
        if (!this.setupRequired) return this.navigate('/', { replace: true });
        return this.showPage(setupPage({ onDone: (u) => this.signedIn(u) }));
      case 'home':
        return this.me ? this.showWall() : this.showSignIn();
      case 'admin':
        if (!this.me) return this.showSignIn();
        if (this.me.role !== 'admin') return this.navigate('/', { replace: true });
        return this.showAdmin();
      case 'new-note':
        if (!this.me) return this.showSignIn();
        return this.newNote({ replace: true });
      case 'note':
        if (!this.me) return this.showSignIn();
        return this.showApp((app) => app.show('note', r.id));
      case 'doc':
        if (!this.anonymousDocs) {
          return this.showApp((app) =>
            app.showMessage('doc', 'Temporary docs are turned off', 'This server only keeps private notes. Sign in to write on your wall.'),
          );
        }
        return this.showApp((app) => app.show('doc', r.id));
      case 'new-doc':
        return this.navigate(docPath(newSlug()), { replace: true });
      case 'invalid':
        return this.showApp((app) =>
          app.showMessage(
            r.what,
            r.what === 'note' ? "This link doesn't lead to a note" : "This link doesn't lead to a doc",
            r.what === 'note'
              ? 'Note links look like /n/ followed by 16 letters and numbers. Check the link.'
              : 'Doc links look like /d/ followed by letters, numbers, - or _. Check the link, or start a fresh doc.',
            `"${r.raw.slice(0, 80)}"`,
          ),
        );
      case 'not-found':
        return this.showPage(this.notFound());
    }
  }

  private switchTo(kind: ViewKind, el: HTMLElement): boolean {
    const same = this.view === kind && this.mount.firstElementChild === el;
    if (!same) {
      if (this.view === 'wall') this.wall?.unmount();
      if (this.view === 'admin') this.admin?.unmount();
      if (this.view === 'app' && kind !== 'app') this.app?.close();
      this.palette.close();
      this.mount.replaceChildren(el);
      window.scrollTo(0, 0);
    }
    this.cameFromWall = this.view === 'wall' && kind !== 'wall';
    this.view = kind;
    document.documentElement.dataset.view = kind;
    return !same;
  }

  private showPage(el: HTMLElement): void {
    this.switchTo('page', el);
  }

  private showSignIn(): void {
    document.title = 'Sign in · Weft';
    this.showPage(
      signInPage({
        anonymousDocs: this.anonymousDocs,
        notice: this.notice,
        onSignedIn: (u) => this.signedIn(u),
        onTempDoc: () => this.newTempDoc(),
      }),
    );
  }

  private showWall(): void {
    if (!this.me || !this.store) return this.showSignIn();
    this.wall ??= new WallView(this, this.store, this.palette);
    const search = this.focusSearchNext;
    this.focusSearchNext = false;
    if (this.switchTo('wall', this.wall.el)) this.wall.mount({ search });
    else if (search) this.wall.focusSearch();
  }

  private showAdmin(): void {
    this.admin ??= new AdminView(this);
    if (this.switchTo('admin', this.admin.el)) this.admin.mount();
  }

  private showApp(run: (app: App) => void): void {
    this.app ??= new App(this.opener, this, this.palette);
    this.switchTo('app', this.app.el);
    run(this.app);
  }

  private notFound(): HTMLElement {
    document.title = 'Not found · Weft';
    return h(
      'div',
      { class: 'auth' },
      h(
        'main',
        { class: 'auth__card auth__card--plain', id: 'main' },
        h('h1', { class: 'auth__title' }, 'Nothing here'),
        h('p', { class: 'auth__sub' }, "That page doesn't exist."),
        h('a', { class: 'btn btn--primary btn--block', href: '/', onclick: (e: MouseEvent) => (e.preventDefault(), this.navigate('/')) }, 'Go home'),
      ),
    );
  }

  // ---------- auth ----------

  private signedIn(u: User): void {
    this.notice = null;
    this.setupRequired = false;
    this.setUser(u);
    if (parseRoute(location.pathname).kind === 'setup') this.navigate('/', { replace: true });
    else this.render();
    toast(`Welcome, ${u.username}`, { icon: 'user' });
  }

  private lostSession(): void {
    if (!this.me) return;
    this.setUser(null);
    this.notice = 'Your session ended. Sign in again to keep going.';
    this.render();
  }

  async signOut(): Promise<void> {
    const store = this.store;
    if (store && store.pendingCount > 0) {
      const ok = await confirmDialog({
        title: 'Sign out?',
        body: `${store.pendingCount} new note${store.pendingCount === 1 ? " hasn't" : "s haven't"} reached the server yet and will be lost.`,
        confirm: 'Sign out anyway',
        danger: true,
      });
      if (!ok) return;
    }
    if (this.view === 'app') this.app?.close();
    try {
      await api.logout();
    } catch {
      /* offline: the cookie still gets dropped server-side when it expires */
    }
    store?.wipe();
    this.store = null;
    await clearLocalNotes();
    this.notice = null;
    this.setUser(null);
    this.navigate('/', { replace: true });
    toast('Signed out', { icon: 'logout' });
  }

  // ---------- Host ----------

  newNote(opts: { replace?: boolean } = {}): void {
    if (!this.me || !this.store) return;
    this.openBridge();
    const id = newNoteId();
    this.store.create(id);
    this.navigate(notePath(id), opts);
  }

  newTempDoc(): void {
    this.navigate(docPath(newSlug()));
  }

  goWall(opts: { search?: boolean } = {}): void {
    this.focusSearchNext = !!opts.search;
    if (this.view === 'wall') return this.showWall();
    if (this.cameFromWall && history.length > 1) {
      history.back();
      return;
    }
    this.navigate('/');
  }

  openAdmin(): void {
    this.navigate('/admin');
  }

  changePassword(): void {
    changePasswordDialog(this);
  }

  async saveDocToWall(slug: string): Promise<void> {
    if (!this.me || !this.store) return;
    const id = newNoteId();
    try {
      const note = await api.createNote({ id, from_doc: slug });
      this.store.adopt(note);
      this.navigate(notePath(id));
      toast('Saved to your wall · this copy is private', { icon: 'check' });
    } catch (e) {
      toast(`Couldn't save: ${errorMessage(e)}`);
    }
  }

  async beforeOpenNote(id: string): Promise<void> {
    await this.store?.ensureCreated(id);
  }

  noteEdited(id: string, text: string): void {
    this.store?.noteEdited(id, text);
  }

  async noteRefused(id: string, status: 401 | 403 | 404): Promise<boolean> {
    if (status === 401) {
      this.lostSession();
      return false;
    }
    if (status === 404 && this.store?.isPending(id)) return this.store.ensureCreated(id, 8000);
    return false;
  }

  recentNotes(): Note[] {
    return this.store?.list('all') ?? [];
  }

  /**
   * Phones only show the keyboard for a focus() inside a user gesture, and the editor isn't ready
   * until the note opens. So focus a hidden input now; the editor takes over (and its contents) once ready.
   */
  private openBridge(): void {
    this.bridge?.remove();
    const input = h('input', {
      class: 'keyboard-bridge',
      type: 'text',
      'aria-hidden': 'true',
      tabindex: '-1',
      autocomplete: 'off',
      autocapitalize: 'sentences',
    });
    document.body.append(input);
    input.focus({ preventScroll: true });
    this.bridge = input;
    clearTimeout(this.bridgeTimer);
    this.bridgeTimer = window.setTimeout(() => {
      if (this.bridge === input) this.bridge = null;
      input.remove();
    }, 4000);
  }

  takeKeyboardBridge(): HTMLInputElement | null {
    const b = this.bridge;
    this.bridge = null;
    return b?.isConnected ? b : null;
  }
}
