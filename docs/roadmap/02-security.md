# Roadmap 02 — Security & Privacy Track

> Status: proposal · Owner: TBD · Last updated: 2026-10-25
> Scope: end-to-end encryption (E2EE), capability links (read/edit/owner), signed ops, optional
> passkey accounts, revocation, abuse/DoS protection, input validation, threat model, review checklist.

## 0. Where we are today

Weft works, but its security model is "whoever knows the URL can do anything, and the server can
read everything":

| Area | Today |
|---|---|
| Access control | None. `/d/<doc_id>` gives full edit rights. `doc_id` is `^[A-Za-z0-9_-]{1,64}$`, and the user can choose it, so it may be guessable. |
| Confidentiality at rest | `data/docs/<doc_id>.log` stores **plaintext** `weft_core::Update` records. |
| Confidentiality in transit | Plain HTTP/WS on `0.0.0.0:7878`. TLS is assumed to come from a proxy, but nothing enforces it. |
| Server role | A full CRDT replica (`Room` owns a `weft_core::Doc`). It merges, compacts (`encode_full`) and renders `export.md`. |
| Integrity | None. Any connection can send any op, including ops with another replica's `ClientId`. |
| Abuse limits | `MAX_FRAME = 16 MiB`, `OUTBOUND_QUEUE = 1024`, `PEER_TIMEOUT = 60 s`, ping every 20 s, `MAX_RECORD = 256 MiB` on log read. No rate limits, no size quotas, no Origin check. |

This track has three goals, in priority order:

1. **The server never sees document content or presence.** It stores and relays ciphertext only.
2. **Links are capabilities.** A read link cannot be turned into an edit link, and both peers and the
   server can check edit rights without trusting each other.
3. **A public instance can't easily be knocked over or filled up**, even by unauthenticated users.

None of this may break the product principles in [VISION.md](../VISION.md): no sign-up is required,
opening a link is instant, offline-first keeps working, and the time-travel scrubber keeps working.
(Time travel runs client-side, so it is unaffected.)

**Architectural consequence (read this first).** VISION says the server is "just another replica".
With E2EE, **the server stops being a CRDT replica** and becomes a *blind, ordered relay with a
ciphertext log*. Server-side merge, compaction, export rendering, and any future server-side
features (search, previews, webhooks, AI) need plaintext, so they move to clients or go away.
This is the biggest product decision in this track and needs sign-off before Phase 1 starts.

---

## 1. End-to-end encryption, with the key in the URL fragment

### 1.1 Design

This is the same basic idea as Excalidraw's shareable links and rooms: the key is generated in the
browser and kept after `#`, which browsers never send to the server. The design borrows
Secsync's structure (documents, **snapshots**, **updates**, **ephemeral messages**, all encrypted
client-side).

**Link formats** (base64url, no padding):

```
Edit link   https://weft.example/d/<doc_id>#e=<root_secret:32B>
Read link   https://weft.example/d/<doc_id>#r=<enc_key:32B><edit_pk:32B>
Owner key   never in a link; stored in the creator's IndexedDB (and in their account keychain, §3)
```

**Key derivation** (HKDF-SHA256, `salt = "weft/v2"`, a distinct `info` for each output):

| Output | `info` | Used for |
|---|---|---|
| `doc_id` (16 B → 22 chars) | `doc-id` | Room name. It is derived from the secret, so it can't be guessed and doesn't link to the content. |
| `enc_key` (32 B, AES-256-GCM) | `enc/epoch/<n>` | Updates and snapshots |
| `aw_key` (32 B, AES-256-GCM) | `awareness/epoch/<n>` | Presence. A separate key means the awareness and update nonce spaces never collide. |
| `edit_seed` (32 B → ed25519) | `sign/epoch/<n>` | Signing updates and snapshots (§2) |
| `read_proof` (32 B) | `read-proof/epoch/<n>`, derived from `enc_key` | Proves to the server that the caller can read, so it can't be served ciphertext otherwise |

Holders of a read link get `enc_key` (and so `aw_key` and `read_proof`, which derive from it) plus
`edit_pk`, but **not** `edit_seed`. To make that possible, `aw_key` and `read_proof` derive from
`enc_key` and not from the root, and read links carry them indirectly. Exact chain:
`root → (doc_id, enc_key, edit_seed)` and `enc_key → (aw_key, read_proof)`.
`doc_id` comes from the **epoch-0** root only and never changes. After a rotation (§3.3), the new
links keep the same `/d/<doc_id>` path and carry the new secret in the fragment.

**What the server stores for each doc** (new on-disk format `data/docs/<doc_id>/`):

```
meta.json        { v:2, created, epoch, edit_pks:{epoch→pk}, owner_pk, read_proof_hash:{epoch→sha256}, limits }
snapshot.bin     the latest Envelope(kind=Snapshot), plus covers_seq
log.bin          [len u32][crc32 u32][seq u64][Envelope] records with seq > covers_seq
snapshot.prev    the previous snapshot, kept 7 days for rollback (see the risks in §1.4)
```

**Envelope** (postcard; replaces raw `Update` bytes on the wire and on disk):

