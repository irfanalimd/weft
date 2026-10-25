# Weft — Build Plan

Check boxes (`[x]`) as items are **done and verified** (tests pass / manually confirmed). Add a short
note after an item if it's useful, e.g. `— 1.2M ops/s on trace`. If you skip or descope something,
write `~~strikethrough~~ (why)` instead of deleting it.

Owners: **A** = core CRDT · **B** = sync + server · **C** = wasm + web sync layer · **D** = UI/UX ·
**Lead** = integration.

See `docs/VISION.md` (why/what) and `docs/ARCHITECTURE.md` (contracts).

---

## M0 · Scaffolding — Lead
- [x] Toolchain: rustup stable, `wasm32-unknown-unknown`, wasm-pack, node/npm
- [x] Cargo workspace with 4 crates + shared `[workspace.dependencies]`
- [x] Contract stubs compile (`weft-core`, `weft-sync` signatures with `todo!()`)
- [x] `web/` Vite + TS + CodeMirror skeleton, `src/sync/types.ts` contract
- [x] `scripts/build-wasm.sh`, `scripts/dev.sh`, `.gitignore`, git init

## M1 · CRDT engine (`weft-core`) — A
- [ ] `Id`, `StateVector` (+ binary encode/decode)
- [ ] Item store with run-length-encoded items, UTF-16 lengths
- [ ] Local `insert` / `delete` producing `Update`s
- [ ] Integration algorithm (Fugue/YATA with left+right origins), concurrent inserts converge
- [ ] Delete ops with their own IDs; tombstones
- [ ] Pending queue for out-of-order / missing-dependency updates
- [ ] `apply_update` returns exact `Change`s (UTF-16 positions)
- [ ] `encode_diff(sv)` / `encode_full()` / `Update::merge`
- [ ] Compact binary format (version byte, varints, client table)
- [ ] `Anchor` + `anchor_at` / `resolve_anchor`
- [ ] Time travel: `op_count`, `version_at`, `text_at`
- [ ] Position lookup faster than O(n) per op (e.g. B-tree / chunked list with cached lengths)
- [ ] Property tests: convergence (N replicas, random order, duplicates), intention, diff, merge, time travel
- [ ] `UndoManager` for local undo/redo
- [ ] Benchmark: replay the automerge-perf editing trace (~260k ops); record ops/s here
- [ ] Fuzz-ish test: `apply_update` on random bytes never panics

## M2 · Sync protocol (`weft-sync`) — B
- [ ] `Message` enum + postcard encode/decode + version check
- [ ] `ClientSession` handshake (Hello → SyncStep → offline diff) and live streaming
- [ ] `Room`: join/leave, broadcast to other peers, awareness cache + replay to newcomers
- [ ] `unsynced_op_count` tracking that stays accurate across reconnects
- [ ] Deterministic network simulator (drop/dup/reorder/delay/partition, seeded)
- [ ] Simulator: 10k seeded scenarios converge (run a smaller count in CI and the full set with `--ignored`)

## M3 · Server (`weft-server`) — B
- [ ] axum app: `/ws/:doc_id`, `/healthz`, `/api/stats`, `/api/docs/:id/export.md`
- [ ] Room registry (load on first join, unload when idle)
- [ ] `DocStore`: append-only checksummed log, torn-tail recovery
- [ ] Compaction to snapshot (temp file + fsync + atomic rename)
- [ ] Static file serving of `web/dist` with SPA fallback
- [ ] Keepalive pings, backpressure, malformed-frame handling
- [ ] Integration test: two native clients over real WebSockets converge; restart server → state survives
- [ ] Crash test: truncate log mid-record → server still loads everything before it

## M4 · WASM + web sync layer — C
- [ ] `weft-wasm` `WeftClient` per contract; `scripts/build-wasm.sh` works
- [ ] WASM size budget: < 150 KB gzipped (record actual)
- [ ] `src/sync/index.ts`: `openSession()` implementing `DocSession`
- [ ] Client id generation + persistence; random friendly name + color
- [ ] IndexedDB persistence (debounced save, load before first paint)
- [ ] WebSocket transport: backoff + jitter, `online`/`visibilitychange` resync
- [ ] CodeMirror collab extension: local → CRDT, remote → editor (no echo), selection preserved
- [ ] Remote cursors + selections with name labels (decorations), driven by awareness
- [ ] Peers list + sync status events
- [ ] History: `historyLength`, `textAtStep`, `restoreStep` (diff current → old text as new ops)
- [ ] Cross-tab: two tabs of the same doc stay in sync (via the server, and BroadcastChannel when offline)

## M5 · UI/UX — D
- [ ] Design tokens (light/dark, accent), typography, the calm centered writing surface
- [ ] Markdown live styling in CodeMirror (headings, emphasis, code, lists, links, `- [ ]` checkboxes)
- [ ] Top bar: auto-title from first heading, presence avatars, sync status pill, Share button
- [ ] Landing: `/` creates a new doc (`/d/<slug>`) instantly
- [ ] Command palette `⌘K` / `Ctrl+K` (fuzzy): new, copy link, export .md, copy HTML, theme, focus, history, rename
- [ ] History scrubber panel (play/pause, drag, restore)
- [ ] Recent docs (local) in palette + empty-state
- [ ] Focus mode, word count / reading time
- [ ] Toasts ("Link copied", "Back online · synced 12 edits")
- [ ] Share popover with QR code
- [ ] Mock session (`?mock`) with fake peers for UI development
- [ ] Responsive (phones), keyboard accessible, `prefers-reduced-motion`
- [ ] PWA: manifest + service worker so the app shell loads offline

## M6 · Integration & polish — Lead
- [ ] End-to-end: two browsers, live edits < 100 ms on localhost
- [ ] Offline scenario: both sides edit offline → reconnect → identical
- [ ] `kill -9` server mid-session → restart → clients resync, no loss
- [ ] Single-command dev (`scripts/dev.sh`) and production build (server serves `web/dist`)
- [ ] README with GIF/screenshots, architecture diagram, benchmark numbers
- [ ] Clippy clean, fmt, tests green

## M7 · Stretch (ambitious)
- [ ] Multi-node: server nodes gossip updates (doc-sharded or full mesh); kill a node → clients fail over
- [ ] Peer-to-peer WebRTC fallback when the server is unreachable
- [ ] End-to-end encryption (key in URL fragment; server stores ciphertext updates only)
- [ ] Author attribution: color text by who wrote it (toggle)
- [ ] Comments/annotations anchored with `Anchor`
- [ ] `weft` CLI: `weft cat <url>`, `weft edit <url>` (terminal client using the same crates)
- [ ] Dockerfile + one-click deploy (Fly.io)

---

## Progress log

| Date | Who | Note |
|---|---|---|
| 2026-10-25 | Lead | Vision, architecture contracts, and plan written |
| 2026-10-25 | Lead | M0 done: workspace + stubs compile (native + wasm32), web skeleton builds, wasm-pack verified |
