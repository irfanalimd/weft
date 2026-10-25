# Weft — Vision

> **Weft** (n.): the threads woven across the warp to make fabric.
> Many people's keystrokes, woven into one document.

## One-liner

A real-time collaborative Markdown editor that is **instant, offline-first, and conflict-free**.
One Rust CRDT engine runs in the browser (compiled to WASM) *and* on the sync server, so
both sides run the same merge logic and always end up with the same document.

## Why it should exist

Most collaborative editors are slow to open, need an account, stop working when the Wi-Fi drops,
and depend on a central server that has to be right. Weft aims to be:

- **Instant**: open the URL and start typing. No sign-up, no loading spinner, no modal.
  A new doc is one keystroke away (`/` → fresh doc, or `⌘K → New`).
- **Offline-first**: every edit lands locally first (IndexedDB). Close the laptop, keep typing
  on the train, reconnect, and it merges cleanly.
- **Conflict-free by construction**: a sequence CRDT means any set of replicas that have seen the
  same operations show the same text, whatever order those operations arrived in. Nobody gets a
  "someone else edited this" dialog.
- **Full-stack Rust**: `weft-core` is one crate that compiles for `wasm32` and native. The server
  doesn't trust the clients and doesn't depend on them. It's just another replica.
- **Fast enough to brag about**: sub-millisecond local edits, a small WASM bundle, and a benchmark
  that replays a real-world editing trace (~260k ops) in well under a second natively.

## Who it's for

- Students and teams writing notes, meeting minutes, specs, and READMEs together.
- Developers who want a share-a-link scratchpad (`weft.local/d/xyz`) and a curl-able export.
- Anyone who has lost work to a flaky connection.

## Product principles

1. **The document is the UI.** A centered, calm writing surface. Chrome appears only when needed.
2. **Zero setup.** No accounts. Your name and color are picked for you and can be changed in one click.
3. **Always tell the truth about sync.** A small status pill shows *Live*, *Offline · 12 unsynced
   edits*, or *Reconnecting…*. Users should never have to guess whether their work is saved.
4. **Keyboard-first, mouse-friendly.** Everything is reachable from the command palette (`⌘K`).
5. **Fast is a feature.** We measure first paint, WASM size, op latency, and merge throughput,
   and treat regressions as bugs.
6. **Simple beats clever.** Clever data structures sit behind a small, boring API.

## Signature features (what makes it cool *and* useful)

| Feature | What the user sees |
|---|---|
| Live multiplayer | Other people's cursors and selections, labelled with their name and color, moving in real time |
| Presence bar | Stacked avatars of who's here; hover to see where they are in the doc; click to jump to their cursor |
| Offline mode | Keeps working with no network; pill shows unsynced count; merges on reconnect |
| Time travel | A history scrubber that replays the document from empty to now, so you can watch it being written. Restore an old version as new edits. |
| Markdown, live-styled | Headings, bold, code, lists, and checkboxes styled inline as you type (no split preview) |
| Command palette | `⌘K`: new doc, copy link, export `.md`, toggle theme, focus mode, history, rename yourself |
| Focus mode | Hides everything except the paragraph you're writing |
| Recent docs | Local list of docs you've opened, with titles taken from the first heading |
| Share | One click copies the link; optional QR code for phones |
| Export | Download `.md`, copy as HTML, or `curl /api/docs/:id/export.md` |
| Stats | Word count, reading time, and number of collaborators, kept out of the way |

## The distributed-systems story

- **Replicas, not clients**: browser tabs, the server, and test simulators all run `weft-core`.
- **Every op has an ID** `(client, clock)`. A **state vector** (`client → next clock`) identifies
  a version, which gives us delta sync and time travel from the same data structure.
- **Sync handshake**: exchange state vectors, send each other only what's missing. The handshake
  is idempotent, so retries, duplicates, and reordering are harmless.
- **Sans-IO protocol** (`weft-sync`): the sync state machines know nothing about sockets, so we can
  test them in a **deterministic network simulator** with drops, duplicates, reordering, and
  partitions, then check that every replica converges.
- **Durable server**: an append-only, checksummed update log per document, compacted into snapshots,
  that recovers from crashes mid-write.
- **Stretch**: several server nodes that gossip updates to each other. That's trivially safe because
  the data is a CRDT.

## Non-goals (for now)

- Accounts, permissions, or auth. Anyone with the link can edit, the way a pastebin works.
- Rich text beyond Markdown (tables, embeds, images).
- End-to-end encryption (good stretch idea, not v1).
- Scaling to millions of docs. The target is "one small box serves a class or a team".

## Success criteria for v1

- [ ] Two browsers editing the same doc see each other's keystrokes in < 100 ms on localhost.
- [ ] Unplug the network, both sides edit, reconnect: identical text, no lost characters.
- [ ] Kill the server with `kill -9` mid-session, restart it: no data loss beyond in-flight frames,
      and clients resync automatically.
- [ ] The simulator runs 10k random multi-replica scenarios with faults and every one converges.
- [ ] Gzipped WASM < 150 KB. The app is interactive in < 300 ms on localhost.
- [ ] It looks good enough that you'd want to use it for your own notes.