```rust
pub struct Envelope {
    pub v: u8,             // 2
    pub kind: Kind,        // Update | Snapshot | Awareness
    pub epoch: u32,        // key epoch (rotation, §3.3)
    pub nonce: [u8; 12],   // random per message
    pub ct: Vec<u8>,       // AES-256-GCM(padded plaintext), includes the 16 B tag
    pub sig: Option<[u8; 64]>, // ed25519 over sig_input(); required for Update/Snapshot
}
// AAD = "weft/v2" || doc_id || kind || epoch  (stops cross-doc / cross-kind replay)
// sig_input = "weft/v2/sig" || doc_id || kind || epoch || nonce || ct
```

Plaintext is **padded** before encryption (to 64 B buckets up to 1 KiB, then powers of two) so that
ciphertext length doesn't reveal the exact size of each keystroke batch. Typing *timing* still leaks
(see the threat model).

### 1.2 Implications for sync, merge, and compaction

The server can't compute state vectors from ciphertext, so delta sync moves from **state vectors
to server sequence numbers**:

- The server gives each accepted envelope a monotonic `seq` and appends it to `log.bin`.
- The client remembers `last_seq` per doc in IndexedDB. `Hello` sends `since_seq`.
- The server replies with `SyncStep2 { snapshot?, updates: [(seq, env)], head_seq }`. It includes the
  snapshot only if `since_seq < covers_seq`. Duplicates are harmless because
  `apply_update` is idempotent and commutative, which is the property that makes a blind relay work.
- The client decrypts, verifies, applies, and tracks `head_sv`: the state vector of everything it
  has seen *from the server*. Its offline edits are then `doc.encode_diff(head_sv)`, pushed as one
  envelope. This replaces handshake step 3.
- **Unsynced count**: `Push { msg_id }` gets `Ack { msg_id, seq }`. A local op is confirmed when the
  push that carried it is acked. `countNotIn(confirmed_sv)` keeps working; `confirmed_sv` is now
  maintained from acks, not from the server's state vector.

**Server-side merge goes away.** `Room` (a replica) is replaced by `RelayRoom` (sans-IO, still in
`weft-sync`, still covered by the network simulator). It orders, verifies signatures, persists,
and fans out. It never decodes CRDT bytes.

**Compaction is done by clients, with encrypted snapshots:**

1. When the log since the last snapshot is over 500 records or 1 MiB, the server sends
   `CompactHint { head_seq }` to **one** connection that has recently sent a valid signed push
   (only editors can sign snapshots). It picks a different one after a 30 s timeout.
2. That client waits until it has applied everything up to `head_seq`. It builds
   `SnapshotPlain { sv: doc.state_vector(), covers_seq, full: doc.encode_full() }`, then
   pads, encrypts, and signs it, and sends `Snapshot { env, covers_seq }`.
3. The server checks the signature against `edit_pks[epoch]` and checks that `covers_seq <= head_seq`
   and `> current covers_seq`. It then writes `snapshot.bin.tmp`, fsyncs, renames, and truncates log
   records `<= covers_seq` (rewriting the tail to a temp file, then renaming). The previous snapshot
   moves to `snapshot.prev`.
