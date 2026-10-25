// Presence: stacked avatars of everyone here. Click one to jump to their cursor.

import type { Peer } from '../sync/index';
import { h } from './dom';
import { initials } from './text';

const IDLE_MS = 60_000;

export interface PresenceOptions {
  onJump: (peer: Peer) => void;
  onSelf: () => void;
  /** 1-based line number of a position, for the tooltip. */
  lineOf: (pos: number) => number | null;
}

export class Presence {
  readonly el = h('div', { class: 'presence', role: 'group', 'aria-label': 'People in this document' });
  private buttons = new Map<string, HTMLButtonElement>();
  private more = h('button', { class: 'avatar avatar--more', type: 'button' });
  private peers: Peer[] = [];
  private narrow = window.matchMedia('(max-width: 640px)');

  constructor(private opts: PresenceOptions) {
    this.el.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-client]');
      if (!btn) return;
      const peer = this.peers.find((p) => p.clientId === btn.dataset.client);
      if (!peer) return;
      if (peer.isSelf) this.opts.onSelf();
      else this.opts.onJump(peer);
    });
    this.more.addEventListener('click', () => {
      // Jump to the most recently active hidden peer.
      const hidden = this.others().slice(this.maxVisible());
      hidden.sort((a, b) => b.lastActive - a.lastActive);
      if (hidden[0]) this.opts.onJump(hidden[0]);
    });
    this.narrow.addEventListener('change', () => this.render(this.peers));
  }

  private others(): Peer[] {
    return this.peers.filter((p) => !p.isSelf);
  }

  private maxVisible(): number {
    return this.narrow.matches ? 2 : 4;
  }

  render(peers: Peer[]): void {
    this.peers = peers;
    const now = Date.now();
    const others = this.others();
    const self = peers.find((p) => p.isSelf);
    const max = this.maxVisible();
    const visible = others.length > max + 1 ? others.slice(0, max) : others;
    const overflow = others.length - visible.length;

    const desired: HTMLElement[] = [];
    const seen = new Set<string>();
    for (const p of visible) desired.push(this.button(p, now)), seen.add(p.clientId);
    if (overflow > 0) {
      this.more.textContent = `+${overflow}`;
      const names = others.slice(visible.length).map((p) => p.name);
      this.more.dataset.tip = names.join('\n');
      this.more.setAttribute('aria-label', `${overflow} more: ${names.join(', ')}`);
      desired.push(this.more);
    }
    if (self) {
      desired.push(this.button(self, now));
      seen.add(self.clientId);
    }

    for (const [id, btn] of this.buttons) {
      if (!seen.has(id)) {
        btn.remove();
        this.buttons.delete(id);
      }
    }
    desired.forEach((el, i) => {
      if (this.el.children[i] !== el) this.el.insertBefore(el, this.el.children[i] ?? null);
    });
    while (this.el.children.length > desired.length) this.el.lastElementChild!.remove();
  }

  private button(p: Peer, now: number): HTMLButtonElement {
    let btn = this.buttons.get(p.clientId);
    if (!btn) {
      btn = h('button', { class: 'avatar', type: 'button', 'data-client': p.clientId });
      this.buttons.set(p.clientId, btn);
    }
    const idle = !p.isSelf && now - p.lastActive > IDLE_MS;
    const line = p.cursor === null ? null : this.opts.lineOf(p.cursor);
    const where = p.isSelf ? 'You · click to rename' : line ? `Line ${line}${idle ? ' · idle' : ''}` : idle ? 'Idle' : 'Here';
    const text = initials(p.name);
    if (btn.textContent !== text) btn.textContent = text;
    btn.style.setProperty('--c', p.color);
    btn.classList.toggle('avatar--self', p.isSelf);
    btn.classList.toggle('is-idle', idle);
    btn.dataset.tip = `${p.name}\n${where}`;
    btn.setAttribute(
      'aria-label',
      p.isSelf ? `You (${p.name}). Change your name or color` : `${p.name}, ${line ? `line ${line}` : 'here'}. Jump to cursor`,
    );
    return btn;
  }
}
