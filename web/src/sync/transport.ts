// WebSocket transport: binary frames, exponential backoff with full jitter, eager reconnect on
// `online` / tab becoming visible, and a manual `reconnect()`.

export interface TransportHandlers {
  /** Socket opened; the caller sends its handshake. */
  onOpen(): void;
  onFrame(frame: Uint8Array): void;
  /** Socket closed (or failed to open). `attempt` = consecutive failures so far. */
  onClose(attempt: number): void;
}

const BASE_MS = 400;
const MAX_MS = 20_000;
const OPEN_TIMEOUT_MS = 8_000;

export class Transport {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly url: string,
    private readonly h: TransportHandlers,
  ) {
    if (typeof window !== 'undefined') {
      const kick = () => this.reconnectSoon();
      const offline = () => this.ws?.close();
      const vis = () => {
        if (document.visibilityState === 'visible') kick();
      };
      window.addEventListener('online', kick);
      window.addEventListener('offline', offline);
      document.addEventListener('visibilitychange', vis);
      this.cleanup.push(
        () => window.removeEventListener('online', kick),
        () => window.removeEventListener('offline', offline),
        () => document.removeEventListener('visibilitychange', vis),
      );
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    if (!this.ws && !this.timer) this.open();
  }

  send(frame: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame as Uint8Array<ArrayBuffer>);
  }

  /** Drop the current socket (if any) and connect immediately with a fresh backoff. */
  reconnect(): void {
    this.stopped = false;
    this.attempt = 0;
    this.clearTimer();
    const ws = this.ws;
    if (ws) {
      this.detach(ws);
      ws.close();
      this.h.onClose(0);
    }
    this.open();
  }

  /** Stop retrying (e.g. after a fatal server error) until `reconnect()`/`start()`. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.ws?.close();
  }

  destroy(): void {
    this.stop();
    if (this.ws) this.detach(this.ws);
    this.ws = null;
    for (const f of this.cleanup) f();
  }

  /** If we're waiting in backoff, try now instead. */
  private reconnectSoon(): void {
    if (this.stopped || this.ws) return;
    this.attempt = 0;
    this.clearTimer();
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // Wait for the `online` event (plus a slow safety retry).
      this.h.onClose(++this.attempt);
      this.timer = setTimeout(() => ((this.timer = null), this.open()), MAX_MS);
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.failed();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.openTimer = setTimeout(() => ws.close(), OPEN_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.openTimer) clearTimeout(this.openTimer);
      this.attempt = 0;
      this.h.onOpen();
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) this.h.onFrame(new Uint8Array(ev.data));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.detach(ws);
      this.ws = null;
      this.failed();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private failed(): void {
    this.attempt++;
    this.h.onClose(this.attempt);
    if (this.stopped) return;
    const cap = Math.min(MAX_MS, BASE_MS * 2 ** Math.min(this.attempt - 1, 10));
    const delay = cap / 2 + Math.random() * (cap / 2); // "equal jitter": never hammer at 0 ms
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  private detach(ws: WebSocket): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    if (this.ws === ws) this.ws = null;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
