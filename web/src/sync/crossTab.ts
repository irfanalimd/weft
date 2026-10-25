// Cross-tab sync over BroadcastChannel: tabs of the same doc forward raw Update frames to each
// other, so they stay in sync even with no server. A new tab announces its state vector and
// peers answer with whatever it lacks. Frames are idempotent, so overlap with the server is fine.

type Msg =
  | { t: 'update'; from: string; frame: Uint8Array }
  | { t: 'hello'; from: string; sv: Uint8Array }
  | { t: 'diff'; from: string; to: string; frame: Uint8Array };

export interface CrossTabHandlers {
  onFrame(frame: Uint8Array): void;
  /** Return an Update frame with everything not in `sv`, or undefined. */
  diffFor(sv: Uint8Array): Uint8Array | undefined;
}

export class CrossTab {
  private readonly ch: BroadcastChannel | null;

  constructor(
    docId: string,
    private readonly self: string,
    h: CrossTabHandlers,
  ) {
    this.ch = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`weft:${docId}`);
    if (!this.ch) return;
    this.ch.onmessage = (ev: MessageEvent<Msg>) => {
      const m = ev.data;
      if (!m || m.from === self) return;
      if (m.t === 'update' || (m.t === 'diff' && m.to === self)) h.onFrame(m.frame);
      else if (m.t === 'hello') {
        const frame = h.diffFor(m.sv);
        if (frame) this.post({ t: 'diff', from: self, to: m.from, frame });
      }
    };
  }

  hello(sv: Uint8Array): void {
    this.post({ t: 'hello', from: this.self, sv });
  }

  update(frame: Uint8Array): void {
    this.post({ t: 'update', from: this.self, frame });
  }

  close(): void {
    this.ch?.close();
  }

  private post(m: Msg): void {
    try {
      this.ch?.postMessage(m);
    } catch {
      /* channel closed */
    }
  }
}
