# Roadmap 04 — Performance & Scale

Status: draft (2026-10). Owners: **A** core CRDT · **B** sync + server · **C** wasm + web sync · **D** UI.
Related: `PLAN.md` (M1 benchmark notes), `docs/ARCHITECTURE.md`.

## 0. Where we are (baseline)

| Metric | Current value | Notes |
|---|---|---|
| automerge-paper trace replay, local (259,778 patches) | ~115 ms (~2.2M ops/s) | `weft-core`, chunked RLE list, 64 runs/chunk |
| same trace, remote apply | ~130 ms (~2.0M ops/s) | |
| Random edits | ~0.85M ops/s | worst case for the cursor cache |
| Sequential typing | 3.6–4.8M ops/s | |
| `encode_full` (trace) | 57–72 ms, 434 KB | update v2, zigzag-delta clocks |
| Load (decode + integrate) | 32–43 ms | full replay of the op log |
| `version_at` / `text_at` | O(n) | replays the log from the start |
| WASM bundle | 59 KB gzipped | |
| Server | axum, one `std::sync::Mutex<RoomInner>` per room, plus a global `Mutex<HashMap>` of rooms | `crates/weft-server/src/lib.rs` |

Code layout: `crates/weft-core/src/{seq.rs (Piece/LId/Loc, chunked list, MAX_PIECES = 64), doc.rs (Doc, ClientData.content: Vec<u16>, LogEntry log, pending queue), encoding.rs, merge.rs, undo.rs}`.

Main gaps, in order of user impact:
1. **Cold load is slower than it needs to be.** 32–43 ms for one document is fine for a single client, but it is the dominant cost when a server reopens 1k documents. Loro reports ~1 ms (0.37 ms shallow) with its 1.0 snapshot format, for a real-world document with *millions* of ops, which is larger than our trace.
2. **Snapshot size**: 434 KB vs 227–293 KB for the other libraries on the same trace (table below). We store history plus tombstones uncompressed.
3. **Time travel is O(n)**, so a history slider stutters on long documents.
4. **The server is untested at scale.** There is no load harness, and a std Mutex held during broadcast serialises fan-out.

---

## 1. Benchmark suite against Yjs (yrs), Automerge, Loro and diamond-types

**Technique.** Add a `benches/` crate (`crates/weft-bench`) that runs the standard traces through every library in one process on one machine, so we stop comparing against numbers published from other hardware. Traces: `automerge-paper` (already in `data/`), `seph-blog1`, `friendsforever`, `clownschool`, `rustcode`, `sveltecomponent`, and the concurrent `node_nodecc` / `git-makefile` traces from the Eg-walker artifact (josephg/editing-traces).

**Published numbers vs ours.** These figures come from different machines and library versions, so treat them as indications of order of magnitude only. Loro's own docs say such tables "serve as indicators of the absence of performance pitfalls" rather than rankings.

| Library | automerge-paper apply/replay | Snapshot size (trace, default) | Snapshot size (gc / shallow) | Load | Source |
|---|---|---|---|---|---|
| **Weft (ours)** | **~115 ms local / ~130 ms remote** | **434 KB** | n/a (no GC yet) | **32–43 ms** | PLAN.md M1 |
| diamond-types | 15.63 ms | 281,042 B | — | Eg-walker paper: "orders of magnitude faster than CRDTs" | Loro native bench (Oct 2024, M2 Max); arXiv 2409.14252 |
| Loro | 88.19 ms | 273,561 B | ~63 KB shallow (~54.5 KB compressed) | ~1 ms (1.0 format), ~0.26–0.37 ms shallow | Loro native bench; Loro 1.0 blog |
| Automerge (Rust) | 450.91 ms | 292,742 B | no GC | — | Loro native bench |
| Yrs | 4,238.8 ms in that table (look up the task row before citing); Yrs is fastest on concurrent list inserts (13.95 ms) | 226,973 B | 71,033 B (gc + compress) | — | Loro native bench / docsize page |

Before quoting any figure in that table, rerun it on our harness. One known mismatch: the Yrs figure most likely comes from a different task row than the plain trace replay.

What the table tells us: our replay speed is in the right league (between diamond-types and Loro). Our **size is the outlier**, at 1.5–1.9× the others. **Load** is the largest relative gap, at 30–100× slower than Loro and diamond-types, because we re-integrate every op on load instead of loading a materialised state.

