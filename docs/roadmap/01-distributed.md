# Roadmap 01 · Distributed Systems Track

> Status: proposal. Builds on M1 (`weft-core` FugueMax CRDT), M2 (`weft-sync` sans-IO `ClientSession` / `Room`
> plus the deterministic simulator in `crates/weft-sync/tests/sim.rs`), and the current single-node
> `weft-server` (axum, `AppState { rooms: HashMap<String, Arc<RoomSlot>> }`, `DocStore` / `DocLog`
> append-only log with compaction).

Weft's core property makes all of this tractable. `apply_update` is **idempotent and commutative**,
and a `StateVector` fully identifies a version, deletes included. So every replica, whether a browser,
a server node, an edge isolate or a WebRTC peer, can converge with every other by trading
`(state_vector → encode_diff)` pairs. No consensus protocol is needed for document *content*. Coordination
is needed only for **ownership** (who serves a room right now), **durability** (when an update counts as
safe), and **cost** (avoiding N² fan-out).

Tracks, in recommended order:

| # | Track | Why it matters | Effort |
|---|-------|----------------|--------|
| 1 | Storage evolution (WAL + S3 snapshots) | Prerequisite for stateless nodes and failover | 2–3 wk |
| 2 | Multi-node cluster (sharding + gossip + failover) | Horizontal scale and HA | 4–6 wk |
| 3 | Jepsen-style chaos harness | Proves 1+2 are correct, and is a strong demo | 2–3 wk (runs in parallel with 2) |
| 4 | Presence at scale | Awareness is currently O(N²) per room | 1–2 wk |
| 5 | Edge deployment (Fly.io / Durable Objects) | Latency for global teams | 2–4 wk |
| 6 | P2P WebRTC fallback + mesh | Works when the server is down and saves server bandwidth | 3–4 wk |

---

## 0 · Protocol groundwork (do first, ~3 days)

`Message` is postcard-encoded. Postcard writes the enum discriminant as a varint, so **appending
variants at the end is wire-compatible for old messages**. An *old* peer that receives a *new* variant,
however, fails with `SyncError::Malformed`. So we need:

- [ ] Bump `protocol` in `Hello` to `2` and add a capability bitset. `Room` replies with only
      what the peer understands.
- [ ] Rule: **never reorder or insert variants in the middle**. Append only. Record this in ARCHITECTURE.md's contract change log.
- [ ] Split the "peer protocol" (node↔node, peer↔peer) from the "client protocol" by giving each its own enum, `weft_sync::cluster::PeerMessage`. Browsers then never need to decode cluster traffic, and the client `Message` grows only for client-visible features.

```rust
// weft-sync/src/lib.rs, appended to `Message` (client-visible additions only)
pub enum Message {
    // ... existing: Hello, SyncStep, Update, Awareness, AwarenessRemove, Error
    /// Server → client: "this room moved; reconnect here". Sent on graceful drain/rebalance.
    Redirect { url: String, epoch: u64 },
    /// Server → client: update `seq` is durable (WAL fsync'd / quorum-acked).
    /// Lets `unsynced_op_count` mean "durable", not just "sent".
    Ack { state_vector: Vec<u8> },
    /// Batched presence (see §4). Replaces N individual Awareness frames.
    AwarenessBatch { entries: Vec<(u64, Vec<u8>)>, removed: Vec<u64> },
    /// WebRTC signaling relay (see §6). Opaque SDP/ICE payloads.
    Signal { from: u64, to: u64, payload: Vec<u8> },
}
```