4. **Self-healing against bad snapshots**: every client that receives `SnapshotAvailable { covers_seq }`
   fetches it, decrypts `sv`, and pushes `doc.encode_diff(&snapshot.sv)` if that diff is non-empty.
   An honest client therefore re-injects anything a buggy or malicious snapshot left out.
   (A malicious *editor* can still delete text through normal ops. Snapshots don't add new power.)

`encode_full()` already contains every op, including delete runs with their IDs, so **time travel
survives compaction**.

### 1.3 Awareness encryption

- `Awareness { client_id, payload }`: `payload` becomes an `Envelope(kind=Awareness)` under
  `aw_key`. It is unsigned, because viewers must be able to show presence too, and AES-GCM
  already authenticates it to key holders.
- `client_id` stays in plaintext so the server can route `AwarenessRemove`. It is random per session
  (already true) and carries no identity. The server must **bind** `client_id` to the connection's
  `Hello`, and drop awareness frames that claim another id (a gap today).
- The name, color, and cursor anchors are all inside the ciphertext. Peers validate after decrypting
  (§5, client-side gaps).
- Awareness cap: 2 KiB ciphertext, at most 20 frames/s per connection, last-writer-wins cache per
  `client_id`.

### 1.4 The export endpoint

`GET /api/docs/:id/export.md` can't work for E2EE docs. Plan:

| Path | E2EE docs | Legacy (v1, plaintext) docs |
|---|---|---|
| `GET /api/docs/:id/export.md` | `409` with JSON `{ "error": "encrypted", "hint": "use weft-cli or the in-app export" }` | unchanged until sunset |
| `GET /api/docs/:id/bundle` (new) | snapshot + tail as ciphertext. Requires the `Weft-Read-Proof: <base64url>` header. | n/a |
| In-app `⌘K → Export .md` | already client-side, unchanged | unchanged |
| `weft-cli export '<link>' > doc.md` (new bin crate) | parses the fragment, fetches the bundle, decrypts and merges with `weft-core` locally | calls the old endpoint |

This keeps the "curl-able export" promise from VISION in spirit: `weft export 'https://…#r=…'`.

### 1.5 Implementation sketch

**New crate `crates/weft-crypto`** (no IO; compiles to wasm32 and native; shared by the CLI, the
server's signature checks, and the simulator tests):

```toml
[dependencies]
aes-gcm = "0.10"          # AES-256-GCM (native + wasm, constant-time software fallback)
ed25519-dalek = { version = "2", default-features = false, features = ["rand_core", "zeroize"] }
hkdf = "0.12"
sha2 = "0.10"
zeroize = { version = "1", features = ["derive"] }
getrandom = { version = "0.2", features = ["js"] }  # wasm entropy via crypto.getRandomValues
subtle = "2"              # constant-time compare for read_proof
```

```rust
pub struct DocKeys { pub doc_id: [u8;16], enc: Key<Aes256Gcm>, aw: Key<Aes256Gcm>,
                     pub read_proof: [u8;32], signer: Option<SigningKey>, pub edit_pk: VerifyingKey }
impl DocKeys {
    pub fn from_edit_secret(root: &[u8;32], epoch: u32) -> Self;
    pub fn from_read_cap(enc_key: &[u8;32], edit_pk: &[u8;32], epoch: u32) -> Self;
    pub fn seal(&self, kind: Kind, plain: &[u8]) -> Result<Envelope, CryptoError>; // pad+encrypt+sign
    pub fn open(&self, doc_id: &str, env: &Envelope) -> Result<Vec<u8>, CryptoError>; // verify+decrypt+unpad
}
pub fn verify_envelope(doc_id: &str, env: &Envelope, pk: &VerifyingKey) -> bool; // server side, no keys
```

**Browser**: there are two reasonable options. Pick one in the Phase 1 spike.

- *(A, recommended)* Keep crypto **in Rust/WASM** (`weft-crypto`, exposed through `weft-wasm`). There is one
  implementation, it's tested in the simulator, and the server verifies with byte-for-byte the same code.
  The cost is roughly 60–90 KB more WASM, and software AES (still constant-time).
- *(B)* `crypto.subtle` AES-GCM (hardware AES, non-extractable `CryptoKey`) plus WebCrypto Ed25519
  where the browser supports it, with dalek as the fallback. It's faster and smaller, but the code is
  duplicated in TS and Rust and needs cross-implementation test vectors.

```ts
// web/src/sync/keys.ts  (option A shown; the UI still only imports from src/sync/index.ts)
export function parseCapability(hash: string): Capability | null;   // "#e=…" | "#r=…"
export function makeLinks(cap: Capability): { edit?: string; read: string };
// WeftClient gains: static withKeys(docId, clientId, cap: Uint8Array, kind: "edit"|"read")
//   onMessage/insert/delete/setAwareness keep the same signatures; frames are envelopes inside.
```

**Wire protocol v2** (`PROTOCOL_VERSION = 2`; v1 stays behind `/ws/` for legacy docs until sunset):

```rust
pub enum Message {
    Hello { protocol: u16, doc_id: String, client_id: u64, since_seq: u64, read_proof: [u8; 32] },
    Create { edit_pk: [u8;32], owner_pk: [u8;32], read_proof_hash: [u8;32], owner_sig: [u8;64] }, // first contact
    SyncStep2 { snapshot: Option<(u64 /*covers_seq*/, Envelope)>, updates: Vec<(u64, Envelope)>, head_seq: u64 },
    Push { msg_id: u32, env: Envelope },               // C→S, kind=Update
    Relay { seq: u64, env: Envelope },                 // S→C
    Ack { msg_id: u32, seq: u64 },                     // S→C
    CompactHint { head_seq: u64 },                     // S→C
    Snapshot { covers_seq: u64, env: Envelope },       // C→S
    SnapshotAvailable { covers_seq: u64 },             // S→C
    Awareness { client_id: u64, env: Envelope },       // kind=Awareness, unsigned
    AwarenessRemove { client_id: u64 },
    Rotate { new_epoch: u32, edit_pk: [u8;32], read_proof_hash: [u8;32], owner_sig: [u8;64] }, // §3.3
    Error { code: u16, message: String },              // new codes: FORBIDDEN, BAD_SIG, TOO_LARGE, RATE_LIMITED, ENCRYPTED
}
```

The ARCHITECTURE.md 🔒 contract changes in `weft-sync`, `weft-wasm`, and `weft-server` must be logged
in the contract change log when Phase 1 lands.

### 1.6 Plan — E2EE

**Phase 1a — crypto and protocol (≈ 6–8 days)**
- [ ] Spike: WASM size and throughput for `aes-gcm` + `ed25519-dalek` vs WebCrypto. Pick option A or B and record it (0.5 d)
- [ ] `weft-crypto` crate: HKDF tree, `seal`/`open`, padding, `verify_envelope`, zeroize, test vectors (2 d)
- [ ] `weft-sync`: `Message` v2, `RelayRoom` sans-IO, client session on seq/acks/`head_sv` (2–3 d)
- [ ] Simulator: v2 clients + relay with drop/dup/reorder; property "all replicas converge, and the server never calls weft-core decode" (1 d)
- [ ] Fuzz targets: `Envelope` decode, `Message` v2 decode (0.5 d)

**Phase 1b — server and storage (≈ 4–5 days)**
- [ ] `DocStore` v2: dir per doc, `meta.json`, seq log, atomic snapshot swap, `snapshot.prev` retention (2 d)
- [ ] `/ws/:doc_id` dispatches on `Hello.protocol` (v1 → `Room`, v2 → `RelayRoom`) (0.5 d)
- [ ] `read_proof` check (constant-time, against `sha256` in meta) for WS and `/bundle` (0.5 d)
- [ ] `CompactHint` election, timeout and re-election, snapshot acceptance rules (1–1.5 d)
- [ ] `/api/docs/:id/bundle`, and `export.md` → 409 for v2 docs (0.5 d)

**Phase 1c — client and UX (≈ 4–5 days)**
- [ ] `src/sync`: parse the fragment, store the capability in IndexedDB under the doc id, build links (1 d)
- [ ] Share dialog: "Copy edit link" / "Copy read-only link", QR for either; a warning that the link *is* the key (1 d)
- [ ] Encrypted awareness; client validation of decrypted presence (0.5 d)
- [ ] Missing or wrong key → a calm "This link is missing its key" screen, never a blank doc (0.5 d)
- [ ] Migration: `⌘K → Encrypt this doc` creates a v2 doc from the v1 text and history, then deletes the v1 log with an owner-confirmed request (1 d)
- [ ] `weft-cli export <link>` (0.5–1 d)

**Phase 1d — defaults and sunset (≈ 1 day + calendar time)**
- [ ] New docs are E2EE by default. The plaintext v1 mode is behind `WEFT_ALLOW_PLAINTEXT=1`
- [ ] Sunset plan: after 90 days, v1 docs become read-only, then get exported or migrated

**Risks**
- **Lost key = lost doc.** There is no server-side recovery by design. Mitigations: keep the capability in IndexedDB; offer an optional account keychain (§3); show a "save your link" nudge for docs with real content.
- **The web E2EE paradox.** The server that stores ciphertext also serves the JS that holds the key, so a malicious or compromised server can ship key-stealing JS. Mitigations: strict CSP; a service worker that pins the app bundle and warns when it changes unexpectedly; reproducible builds with published hashes; later, a desktop or extension build. Document this honestly.
- **Fragment leakage**: browser history and synced history, screenshots, chat-app clients that see the full link, extensions. Optionally strip the fragment with `history.replaceState` after saving it to IndexedDB (Share rebuilds the link). The default is to keep it, for zero-setup copying from the URL bar.
- **AES-GCM nonce misuse.** Random 96-bit nonces are safe up to about 2³² messages per key. Count messages per epoch, and auto-rotate (§3.3) well before that. XChaCha20-Poly1305 (`chacha20poly1305` crate) is the fallback if option A is chosen.
- **We lose server features**: server-side search, previews, webhooks and AI would all need plaintext. If one is ever needed, it becomes an explicit per-doc opt-in, never a silent change.
- **Snapshot poisoning or rollback**: covered by signature checks, `snapshot.prev`, and client self-healing (§1.2 step 4). A malicious *server* can still withhold updates (a fork or freshness attack). Detecting that needs hash-chained updates; deferred to Phase 6.

---

## 2. Read-only vs. edit links: capability tokens and signed ops

### 2.1 Design

- **Edit right = holding `edit_seed` for the current epoch.** Every `Update` and `Snapshot` envelope is
  signed with ed25519 (`edit_sk`).
- **The server checks** every `Push` and `Snapshot` against `meta.edit_pks[epoch]` and rejects with
  `Error{BAD_SIG}` (then closes the connection after 3 failures). The server learns nothing about
  content, and it doesn't even need to know which connections are "editors". It only checks signatures.
- **Peers also check**, against the `edit_pk` they derived from (or were given in) their link, so a
  malicious server can't inject ops by registering its own key. The client is the source of truth;
  server verification is a DoS and storage filter.
- **Read-only UX**: if `#r=`, CodeMirror gets `EditorState.readOnly.of(true)`, the pill says
  "View only", and the session never produces `Push`. Viewers still send encrypted awareness, so
  their cursor shows up.
- **The doc_id itself is not enough to fetch ciphertext**: `Hello.read_proof` must hash to the stored value.
  So a `doc_id` leaked through logs or a `Referer` header (fragments aren't sent in `Referer`, but
  paths are; we set `Referrer-Policy: no-referrer`) doesn't expose even ciphertext.
- **Creation (TOFU)**: the first `Hello` for an unknown `doc_id` must be followed by `Create`, signed
  by `owner_sk`. Because `doc_id` comes from a 256-bit secret, nobody can squat a doc before its
  creator does.

**Hardening: per-session author keys (Phase 6).** All editors share one `edit_sk`, so a malicious
editor can forge ops with *another* replica's `(client, clock)` IDs. Two different ops with the same
`Id` cause permanent **divergence**, which is worse than vandalism. Fix: each session generates an
ephemeral ed25519 key, sets `client_id = u64::from_le_bytes(sha256(session_pk)[..8])`, and publishes
a `SessionCert { session_pk, sig_by_edit_sk }`. Peers then reject ops whose `Id.client` doesn't match
the signer's certified session. This needs `weft-core` to expose the client ids contained in an
`Update` (an additive API: `Update::clients() -> impl Iterator<ClientId>`).

### 2.2 Implementation sketch

```rust
// weft-server (RelayRoom::on_push)
let pk = meta.edit_pks.get(&env.epoch).ok_or(Error::forbidden("unknown epoch"))?;
if env.kind != Kind::Update || !weft_crypto::verify_envelope(&doc_id, &env, pk) {
    conn.bad_sigs += 1;
    return Err(Error::bad_sig());
}
// limits (§4) → seq = log.append(&env)? → Ack{msg_id, seq} to sender, Relay{seq, env} to others
```

```ts
// src/sync/session.ts
if (cap.kind === "read") editor.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(true)) });
```

Cost: signing about 20–50 µs per op batch in WASM; updates are already debounced and batched, so
this is negligible. Overhead is 64 B signature + 12 B nonce + 16 B tag + about 8 B framing per envelope.

### 2.3 Plan — capabilities

- [ ] HKDF tree emits `edit_seed`; `DocKeys::from_read_cap` has no signer (part of 1a)
- [ ] Server signature verification on `Push` and `Snapshot`; `BAD_SIG` error code and close after 3 failures (1 d)
- [ ] Peer-side verification in `ClientSession`: drop unsigned or badly signed envelopes and count them in diagnostics (0.5 d)
- [ ] Read-only editor mode, "View only" pill, palette commands hidden or disabled (1 d)
- [ ] `read_proof` for WS + `/bundle`; `Referrer-Policy: no-referrer` (0.5 d)
- [ ] `Create` with an owner signature; reject `Push` to an unknown doc (0.5 d)
- [ ] Tests: a read link can't produce an accepted push; a forged pk from the server is rejected by peers; replay into another doc fails because of AAD and signed `doc_id` (1 d)

**Effort**: about 4–5 days on top of Phase 1.
**Risks**: read links can't be "upgraded" without a new link, which is intended and should be
explained in the Share UI. Shared-key editing means editors can't be told apart (fixed by session
certs in Phase 6). Replaying old signed envelopes is accepted but harmless, because the CRDT is idempotent.

---

## 3. Optional accounts (passkeys), doc ownership, revocation

### 3.1 Design principles

- **Accounts are optional and additive.** Opening a link never needs an account. An account adds:
  a synced, *encrypted* keychain of "my docs"; ownership across devices; revocation and rotation
  from any device; and later, per-person sharing.
- **Passkeys only (WebAuthn)**, no passwords. Server: `webauthn-rs`. Client: `navigator.credentials` directly
  (or `@simplewebauthn/browser`).
- **The server never holds plaintext keys.** The keychain is encrypted with a key derived from the
  **WebAuthn PRF extension** where it's supported, with a printable recovery code as fallback (or as
  the only option on authenticators without PRF).

