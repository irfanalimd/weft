// Tiny DOM helpers. No framework: elements are created once and updated in place.

type Child = Node | string | number | null | undefined | false;
type AttrValue = string | number | boolean | null | undefined | ((ev: any) => void);

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, AttrValue> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === 'class') {
        el.className = String(value);
      } else if (value === true) {
        el.setAttribute(key, '');
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

export const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function shortcut(key: string, opts: { shift?: boolean } = {}): string {
  if (isMac) return `⌘${opts.shift ? '⇧' : ''}${key}`;
  return `Ctrl+${opts.shift ? 'Shift+' : ''}${key}`;
}

export function isModKey(e: KeyboardEvent | MouseEvent): boolean {
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Elements inside `root` that can receive keyboard focus, in DOM order. */
export function focusable(root: Element): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hidden && el.offsetParent !== null);
}

/** Keep Tab focus inside `root` (for modal surfaces). Returns a keydown handler to attach. */
export function trapFocus(root: HTMLElement): (e: KeyboardEvent) => void {
  return (e) => {
    if (e.key !== 'Tab') return;
    const items = focusable(root);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.round(hr / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
