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
- [x] `Id`, `StateVector` (+ binary encode/decode)
- [x] Item store with run-length-encoded items, UTF-16 lengths
- [x] Local `insert` / `delete` producing `Update`s
- [x] Integration algorithm (Fugue/YATA with left+right origins), concurrent inserts converge — FugueMax (YjsMod formulation)
- [x] Delete ops with their own IDs; tombstones
- [x] Pending queue for out-of-order / missing-dependency updates
- [x] `apply_update` returns exact `Change`s (UTF-16 positions)
- [x] `encode_diff(sv)` / `encode_full()` / `Update::merge`
- [x] Compact binary format (version byte, varints, client table) — update v2: zigzag-delta clocks; trace full state 434 KB
- [x] `Anchor` + `anchor_at` / `resolve_anchor`
- [x] Time travel: `op_count`, `version_at`, `text_at`
- [x] Position lookup faster than O(n) per op (e.g. B-tree / chunked list with cached lengths) — chunked list (64 runs/chunk) + per-client BTreeMap id index + cursor cache
- [x] Property tests: convergence (N replicas, random order, duplicates; also delivers diffs and merged batches) — ~~intention, diff, merge, time travel~~ (descoped: user wants minimal tests)
- [x] `UndoManager` for local undo/redo
- [x] Benchmark: replay the automerge-perf editing trace (~260k ops); record ops/s here — 259,778 patches: local ~115 ms (~2.2M ops/s), remote apply ~130 ms (~2.0M ops/s); seq typing ~3.6–4.8M ops/s, random edits ~0.85M ops/s
- [x] Fuzz-ish test: `apply_update` on random bytes never panics

## M2 · Sync protocol (`weft-sync`) — B
- [x] `Message` enum + postcard encode/decode + version check
- [x] `ClientSession` handshake (Hello → SyncStep → offline diff) and live streaming
- [x] `Room`: join/leave, broadcast to other peers, awareness cache + replay to newcomers
- [x] `unsynced_op_count` tracking that stays accurate across reconnects (asserted in the simulator)
- [x] Deterministic network simulator (drop/dup/reorder/delay/partition, seeded) — `crates/weft-sync/tests/sim.rs`; also server crash + restart from the persisted log, emoji edits, awareness
- [x] Simulator: 10k seeded scenarios converge (run a smaller count in CI and the full set with `--ignored`) — 200 seeds ≈3.5 s debug; 10k ≈26 s `--release --ignored`

## M3 · Server (`weft-server`) — B
- [x] axum app: `/ws/:doc_id`, `/healthz`, `/api/stats`, `/api/docs/:id/export.md` (verified manually with curl + `examples/ws_client.rs`)
- [x] Room registry (load on first join, unload when idle) — unload seen ~65 s after last disconnect
- [x] `DocStore`: append-only checksummed log, torn-tail recovery
- [x] Compaction to snapshot (temp file + fsync + atomic rename) — seen after 1100 edits
- [x] Static file serving of `web/dist` with SPA fallback
- [x] Keepalive pings, backpressure, malformed-frame handling (malformed frame verified: only that connection closed; slow-consumer drop not exercised manually)
- [x] ~~Integration test~~ (descoped: user wants minimal tests; verified manually): two native clients over real WebSockets converge; `kill -9` + restart → state survives
- [x] ~~Crash test~~ (descoped: user wants minimal tests; verified manually): truncated log mid-record → server loaded the prefix and truncated the torn tail

## M4 · WASM + web sync layer — C
- [x] `weft-wasm` `WeftClient` per contract; `scripts/build-wasm.sh` works
- [x] WASM size budget: < 150 KB gzipped (record actual) — 59.3 KB gzipped (148.7 KB raw; wasm-opt via wasm-pack, opt-level=s)
- [x] `src/sync/index.ts`: `openSession()` implementing `DocSession` — verified headless (Node + Vite SSR, no editor view)
- [x] Client id generation + persistence; random friendly name + color — client id is fresh per session by design (see ARCHITECTURE change log); name/color persisted
- [x] IndexedDB persistence (debounced save, load before first paint) — verified in Chromium: offline reload keeps text
- [x] WebSocket transport: backoff + jitter, `online`/`visibilitychange` resync — Chromium: offline→online and server kill -9 both resync (visibilitychange not exercised)
- [x] CodeMirror collab extension: local → CRDT, remote → editor (no echo), selection preserved — Chromium E2E: 2–7 ms keystroke latency, concurrent edits converge
- [x] Remote cursors + selections with name labels (decorations), driven by awareness — rendering confirmed in screenshots
- [x] Peers list + sync status events
- [x] History: `historyLength`, `textAtStep`, `restoreStep` (diff current → old text as new ops)
- [ ] Cross-tab: two tabs of the same doc stay in sync (via the server, and BroadcastChannel when offline) — server path + offline frame forwarding verified in smoke; BroadcastChannel wiring needs a browser