### 3.2 Ownership

- The **owner key** (`owner_sk`, ed25519) is generated at creation, registered as `owner_pk` in `meta.json`,
  and stored in IndexedDB and, if signed in, in the keychain. It is never put in a link.
- Owner-only actions are signed by `owner_sk`: **rotate** (new epoch), **delete** (purge snapshot and log),
  **set expiry/retention**, **claim** (`Claim { doc_id, account_id }`, which links the doc to an account so
  it is listed there and exempt from idle expiry).
- Without an account, ownership = "the browser that created it". The UI says so, and offers
  "Back up owner key" (download a file or copy a recovery string).

### 3.3 Revocation and key rotation

There are two separate levels:

| What leaked | Action | Effect |
|---|---|---|
| Edit link | Owner `Rotate`: new epoch with a new root secret → new `edit_pk`, `enc_key`, `read_proof` | The server rejects pushes signed with the old epoch key. The owner sends new links to the people who should keep access. |
| Read link | The same `Rotate` | New updates use the new key. The next compaction re-snapshots under the new epoch, and the server deletes the older ciphertext and the old `read_proof_hash`, so old links can't even fetch. |

Facts to state plainly in the UI: **revocation only works going forward.** Anyone who has already read
the doc has the content. In link-only mode, the owner has to redistribute the new link out of band.