**Implementation sketch.**
- `weft-bench` depends on `yrs`, `automerge`, `loro`, `diamond-types` (pinned versions), and `criterion` (or `divan` for faster iteration).
- One trait: `trait Subject { fn replay(trace) -> Self; fn encode(&self) -> Vec<u8>; fn decode(&[u8]) -> Self; fn text(&self) -> String; fn mem_bytes() }`. Each library gets a ~50-line adapter.
- Metrics per (library, trace): replay local, apply remote update(s), encode, decode, decode+materialise text, encoded size (raw and zstd/gzip), peak RSS (use `dhat` or a counting `#[global_allocator]`).
- Check correctness: every subject's final text must equal the trace's `endContent`.
- JS/WASM mode: the same traces in Node via `yjs`, `@automerge/automerge`, `loro-crdt`, and our `weft-wasm` build (`web/bench/`, run with `vitest bench` or `tinybench`).

**Phased plan.**
- [ ] P1: `weft-bench` crate with a Weft-only criterion bench over `automerge-paper` (replay/encode/decode/size). This replaces the ad-hoc timing.
- [ ] P1: add the `seph-blog1`, `friendsforever` and `clownschool` traces (and `data/README` with licence and provenance)
- [ ] P2: adapters for yrs, automerge, loro, diamond-types, plus the final-text equality check
- [ ] P2: memory measurement via a counting allocator (steady-state and peak during replay)
- [ ] P3: JS/WASM harness comparing `yjs`, `@automerge/automerge`, `loro-crdt` and `weft-wasm` in Node 22
- [ ] P3: concurrent traces (Eg-walker `node_nodecc`, `git-makefile`) to stress merge of long-running branches
- [ ] P3: generate `docs/perf/RESULTS.md` from the bench JSON (machine, rustc and library versions in the header)

**How to measure.** `cargo bench -p weft-bench -- --save-baseline main`; report the median of 20 samples, with CPU frequency pinned where possible (`taskset -c 2`, performance governor). Keep one table per machine.

---

## 2. CRDT engine optimisations (`weft-core`)

### 2.1 B-tree with cached counts (replace the chunked list)

**Technique.** The current `Seq` is a flat list of 64-piece chunks with cached visible UTF-16 lengths, plus a per-client `BTreeMap` from clock to chunk. A position lookup is O(n/64) chunk scans, made fast in practice by the cursor cache, which is why random edits (0.85M ops/s) are ~3–5× slower than sequential ones. A B-tree (or order-statistic rope) keeps per-node aggregate counts: visible length, and optionally total length including tombstones. Both index→leaf and leaf→index then take O(log n). diamond-types uses a "content tree" (a B-tree of RLE runs) plus a separate "marker" index from id to leaf, which is the same shape.

**Expected gain.** Random edits: 0.85M → ~2–3M ops/s, flat as the document grows. The trace replay changes little (it is already cursor-friendly). The main win is a flat curve for 1 MB+ documents and for remote ops landing far from the cursor.

**Sketch.**
- Internal nodes: `[(child, vis_len, total_len); B]` with B = 16–32. Leaves: `ArrayVec<Piece, 32–64>`.
- Store leaves in a slab (`Vec<Leaf>` + free list) so the existing `Loc { chunk, idx, off }` survives as `(leaf_id, idx, off)`, and the id index keeps pointing to leaf ids. On a split, update the index entries of the moved pieces only.
- Parent pointers on leaves let us compute leaf→position (needed by `apply_update` to emit `Change` positions) by walking up and summing left siblings.
- Keep the cursor cache as a fast path.
- Keep the `Key = (usize, usize, u64)` total order used by FugueMax comparisons. It needs a leaf order rank, which can be computed on demand by walking up the tree in O(log n), or made unnecessary by comparing through the tree path.

**Plan.**
- [ ] Bench: random-edit microbench at 10 KB / 100 KB / 1 MB / 10 MB documents to show the current growth curve
- [ ] Prototype `Seq` trait boundary so the chunked list and the B-tree are swappable behind `cfg` or a generic
- [ ] Implement the B-tree with `vis_len` aggregates, a slab of leaves and parent pointers
- [ ] Port the id index to leaf ids and test the split/merge invariants with proptest against the old `Seq`
- [ ] Switch the default once random edits are ≥2× faster and the trace is no slower than 5%