`Ack` matters. Today an edit counts as confirmed once it is "sent on a live connection". With
failover, a node can crash after the TCP send and before the fsync. With `Ack`, the client keeps ops in
its unsynced set until an `Ack` state vector covers them. On reconnect to a *different* node, the
existing handshake (send everything not in the server's SV) re-sends whatever was lost. The current
design already handles this. `Ack` only makes the UI's "saved" indicator honest.

---

## 1 · Storage evolution: WAL → object-storage snapshots

### What and why
Today `DocStore` holds one append-only file per doc on local disk, with `DocLog::compact(full)` rewriting it.
That ties a document to one machine's disk, which blocks failover and stateless nodes. The target:

```
 hot path (ms)                 warm (s)                       cold (min)
 ┌──────────┐ append+fsync ┌──────────────┐  every N ops / T s ┌───────────────────┐
 │  Room    │─────────────►│ WAL segment  │───────────────────►│ S3: snapshot.vN   │
 │ (memory) │              │ (local NVMe  │  upload segment    │      + segments/  │
 └──────────┘              │  or Redis /  │───────────────────►│  wal-<sv-hash>    │
                           │  NATS JS)    │                    └───────────────────┘
                           └──────────────┘
 load = latest snapshot + all segments newer than it (apply is idempotent → overlap is harmless)
```

Idempotent apply makes this unusually simple. Loading a snapshot plus **overlapping** WAL segments is
fine, so we never need exactly-once log truncation.

### Design
- **WAL**: per-node, multi-doc, segment files (`wal-000042.log`) with records
  `[len u32][crc32 u32][doc_id_len u8][doc_id][update bytes]`. One fsync covers many docs (group commit
  every 2–5 ms), which beats one fsync per doc file.
- **Snapshot**: `doc.encode_full()` → `s3://weft/docs/{doc_id}/snap-{epoch}-{sv_hash}.bin`, plus a
  manifest `docs/{doc_id}/MANIFEST` (JSON: latest snapshot key, state vector, list of segment keys). Write the
  manifest last using S3 conditional writes (`If-Match` ETag) to get compare-and-swap. That gives fencing for free (see §2).
- **Retention / time travel**: keep old snapshots under lifecycle rules. `version_at` / `text_at` already
  exist, so "restore to yesterday" means loading an old snapshot.

### Rust sketch (new crate `weft-storage`, the server depends on it)

```rust
#[async_trait::async_trait]
pub trait DocBackend: Send + Sync + 'static {
    async fn load(&self, doc_id: &str) -> io::Result<LoadedDoc>;          // snapshot + tail
    async fn append(&self, doc_id: &str, u: &Update) -> io::Result<Lsn>;  // durable on return
    async fn snapshot(&self, doc_id: &str, full: &Update, sv: &StateVector,
                      expect: Option<ETag>) -> Result<ETag, CasError>;
}
pub struct LoadedDoc { pub updates: Vec<Update>, pub manifest_etag: Option<ETag> }

pub struct LocalFs { /* today's DocStore, adapted */ }
pub struct S3Tiered {
    wal: Wal,                               // local segments, group commit
    s3: aws_sdk_s3::Client,                 // or `object_store` crate (S3/GCS/Azure/R2/local)
    bucket: String,
    uploader: tokio::task::JoinHandle<()>,  // ships sealed segments, writes snapshots
}

pub struct Wal { tx: mpsc::Sender<WalReq> }            // single writer task
struct WalReq { doc: Arc<str>, bytes: Bytes, done: oneshot::Sender<Lsn> }
// writer loop: drain channel up to 5ms / 1MB → write_all → fdatasync → complete all oneshots
```

Prefer the `object_store` crate over `aws-sdk-s3`. It covers S3, R2, GCS and the local FS behind one API,
and its `PutMode::Update` gives conditional puts, so the tests run against `LocalFileSystem` with no MinIO.

### Phases
- [ ] P1 (3d): extract the `DocBackend` trait; `LocalFs` wraps the current `DocStore`; server uses `Arc<dyn DocBackend>`.
- [ ] P2 (4d): `Wal` with group commit and CRC; recovery skips the torn tail (same as `parse_records` today).
- [ ] P3 (4d): `S3Tiered` snapshot uploader with manifest CAS; load = snapshot + segments.
- [ ] P4 (2d): emit `Message::Ack` after `append` resolves; the client's unsynced counter waits for it.
- [ ] P5 (2d): metrics such as `wal_fsync_ms` p50/p99, `snapshot_bytes`, `load_ms`; `/api/stats` exposes them.

**Risks**: S3 latency (50–200 ms) must never be on the edit path, only the WAL is. Tombstones grow without bound,
and snapshot size is the long-term limit (the trace's full state is already 434 KB), so later work needs a GC/"squash history" story.
**Demo**: kill `-9` the server while two tabs type, delete the local data dir, start a fresh node pointing at the
same bucket, and both tabs reconnect with zero loss.

---

## 2 · Multi-node cluster

### Option A: Doc sharding with consistent hashing (recommended default)
Each doc has exactly one **owner** node at a time, and all of its clients connect there. This is the Figma model
(one process per doc, clients connected over WebSockets).

```
            ┌─────────────── load balancer / any node ───────────────┐
 client ──► │ GET /ws/:doc  → ring.owner(doc) == me ? serve : 307 /   │
            │                 or Message::Redirect{url}               │
            └──────┬──────────────────┬──────────────────┬───────────┘
                ┌──▼──┐            ┌──▼──┐            ┌──▼──┐
                │ n1  │◄──gossip──►│ n2  │◄──gossip──►│ n3  │   membership: chitchat/foca (SWIM)
                └──┬──┘            └──┬──┘            └──┬──┘
                   └──────── WAL → S3 (shared) ──────────┘
 ring: rendezvous (HRW) hash(doc_id, node_id) → highest weight wins; 2nd-highest = hot standby
```

- **Ring**: rendezvous hashing (HRW) is simpler than a virtual-node ring and moves only `1/N` of the docs when membership changes.
  Use `hash = xxh3(doc_id || node_id)`.
- **Membership**: the `chitchat` crate (Scuttlebutt anti-entropy gossip, from Quickwit) or `foca` (SWIM).
  Each node advertises `{node_id, addr, region, load, draining}`.
- **Fencing**: ownership has an **epoch**. Before serving writes, a new owner CASes the doc's S3 manifest
  `owner_epoch` (or takes a lease in etcd/Redis). A stale owner's snapshot CAS fails and it steps down. Because the
  CRDT merges anything, a brief split-brain cannot corrupt content. Two owners just *diverge for a moment*, and
  anti-entropy reconciles them. Fencing exists only to stop double fan-out and wasted work.

### Option B: Full replication (every node holds every hot doc)
Every node can serve every doc, and updates are broadcast between nodes. This is the y-redis/y-hub model: stateless servers
stream updates through Redis, and separate workers persist to S3/Postgres.

| | Sharding (A) | Full replication (B) |
|---|---|---|
| Memory | 1× per doc | N× per hot doc |
| Client routing | needs redirect / sticky | any node, plain round-robin LB |
| Fan-out | local | cross-node bus (Redis/NATS) per update |
| Failover | reload from WAL/S3 (~100 ms–1 s) | instant (others already have it) |
| Fit for Weft | ✓ default | for "hot" docs with 500+ viewers |

**Hybrid**: shard by default, and replicate a doc to its top-k HRW nodes when `connection_count > threshold`.

### Inter-node gossip with anti-entropy (state-vector exchange)
Two mechanisms, as in Dynamo/Cassandra:
1. **Push (eager)**: the owner forwards each `Update` to its standby or replicas as soon as it is integrated.
2. **Pull (anti-entropy)**: every `T` = 1–5 s, or on reconnect, each pair of replicas exchanges a
   **digest**. If digests differ, they exchange state vectors, then `encode_diff(sv)`. This repairs any dropped push.

```
 n1                                   n2
  │ Digest{doc, sv_hash, op_count} ──► │   cheap: 16 bytes per doc
  │ ◄── SvRequest{doc, sv(n2)} ─────── │   only if hash differs
  │ ──► Diff{doc, encode_diff(sv(n2))} │
  │ ◄── Diff{doc, encode_diff(sv(n1))} │   symmetric
```

For many docs per node pair, batch the digests: one `DigestBatch` covers all shared docs, and a Merkle tree over
`(doc_id, sv_hash)` buckets keeps it O(changed) at large scale.

```rust
// weft-sync/src/cluster.rs — sans-IO, same style as Room, so it runs in the simulator
#[derive(Serialize, Deserialize)]
pub enum PeerMessage {
    Join   { node: NodeId, epoch: u64, addr: String, region: String },
    Push   { doc: String, update: Vec<u8> },
    DigestBatch { entries: Vec<(String, u64 /*sv_hash*/, u64 /*op_count*/)> },
    SvRequest { doc: String, state_vector: Vec<u8> },
    Diff   { doc: String, update: Vec<u8>, state_vector: Vec<u8> },
    Handoff { doc: String, to: NodeId, epoch: u64 },        // graceful rebalance
    Presence { doc: String, batch: Vec<(u64, Vec<u8>)> },   // see §4
}

pub struct Replicator {
    me: NodeId,
    peers: BTreeMap<NodeId, PeerState>,
    docs: HashMap<String, DocReplica>,   // doc → (sv_hash cache, interested peers)
}
pub struct ReplicatorOutput { pub send: Vec<(NodeId, PeerMessage)>, pub apply: Vec<(String, Update)> }

impl Replicator {
    pub fn on_local_update(&mut self, doc: &str, u: &Update) -> ReplicatorOutput;  // → Push
    pub fn on_tick(&mut self, now: Instant, docs: &dyn DocView) -> ReplicatorOutput; // → DigestBatch
    pub fn on_message(&mut self, from: NodeId, m: PeerMessage, docs: &dyn DocView)
        -> Result<ReplicatorOutput, SyncError>;
}
/// StateVector needs a stable hash: add `StateVector::digest() -> u64` to weft-core (additive, not frozen).
```

The transport is a separate async layer in `weft-server`: one persistent WebSocket or QUIC (`quinn`) connection per node pair, length-prefixed `PeerMessage`s, and mTLS.

### Failover with client reconnect
```
 t0  n2 owns doc; clients C1,C2 connected; n3 = HRW #2 (warm standby via Push)
 t1  n2 dies.  C1,C2 see WS close → exponential backoff + jitter (already in DocSession)
 t2  SWIM marks n2 suspect → dead (~1–3 s); ring recomputed; n3 is owner
 t3  n3 CASes manifest owner_epoch = e+1; loads S3 snapshot + WAL tail (or already warm)
 t4  C1 reconnects to LB → any node → Redirect → n3; Hello{sv} → SyncStep → resend unsynced ops
```
Clients lose nothing. Their unsynced ops, i.e. anything not covered by an `Ack`, get re-sent, and the server's copy fills in through `SyncStep`.
Ops that n2 fsync'd locally but never shipped to S3 are recovered when n2 restarts, or are lost if its disk is gone. That is exactly why
the client keeps ops until it sees `Ack`, and why the WAL should ideally be replicated (NATS JetStream R=3, or n2 → n3 Push before ack).

**Durability modes** (config): `ack=local` (fsync on owner), `ack=standby` (owner + Push acked by #2),
`ack=s3` (slow; for tests).

### Phases
- [ ] P1 (1w): `Replicator` sans-IO with Push + digest anti-entropy; simulator tests with 3 nodes and N clients.
- [ ] P2 (1w): membership (`chitchat`) + HRW ring + `/ws/:doc` redirect; `Message::Redirect`.
- [ ] P3 (1w): epochs + manifest CAS fencing; warm standby on HRW #2.
- [ ] P4 (4d): graceful drain (`SIGTERM` → `Handoff` → `Redirect` all clients → exit) for zero-downtime deploys.
- [ ] P5 (1w): hot-doc replication mode over a NATS or Redis Streams bus (behind a feature flag).
- [ ] P6 (3d): `docker-compose.cluster.yml` with 3 nodes, MinIO, and Caddy as LB.

**Risks / tradeoffs**: redirect loops during membership flaps (mitigate: put the epoch in `Redirect`, and have clients
ignore redirects to a lower epoch). Thundering herd on failover (jitter, plus a per-node admission limit). The per-doc
`Mutex<RoomInner>` is fine, but cross-node Push must happen *outside* the lock. HRW is not load-aware, so add
weights from advertised load later (bounded-load consistent hashing).
**Demo**: a 3-node compose cluster, a `weft-load` bot driving 200 docs, and a Grafana panel of per-node rooms. `docker kill n2`
mid-typing shows the tabs' status pill go "reconnecting → live" in under 3 s, and the text matches across all tabs.

---

## 3 · Jepsen-style chaos harness

### What and why
`tests/sim.rs` already runs a seeded deterministic network (drop/dup/reorder/delay/partition, server crash +
restart from the log). Extend it from "one server, N clients" to "**N nodes, M clients, shared storage, faulty
clocks and disks**", and add a **checker** that verifies properties over a recorded history, as Jepsen does.

### Design
```
 ┌──────────── Simulation (single thread, seeded ChaCha RNG, virtual clock) ────────────┐
 │  clients[ClientSession] ──SimNet── nodes[Room + Replicator + SimBackend] ── SimS3     │
 │        ▲                    ▲  faults: drop, dup, reorder, delay, partition(A|B),    │
 │        │                    │          bridge, node crash, disk torn-write, fsync-lie,│
 │  Nemesis schedule ──────────┘          clock skew, slow node, S3 CAS race             │
 │  History log: (t, actor, op, result) ─────────────► Checker                           │
 └───────────────────────────────────────────────────────────────────────────────────────┘
```

**Properties checked:**
1. **Strong eventual consistency**: after heal plus quiescence, every live replica has an identical `text()` and `StateVector`.
2. **No lost acked writes**: every op covered by a client-received `Ack` is in the final state.
3. **Intention preservation (Fugue)**: no interleaving of concurrent runs typed at the same position.
4. **Monotonic reads per client**: a client's SV never goes backwards across reconnects or failovers.
5. **Liveness**: once the network heals, convergence within `K` ticks.
6. **No double owner beyond lease** (fencing works): at most one node holds a valid epoch at any time.

```rust
// crates/weft-chaos (dev-only crate) — reuses weft-sync sans-IO state machines verbatim
pub enum Fault {
    Partition(Vec<Vec<Actor>>), Heal, Crash(NodeId), Restart(NodeId),
    TornWrite { node: NodeId, bytes: usize }, FsyncLies(NodeId), Skew(NodeId, i64),
    S3Delay(Duration), DropRate(f64), DupRate(f64),
}
pub struct Nemesis { rng: ChaCha8Rng, schedule: Vec<(Tick, Fault)> }
pub struct Sim { net: SimNet, nodes: Vec<SimNode>, clients: Vec<SimClient>, s3: SimS3,
                 history: Vec<Event>, now: Tick }
impl Sim {
    pub fn run(seed: u64, cfg: &ChaosCfg) -> Result<Report, Violation>;
}
// proptest / cargo-fuzz drives `seed`; on failure print `WEFT_SEED=0x... cargo test -p weft-chaos`
// and auto-shrink the fault schedule (delta debugging) to a minimal repro.
```

Because `Room`, `ClientSession` and `Replicator` are sans-IO, the cluster logic is tested *deterministically*, which is
FoundationDB/TigerBeetle-style simulation rather than Jepsen's real-VM approach. Add a thin **real-mode** runner later
(3 `weft-server` processes, `toxiproxy` for faults, and a Rust driver over real WebSockets) to catch
bugs in tokio/IO glue the simulator can't see.

### Phases
- [ ] P1 (4d): refactor `sim.rs` into `weft-chaos` with `Actor`, `SimNet`, `History`; port existing tests.
- [ ] P2 (4d): multi-node + `SimBackend`/`SimS3` (with torn writes, fsync lies, CAS races).
- [ ] P3 (3d): checker for properties 1–6 + seed shrinking.
- [ ] P4 (3d): CI job running 10k seeds nightly, 200 per PR; failing seeds saved to `tests/regressions/`.
- [ ] P5 (1w, optional): real-process mode with toxiproxy; produce an HTML report of the history timeline.

**Risks**: simulator/real-world drift, which the real-mode runner mitigates. Checker cost on long histories (keep runs to ~10k ops).
**Demo**: `cargo run -p weft-chaos -- --seed random --nodes 5 --clients 20 --minutes 1` prints a fault timeline
and "converged ✓ 0 lost acks". Then deliberately break fencing (feature flag), show it finds a violation and
shrinks it to a 6-step repro.

---

## 4 · Presence at scale

### Problem
Every cursor move today is an `Awareness` frame broadcast to every peer, so a room with N users does
O(N) work per move and O(N²) per second. Cursor traffic at 30 Hz dwarfs edit traffic.

### Design
- **Ephemeral, never persisted, last-writer-wins per client** with a per-client `seq`. It should never touch the WAL.
- **Server-side coalescing**: the room buffers the latest awareness per client and flushes one `AwarenessBatch`
  every 50 ms (20 Hz), sending only clients that changed. Bandwidth drops from O(moves × N) to O(N × 20 Hz × changed).
- **Interest management**: beyond ~50 users, send each viewer full cursors only for peers in its viewport
  (client sends `{visible_range}` as anchors) plus a compact "avatar list". Large docs get a "N others viewing" count.
- **Cluster**: presence goes only to nodes that have clients for that doc, via `PeerMessage::Presence`, and is
  batched per tick. Under full replication, use a pub/sub topic per doc with no persistence (NATS core, not JetStream).
- **Liveness**: a TTL of 30 s with heartbeat piggy-backed on batches; `AwarenessRemove` fires on TTL expiry and on
  disconnect. On node failover presence is simply rebuilt, since clients resend on `Hello`.
- **Cursor stability**: payloads carry `Anchor`s (already in core), so cursors survive concurrent edits.

```rust
pub struct PresenceHub {
    latest: HashMap<u64 /*client*/, (u32 /*seq*/, Bytes, Instant)>,
    dirty: HashSet<u64>,
    flush_every: Duration,          // 50ms
    ttl: Duration,                  // 30s
}
impl PresenceHub {
    pub fn on_awareness(&mut self, client: u64, seq: u32, payload: Bytes, now: Instant);
    pub fn on_tick(&mut self, now: Instant) -> Option<Message /*AwarenessBatch*/>;
}
```

### Phases
- [ ] P1 (3d): `PresenceHub` in `Room`; `AwarenessBatch`; client throttles to 20 Hz (rAF-aligned).
- [ ] P2 (2d): TTL expiry + heartbeat; simulator test "200 clients, 30 Hz, bounded bytes/s".
- [ ] P3 (3d): viewport interest filtering; "N viewers" UI for large rooms.
- [ ] P4 (2d): cluster `Presence` forwarding, batched per tick.

**Risks**: added latency (≤50 ms) feels laggy, so interpolate cursors client-side. Privacy (hide cursors in "view only" mode).
**Demo**: a bot swarm of 300 synthetic cursors in one doc, with a stats overlay showing server egress before and after (e.g. 40 MB/s → 1 MB/s).

---

## 5 · Edge deployment

### Option A: Fly.io regions (fits the current architecture)
Run `weft-server` in several regions (`iad`, `fra`, `sin`) and keep the HRW ring **region-aware**: a doc's owner is chosen
in the region of its **first/majority editor**. Fly's `fly-replay` response header lets any edge machine forward the
WebSocket upgrade to the owner machine without a client-visible redirect. Storage: Tigris/S3 for snapshots and a local
volume for the WAL.

```
 user (Singapore) ──► sin edge ──fly-replay: instance=owner──► fra owner (doc's home)
                         └─ optional read replica: sin follows fra via Push (read-mostly viewers)
```

**Home migration**: if more than 70% of the active editors over 10 minutes are in another region, `Handoff` the doc there.
CRDT convergence makes this safe, because the worst case is a short double-serve that anti-entropy fixes.

### Option B: Cloudflare Durable Objects style
One DO per document is the PartyKit / y-partyserver model. A DO is a single-threaded actor with
co-located storage, placed near its first requester, which maps 1:1 onto `Room`. `weft-sync` is sans-IO and
`weft-core` already builds for `wasm32-unknown-unknown`, so a `weft-worker` crate using `workers-rs` can host `Room` directly:

```rust
#[durable_object]
pub struct DocObject { state: State, env: Env, room: Option<weft_sync::Room> }

impl DurableObject for DocObject {
    async fn fetch(&mut self, req: Request) -> Result<Response> {
        let pair = WebSocketPair::new()?;
        self.state.accept_web_socket(&pair.server);          // hibernation API
        Response::from_websocket(pair.client)
    }
    async fn websocket_message(&mut self, ws: WebSocket, msg: WebSocketIncomingMessage) -> Result<()> {
        let room = self.ensure_room().await?;                // rehydrate from DO storage / R2 after hibernation
        let out = room.on_message(conn_id(&ws), Message::decode(bytes(&msg))?)?;
        for u in out.persist { self.state.storage().put(&wal_key(), u.0).await?; }
        deliver(&self.state, out.to);
        Ok(())
    }
}
```

Caveats: hibernation drops in-memory state, so the `Room` must rehydrate quickly. Store an `encode_full()` snapshot in DO
storage plus a small update tail, and compact to R2 periodically (y-cf providers default to about 30 s). Per-message
request billing means the client should batch keystrokes, which the 20 Hz presence batching also helps with. DO storage values have size limits, so chunk large snapshots.

### Phases
- [ ] P1 (3d): region field in membership + region-aware HRW; `fly.toml` with 3 regions; `fly-replay` routing.
- [ ] P2 (4d): home-migration policy + `Handoff`; latency dashboard by region.
- [ ] P3 (1–2w, spike): `weft-worker` DO prototype that hosts `Room` in wasm and reuses the same web client.
- [ ] P4 (2d): write up the decision (Fly vs DO) with cost per 1k MAU and p50/p99 keystroke→echo latency.

**Risks**: cross-region editors still pay the RTT to the home, which is fine because local echo is instant and only remote visibility is delayed.
Vendor lock-in for DO, offset by keeping `weft-sync` the single source of protocol logic.
**Demo**: two browsers using VPN exits in Frankfurt and Singapore, with an on-screen RTT meter; trigger a home migration and watch the latency badge for the Singapore user drop.

---

## 6 · Peer-to-peer WebRTC fallback + small-room mesh

### What and why
For small rooms (≤6 peers), browsers can sync directly over WebRTC DataChannels. This gives lower latency on a LAN,
keeps working if the server goes down mid-session, and offloads bandwidth. The server stays the **durable peer and
signaling relay**. Every peer is a full CRDT replica, so P2P is "just another transport" for the same messages.

```
        signaling via existing WS (Message::Signal)            ┌── server (durable peer)
   A ◄══════ DataChannel ══════► B                              │   still receives all Updates
   ▲ ╲                         ╱ ▲                              │   from at least one peer
   ║   ╲══════ DataChannel ══╱   ║    full mesh ≤ 6 peers       │
   ▼                             ▼    (15 links); >6 → server   │
   C ◄═══════════════════════► D      star only                 │
```

### Design
- **Signaling**: reuse the room WebSocket. `Message::Signal { from, to, payload }` carries SDP offer/answer and ICE
  candidates, and the `Room` forwards it to `to` without inspecting it. STUN uses public servers; TURN uses `coturn` or
  Cloudflare Calls TURN, and is optional (if TURN fails, fall back to the server star).
- **Peer protocol**: run the same `ClientSession`/`Room` handshake *pairwise*. Each DataChannel gets a tiny
  `PeerLink` state machine: on open, exchange `SyncStep{sv}`, then stream `Update`s. Dedup is free (idempotent apply).
- **Fan-out rule**: a local edit goes to the server **and** every mesh peer. Remote updates received from a peer
  are not re-broadcast in a full mesh, but **are** forwarded to the server if the server link is up and the SV
  shows the server lacks them. That is anti-entropy again, with periodic `sv` exchange on each link.
- **Server-down mode**: the UI shows "Peer-to-peer (not saved to server)". On server reconnect, the normal handshake uploads everything.
- **Security**: DTLS secures the transport, but peers must be authorized. The server signs a short-lived room token, peers
  verify it in the first DataChannel message, and the server can refuse to relay `Signal` for unauthorized users.

```rust
// weft-sync/src/p2p.rs — sans-IO, wasm-friendly; also simulator-testable
pub struct PeerLink { remote: u64, state: LinkState, remote_sv: Option<StateVector> }
impl PeerLink {
    pub fn on_open(&mut self, doc: &Doc) -> Vec<Message>;                       // SyncStep{sv}
    pub fn on_message(&mut self, doc: &mut Doc, m: Message) -> Result<ClientOutput, SyncError>;
    pub fn on_local_update(&mut self, u: &Update) -> Vec<Message>;
}
pub struct Mesh { links: BTreeMap<u64, PeerLink>, max_peers: usize /*6*/ }
```
The browser side (`web/src/sync/p2p.ts`) owns `RTCPeerConnection` and DataChannels (`ordered: true`). It calls into the wasm `Mesh`.
Native peers for tests can use the `webrtc` crate (webrtc-rs) or `str0m`.

### Phases
- [ ] P1 (3d): `Message::Signal` relay in `Room`; capability-gated.
- [ ] P2 (1w): `PeerLink` + `Mesh` sans-IO; simulator tests mixing server and mesh links, with server outage.
- [ ] P3 (1w): browser WebRTC transport, ICE/STUN, mesh-size cap, fallback to star.
- [ ] P4 (3d): auth tokens on DataChannel; "P2P / server" indicator in the status pill.
- [ ] P5 (optional): serverless rooms (signaling over a QR code or a share link with manual SDP) for fully offline LAN parties.

**Risks**: NAT traversal failures (~10–20% without TURN). Mesh scales O(N²), so cap it. Browser tab throttling
stalls DataChannels. Debuggability, so log link state to the existing toasts and history UI.
**Demo**: 3 laptops on the same Wi-Fi editing, then stop the server process. Edits still flow (pill shows "P2P").
Restart the server and the pill returns to "saved", and `/api/export` matches all the tabs.

---

## Cross-cutting

- **Observability**: `tracing` spans per room/node, Prometheus exporter (`metrics` + `metrics-exporter-prometheus`):
  `rooms_active`, `ws_conns`, `update_bytes_in/out`, `antientropy_repairs_total`, `failover_seconds`,
  `ack_latency_ms`. Repair counts are the canary metric. If they are nonzero in steady state, Push is lossy.
- **Auth** moves to signed doc tokens (JWT/PASETO) checked at any node, which is required before multi-tenant edge deploys.
- **Backpressure**: per-connection bounded `mpsc` already exists. Add a per-node admission limit and a shed policy (close slow
  consumers with `Error{code}`; they recover via handshake).
- **GC / tombstone compaction** is the long-term scaling limit for every track above. Snapshot size drives load
  time, failover time, and DO rehydrate time. Coordinate with the core-CRDT roadmap.

## Suggested milestone order (≈ 14–18 weeks, 1–2 engineers)
- [ ] D0 Protocol groundwork (capabilities, `Ack`, `Redirect`)
- [ ] D1 Storage: `DocBackend`, WAL, S3 snapshots
- [ ] D2 Chaos harness P1–P3 (in parallel with D3; every D3 PR adds a chaos scenario)
- [ ] D3 Cluster: Replicator, ring, fencing, failover, drain
- [ ] D4 Presence batching + interest management
- [ ] D5 Edge: Fly multi-region, DO spike
- [ ] D6 WebRTC mesh

## References
- Figma multiplayer (process per doc, WebSockets): https://www.figma.com/blog/multiplayer-editing-in-figma/ ; https://www.figma.com/blog/under-the-hood-of-figmas-infrastructure/
- y-redis / y-hub (stateless servers, Redis streams, S3/Postgres workers): https://github.com/yjs/yhub ; https://discuss.yjs.dev/t/y-redis-an-alternative-backend-to-y-websocket/2509
- PartyServer / Durable Objects + Yjs + hibernation: https://github.com/cloudflare/partykit ; https://github.com/TimoWilhelm/yjs-cf-ws-provider ; https://github.com/napolab/y-durableobjects
- Gossip/membership crates: `chitchat` (Scuttlebutt), `foca` (SWIM); storage: `object_store`; QUIC: `quinn`; WebRTC: `str0m`, `webrtc`.