Rotation steps:
1. The owner client generates root′, derives epoch `n+1` keys, and sends `Rotate { new_epoch, edit_pk′, read_proof_hash′, owner_sig }`.
2. The server checks `owner_sig`, sets `epoch = n+1`, stops accepting `n` pushes, and broadcasts `EpochChanged { epoch }`.
3. Clients holding root′ continue. Clients on the old link see "Access to this doc was changed by its owner".
4. The owner client immediately snapshots under `n+1` (`covers_seq = head`). The server deletes `<= covers_seq` and epoch-`n` metadata after a 7-day grace period, or immediately if "revoke now" is ticked.

Automatic rotation (no new links needed): rotate the **data key** while keeping the capability
(`enc/epoch/n` derived from the same root) when nearing nonce limits. Only owner-initiated rotations change the root.

### 3.4 Per-person sharing (later, Phase 5)

Each account has an X25519 keypair (the private key is wrapped by the PRF key). The doc's epoch secret
is wrapped to each member's public key (a "lockbox", similar to how Serenity Notes and other E2EE
apps share). Revocation = new epoch, re-wrapped to the remaining members, so no link redistribution
is needed. MLS (`openmls`) is the heavyweight alternative; it's not justified for small groups yet.

### 3.5 Implementation sketch

```rust
// weft-server: new module accounts.rs (SQLite via sqlx or rusqlite; WEFT_ACCOUNTS=1 to enable)
// tables: accounts(id, created), credentials(id, account_id, passkey_json), sessions(id_hash, account_id, exp),
//         keychains(account_id, version, blob /*ciphertext*/), claims(doc_id, account_id)
POST /api/auth/register/start|finish   // webauthn-rs Webauthn::start_passkey_registration / finish_…
POST /api/auth/login/start|finish
PUT  /api/keychain   (If-Match: version)  // opaque ciphertext blob, ≤ 256 KiB
POST /api/docs/:id/claim   { owner_sig }
POST /api/docs/:id/delete  { owner_sig, ts }   // ts ±5 min against replay
// session cookie: __Host-weft, HttpOnly, Secure, SameSite=Lax; state-changing routes also check Origin
```