**Measure.** Random edits ops/s vs document size (should be roughly flat); trace replay within ±5%; `Seq` memory per piece.

### 2.2 Eg-walker-style event graph replay

**Technique.** Eg-walker (Gentle & Kleppmann, EuroSys 2025) stores only the *event graph*: ops with original indices, plus parent versions. It builds CRDT state transiently, and only for the concurrent region being merged. Steady state is a plain string plus a compact op log. Loading is "the same as OT and orders of magnitude faster than the CRDTs tested", and steady-state memory is "at least an order of magnitude below the CRDTs".

**Expected gain for Weft.** Load becomes "read the string" (≪1 ms instead of 32–43 ms), and memory per open document is roughly the text plus a compact log. Sequential (non-concurrent) ops become plain string edits, about 10× faster in the paper's evaluation.

**Cost / risk.** This is a large architectural change. Our wire format (FugueMax items with origins) and `Anchor`s are id-based, and Eg-walker would need to translate ids to positions when concurrency occurs. Recommendation: do **not** rewrite. Adopt its two cheapest ideas:
1. **Fast path for causally-sequential remote ops**: if an update's deps equal our current frontier and nothing is pending, apply it as a position edit with a cheap id-index update, and skip the origin comparison loop.
2. **Materialised-text snapshot** (see 2.4), so load does not need the CRDT structure until a concurrent op arrives.

**Plan.**
- [ ] Write-up: map Eg-walker's "prepare/effect" versions onto our `LogEntry` log, and identify what `Anchor` resolution needs
- [ ] Measure how often remote updates are "sequential w.r.t. our frontier" in real sessions (add a counter in `weft-server` logs)
- [ ] Implement the sequential fast path in `doc.rs::apply_update`, and check equality against the slow path with proptest
- [ ] Spike (time-boxed to 1 week): Eg-walker replay over our log, comparing trace replay and memory against the current engine

**Measure.** Remote apply ops/s on the trace and on the concurrent traces; RSS per document; load time.

### 2.3 GC / compaction of tombstones

**Technique.** Deleted runs stay as `Piece { deleted: true }`, and their content stays in `ClientData.content: Vec<u16>`. Two levels of GC:
- **Content GC** (safe once all known peers have seen the delete): drop the deleted characters' content and keep only the id range. This is Yjs's `gc: true`, which takes the Yrs trace snapshot from 227 KB to 71 KB.
- **Structural compaction**: merge adjacent tombstone pieces across clients into "GC ranges" when no live item uses them as an origin. Requires the server to know a causal-stability frontier (the min state vector over all replicas it has heard from recently).

