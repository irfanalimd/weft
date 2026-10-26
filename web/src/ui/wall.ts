// The Wall: your notes as a masonry grid of cards, with search, filters and quick actions.
// Paints from the local cache first, then refreshes from the server.

import { errorMessage, NOTE_COLORS, type Note, type NoteColor, type NoteFilter } from '../api';
import { warmUp } from '../sync/index';
import { openAccountMenu } from './account';
import { accountCommands, byGroup, noteItems, themeItem } from './commands';
import { h, isModKey, relativeTime, shortcut } from './dom';
import type { Host } from './host';
import { icon, logoSvg } from './icons';
import { openMenu, type MenuItem } from './modal';
import { cardPreview, type NotesStore } from './notes';
import type { Palette } from './palette';
import { notePath } from './router';
import { initials } from './text';
import { currentTheme, toggleTheme } from './theme';
import { toast } from './toast';

export const COLOR_NAMES: Record<NoteColor, string> = {
  default: 'Default',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  gray: 'Gray',
};

const FILTERS: { key: NoteFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pinned', label: 'Pinned' },
  { key: 'archived', label: 'Archived' },
];

const GAP = 12;
const MIN_CARD = 232;
const LONG_PRESS_MS = 450;
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

/** Cards distributed into columns, each card going to the currently shortest column (keeps reading order). */
class Masonry {
  readonly el = h('div', { class: 'grid' });
  private cols: HTMLElement[] = [];
  private items: HTMLElement[] = [];
  private width = 0;

  constructor() {
    new ResizeObserver(() => {
      const w = this.el.clientWidth;
      if (w && this.columnCount(w) !== this.cols.length) this.layout();
      this.width = w;
    }).observe(this.el);
  }

  private columnCount(w: number): number {
    if (w < 560) return 2;
    return Math.max(2, Math.min(6, Math.floor((w + GAP) / (MIN_CARD + GAP))));
  }

  set(items: HTMLElement[]): void {
    this.items = items;
    this.layout();
  }

  layout(): void {
    const w = this.el.clientWidth || this.width || window.innerWidth;
    const n = this.columnCount(w);
    if (this.cols.length !== n) {
      this.cols = Array.from({ length: n }, () => h('div', { class: 'grid__col' }));
      this.el.replaceChildren(...this.cols);
    }
    for (const c of this.cols) c.replaceChildren();
    if (!this.el.isConnected) {
      this.items.forEach((it, i) => this.cols[i % n].append(it));
      return;
    }
    const heights = new Array<number>(n).fill(0);
    for (const it of this.items) {
      let i = 0;
      for (let k = 1; k < n; k++) if (heights[k] < heights[i] - 1) i = k;
      this.cols[i].append(it);
      heights[i] += it.offsetHeight + GAP;
    }
  }
}