```ts
// PRF-derived keychain key
const cred = await navigator.credentials.get({ publicKey: { ...opts,
  extensions: { prf: { eval: { first: utf8("weft keychain v1") } } } } });
const prf = cred.getClientExtensionResults().prf?.results?.first; // undefined → fall back to recovery code
```

### 3.6 Plan — accounts, ownership, revocation

**Phase 2 — ownership and link-only revocation (≈ 5–7 days)**
- [ ] Owner key generation, IndexedDB storage, "Back up owner key" (1 d)
- [ ] `Rotate`, `EpochChanged`, server epoch enforcement, grace-period purge (2 d)
- [ ] Owner-signed delete and retention; idle-doc expiry for unclaimed docs (default 180 days, configurable) (1 d)
- [ ] UI: "Manage access" panel (rotate edit link, rotate all links, delete doc) (1–2 d)
- [ ] Tests: old edit key is rejected after rotation; old read proof can't fetch after purge (1 d)

**Phase 3 — passkey accounts (≈ 8–12 days)**
- [ ] `webauthn-rs` registration and login, sessions, SQLite schema, migrations (3 d)
- [ ] Encrypted keychain (PRF → HKDF → AES-GCM), recovery-code fallback, conflict-safe `If-Match` (2–3 d)
- [ ] Claim docs; a "My docs" view (list decrypted client-side) (2 d)
- [ ] CSRF: Origin checks, `SameSite`; account deletion = purge keychain and claims (1 d)
- [ ] Security review of the auth flows (1–2 d)

**Phase 5 — per-person sharing (≈ 10–15 days, only if there is demand)**
- [ ] Account X25519 keys, lockboxes, invite flow, member list, re-wrap on revoke

**Risks**: PRF support varies between authenticators and platforms, so the recovery-code path must be
first-class. Account recovery is impossible by design without the recovery code. Accounts add PII
(credential IDs, timestamps), which needs a privacy notice. "Optional" must stay optional, so no
feature should silently require sign-in.

---

## 4. Abuse and DoS protection

Anyone can create docs and connect without auth, so limits are the only defense. Every limit below
goes in `Config` (env `WEFT_LIMIT_*`) with a sensible default.

| Vector | Limit / mechanism | Default | Where |
|---|---|---|---|
| WS frame size | `WebSocketUpgrade::max_message_size` / `max_frame_size` | **1 MiB** (today 16 MiB); snapshots up to 16 MiB only with `Snapshot` (allowed after Hello, only if a hint is pending) | `ws_route` |
| Connections per IP | `DashMap<IpNet, u32>` guard; IPv6 grouped per /64 | 32 | accept path |
| Connections per doc | room peer count | 100 | `join` |
| Global connections | `tokio::sync::Semaphore` permit held for the connection's lifetime | 10 000 | `connection` |
| Messages per connection | `governor` GCRA bucket | 50/s burst 200 (Update), 20/s (Awareness) | `handle_frame` |
| Bytes per doc per minute | per-room bucket | 8 MiB/min | `RelayRoom` |
| New docs per IP | `governor` keyed by IP | 30/hour; optional hashcash PoW (≈2¹⁸) under attack | `Create` |
| Max doc size | log bytes since snapshot + snapshot size | 32 MiB total; over that → `TOO_LARGE` + `CompactHint` | `DocStore` |
| Global disk | refuse `Create` below a free-space floor | 5% / 2 GiB | `DocStore` |
| HTTP API | `tower_governor` per IP on `/api/*` | 10/s | router |
| Handshake (slowloris) | HTTP header read timeout (`hyper-util` builder `header_read_timeout`) or reverse proxy; `Hello` must arrive in 5 s (`tokio::time::timeout`) | 10 s / 5 s | serve / `connection` |
| Idle connection | already `PEER_TIMEOUT = 60 s` and ping every 20 s | keep | — |
| Slow readers | already `OUTBOUND_QUEUE = 1024` frames → drop. Also add a byte budget per connection (8 MiB) | — | sender task |
| Rooms in memory | LRU cap on loaded rooms, plus the existing 60 s idle unload | 2 000 | `rooms` map |
| Cross-site WebSocket hijacking | check `Origin` against `WEFT_ALLOWED_ORIGINS` | same-origin | `ws_route` |
| Client IP behind proxy | trust `X-Forwarded-For` only from `WEFT_TRUSTED_PROXIES` | none | middleware |

