// The sync status pill. Always tells the truth, without flickering on every keystroke.

import type { SyncState } from '../sync/index';
import { h, relativeTime } from './dom';

type Shown = 'connecting' | 'live' | 'syncing' | 'offline' | 'reconnecting' | 'error';

/** Unconfirmed edits must persist this long before "Syncing…" shows (acks are usually instant). */
const SYNCING_DELAY = 900;

export class SyncPill {
  readonly el: HTMLElement;
  private dot = h('span', { class: 'pill__dot', 'aria-hidden': 'true' });
  private label = h('span', { class: 'pill__text' });
  private retry: HTMLButtonElement;
  private state: SyncState = { status: 'connecting', unsyncedEdits: 0, lastSyncedAt: null };
  private syncingTimer = 0;
  private syncingSince: number | null = null;
  private tipTimer = 0;

  constructor(onRetry: () => void) {
    this.retry = h('button', { class: 'pill__retry', type: 'button', onclick: onRetry }, 'Retry');
    this.el = h('div', { class: 'pill', role: 'status', 'data-status': 'connecting', 'data-tip-align': 'end' }, this.dot, this.label, this.retry);
    this.render();
    // Keep "last synced 3 min ago" fresh.
    this.tipTimer = window.setInterval(() => this.updateTip(this.shown()), 30_000);
  }

  update(s: SyncState): void {
    this.state = s;
    if (s.status === 'live' && s.unsyncedEdits > 0) {
      if (this.syncingSince === null) this.syncingSince = Date.now();
      clearTimeout(this.syncingTimer);
      this.syncingTimer = window.setTimeout(() => this.render(), SYNCING_DELAY);
    } else {
      this.syncingSince = null;
      clearTimeout(this.syncingTimer);
    }
    this.render();
  }

  destroy(): void {
    clearTimeout(this.syncingTimer);
    clearInterval(this.tipTimer);
  }

  private shown(): Shown {
    const s = this.state;
    if (s.status === 'live') {
      const pending = s.unsyncedEdits > 0 && this.syncingSince !== null && Date.now() - this.syncingSince >= SYNCING_DELAY;
      return pending ? 'syncing' : 'live';
    }
    return s.status;
  }

  private render(): void {
    const shown = this.shown();
    const n = this.state.unsyncedEdits;
    let text: string;
    let long = '';
    switch (shown) {
      case 'connecting':
        text = 'Connecting…';
        break;
      case 'live':
        text = 'Live';
        break;
      case 'syncing':
        text = 'Syncing…';
        break;
      case 'offline':
        text = 'Offline';
        long = n > 0 ? ` · ${n} unsynced` : ' · saved locally';
        break;
      case 'reconnecting':
        text = 'Reconnecting…';
        break;
      case 'error':
        text = 'Sync paused';
        break;
    }
    this.el.dataset.status = shown;
    this.label.replaceChildren(text, long ? h('span', { class: 'pill__text-long' }, long) : '');
    this.retry.hidden = !(shown === 'reconnecting' || shown === 'error' || shown === 'offline');
    this.updateTip(shown);
  }

  private updateTip(shown: Shown): void {
    const s = this.state;
    const last = s.lastSyncedAt ? `Last synced ${relativeTime(s.lastSyncedAt)}` : 'Not synced yet';
    const n = s.unsyncedEdits;
    const edits = `${n} edit${n === 1 ? '' : 's'}`;
    let tip: string;
    switch (shown) {
      case 'live':
        tip = `Everything is synced\n${last}`;
        break;
      case 'syncing':
        tip = `Sending ${edits}…`;
        break;
      case 'offline':
        tip = n > 0 ? `${edits} saved on this device.\nThey'll sync when you're back online.` : `Saved on this device.\n${last}`;
        break;
      case 'reconnecting':
        tip = `Trying to reach the server…\nYour edits are safe on this device.`;
        break;
      case 'error':
        tip = s.error ? `${s.error}\nYour edits are safe on this device.` : 'Your edits are safe on this device.';
        break;
      default:
        tip = 'Connecting to the sync server…';
    }
    this.el.dataset.tip = tip;
    this.el.setAttribute('aria-label', `Sync status: ${this.label.textContent}. ${tip.replace(/\n/g, ' ')}`);
  }
}
