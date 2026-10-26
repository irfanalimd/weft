// Modal dialogs (forms, confirms) and small anchored menus / bottom sheets.

import { h, trapFocus } from './dom';
import { icon, type IconName } from './icons';

export interface ModalHandle {
  el: HTMLElement;
  close(): void;
}

let openCount = 0;

/** A centered dialog (a bottom sheet on phones). `content` is usually a <form>. */
export function openModal(opts: {
  title: string;
  content: Node;
  onClose?: () => void;
  /** Element to focus first; defaults to the first input. */
  focus?: HTMLElement;
  size?: 'small' | 'normal';
}): ModalHandle {
  const restore = document.activeElement as HTMLElement | null;
  const titleId = `modal-title-${++openCount}`;
  const closeBtn = h('button', { class: 'btn btn--icon modal__close', type: 'button', 'aria-label': 'Close' }, icon('x'));
  const panel = h(
    'div',
    {
      class: `modal${opts.size === 'small' ? ' modal--small' : ''}`,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
    },
    h('div', { class: 'modal__head' }, h('h2', { class: 'modal__title', id: titleId }, opts.title), closeBtn),
    opts.content,
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, panel);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.classList.add('is-leaving');
    window.setTimeout(() => backdrop.remove(), 160);
    document.body.classList.remove('has-modal');
    opts.onClose?.();
    if (restore?.isConnected) restore.focus({ preventScroll: true });
  };
  const trap = trapFocus(panel);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else trap(e);
  };
  document.addEventListener('keydown', onKey, true);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.body.append(backdrop);
  document.body.classList.add('has-modal');
  const first = opts.focus ?? panel.querySelector<HTMLElement>('input:not([type=hidden]):not([readonly]), select, textarea');
  // On touch screens, don't pop the keyboard over a confirm; do focus inputs (that's the point of the form).
  (first ?? panel.querySelector<HTMLElement>('.btn--primary, .btn--danger') ?? closeBtn).focus({ preventScroll: true });
  return { el: panel, close };
}

/** A yes/no confirmation. Resolves true if confirmed. */
export function confirmDialog(opts: { title: string; body: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const ok = h('button', { class: `btn ${opts.danger ? 'btn--danger' : 'btn--primary'}`, type: 'submit' }, opts.confirm);
    const cancel = h('button', { class: 'btn btn--outline', type: 'button' }, 'Cancel');
    const form = h(
      'form',
      { class: 'modal__body' },
      h('p', { class: 'modal__text' }, opts.body),
      h('div', { class: 'modal__actions' }, cancel, ok),
    );
    const m = openModal({ title: opts.title, content: form, size: 'small', focus: ok, onClose: () => resolve(result) });
    cancel.addEventListener('click', () => m.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      result = true;
      m.close();
    });
  });
}

/** A labelled input row for forms. */
export function field(
  label: string,
  input: HTMLInputElement | HTMLSelectElement,
  extra?: Node | null,
  hint?: string,
): HTMLElement {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h(
    'div',
    { class: 'field' },
    h('label', { class: 'field__label', for: id }, label),
    extra ? h('div', { class: 'field__row' }, input, extra) : input,
    hint ? h('p', { class: 'field__hint' }, hint) : null,
  );
}

export function formError(): HTMLElement {
  return h('p', { class: 'form-error', role: 'alert', hidden: true });
}

export function showError(el: HTMLElement, msg: string | null): void {
  el.textContent = msg ?? '';
  el.hidden = !msg;
}

/** Disable a submit button with a spinner while `work` runs. */
export async function busy<T>(btn: HTMLButtonElement, work: () => Promise<T>): Promise<T> {
  btn.disabled = true;
  btn.classList.add('is-busy');
  try {
    return await work();
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
  }
}

// ---------- Menus ----------

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  run: () => void;
}

export interface MenuHandle {
  close(): void;
}

const sheetQuery = window.matchMedia('(max-width: 640px), (hover: none) and (pointer: coarse)');

/**
 * An anchored popover menu on desktop, a bottom sheet on phones. `header` and `extra` are optional
 * custom nodes (e.g. a title, a row of color swatches).
 */
export function openMenu(opts: {
  anchor: HTMLElement | null;
  items: MenuItem[];
  header?: Node;
  extra?: Node;
  label: string;
  align?: 'start' | 'end';
  onClose?: () => void;
}): MenuHandle {
  const restore = document.activeElement as HTMLElement | null;
  const sheet = sheetQuery.matches || !opts.anchor;
  const list = h(
    'div',
    { class: 'menu__list', role: 'menu', 'aria-label': opts.label },
    ...opts.items.map((it) =>
      h(
        'button',
        { class: `menu__item${it.danger ? ' is-danger' : ''}`, type: 'button', role: 'menuitem' },
        it.icon ? icon(it.icon) : null,
        h('span', null, it.label),
      ),
    ),
  );
  const panel = h('div', { class: `menu${sheet ? ' menu--sheet' : ''}` }, opts.header ?? null, opts.extra ?? null, list);
  const layer = h('div', { class: `menu-layer${sheet ? ' menu-layer--sheet' : ''}` }, panel);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    layer.classList.add('is-leaving');
    window.setTimeout(() => layer.remove(), 160);
    opts.onClose?.();
    if (restore?.isConnected && !sheet) restore.focus({ preventScroll: true });
  };
  const buttons = () => Array.from(panel.querySelectorAll<HTMLButtonElement>('button'));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const bs = buttons();
      const i = bs.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % bs.length : (i - 1 + bs.length) % bs.length;
      bs[next]?.focus();
    } else if (e.key === 'Tab') {
      trapFocus(panel)(e);
    }
  };
  list.querySelectorAll('button').forEach((b, i) =>
    b.addEventListener('click', () => {
      close();
      opts.items[i].run();
    }),
  );
  layer.addEventListener('pointerdown', (e) => {
    if (e.target === layer) {
      e.preventDefault();
      close();
    }
  });
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);
  document.body.append(layer);
  if (!sheet && opts.anchor) {
    const r = opts.anchor.getBoundingClientRect();
    const w = panel.offsetWidth;
    const hgt = panel.offsetHeight;
    let left = opts.align === 'start' ? r.left : r.right - w;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 6);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }
  (list.querySelector<HTMLButtonElement>('button') ?? panel.querySelector<HTMLButtonElement>('button'))?.focus({
    preventScroll: true,
  });
  return { close };
}