**v1 (plaintext) mode only, until sunset:** `weft-core` buffers causally-unready ops in a **pending
queue with no bound**. A client can send ops that depend on IDs that never arrive and grow server
memory forever. Cap it at 10 000 pending runs or 4 MiB per doc, and on overflow drop the connection
that sent them. Also reject ops whose `clock + n` would overflow `u64`.

### Plan — abuse and DoS (Phase 0, ≈ 4–6 days; do this first, it needs no protocol change)
- [ ] Lower `MAX_FRAME` to 1 MiB; add a per-connection byte budget (0.5 d)
- [ ] `governor` rate limits per connection, IP, and doc; `tower_governor` on `/api` (1 d)
- [ ] Connection caps (global semaphore, per IP, per doc); LRU cap on rooms (1 d)
- [ ] Hello timeout; header read timeout (or document "run behind Caddy/nginx" as required) (0.5 d)
- [ ] `Origin` allow-list on `/ws`; trusted-proxy handling for IPs (0.5 d)
- [ ] Doc size cap and disk floor; `TOO_LARGE` error code; client toast (1 d)
- [ ] Pending-queue cap and clock-overflow checks in `weft-core` (0.5–1 d)
- [ ] Load test: 1 000 sockets plus a flood client, checking the server stays responsive (`tokio-tungstenite` harness) (1 d)

**Risks**: per-IP limits hurt NAT'd classrooms (the "students" persona). Keep the defaults generous and
make the per-doc limits the main control. PoW costs battery on phones, so enable it only under attack.

---

## 5. Input validation: in place vs. gaps

| Input | In place today | Gap / action |
|---|---|---|
| `doc_id` path | regex `^[A-Za-z0-9_-]{1,64}$`; 400 on `export.md`; Error frame + close 1008 on WS | v2: exactly 22 chars of base64url. Check that `Hello.doc_id == path doc_id`. |
| WS frame | `max_message_size(16 MiB)`; malformed → close the connection, not the room | lower the size (§4); fuzz `Message::decode` |
| Protocol version | `PROTOCOL_VERSION` error code | v1/v2 dispatch |
| CRDT update bytes | `DecodeError` on malformed input; undecodable log records skipped on load | **fuzz** `Update` decode / `apply_update` / `StateVector::decode` / `Anchor::decode`; refuse `Vec::with_capacity(len)` sized from untrusted varints; pending-queue cap; clock overflow |
| Log file | CRC32 per record; torn tail ignored; `MAX_RECORD = 256 MiB` | lower to the doc cap (32 MiB); v2 format checks seq monotonicity |
| Awareness payload | opaque bytes on the server | bind `client_id` to the connection; size and rate caps. **Client side**: after decode/decrypt, check `name` ≤ 64 chars (rendered with `textContent` only), `color` matches `^#[0-9a-fA-F]{6}$` (it ends up in a style, so this blocks CSS injection), anchors decode errors are ignored. |
| Static files | `web/dist` with SPA fallback | confirm `ServeDir` traversal safety with a test; set `X-Content-Type-Options: nosniff` |
| HTTP responses | — | add security headers: CSP `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`; Trusted Types; `Referrer-Policy: no-referrer`; HSTS (when TLS) |
| "Copy as HTML" export | — | sanitize generated HTML (allow-list renderer; never pass raw Markdown HTML through) |
| `/api/stats` | public | fine, but don't add doc ids or IPs to it |
| Transport | plain HTTP/WS | require TLS in production (`axum-server` + `rustls`, or a proxy); refuse E2EE key handling on non-secure origins (`window.isSecureContext`) |

---

## 6. Threat model

Assets: document content and history, presence (names, cursors), who-collaborates-with-whom
metadata, edit integrity, availability.

| # | Adversary | Capability | Goal | Today | After this track | Residual risk |
|---|---|---|---|---|---|---|
| T1 | Passive network observer | sniff traffic | read docs | **Exposed** (no TLS by default) | TLS + E2EE | timing, sizes (padded), IPs |
| T2 | Active network attacker | MITM | inject JS, steal keys | **Exposed** | TLS + HSTS required; secure-context check | CA compromise |
| T3 | Honest-but-curious server operator / disk thief / backup leak | read storage and logs | read docs | **Exposed** (plaintext logs) | ciphertext only; `doc_id` not linked to content | metadata: doc count, sizes, IPs, times, number of collaborators |
| T4 | Malicious server | modify JS, withhold or reorder data | steal keys, inject edits, roll back | **Total** | injection blocked (peer sig check); rollback partly mitigated (`snapshot.prev`, self-heal) | **Malicious JS can still steal keys** (the web E2EE limit); withholding updates (needs hash chains, Phase 6) |
| T5 | Link guesser | enumerate doc ids | read or edit | **Exposed** for short or custom ids | 128-bit derived id + `read_proof` | none practical |
| T6 | Read-link holder | valid `#r=` | edit or vandalize | n/a (all links edit) | signatures enforced by server and peers | can re-share the read link; can read forever what they've already seen |
| T7 | Edit-link holder gone rogue | valid `#e=` | vandalize, forge others' op ids | can do anything | rotation revokes going forward; `snapshot.prev` | Id-forgery divergence until session certs (Phase 6); content already seen |
| T8 | Leaked link (history, chat, screenshot) | link | access | full access | rotation/revocation; optional fragment stripping | human error |
| T9 | XSS via peer content (name, color, markdown, HTML export) | malicious peer data | run script, steal keys from fragment or IndexedDB | **Possible** (unvalidated awareness) | validation + `textContent` + CSP + Trusted Types | browser bugs |
| T10 | Supply chain (npm / crates) | malicious dependency | steal keys | possible | lockfiles, `cargo audit`/`cargo deny`, `npm audit`, minimal deps, SRI for any CDN (none planned) | zero-days |
| T11 | Anonymous flooder | many sockets or frames | DoS, disk fill | **Exposed** (no limits) | §4 limits, PoW under attack, quotas | large botnets → upstream (CDN/WAF) |
| T12 | Malicious extension / compromised device | reads the page | everything | exposed | out of scope (documented) | out of scope |
| T13 | Account attacker | phishing, session theft | own or delete docs | n/a | passkeys (phishing-resistant), `__Host-` cookies, owner sig for destructive actions | recovery-code theft |
| T14 | Cross-site page | CSWSH, CSRF | act as the user | possible on WS (no Origin check) | Origin allow-list; SameSite cookies | — |