## M5 · UI/UX — D
- [x] Design tokens (light/dark, accent), typography, the calm centered writing surface — `src/styles/tokens.css`, system fonts, 72ch measure
- [x] Markdown live styling in CodeMirror (headings, emphasis, code, lists, links, `- [ ]` checkboxes) — lazy code-block grammars; HTML grammar kept out of the main chunk
- [x] Top bar: auto-title from first heading, presence avatars, sync status pill, Share button
- [x] Landing: `/` creates a new doc (`/d/<slug>`) instantly — 10-char base58 slug + `replaceState`
- [x] Command palette `⌘K` / `Ctrl+K` (fuzzy): new, copy link, export .md, copy HTML, theme, focus, history, rename
- [x] History scrubber panel (play/pause, drag, restore)
- [x] Recent docs (local) in palette + empty-state
- [x] Focus mode, word count / reading time
- [x] Toasts ("Link copied", "Back online · synced 12 edits")
- [x] Share popover with QR code — `qrcode-generator`, lazy chunk (7 KB gz)
- [x] Mock session (`?mock`) with fake peers for UI development — `?mock=5`, `&empty`, `&stable`
- [ ] Responsive (phones), keyboard accessible, `prefers-reduced-motion` — 390px screenshot and keyboard palette look right; reduced-motion and a real phone still unchecked
- [x] PWA: manifest + service worker so the app shell loads offline — Chromium: offline reload of the production build works

## M6 · Integration & polish — Lead
- [x] End-to-end: two browsers, live edits < 100 ms on localhost — 2–7 ms after keystroke (headless Chromium)
- [x] Offline scenario: both sides edit offline → reconnect → identical
- [x] `kill -9` server mid-session → restart → clients resync, no loss — resynced in ~60 ms, export matches
- [ ] Single-command dev (`scripts/dev.sh`) and production build (server serves `web/dist`) — production path verified; `dev.sh` not yet run
- [ ] README with GIF/screenshots, architecture diagram, benchmark numbers
- [x] Clippy clean, fmt, tests green

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
| 2026-10-25 | C | M4: `weft-wasm` WeftClient (59.3 KB gz) + `web/src/sync` (session, transport, IndexedDB, BroadcastChannel, CodeMirror collab + remote cursors). `web/scripts/smoke.mjs`: 13/13 checks pass against the real weft-server, direct and through the Vite proxy (live edit, concurrent + emoji, awareness anchors, offline reconnect, late joiner, restore-from-state, history, offline cross-tab frames). Browser-only paths still unverified. |
| 2026-10-25 | A | weft-core v1 landed: full §1 API works (insert/delete/apply_update/encode_diff/state_vector/merge/anchors/time travel/UndoManager); FugueMax integration, chunked RLE store. Optimization in progress, API stable |
| 2026-10-25 | B | M2 done: `weft-sync` protocol, `ClientSession`, `Room`; seeded simulator (200 seeds in `cargo test`, 10k with `--ignored`) green against A's core |
| 2026-10-25 | B | M3 done: `weft-server` (axum 0.8; registry, DocStore log + compaction, SPA, keepalive, bounded queues). Verified manually: 2-client convergence, kill -9 restart, torn tail, malformed frame, compaction, idle unload |
| 2026-10-25 | D | M5 UI built (vanilla TS + CSS): editor live styling, top bar, palette, history scrubber, share/QR, focus mode, toasts, recents, mock session, PWA shell. Typecheck + build green; dev server serves `/` and `/d/test?mock`. Main JS 208 KB (70 KB gz), CSS 6 KB gz. Not yet eyeballed in a real browser. |
| 2026-10-25 | A | M1 done. Fixed trimmed-delete clock bug (root cause of weft-sync sim seed 2450; verified by reintroducing it); proptest now also delivers merged batches and catches it. Update format bumped to v2 (delta clocks, -19% size). Tests kept minimal per user: convergence proptest + random-bytes no-panic. Benches: `cargo bench -p weft-core` |
| 2026-10-25 | Lead | M6: 16/16 headless-Chromium checks (live latency, offline merge, reload, late join, kill -9 recovery, offline PWA reload). Fixed editor focus ring, stale offline toast, and unsynced count after offline reload (`countNotIn` + persisted confirmed SV) |
| 2026-10-25 | Security | Phase 0 abuse limits (roadmap 02): 1 MiB frames, Origin check, loopback-only XFF, per-IP (64)/global (10k) conn caps, 300/s msg bucket, 10 s Hello deadline, 16 MiB doc quota, 2000-room cap, awareness bound to Hello id, core pending-queue cap, client name/color sanitizing. Verified manually against a server on :7990 (ws_client, node probe, curl) |