export class WallView {
  readonly el: HTMLElement;
  private filter: NoteFilter = 'all';
  private query = '';
  private results: { q: string; notes: Note[]; local: boolean } | null = null;
  private searchSeq = 0;
  private searchTimer = 0;
  private cards = new Map<string, { el: HTMLElement; sig: string; time: HTMLTimeElement }>();
  private pinned = new Masonry();
  private others = new Masonry();
  private pinnedSection: HTMLElement;
  private othersSection: HTMLElement;
  private othersHeading: HTMLElement;
  private emptyEl = h('div', { class: 'wall-empty', hidden: true });
  private searchInput: HTMLInputElement;
  private clearBtn: HTMLButtonElement;
  private chips: HTMLButtonElement[] = [];
  private offlineEl = h('span', { class: 'wall-offline', hidden: true, 'data-tip': 'Showing notes saved on this device' }, icon('wifiOff'), h('span', null, 'Offline'));
  private avatarBtn: HTMLButtonElement;
  private unsub: (() => void) | null = null;
  private tick = 0;
  private lastRefresh = 0;
  private suppressClick = false;
  private menuOpen = false;

  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') this.refresh();
  };
  private readonly onFocus = () => this.refresh();
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);
  private readonly onScroll = () => this.el.classList.toggle('is-scrolled', window.scrollY > 4);

  constructor(
    private host: Host,
    private store: NotesStore,
    private palette: Palette,
  ) {
    const brand = h('a', { class: 'brand wall-brand', href: '/', 'aria-label': 'Weft' });
    brand.innerHTML = logoSvg;
    brand.append(h('span', { class: 'wall-brand__name' }, 'Weft'));
    brand.addEventListener('click', (e) => {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    this.searchInput = h('input', {
      class: 'search__input',
      type: 'search',
      placeholder: 'Search your notes',
      'aria-label': 'Search your notes',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
    });
    this.clearBtn = h('button', { class: 'btn btn--icon search__clear', type: 'button', 'aria-label': 'Clear search', hidden: true }, icon('x'));
    const search = h('div', { class: 'search', role: 'search' }, icon('search', 'icon search__icon'), this.searchInput, this.clearBtn);
    this.searchInput.addEventListener('input', () => this.onSearchInput());
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.setQuery('');
        this.searchInput.blur();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(this.searchTimer);
        void this.runSearch();
        if (!finePointer.matches) this.searchInput.blur(); // put the keyboard away to show results
      }
    });
    this.clearBtn.addEventListener('click', () => {
      this.setQuery('');
      this.searchInput.focus();
    });

    const me = host.me!;
    this.avatarBtn = h(
      'button',
      { class: 'account-btn', type: 'button', 'aria-label': `Account: ${me.username}`, 'aria-haspopup': 'menu' },
      initials(me.username),
    );
    this.avatarBtn.addEventListener('click', () => openAccountMenu(host, this.avatarBtn));

    const paletteBtn = h(
      'button',
      { class: 'btn btn--icon hide-narrow-flex', type: 'button', 'aria-label': `Commands (${shortcut('K')})`, 'data-tip': `Commands  ${shortcut('K')}`, onclick: () => this.openPalette() },
      icon('command'),
    );

    const chipRow = h('div', { class: 'chips', role: 'group', 'aria-label': 'Show' });
    for (const f of FILTERS) {
      const b = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(f.key === this.filter), 'data-filter': f.key }, f.label);
      b.addEventListener('click', () => this.setFilter(f.key));
      this.chips.push(b);
      chipRow.append(b);
    }
    chipRow.append(this.offlineEl);

    const top = h(
      'header',
      { class: 'wall-top' },
      h('div', { class: 'wall-bar' }, brand, search, paletteBtn, this.avatarBtn),
      chipRow,
    );

    const composer = h(
      'button',
      { class: 'composer', type: 'button', 'aria-label': 'Take a note' },
      h('span', { class: 'composer__text' }, 'Take a note…'),
      h('span', { class: 'kbd composer__kbd', 'aria-hidden': 'true' }, 'N'),
      icon('plus', 'icon composer__icon'),
    );
    composer.addEventListener('click', () => host.newNote());

    this.othersHeading = h('h2', { class: 'wall-heading' }, 'Others');
    this.pinnedSection = h('section', { class: 'wall-section', 'aria-label': 'Pinned notes' }, h('h2', { class: 'wall-heading' }, icon('pin'), 'Pinned'), this.pinned.el);
    this.othersSection = h('section', { class: 'wall-section', 'aria-label': 'Notes' }, this.othersHeading, this.others.el);

    const main = h('main', { class: 'wall-main', id: 'main' }, composer, this.pinnedSection, this.othersSection, this.emptyEl);
    main.addEventListener('click', (e) => this.onClick(e));
    main.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.bindLongPress(main);

    const fab = h('button', { class: 'fab', type: 'button', 'aria-label': 'New note' }, icon('plus'));
    fab.addEventListener('click', () => host.newNote());

    this.el = h('div', { class: 'wall' }, top, main, fab);
  }

  mount(opts: { search?: boolean } = {}): void {
    warmUp();
    this.unsub = this.store.on(() => this.render());
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('focus', this.onFocus);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('scroll', this.onScroll, { passive: true });
    this.tick = window.setInterval(() => this.updateTimes(), 30_000);
    document.title = 'Weft';
    this.render();
    this.refresh(true);
    if (opts.search) this.focusSearch();
  }

  unmount(): void {
    this.unsub?.();
    this.unsub = null;
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('focus', this.onFocus);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('scroll', this.onScroll);
    clearInterval(this.tick);
  }

  focusSearch(): void {
    this.searchInput.focus();
    this.searchInput.select();
  }

  private refresh(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastRefresh < 4000) return;
    this.lastRefresh = now;
    this.store.refresh(this.filter).catch((e) => console.warn('[weft] wall refresh failed', e));
    if (this.query) void this.runSearch();
  }

  // ---------- filters + search ----------

  private setFilter(f: NoteFilter): void {
    if (f === this.filter) return;
    this.filter = f;
    for (const c of this.chips) c.setAttribute('aria-pressed', String(c.dataset.filter === f));
    this.results = null;
    this.render();
    this.refresh(true);
  }

  private setQuery(q: string): void {
    this.searchInput.value = q;
    this.onSearchInput();
  }

  private onSearchInput(): void {
    const q = this.searchInput.value;
    this.query = q.trim();
    this.clearBtn.hidden = !q;
    clearTimeout(this.searchTimer);
    if (!this.query) {
      this.results = null;
      this.searchSeq++;
      this.render();
      return;
    }
    // Instant local matches while the server's full-text search is on its way.
    this.results = { q: this.query, notes: this.store.searchLocal(this.query, this.filter), local: true };
    this.render();
    this.searchTimer = window.setTimeout(() => void this.runSearch(), 250);
  }

  private async runSearch(): Promise<void> {
    const q = this.query;
    if (!q) return;
    const seq = ++this.searchSeq;
    try {
      const r = await this.store.search(q, this.filter);
      if (seq !== this.searchSeq) return;
      this.results = { q, ...r };
      this.render();
    } catch (e) {
      if (seq === this.searchSeq) toast(errorMessage(e));
    }
  }

  // ---------- rendering ----------

  private render(): void {
    this.offlineEl.hidden = this.store.online !== false;
    let pinned: Note[] = [];
    let others: Note[];
    if (this.results) {
      others = this.results.notes;
    } else {
      const list = this.store.list(this.filter);
      if (this.filter === 'all') {
        pinned = list.filter((n) => n.pinned);
        others = list.filter((n) => !n.pinned);
      } else others = list;
    }
    this.pinnedSection.hidden = pinned.length === 0;
    this.othersSection.hidden = others.length === 0;
    this.othersHeading.hidden = !this.results && pinned.length === 0;
    this.othersHeading.textContent = this.results
      ? `${others.length} result${others.length === 1 ? '' : 's'}${this.results.local ? ' on this device' : ''}`
      : 'Others';
    this.el.classList.toggle('is-searching', !!this.results);

    const keep = new Set<string>();
    const cardsFor = (list: Note[]) =>
      list.map((n) => {
        keep.add(n.id);
        return this.card(n);
      });
    this.pinned.set(cardsFor(pinned));
    this.others.set(cardsFor(others));
    for (const id of this.cards.keys()) if (!keep.has(id)) this.cards.delete(id);

    const empty = pinned.length + others.length === 0;
    this.emptyEl.hidden = !empty;
    if (empty) this.renderEmpty();
  }

  private renderEmpty(): void {
    let title: string;
    let body: string;
    if (this.results) {
      title = 'No matching notes';
      body = this.results.local ? `Nothing on this device matches “${this.results.q}”.` : `Nothing matches “${this.results.q}”.`;
    } else if (this.filter === 'pinned') {
      title = 'No pinned notes';
      body = 'Pin the notes you need most and they stay at the top.';
    } else if (this.filter === 'archived') {
      title = 'Nothing archived';
      body = 'Archive notes you want to keep but not see every day.';
    } else {
      title = 'Your wall is empty';
      body = finePointer.matches ? 'Click “Take a note…” or press N, then just type.' : 'Tap + and start typing. Every note saves itself.';
    }
    this.emptyEl.replaceChildren(icon(this.results ? 'search' : 'wall', 'icon wall-empty__icon'), h('h2', null, title), h('p', null, body));
  }

  private card(n: Note): HTMLElement {
    const preview = cardPreview(n);
    const sig = [n.title, preview, n.color, n.pinned, n.archived, this.store.isPending(n.id)].join('\u0000');
    const hit = this.cards.get(n.id);
    if (hit && hit.sig === sig) {
      hit.time.textContent = relativeTime(n.updated_at);
      return hit.el;
    }
    const label = n.title || preview.split('\n', 1)[0] || 'Empty note';
    const time = h('time', { class: 'card__time', datetime: new Date(n.updated_at).toISOString() }, relativeTime(n.updated_at));
    const action = (name: string, ic: Parameters<typeof icon>[0], tip: string) =>
      h('button', { class: 'card__action', type: 'button', 'data-action': name, 'aria-label': tip, 'data-tip': tip }, icon(ic));
    const el = h(
      'article',
      { class: 'card', 'data-color': n.color, 'data-id': n.id },
      h('a', { class: 'card__link', href: notePath(n.id), 'aria-label': label, draggable: 'false' }),
      h(
        'button',
        {
          class: `card__pin${n.pinned ? ' is-pinned' : ''}`,
          type: 'button',
          'data-action': 'pin',
          'aria-label': n.pinned ? 'Unpin' : 'Pin',
          'aria-pressed': String(n.pinned),
        },
        icon('pin'),
      ),
      n.title ? h('h3', { class: 'card__title' }, n.title) : null,
      preview ? h('p', { class: `card__preview${n.title ? '' : ' is-lead'}` }, preview) : null,
      !n.title && !preview ? h('p', { class: 'card__empty' }, 'Empty note') : null,
      h(
        'div',
        { class: 'card__foot' },
        time,
        this.store.isPending(n.id) ? h('span', { class: 'card__pending', 'data-tip': 'Will sync when online', 'aria-label': 'Not synced yet' }, icon('cloud')) : null,
        h(
          'div',
          { class: 'card__actions' },
          action('color', 'palette', 'Color'),
          action('archive', n.archived ? 'unarchive' : 'archive', n.archived ? 'Unarchive' : 'Archive'),
          action('delete', 'trash', 'Delete'),
        ),
        h('button', { class: 'card__more', type: 'button', 'data-action': 'more', 'aria-label': `Actions for ${label}` }, icon('more')),
      ),
    );
    this.cards.set(n.id, { el, sig, time });
    return el;
  }

  private updateTimes(): void {
    for (const [id, c] of this.cards) {
      const n = this.store.get(id);
      if (n) c.time.textContent = relativeTime(n.updated_at);
    }
  }

  // ---------- interaction ----------

  private noteOf(target: EventTarget | null): Note | undefined {
    const card = (target as HTMLElement | null)?.closest<HTMLElement>('.card');
    const id = card?.dataset.id;
    if (!id) return undefined;
    return this.store.get(id) ?? this.results?.notes.find((n) => n.id === id);
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (this.suppressClick) {
      this.suppressClick = false;
      e.preventDefault();
      return;
    }
    const btn = t.closest<HTMLButtonElement>('[data-action]');
    const note = this.noteOf(t);
    if (btn && note) {
      e.preventDefault();
      this.act(btn.dataset.action!, note, btn);
      return;
    }
    const link = t.closest<HTMLAnchorElement>('.card__link');
    if (link && note) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      this.host.navigate(notePath(note.id));
    }
  }

  private onContextMenu(e: MouseEvent): void {
    const note = this.noteOf(e.target);
    if (!note) return;
    e.preventDefault();
    this.openActions(note, finePointer.matches ? (e.target as HTMLElement).closest<HTMLElement>('.card') : null);
  }

  /** Long-press a card on touch screens to get its actions (iOS has no contextmenu event). */
  private bindLongPress(root: HTMLElement): void {
    let timer = 0;
    let start: { x: number; y: number } | null = null;
    const cancel = () => {
      clearTimeout(timer);
      start = null;
      root.querySelector('.card.is-pressing')?.classList.remove('is-pressing');
    };
    root.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
      if (!card || (e.target as HTMLElement).closest('button')) return;
      start = { x: e.clientX, y: e.clientY };
      card.classList.add('is-pressing');
      timer = window.setTimeout(() => {
        const note = this.noteOf(card);
        cancel();
        if (!note) return;
        this.suppressClick = true;
        window.setTimeout(() => (this.suppressClick = false), 800);
        navigator.vibrate?.(8);
        this.openActions(note, null);
      }, LONG_PRESS_MS);
    });
    root.addEventListener('pointermove', (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
    });
    root.addEventListener('pointerup', cancel);
    root.addEventListener('pointercancel', cancel);
  }

  private act(action: string, note: Note, btn: HTMLElement): void {
    switch (action) {
      case 'pin':
        this.patch(note, { pinned: !note.pinned }, note.pinned ? 'Unpinned' : 'Pinned');
        break;
      case 'archive':
        this.archive(note);
        break;
      case 'delete':
        this.remove(note);
        break;
      case 'color':
        this.openColors(note, btn);
        break;
      case 'more':
        this.openActions(note, finePointer.matches ? btn : null);
        break;
    }
  }

  private patch(note: Note, patch: Partial<Pick<Note, 'pinned' | 'archived' | 'color'>>, done?: string, undo?: () => void): void {
    this.store
      .patch(note.id, patch)
      .then(() => {
        if (this.results) void this.runSearch();
      })
      .catch((e) => toast(errorMessage(e), { icon: 'wifiOff' }));
    if (done) toast(done, { icon: 'check', ...(undo ? { action: { label: 'Undo', run: undo } } : {}) });
  }

  private archive(note: Note): void {
    const archived = !note.archived;
    this.patch(note, { archived, pinned: archived ? false : note.pinned }, archived ? 'Archived' : 'Moved back to your wall', () =>
      this.patch(note, { archived: note.archived, pinned: note.pinned }),
    );
  }

  private remove(note: Note): void {
    const undo = this.store.remove(note.id, (e) => toast(`Couldn't delete: ${errorMessage(e)}`));
    if (this.results) this.results.notes = this.results.notes.filter((n) => n.id !== note.id);
    this.render();
    const name = note.title || 'note';
    toast(`Deleted “${name.length > 28 ? name.slice(0, 27) + '…' : name}”`, {
      icon: 'trash',
      duration: 6000,
      action: { label: 'Undo', run: undo },
    });
  }

  private swatches(note: Note, onPick: () => void): HTMLElement {
    const row = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Note color' });
    for (const c of NOTE_COLORS) {
      const b = h('button', {
        class: 'swatch',
        type: 'button',
        role: 'radio',
        'data-color': c,
        'aria-checked': String(note.color === c),
        'aria-label': COLOR_NAMES[c],
        title: COLOR_NAMES[c],
      });
      if (note.color === c) b.append(icon('check'));
      b.addEventListener('click', () => {
        onPick();
        if (c !== note.color) this.patch(note, { color: c });
      });
      row.append(b);
    }
    return row;
  }

  private openColors(note: Note, anchor: HTMLElement): void {
    const m = openMenu({ anchor, items: [], label: 'Note color', extra: this.swatches(note, () => m.close()) });
  }

  private openActions(note: Note, anchor: HTMLElement | null): void {
    if (this.menuOpen) return;
    this.menuOpen = true;
    const items: MenuItem[] = [
      { label: note.pinned ? 'Unpin' : 'Pin to top', icon: note.pinned ? 'pinOff' : 'pin', run: () => this.act('pin', note, document.body) },
      { label: note.archived ? 'Unarchive' : 'Archive', icon: note.archived ? 'unarchive' : 'archive', run: () => this.archive(note) },
      { label: 'Delete', icon: 'trash', danger: true, run: () => this.remove(note) },
    ];
    const header = h('div', { class: 'menu__header' }, h('strong', null, note.title || 'Untitled note'), h('span', null, `Edited ${relativeTime(note.updated_at)}`));
    const m = openMenu({
      anchor,
      items,
      header,
      label: 'Note actions',
      extra: this.swatches(note, () => m.close()),
      onClose: () => (this.menuOpen = false),
    });
  }

  // ---------- keyboard + palette ----------

  openPalette(): void {
    if (this.palette.isOpen) {
      this.palette.close();
      return;
    }
    const items = accountCommands(this.host, 'wall');
    items.push(themeItem(currentTheme(), () => toggleTheme()));
    items.push(...noteItems(this.host, null));
    this.palette.open(byGroup(items));
  }

  private handleKey(e: KeyboardEvent): void {
    if (!this.el.isConnected || document.body.classList.contains('has-modal')) return;
    const key = e.key.toLowerCase();
    if (isModKey(e) && !e.altKey && key === 'k') {
      e.preventDefault();
      this.openPalette();
      return;
    }
    const t = e.target as HTMLElement;
    const typing = t.closest('input, textarea, select, [contenteditable]');
    if (typing || e.metaKey || e.ctrlKey || e.altKey || this.palette.isOpen) return;
    if (e.key === '/') {
      e.preventDefault();
      this.focusSearch();
    } else if (key === 'n' || key === 'c') {
      e.preventDefault();
      this.host.newNote();
    }
  }
}