---

## 7. Security review checklist

Run this for every PR in this track, and in full before E2EE becomes the default.

**Crypto**
- [ ] No custom primitives; only `aes-gcm`, `ed25519-dalek`, `hkdf`, `sha2` (or WebCrypto)
- [ ] Nonces come from a CSPRNG, are never reused under a key, and messages are counted per epoch
- [ ] AAD binds `doc_id`, `kind`, `epoch`; the signature covers nonce and ciphertext
- [ ] Every `info` string in HKDF is distinct and versioned (`weft/v2/...`)
- [ ] Secrets are zeroized in Rust and never logged (check `tracing` fields and `Debug` impls)
- [ ] Constant-time comparison for `read_proof` (`subtle`)
- [ ] Cross-implementation test vectors (if option B) run in CI

**Protocol and server**
- [ ] The server never decodes CRDT bytes for v2 docs (a test asserts this)
- [ ] Every `Push`/`Snapshot` has its signature checked before persisting or relaying
- [ ] `client_id` is bound to the connection; `Hello.doc_id == path`
- [ ] Every limit in §4 is configured, tested, and returns a clear `Error` code
- [ ] Atomic writes (tmp + fsync + rename) for snapshot and log rewrite; crash test
- [ ] Fuzz targets run in CI for 60 s per PR and nightly for longer

**Client**
- [ ] The fragment is read once and never sent in any request, log, analytics, or error report
- [ ] Peer-supplied strings are rendered with `textContent` only; color is regex-validated
- [ ] The CSP is enforced (not report-only) in production; no `unsafe-inline`
- [ ] Read-only mode can't produce `Push` (unit + e2e)
- [ ] Missing or invalid key → error screen, never silently creates a new empty doc under that id

**Ops and privacy**
- [ ] TLS + HSTS in the deployment guide; `isSecureContext` check
- [ ] Server logs contain no doc content, no fragments, no `read_proof`; IPs are rotated or truncated after 7 days
- [ ] `cargo audit`, `cargo deny`, and `npm audit` in CI
- [ ] SECURITY.md with a disclosure contact; written threat-model limits (T4, T12) shown in the app's "About security"
- [ ] An external review before calling it "end-to-end encrypted" in marketing

---

## 8. Phase summary and effort

| Phase | Content | Effort | Depends on |
|---|---|---|---|
| 0 | Hardening: limits, timeouts, Origin, headers, validation gaps, fuzzing | 4–6 d | — |
| 1 | E2EE v2: `weft-crypto`, envelopes, seq relay, client snapshots, encrypted awareness, bundle + CLI export, migration | 15–19 d | 0 |
| 1′ | Capability links + signed ops (read/edit), `read_proof` (overlaps with 1) | 4–5 d | 1a |
| 2 | Owner key, rotation and revocation, delete, retention | 5–7 d | 1 |
| 3 | Optional passkey accounts + encrypted keychain + claims | 8–12 d | 2 |
| 5 | Per-person sharing with lockboxes (on demand) | 10–15 d | 3 |
| 6 | Session-certified author keys, hash-chained updates (fork/withholding detection), external audit | 8–12 d + audit | 1′ |

Total for the core (0 → 3): about **36–49 engineer-days**.

## References

- Secsync — E2EE CRDT sync architecture (documents, snapshots, updates, ephemeral messages): https://github.com/serenity-kit/secsync
- Naisho / Secsync funding page (NLnet): https://nlnet.nl/project/Naisho/
- Excalidraw — End-to-End Encryption in the Browser (key in the URL fragment): https://plus.excalidraw.com/blog/end-to-end-encryption
- Yjs community discussion on Y.Text and E2EE: https://discuss.yjs.dev/t/y-text-and-end-to-end-encryption/2854
- Crates: `aes-gcm`, `ed25519-dalek`, `hkdf`, `governor`, `tower_governor`, `webauthn-rs`