**Expected gain.** Snapshot 434 KB → ~100–150 KB on the trace (estimate based on Yrs's gc ratio). Memory scales with live text, not total typed text. Time travel before the GC point is given up, unless history checkpoints (2.5) are kept separately in cold storage.

**Plan.**
- [ ] Add a `Doc::gc(stable: &StateVector)` that drops content for tombstones fully covered by `stable`
- [ ] Encoding: emit GC'd runs as `(client, clock, len)` without content (format version bump, readers accept both)
- [ ] Server tracks a per-room stability frontier: the min SV over connected clients and recently-seen clients (TTL). Run GC on persist.
- [ ] Document the interaction with `UndoManager` (undo of a delete needs content): keep content within the local undo window
- [ ] Optional: keep a full-history archive per document in object storage so `text_at` still works for old versions

**Measure.** Snapshot size and RSS on the trace before and after; convergence proptest including GC'd replicas.

### 2.4 Lazy-load snapshot format

**Technique.** Today `encode_full` serialises the op log, and load re-integrates it (32–43 ms). Instead, write a **sectioned snapshot**:
1. Header + section table (offsets/lengths, so readers can skip sections).
2. `text`: the visible UTF-8 string. This is enough to render immediately.
3. `state`: the `Seq` pieces in document order, columnar (client column, clock deltas, len, deleted bitmap, origin columns), which is enough to rebuild `Seq` without running integration.
4. `history`: the op log (for `text_at`), compressed, decoded only on demand.
5. Optional `checkpoints` (2.5).

Columns are delta + varint encoded, then optionally zstd (in WASM, use `lz4_flex` or the browser's `DecompressionStream` to keep size down).

**Expected gain.** Time to first text drops to ~1 ms (one memcpy plus UTF-8 validation). Full editable state comes from linear piece rebuild without origin search, an estimated 5–10× faster than replay (3–8 ms). Loro reports a similar change taking load from 16 ms to 1 ms. `encode_full` gets faster too, since it is a linear dump rather than log re-encoding.

**Plan.**
- [ ] Define snapshot v3 in `docs/ARCHITECTURE.md` (sections, versioning, forward compatibility)
- [ ] `encode_snapshot()` / `Doc::load_snapshot()` with lazy `history` (an `OnceCell<Vec<LogEntry>>`)
- [ ] `weft-wasm`: `textFromSnapshot(bytes)` that returns only the text, for first paint before the full doc is built
- [ ] Server stores snapshot v3 and sends it on join instead of the full update
- [ ] Bench: time-to-text, time-to-editable, size (raw/zstd)

**Measure.** On the trace: target ≤1 ms to text, ≤8 ms to editable, ≤250 KB raw (≤120 KB zstd).

### 2.5 History checkpoints so `text_at` is O(log n)

**Technique.** `version_at(k)` / `text_at(k)` replay k ops. Store checkpoints every K ops (e.g. K = 4096). A checkpoint is the visible text at that op, or a compact "visible id-range set" so it works with the live `Seq`. `text_at(k)` then binary-searches to the nearest checkpoint ≤ k and replays at most K ops.

Alternative with no extra storage: each piece already carries its insert id. Deletes carry their own ids. For a linear log, "visible at op k" means "inserted at log index ≤ k and not deleted at log index ≤ k". With a per-piece `(insert_idx, delete_idx)` pair, `text_at(k)` becomes one filtered scan of `Seq`. That is O(n) in document size but with no replay, and with B-tree aggregates of min/max idx per node, whole subtrees can be skipped.

**Expected gain.** History slider scrubbing is ≤ K ops of work per frame, giving ~1–2 ms per seek on the trace instead of up to ~115 ms.

**Plan.**
- [ ] Record `log_idx` for insert and delete on each piece (piece splits if delete indices differ, which RLE already handles)
- [ ] `text_at` via a filtered scan; bench vs the current replay
- [ ] Optional sparse text checkpoints (every 4096 ops, zstd) in the snapshot `checkpoints` section
- [ ] UI: debounce the slider to rAF and show the nearest checkpoint while seeking

**Measure.** p50/p99 `text_at(random k)` on the trace. Target p99 < 5 ms native, < 10 ms WASM.

### 2.6 Smaller wins

- [ ] `ClientData.content: Vec<u16>` stores placeholders for delete clocks. Store content per insert run (or in one shared UTF-8 rope) to drop the placeholders: less memory and faster encode
- [ ] `encode_full` at 57–72 ms is slower than replay. Profile (`cargo flamegraph`). It is probably per-op varint and `BTreeMap` iteration, and could use preallocation plus a column writer
- [ ] Try `MAX_PIECES` 32/128 and check the effect on random vs sequential edits
- [ ] Use `FxHash`/`ahash` for any `HashMap` on hot paths

---

## 3. WASM size/speed budget in CI, and avoiding JS↔WASM copies

**Technique.**
- **Budget**: fail CI if `weft_wasm_bg.wasm.gz` > 64 KB (current 59 KB, ~8% headroom), or if the trace replay in Node is more than 10% slower than `main`.
- **Size levers**: `opt-level = "z"` vs `"s"` (measure both), `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `wasm-opt -Oz --enable-bulk-memory`. Avoid `format!`/`Debug` on hot paths. Check with `twiggy top`.
- **Copies**: every `applyUpdate(Uint8Array)` copies bytes into linear memory (unavoidable, but use `Uint8Array` views, not `Vec<u8>` → JS arrays). The main avoidable costs are:
  - Returning `Change[]` as JS objects (serde-wasm-bindgen allocates per change). Instead, return a flat `Uint32Array` `[kind, pos, len, …]` plus one string buffer, and decode in TS.
  - Strings: return inserted text as one concatenated string per update, not per change.
  - `getText()` on every update: never. Keep CodeMirror in sync from `Change`s, and call `getText` only on load or debug.
  - Use `TextDecoder` on a view of WASM memory for large strings.

**Expected gain.** Remote apply in the browser is dominated by the bridge for small updates. Flat arrays usually give 2–5× fewer allocations per update. Size stays ≤64 KB.

**Plan.**
- [ ] `scripts/wasm-size.sh`: build release, gzip/brotli, print sizes, exit non-zero over budget; wire into CI
- [ ] `web/bench/trace.bench.ts`: replay the trace through `weft-wasm` in Node and output JSON; CI compares against the main baseline
- [ ] Change the `applyUpdate` return type to a flat encoding (keep the old API behind a flag for one release)
- [ ] `twiggy` report as a CI artifact; investigate any function >2 KB
- [ ] Try `wasm-opt -Oz` vs `-O3` (size vs speed) and record the trade-off

**Measure.** gzipped/brotli bytes; trace replay ms in Node; allocations per `applyUpdate` (Chrome heap profiler); p99 time from a remote update to the CodeMirror dispatch.

---

## 4. Server (`weft-server`)

### 4.1 Per-room actor tasks

**Technique.** Replace `Mutex<RoomInner>` with one tokio task per room that owns the `Room` and receives `enum RoomMsg { Join, Update(bytes, from), Awareness, Leave, Persist }` over an `mpsc` channel. The global `Mutex<HashMap<String, Arc<RoomSlot>>>` becomes a `DashMap<DocId, RoomHandle>` (or a sharded map). Socket tasks never block on a lock. The room task serialises integration, which the CRDT requires anyway, and never holds a lock across `.await`.

**Expected gain.** No contention on the global map. No blocking of tokio workers by a std Mutex during a long merge (e.g. a 1 MB initial sync). Natural places for batching, backpressure, idle eviction and persistence timers.

**Plan.**
- [ ] `RoomActor` with a bounded `mpsc` (e.g. 1024), and a `RoomHandle` clone per socket
- [ ] Idle eviction: no members for 60 s → persist, drop the actor, remove it from the map
- [ ] Join during load: a `OnceCell`-style "loading" state so concurrent joins share one load
- [ ] Remove `std::sync::Mutex` from the request path (keep it only for metrics, if at all)

### 4.2 Update batching / coalescing

**Technique.** When a room actor drains its inbox, it takes all queued `Update`s (`try_recv` loop up to N or 2 ms), applies them, and broadcasts **one merged update** (`Update::merge` already exists) to each peer, excluding each sender's own ops. Awareness messages are coalesced to the latest per client.

**Expected gain.** Under burst (paste, reconnect storms, 50 typists), M updates × P peers sends become ~1 × P. Merged RLE updates are also smaller on the wire.

**Plan.**
- [ ] Drain-and-merge loop with `max_batch = 64`, `max_delay = 2 ms` (only waits if the queue is non-empty)
- [ ] Per-recipient exclusion: either send the merged update to everyone (idempotent; clients drop known ops) or build a per-sender diff. Start with "send to all"; it is simpler, and the CRDT dedups.
- [ ] Metric: `updates_in` vs `frames_out` per room

### 4.3 Broadcast fan-out cost model

Per room with P peers and an update rate of u updates/s:
- Integration: u × c_apply (≈ 0.5 µs per op natively) — negligible.
- Encode once: 1 × c_encode per batch. **Encode once and share an `Arc<[u8]>` / `Bytes` across all peers**, never per peer.
- Send: P × (c_ws_frame + syscall). At ~2–5 µs per frame, plus TLS if terminated in-process, this term dominates. 100 peers × 20 updates/s ≈ 2,000 frames/s ≈ 4–10 ms CPU/s per room.
- Server-wide: Σ_rooms P_r × u_r frames/s. With 10k sockets across 1k docs (avg 10 peers) and 2 updates/s each (keystroke batching on the client at ~16–50 ms), that is ~200k frames/s, roughly 1–2 cores of frame work. Batching (4.2) divides this by the batch factor.
- Per-peer outbound queue: a bounded channel (e.g. 256 frames). On overflow, drop the queue and send a resync (`SyncStep1`) instead of buffering without bound. A slow consumer must never stall the room.

**Plan.**
- [ ] Use `bytes::Bytes` for broadcast payloads, with one encode per batch
- [ ] Bounded per-socket writer task, with resync-on-overflow
- [ ] Microbench: fan-out of a 50-byte update to 1/10/100/1000 local sockets; fit c_frame

### 4.4 Memory per doc

**Technique.** Measure and cap. Today a room holds the full `Doc` (pieces + `Vec<u16>` content + log). Target: ≤ 3× text size + O(pieces) for hot documents. Evict idle rooms to the snapshot (4.1) and keep hot rooms only.

**Plan.**
- [ ] `Doc::heap_size()` (approximate, summed over Vec capacities) exposed as a metric `weft_room_bytes`
- [ ] Measure on the trace: bytes per document after replay, after GC (2.3), after snapshot load (2.4)
- [ ] Global memory budget: LRU-evict idle rooms when the total exceeds the limit

### 4.5 Cold-load time

Cold load = storage read + decode + (re)build. Today it is a 32–43 ms decode for a trace-sized document. With snapshot v3 (2.4) the target is ≤ 8 ms editable. Also:
- [ ] Do the load in `spawn_blocking`, so a large decode never stalls the runtime
- [ ] Persist compaction: on persist, write snapshot v3 + truncate the update log (append-only updates between snapshots)
- [ ] Metric: `weft_room_load_seconds` histogram (p50/p99)
- [ ] Join reply: send snapshot v3 bytes directly (client renders text first, see §5)

### 4.6 Load-test harness (10k concurrent sockets, 1k docs)

**Technique.** A custom tokio client (`crates/weft-loadtest`) is a better fit than goose. Goose is HTTP-request oriented, while we need long-lived WebSockets with CRDT state per client. Each virtual user: connect `ws://…/doc/{id}`, do the sync handshake, then type at a configurable rate (Poisson, mean 5 chars/s, with bursts) using a real `weft_core::Doc`, so traffic is realistic and convergence can be checked.

**Sketch.**
- `tokio-tungstenite` clients, one task per user. 10k sockets need `ulimit -n 65536`, and ideally multiple source IPs or ports (`SO_REUSEADDR`, several loopback aliases 127.0.0.2…) to avoid ephemeral-port exhaustion.
- Scenario config (TOML): docs = 1000, users = 10000, distribution = zipf(1.1), so a few hot docs have 200+ peers and most have 1–5; typing rate; join ramp (500/s); duration; reconnect storm at t = 5 min (drop 30% and reconnect).
- Metrics: echo latency (each client stamps ops; peers record receipt time → p50/p95/p99 end-to-end), connect/handshake time, server CPU/RSS (scraped from `/metrics`), dropped/resynced sockets.
- End check: every client's text for doc X equals the server's (hash compare) → convergence under load.
- Optionally use goose for HTTP endpoints only (document list, snapshot download).

**Targets (single 8-vCPU box).** 10k sockets, 1k docs, 50k ops/s aggregate: p99 echo < 50 ms, server RSS < 2 GB, no resyncs in steady state, 100% convergence.

**Plan.**
- [ ] `weft-loadtest` crate: single-doc, 100-client smoke scenario
- [ ] Latency stamping + HDR histogram output (`hdrhistogram` crate) → JSON
- [ ] Zipf multi-doc scenario, ramp control, reconnect storm
- [ ] Server `/metrics` (Prometheus): sockets, rooms, frames/s, room bytes, load times, queue depths
- [ ] Run before/after 4.1–4.3 and record results in `docs/perf/RESULTS.md`
- [ ] Nightly CI job running a reduced profile (1k sockets / 100 docs, 2 min)

---

## 5. Frontend: large docs, CodeMirror viewport, first paint

**Technique.**
- **Large docs (1 MB+)**: CodeMirror 6 already virtualises rendering via its viewport. Our risks are elsewhere:
  - Markdown parsing: `@codemirror/lang-markdown` parses incrementally and time-sliced, so keep it that way. Avoid any full-document decorations (live preview widgets) computed outside `view.visibleRanges`.
  - Sync layer: never call `getText()` or rebuild the doc. Translate `Change`s into one `ChangeSet` per update (one `view.dispatch`).
  - UTF-16 positions: CodeMirror and Weft both use UTF-16 code units, so no conversion pass is needed. Keep it that way.
  - Remote cursors/awareness: render only decorations in the viewport.
  - Initial load: decode in a Web Worker (WASM in the worker), post the text to the main thread, create the `EditorState` from the text, then hand off.
- **First paint**: serve snapshot v3 text section (§2.4) → `EditorState.create({ doc: text })` → paint → then build the CRDT and attach sync. The editor is read-only until it is ready (usually < 20 ms later).

**Metrics.** `performance.mark` at nav start → `ws-open` → `snapshot-received` → `text-rendered` (FCP of editor content) → `editable`. Keystroke-to-paint latency via the Event Timing API (INP). Remote-update-to-paint p99.

**Plan.**
- [ ] Generate fixtures: 1 MB / 5 MB / 20 MB Markdown (concatenated traces plus real READMEs)
- [ ] Playwright perf test: load fixture, record marks, type 200 chars, record INP; output JSON
- [ ] Move WASM decode into a worker for docs > 256 KB
- [ ] Audit decorations and extensions for full-document work (`EditorView.decorations` over `visibleRanges` only)
- [ ] Targets: 1 MB doc text-rendered < 300 ms on a mid laptop (4× CPU throttle in CI), editable < 600 ms, INP < 50 ms

---

## 6. Perf regression dashboard

**Technique.** Every push to `main` runs the bench suite (§1 Weft-only subset, §3 WASM size and Node trace, §5 Playwright marks, a reduced §4.6 profile nightly). Results are pushed as JSON to a `perf-data` branch, or uploaded with `github-action-benchmark`, which renders a chart page and comments on PRs when a metric regresses by more than a threshold. Alternatives: Bencher.dev (hosted, supports criterion and statistical thresholds) or CodSpeed (instruction-count based, low noise on shared CI runners).

**Noise control.** Shared CI runners are noisy (±10–20%). Use instruction counts (CodSpeed / `iai-callgrind`) for gating PRs, and wall-clock on a dedicated self-hosted runner for the dashboard trend.

**Tracked series.**
| Series | Gate |
|---|---|
| trace replay local/remote (ns/op, instr count) | +5% instr fails PR |
| random edits ops/s at 100 KB, 1 MB | +10% |
| encode_full ms, snapshot bytes | +5% bytes fails |
| load ms (time-to-text, time-to-editable) | +10% |
| text_at p99 | +20% |
| WASM gz bytes | hard cap 64 KB |
| Node trace replay via WASM | +10% |
| Editor first paint / INP (Playwright) | +15% (trend only) |
| Loadtest p99 echo, RSS (nightly) | trend + alert |

**Plan.**
- [ ] `iai-callgrind` benches for replay/encode/decode (deterministic, PR gate)
- [ ] `github-action-benchmark` (or Bencher) wired to criterion JSON + custom JSON for size/WASM/Playwright
- [ ] Dashboard page (GitHub Pages from the `perf-data` branch) linked from the README
- [ ] PR comment bot with a per-metric delta table
- [ ] Monthly comparison run vs yrs/automerge/loro/diamond-types (§1), appended to RESULTS.md

---

## 7. Suggested sequencing

| Phase | Weeks | Items | Exit criteria |
|---|---|---|---|
| P1 Measure | 1–2 | §1 Weft benches, §3 size gate, §6 iai + dashboard, §4.6 smoke harness, §4.4 heap metric | Baselines recorded, CI gates active |
| P2 Quick wins | 3–5 | §4.1 actors, §4.2 batching, §4.3 shared `Bytes`, §2.6, §3 flat change encoding | 10k sockets / 1k docs passes p99 < 50 ms |
| P3 Load & size | 6–9 | §2.4 snapshot v3, §2.3 content GC, §4.5 cold-load, §5 first paint | Load ≤ 8 ms, snapshot ≤ 250 KB, 1 MB doc paints < 300 ms |
| P4 Scale curve | 10–13 | §2.1 B-tree, §2.5 `text_at`, §2.2 sequential fast path, §1 cross-library suite | Random edits ≥ 2M ops/s flat to 10 MB, `text_at` p99 < 5 ms |
| P5 Research | later | Eg-walker spike (§2.2) | Go/no-go write-up |

## Sources

- Gentle & Kleppmann, *Collaborative Text Editing with Eg-walker: Better, Faster, Smaller* (EuroSys 2025): https://arxiv.org/pdf/2409.14252
- Weidner & Kleppmann, *The Art of the Fugue*: https://arxiv.org/pdf/2305.00583
- Loro native benchmarks: https://loro.dev/docs/performance/native · JS/WASM: https://loro.dev/docs/performance · doc size: https://cn.loro.dev/docs/performance/docsize
- Loro 1.0 (snapshot format, shallow snapshots): https://loro.dev/blog/v1.0
- automerge-perf traces: https://github.com/automerge/automerge-perf
