// Share popover: the link, a copy button, a QR code for phones, and the native share sheet.

import { h, trapFocus } from './dom';
import { copyText } from './exportDoc';
import { icon } from './icons';
import { toast } from './toast';

const qrCache = new Map<string, string>();

/** QR code as an SVG string. The encoder is a small lazy chunk, loaded on first use. */
async function qrSvg(text: string): Promise<string> {
  const hit = qrCache.get(text);
  if (hit) return hit;
  const { default: qrcode } = await import('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.isDark(y, x)) {
        // Merge horizontal runs into one rect to keep the path short.
        let run = 1;
        while (x + run < n && qr.isDark(y, x + run)) run++;
        d += `M${x} ${y}h${run}v1h-${run}z`;
        x += run - 1;
      }
    }
  }
  const svg = `<svg viewBox="0 0 ${n} ${n}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="img" aria-label="QR code for this document's link"><path d="${d}" fill="#111"/></svg>`;
  qrCache.set(text, svg);
  return svg;
}

export class SharePopover {
  readonly el: HTMLElement;
  private url = '';
  private urlInput: HTMLInputElement;
  private qr: HTMLElement;
  private anchor: HTMLElement | null = null;
  private readonly onDocPointer = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!this.el.contains(t) && !this.anchor?.contains(t)) this.close(false);
  };
  private readonly onResize = () => this.position();

  constructor() {
    this.urlInput = h('input', {
      class: 'share__url',
      type: 'text',
      readonly: true,
      'aria-label': 'Link to this document',
      onfocus: (e: FocusEvent) => (e.target as HTMLInputElement).select(),
    });
    const copyBtn = h(
      'button',
      { class: 'btn btn--primary', type: 'button', 'data-autofocus': '', onclick: () => this.copy() },
      icon('copy'),
      'Copy',
    );
    this.qr = h('div', { class: 'share__qr', 'aria-hidden': 'false' });
    const canShare = typeof navigator.share === 'function';
    this.el = h(
      'div',
      { class: 'popover', role: 'dialog', 'aria-label': 'Share this document', hidden: true },
      h('h2', null, 'Share this doc'),
      h('p', null, 'Anyone with the link can view and edit. No sign-up needed.'),
      h('div', { class: 'share__row' }, this.urlInput, copyBtn),
      this.qr,
      h('p', { class: 'share__qr-note' }, 'Scan to open on your phone'),
      canShare
        ? h(
            'button',
            { class: 'btn btn--outline share__native', type: 'button', onclick: () => this.nativeShare() },
            icon('share'),
            'Share via…',
          )
        : null,
    );
    const trap = trapFocus(this.el);
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close(true);
      } else trap(e);
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  toggle(anchor: HTMLElement, url: string): void {
    if (this.isOpen) this.close(true);
    else this.open(anchor, url);
  }

  open(anchor: HTMLElement, url: string): void {
    this.anchor = anchor;
    this.url = url;
    this.urlInput.value = url;
    this.el.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    this.position();
    this.el.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    this.qr.replaceChildren();
    qrSvg(url)
      .then((svg) => {
        if (this.url === url) this.qr.innerHTML = svg;
      })
      .catch(() => {
        this.qr.textContent = 'QR code unavailable offline';
      });
    document.addEventListener('pointerdown', this.onDocPointer, true);
    window.addEventListener('resize', this.onResize);
  }

  close(returnFocus: boolean): void {
    if (!this.isOpen) return;
    const hadFocus = this.el.contains(document.activeElement);
    this.el.hidden = true;
    this.anchor?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.onDocPointer, true);
    window.removeEventListener('resize', this.onResize);
    if (returnFocus || hadFocus) this.anchor?.focus({ preventScroll: true });
  }

  private position(): void {
    if (!this.anchor) return;
    const r = this.anchor.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    const left = Math.max(12, Math.min(r.right - width, window.innerWidth - width - 12));
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.left = `${Math.round(left)}px`;
  }

  private async copy(): Promise<void> {
    try {
      await copyText(this.url);
      toast('Link copied', { icon: 'check' });
      this.close(true);
    } catch {
      this.urlInput.focus();
      this.urlInput.select();
      toast('Press ' + (navigator.platform.includes('Mac') ? '⌘C' : 'Ctrl+C') + ' to copy');
    }
  }

  private async nativeShare(): Promise<void> {
    try {
      await navigator.share({ title: document.title, url: this.url });
      this.close(true);
    } catch {
      /* cancelled */
    }
  }
}
