// Time travel: scrub (or play) through every step of the doc's history and restore an old version.

import { createPreview } from '../editor/setup';
import type { DocSession } from '../sync/index';
import { h, prefersReducedMotion } from './dom';
import { icon } from './icons';

export interface HistoryOptions {
  /** Where the read-only preview goes (replaces the editor while open). */
  previewParent: HTMLElement;
  onOpenChange: (open: boolean) => void;
  onRestored: (step: number) => void;
}

export class HistoryPanel {
  readonly bar: HTMLElement;
  private previewWrap: HTMLElement;
  private preview: ReturnType<typeof createPreview> | null = null;
  private badge = h('div', { class: 'history-preview__badge' });
  private range: HTMLInputElement;
  private label = h('span', { class: 'history__label', 'aria-live': 'off' });
  private playBtn: HTMLButtonElement;
  private restoreBtn: HTMLButtonElement;
  private confirm: HTMLElement;
  private session: DocSession | null = null;
  private step = 0;
  private len = 0;
  private playing = false;
  private raf = 0;
  private renderQueued = false;
  private poll = 0;
  private restoreFocus: HTMLElement | null = null;

  constructor(private opts: HistoryOptions) {
    this.range = h('input', {
      class: 'history__range',
      type: 'range',
      min: 0,
      max: 0,
      step: 1,
      value: 0,
      'aria-label': 'History position',
    });
    this.range.addEventListener('input', () => {
      this.pause();
      this.go(Number(this.range.value));
    });
    this.playBtn = h('button', {
      class: 'btn btn--icon',
      type: 'button',
      'aria-label': 'Play history',
      'data-tip': 'Replay',
      onclick: () => (this.playing ? this.pause() : this.play()),
    });
    this.restoreBtn = h(
      'button',
      { class: 'btn btn--outline btn--small', type: 'button', onclick: () => this.askRestore() },
      icon('restore'),
      'Restore',
    );
    this.confirm = h(
      'div',
      { class: 'history__confirm', hidden: true, role: 'alertdialog', 'aria-label': 'Restore this version?' },
      h('span', { class: 'hide-narrow' }, 'Restore this version?'),
      h('button', { class: 'btn btn--primary btn--small', type: 'button', 'data-confirm': '', onclick: () => this.doRestore() }, 'Restore'),
      h('button', { class: 'btn btn--small', type: 'button', onclick: () => this.cancelRestore() }, 'Cancel'),
    );
    const closeBtn = h(
      'button',
      { class: 'btn btn--icon', type: 'button', 'aria-label': 'Close history', 'data-tip': 'Close (Esc)', 'data-tip-align': 'end', onclick: () => this.close() },
      icon('x'),
    );
    this.bar = h(
      'div',
      { class: 'history', role: 'region', 'aria-label': 'Document history', hidden: true },
      this.playBtn,
      this.range,
      this.label,
      this.restoreBtn,
      this.confirm,
      closeBtn,
    );
    this.bar.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!this.confirm.hidden) this.cancelRestore();
        else this.close();
      } else if (e.key === ' ' && e.target === this.range) {
        e.preventDefault();
        this.playing ? this.pause() : this.play();
      }
    });
    this.previewWrap = h('div', { class: 'history-preview column' }, this.badge);
    opts.previewParent.append(this.previewWrap);
    this.setPlayIcon();
  }

  get isOpen(): boolean {
    return !this.bar.hidden;
  }

  open(session: DocSession): void {
    if (this.isOpen) return;
    this.session = session;
    const active = document.activeElement as HTMLElement | null;
    this.restoreFocus = active && active !== document.body ? active : null;
    if (!this.preview) {
      const host = h('div', { class: 'weft-editor' });
      this.previewWrap.append(host);
      this.preview = createPreview(host);
    }
    this.len = session.historyLength();
    this.step = this.len;
    this.bar.hidden = false;
    this.cancelRestore();
    this.opts.onOpenChange(true);
    this.sync();
    this.render();
    this.range.focus();
    // Others may keep typing while we look; keep the end of the scrubber live.
    this.poll = window.setInterval(() => this.refreshLength(), 1000);
  }

  close(): void {
    if (!this.isOpen) return;
    this.pause();
    clearInterval(this.poll);
    this.bar.hidden = true;
    this.session = null;
    this.opts.onOpenChange(false);
    const target = this.restoreFocus;
    this.restoreFocus = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }

  toggle(session: DocSession): void {
    if (this.isOpen) this.close();
    else this.open(session);
  }

  private refreshLength(): void {
    if (!this.session) return;
    const len = this.session.historyLength();
    if (len === this.len) return;
    const atEnd = this.step === this.len;
    this.len = len;
    if (atEnd && !this.playing) this.step = len;
    this.sync();
    this.render();
  }

  private go(step: number, follow = false): void {
    this.step = Math.max(0, Math.min(this.len, Math.round(step)));
    this.sync();
    this.queueRender(follow);
  }

  private sync(): void {
    this.range.max = String(this.len);
    this.range.value = String(this.step);
    const pct = this.len === 0 ? 100 : (this.step / this.len) * 100;
    this.range.style.setProperty('--pct', `${pct}%`);
    this.range.setAttribute('aria-valuetext', `Step ${this.step} of ${this.len}`);
    const now = this.step === this.len;
    this.label.textContent = now ? `Now · ${this.len} steps` : `Step ${this.step} / ${this.len}`;
    this.badge.replaceChildren(icon('history'), now ? 'Current version · read-only' : `Step ${this.step} of ${this.len} · read-only preview`);
    this.restoreBtn.disabled = now;
    this.restoreBtn.setAttribute('aria-label', now ? 'Restore (this is the current version)' : `Restore step ${this.step}`);
  }

  private queueRender(follow = false): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render(follow);
    });
  }

  private render(follow = false): void {
    if (!this.session || !this.preview) return;
    this.preview.set(this.session.textAtStep(this.step), follow);
  }

  private play(): void {
    if (!this.session || this.len === 0) return;
    this.cancelRestore();
    if (this.step >= this.len) this.step = 0;
    this.playing = true;
    this.setPlayIcon();
    // Whole replay takes 3-12 s whatever the doc size; reduced motion jumps in bigger steps.
    const duration = Math.min(12000, Math.max(3000, this.len * 25));
    const perMs = this.len / duration;
    let pos = this.step;
    let last = performance.now();
    const frame = (t: number) => {
      if (!this.playing) return;
      const dt = Math.min(100, t - last);
      last = t;
      pos += dt * perMs * (prefersReducedMotion() ? 4 : 1);
      if (pos >= this.len) {
        this.go(this.len, true);
        this.pause();
        return;
      }
      this.go(pos, true);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.setPlayIcon();
  }

  private setPlayIcon(): void {
    this.playBtn.replaceChildren(icon(this.playing ? 'pause' : 'play'));
    this.playBtn.setAttribute('aria-label', this.playing ? 'Pause replay' : 'Replay history');
    this.playBtn.dataset.tip = this.playing ? 'Pause' : 'Replay';
  }

  private askRestore(): void {
    if (this.step === this.len) return;
    this.pause();
    this.restoreBtn.hidden = true;
    this.confirm.hidden = false;
    this.confirm.querySelector<HTMLElement>('[data-confirm]')?.focus();
  }

  private cancelRestore(): void {
    const wasOpen = !this.confirm.hidden;
    this.confirm.hidden = true;
    this.restoreBtn.hidden = false;
    if (wasOpen) this.range.focus();
  }

  private doRestore(): void {
    if (!this.session) return;
    const step = this.step;
    this.session.restoreStep(step);
    this.confirm.hidden = true;
    this.restoreBtn.hidden = false;
    this.close();
    this.opts.onRestored(step);
  }
}
