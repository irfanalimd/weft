// Command palette (⌘K / Ctrl+K): fuzzy list of actions, plus a one-line prompt mode.

import { clear, h, shortcut } from './dom';
import { fuzzy } from './fuzzy';
import { icon, type IconName } from './icons';

export interface PaletteItem {
  id: string;
  label: string;
  group?: string;
  icon?: IconName;
  /** Color swatch instead of an icon. */
  swatch?: string;
  hint?: string;
  /** Extra words that should match (not shown). */
  keywords?: string;
  /** Return `false` to keep the palette open (e.g. when it opened a sub-list). */
  run: () => void | boolean;
}

interface PromptOptions {
  placeholder: string;
  initial?: string;
  action: (value: string) => string; // label for the submit row, e.g. 'Rename to “x”'
  onSubmit: (value: string) => void;
}

export class Palette {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLUListElement;
  private footer: HTMLElement;
  private items: PaletteItem[] = [];
  private shown: PaletteItem[] = [];
  private selected = 0;
  private prompt: PromptOptions | null = null;
  private restoreFocus: HTMLElement | null = null;
  private lastPointer = { x: -1, y: -1 };
  private generation = 0;

  constructor() {
    this.input = h('input', {
      class: 'palette__input',
      type: 'text',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'palette-list',
      'aria-autocomplete': 'list',
      'aria-label': 'Search commands',
      autocomplete: 'off',
      spellcheck: 'false',
      enterkeyhint: 'go',
    });
    this.list = h('ul', { class: 'palette__list', id: 'palette-list', role: 'listbox', 'aria-label': 'Commands' });
    this.footer = h(
      'div',
      { class: 'palette__footer', 'aria-hidden': 'true' },
      h('span', null, h('span', { class: 'kbd' }, '↑'), h('span', { class: 'kbd' }, '↓'), 'navigate'),
      h('span', null, h('span', { class: 'kbd' }, '↵'), 'run'),
      h('span', null, h('span', { class: 'kbd' }, 'esc'), 'close'),
      h('span', { style: 'margin-left:auto' }, h('span', { class: 'kbd' }, shortcut('K')), 'toggle'),
    );
    const panel = h(
      'div',
      { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
      h('div', { class: 'palette__field' }, icon('search'), this.input),
      this.list,
      this.footer,
    );
    this.el = h('div', { class: 'palette-backdrop', hidden: true }, panel);

    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) {
        e.preventDefault();
        this.close();
      }
    });
    this.input.addEventListener('input', () => this.render());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.list.addEventListener('mousemove', (e) => {
      // Only follow the mouse when it actually moves (not when the list scrolls under it).
      if (e.clientX === this.lastPointer.x && e.clientY === this.lastPointer.y) return;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      const li = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
      if (li) this.select(Number(li.dataset.index), false);
    });
    this.list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
    this.list.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
      if (li) this.runAt(Number(li.dataset.index));
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(items: PaletteItem[], placeholder = 'Type a command or search…'): void {
    this.prompt = null;
    this.items = items;
    this.show(placeholder, '');
  }

  ask(opts: PromptOptions): void {
    this.prompt = opts;
    this.items = [];
    this.show(opts.placeholder, opts.initial ?? '');
    this.input.select();
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.prompt = null;
    const target = this.restoreFocus;
    this.restoreFocus = null;
    if (target && target.isConnected) target.focus({ preventScroll: true });
  }

  private show(placeholder: string, value: string): void {
    this.generation++;
    if (!this.isOpen) {
      const active = document.activeElement as HTMLElement | null;
      this.restoreFocus = active && active !== document.body ? active : null;
    }
    this.el.hidden = false;
    this.input.placeholder = placeholder;
    this.input.value = value;
    this.input.setAttribute('aria-label', this.prompt ? placeholder : 'Search commands');
    this.selected = 0;
    this.render();
    this.input.focus();
  }

  private render(): void {
    clear(this.list);
    const query = this.input.value;

    if (this.prompt) {
      const value = query.trim();
      const p = this.prompt;
      this.shown = value
        ? [{ id: 'submit', label: p.action(value), icon: 'check', run: () => p.onSubmit(value) }]
        : [];
      if (!value) this.list.append(h('li', { class: 'palette__empty', role: 'presentation' }, p.placeholder));
      this.shown.forEach((item, i) => this.list.append(this.row(item, i, [])));
      this.select(0, false);
      return;
    }

    let rows: { item: PaletteItem; indices: number[]; score: number }[];
    if (!query.trim()) {
      rows = this.items.map((item) => ({ item, indices: [], score: 0 }));
    } else {
      rows = [];
      for (const item of this.items) {
        const m = fuzzy(query, item.label);
        if (m) {
          rows.push({ item, indices: m.indices, score: m.score });
          continue;
        }
        const k = item.keywords ? fuzzy(query, item.keywords) : null;
        if (k) rows.push({ item, indices: [], score: k.score - 6 });
      }
      rows.sort((a, b) => b.score - a.score);
    }

    this.shown = rows.map((r) => r.item);
    if (rows.length === 0) {
      this.list.append(h('li', { class: 'palette__empty', role: 'presentation' }, 'No matching commands'));
    }
    let group: string | undefined;
    rows.forEach((r, i) => {
      const g = r.item.group;
      if (!query.trim() && g && g !== group) {
        this.list.append(h('li', { class: 'palette__group', role: 'presentation' }, g));
      }
      group = g;
      this.list.append(this.row(r.item, i, r.indices));
    });
    this.select(0, false);
  }

  private row(item: PaletteItem, index: number, indices: number[]): HTMLLIElement {
    const label = h('span', { class: 'palette__label' });
    if (indices.length) {
      const set = new Set(indices);
      let run = '';
      let inMark = false;
      const flush = () => {
        if (!run) return;
        label.append(inMark ? h('mark', null, run) : run);
        run = '';
      };
      Array.from(item.label).forEach((ch, i) => {
        const m = set.has(i);
        if (m !== inMark) {
          flush();
          inMark = m;
        }
        run += ch;
      });
      flush();
    } else {
      label.textContent = item.label;
    }
    return h(
      'li',
      {
        class: 'palette__item',
        role: 'option',
        id: `palette-opt-${index}`,
        'data-index': index,
        'aria-selected': 'false',
      },
      item.swatch
        ? h('span', { class: 'palette__swatch', style: `--c: ${item.swatch}` })
        : icon(item.icon ?? 'dot'),
      label,
      item.hint ? h('span', { class: 'palette__hint' }, item.hint) : null,
    );
  }

  private select(i: number, scroll = true): void {
    const n = this.shown.length;
    if (n === 0) {
      this.input.removeAttribute('aria-activedescendant');
      return;
    }
    this.selected = ((i % n) + n) % n;
    this.list.querySelectorAll('[aria-selected="true"]').forEach((el) => el.setAttribute('aria-selected', 'false'));
    const el = this.list.querySelector<HTMLElement>(`#palette-opt-${this.selected}`);
    if (el) {
      el.setAttribute('aria-selected', 'true');
      this.input.setAttribute('aria-activedescendant', el.id);
      if (scroll) el.scrollIntoView({ block: 'nearest' });
    }
  }

  private runAt(i: number): void {
    const item = this.shown[i];
    if (!item) return;
    const gen = this.generation;
    const keepOpen = item.run() === false;
    // If the item switched to a sub-list or prompt, stay open.
    if (!keepOpen && this.generation === gen) this.close();
  }

  private onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.select(this.selected + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.select(this.selected - 1);
        break;
      case 'Tab':
        e.preventDefault();
        this.select(this.selected + (e.shiftKey ? -1 : 1));
        break;
      case 'Home':
        if (this.input.value) return;
        e.preventDefault();
        this.select(0);
        break;
      case 'End':
        if (this.input.value) return;
        e.preventDefault();
        this.select(this.shown.length - 1);
        break;
      case 'Enter':
        e.preventDefault();
        if (!e.isComposing) this.runAt(this.selected);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.close();
        break;
    }
  }
}
