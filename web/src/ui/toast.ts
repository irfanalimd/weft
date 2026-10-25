// Quiet, short-lived notifications at the bottom of the screen.

import { h } from './dom';
import { icon, type IconName } from './icons';

export interface ToastOptions {
  icon?: IconName;
  duration?: number;
  action?: { label: string; run: () => void };
}

let root: HTMLElement | null = null;
const live = new Map<string, { el: HTMLElement; timer: number }>();

function container(): HTMLElement {
  if (!root) {
    root = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(root);
  }
  return root;
}

export function toast(message: string, opts: ToastOptions = {}): void {
  const duration = opts.duration ?? (opts.action ? 6000 : 2600);
  const existing = live.get(message);
  if (existing) {
    // Same message again: just extend it instead of stacking duplicates.
    clearTimeout(existing.timer);
    existing.timer = window.setTimeout(() => dismiss(message), duration);
    return;
  }
  const el = h(
    'div',
    { class: 'toast' },
    opts.icon ? icon(opts.icon) : null,
    h('span', null, message),
    opts.action
      ? h(
          'button',
          {
            class: 'toast__action',
            type: 'button',
            onclick: () => {
              opts.action!.run();
              dismiss(message);
            },
          },
          opts.action.label,
        )
      : null,
  );
  const c = container();
  c.append(el);
  while (c.children.length > 3) {
    const first = c.firstElementChild as HTMLElement;
    for (const [k, v] of live) if (v.el === first) live.delete(k);
    first.remove();
  }
  live.set(message, { el, timer: window.setTimeout(() => dismiss(message), duration) });
}

export function dismiss(message: string): void {
  const t = live.get(message);
  if (!t) return;
  live.delete(message);
  clearTimeout(t.timer);
  t.el.classList.add('is-leaving');
  const done = () => t.el.remove();
  t.el.addEventListener('animationend', done, { once: true });
  window.setTimeout(done, 400);
}
