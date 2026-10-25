// End-to-end smoke test: real WeftClient (wasm pkg) x3 over real WebSockets to weft-server.
// Usage: node scripts/smoke.mjs [ws://localhost:7878]   (or via Vite: ws://localhost:5173)
import { readFileSync } from 'node:fs';
import { initSync, WeftClient } from '../src/wasm/pkg/weft_wasm.js';

initSync({ module: readFileSync(new URL('../src/wasm/pkg/weft_wasm_bg.wasm', import.meta.url)) });
const BASE = process.argv[2] ?? 'ws://localhost:7878';
const DOC = `smoke-${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => (console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`), ok || failed++);

function client(name, id, state) {
  const wc = state ? WeftClient.fromState(DOC, id, state) : new WeftClient(DOC, id);
  const c = { name, wc, ws: null, peers: new Map(), text: wc.text() };
  c.send = (frames) => frames.forEach((f) => c.ws?.readyState === 1 && c.ws.send(f));
  c.connect = () =>
    new Promise((resolve, reject) => {
      const ws = (c.ws = new WebSocket(`${BASE}/ws/${DOC}`));
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => c.send(wc.onConnected());
      ws.onerror = (e) => reject(new Error(`${name}: ws error ${e.message ?? ''}`));
      ws.onclose = () => wc.onDisconnected();
      ws.onmessage = (ev) => {
        const out = wc.onMessage(new Uint8Array(ev.data));
        c.send(out.send);
        // Mirror changes onto a plain string like the editor would; must track wc.text().
        for (const ch of out.changes) {
          if (ch.insert) c.text = c.text.slice(0, ch.insert.pos) + ch.insert.text + c.text.slice(ch.insert.pos);
          else c.text = c.text.slice(0, ch.delete.pos) + c.text.slice(ch.delete.pos + ch.delete.len);
        }
        for (const a of out.awareness) a.payload ? c.peers.set(a.clientId, JSON.parse(a.payload)) : c.peers.delete(a.clientId);
        if (wc.isLive()) resolve();
      };
    });
  c.disconnect = () => new Promise((r) => { c.ws.onclose = () => (wc.onDisconnected(), r()); c.ws.close(); });
  c.insert = (pos, s) => (c.send(wc.insert(pos, s)), (c.text = wc.text()));
  c.del = (pos, n) => (c.send(wc.delete(pos, n)), (c.text = wc.text()));
  return c;
}

async function settle(cs, ms = 3000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(25)) {
    if (cs.every((c) => c.wc.text() === cs[0].wc.text() && c.wc.isSynced())) return true;
  }
  return false;
}

const a = client('a', 1001n), b = client('b', 2002n);
await Promise.all([a.connect(), b.connect()]);
check(a.wc.isLive() && b.wc.isLive(), 'both clients completed handshake');

const t0 = performance.now();
a.insert(0, 'Hello world');
await settle([a, b]);
check(b.wc.text() === 'Hello world', `live edit a→b in ${(performance.now() - t0).toFixed(1)} ms`);

// Concurrent edits at the same spot, plus a delete and non-BMP text.
a.insert(5, ',');
b.insert(11, '! 👋🏽');
b.del(0, 1);
b.insert(0, 'h');
await settle([a, b]);
check(a.wc.text() === b.wc.text(), `concurrent edits converge: ${JSON.stringify(a.wc.text())}`);
check(a.text === a.wc.text() && b.text === b.wc.text(), 'emitted changes reproduce the text exactly');

// Awareness with anchors.
const anchor = a.wc.anchorAt(5);
a.send(a.wc.setAwareness(JSON.stringify({ name: 'Ada', color: '#7c5cff', cursor: { anchor, head: anchor } })));
await sleep(200);
const pa = b.peers.get(1001n);
check(pa?.name === 'Ada', 'awareness delivered');
check(pa && b.wc.resolveAnchor(pa.cursor.head) === 5, 'peer anchor resolves to the same position');

// Offline: b disconnects, both edit, b reconnects.
await b.disconnect();
a.insert(0, '# ');
b.insert(b.wc.lenUtf16(), '\noffline line');
check(b.wc.unsyncedOpCount() > 0, `offline edit counted as unsynced (${b.wc.unsyncedOpCount()})`);
await b.connect();
check(await settle([a, b]), `offline edits merged after reconnect: ${JSON.stringify(a.wc.text())}`);
check(a.text === a.wc.text() && b.text === b.wc.text(), 'changes after reconnect reproduce the text');

// A fresh client (and one restored from saved state) gets the full doc.
const c = client('c', 3003n);
const d = client('d', 4004n, b.wc.encodeState());
await Promise.all([c.connect(), d.connect()]);
check(await settle([a, b, c, d]), 'late joiner + restored-from-state client converge');

// History.
const n = a.wc.opCount();
check(a.wc.textAtStep(0) === '' && a.wc.textAtStep(n) === a.wc.text(), `textAtStep 0..${n} endpoints`);

// Restore-like diff edit on c propagates.
c.del(0, c.wc.lenUtf16());
c.insert(0, 'restored');
check(await settle([a, b, c, d]) && a.wc.text() === 'restored', 'full replace propagates');

// Cross-tab path (BroadcastChannel in the browser), fully offline: forward local-update frames.
const t1 = new WeftClient(DOC, 5005n), t2 = WeftClient.fromState(DOC, 6006n, t1.encodeState());
t1.insert(0, 'tab one');
t2.onMessage(t1.takeLocalUpdate());
t2.insert(0, '> ');
t1.onMessage(t2.takeLocalUpdate());
const late = new WeftClient(DOC, 7007n);
late.onMessage(t1.encodeDiffFrame(late.stateVector()));
check(t1.text() === '> tab one' && t2.text() === t1.text() && late.text() === t1.text(), 'offline cross-tab frames converge');

for (const x of [a, b, c, d]) x.ws.close();
await sleep(50);
console.log(failed ? `\n${failed} check(s) failed` : '\nall smoke checks passed');
process.exit(failed ? 1 : 0);
