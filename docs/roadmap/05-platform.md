# Roadmap 05 · Platform & Ecosystem

> Track owner: TBD · Status: proposal · Builds on: M0–M6 (shipped), M7 items "`weft` CLI" and
> "Dockerfile + one-click deploy". Contracts referenced here live in `docs/ARCHITECTURE.md`;
> anything new below is **additive** (no 🔒 signature changes) unless explicitly flagged.

Weft today is one binary (`weft-server`) plus a browser app. The engine, though, is already
portable: `weft-core` is pure Rust with no IO, and `weft-sync::ClientSession` is a sans-IO state
machine. That means **every new surface in this track is mostly glue**: put a socket on one side of
`ClientSession` and a UI or file or agent on the other. This track turns Weft from "a web app"
into "a document substrate you can reach from anywhere": terminal, desktop, phone, Git, your
editor, scripts, and AI agents.

## Contents

0. [Foundation: `weft-client` (native driver crate)](#0-foundation-weft-client)
1. [`weft` CLI + TUI](#1-weft-cli--tui-ratatui)
2. [Desktop (Tauri 2)](#2-desktop-tauri-2)
3. [Mobile (PWA polish, then Tauri mobile)](#3-mobile)
4. [Git sync + Obsidian / VS Code plugins](#4-git-sync--editor-plugins)
5. [REST + webhook API](#5-rest--webhook-api)
6. [MCP server (AI agents as live collaborators)](#6-mcp-server)
7. [Deploy: static binary, Docker, Fly.io](#7-deploy)
8. [Observability + backups](#8-observability--backups)
9. [Sequencing, effort, risks](#9-sequencing-effort-risks)

Effort scale: **S** ≤ 2 days · **M** 3–7 days · **L** 2–4 weeks · **XL** > 1 month (one engineer).

---

## 0. Foundation: `weft-client`

**Why first:** CLI, TUI, Tauri, git-sync, and the MCP server all need the same thing: "connect a
native `ClientSession` to `/ws/{doc}`, reconnect forever, persist locally, and give me a stream of
changes". Write it once.

**Design.** New crate `crates/weft-client` (native only, `tokio` + `tokio-tungstenite`, both
already workspace deps). It owns a background task that drives `ClientSession`, and exposes a
cheap-to-clone handle:

```rust
// crates/weft-client/src/lib.rs
pub struct Connect { pub server: Url, pub doc_id: String, pub store: Option<PathBuf>, pub name: String }

#[derive(Clone)]
pub struct DocHandle { tx: mpsc::Sender<Cmd>, state: watch::Receiver<Snapshot> }

pub enum Event { Changes(Vec<weft_core::Change>), Peers(Vec<Peer>), Status(ConnStatus) }

impl DocHandle {
    pub async fn open(cfg: Connect) -> Result<Self, ClientError>;     // spawns driver task
    pub fn text(&self) -> String;                                      // from latest Snapshot
    pub async fn insert(&self, pos: usize, text: &str) -> Result<()>; // UTF-16 positions
    pub async fn delete(&self, pos: usize, len: usize) -> Result<()>;
    pub async fn replace_all(&self, new_text: &str) -> Result<()>;    // minimal diff, see below
    pub async fn set_presence(&self, p: Presence) -> Result<()>;      // Awareness JSON contract
    pub fn subscribe(&self) -> broadcast::Receiver<Event>;
    pub async fn wait_synced(&self, timeout: Duration) -> Result<()>; // is_synced() && unsynced==0
}
```

Pieces:

- **Driver loop**: `select!` over socket frames, command channel, a ping timer, and a reconnect
  backoff (250 ms → 10 s, jittered). On connect: `session.on_connected()`; on close:
  `session.on_disconnected()`. Identical semantics to `web/src/sync/session.ts`.
- **Local store**: optional, reuses the server's `DocStore` log format
  (`[len][crc32][update]`) so a file written by the CLI can be loaded by the server and vice
  versa. Move `DocStore` from `weft-server/src/store.rs` into a small `weft-store` crate (or a
  `store` feature on `weft-sync`) so both sides share it.
- **Text diffing** (`replace_all`): the CLI, git-sync, REST, and MCP all receive "the new full
  text" and must turn it into minimal insert/delete ops so concurrent edits merge sanely. Use
  `similar` (Myers, char-level with a line-level pre-pass for speed) and convert byte/char
  offsets to **UTF-16** before calling `insert`/`delete`. Apply hunks back-to-front so earlier
  positions stay valid. Put this in `weft-core::text_diff` (pure, no deps besides `similar`) so the
  server can use it too.
- **Client id**: random `u64` per process; `ClientSession` is per connection, Doc persisted.

**Plan**

- [ ] Extract `DocStore` into a shared crate; server keeps its behavior (tests stay green)
- [ ] `weft-core::text_diff::ops(old, new) -> Vec<Edit>` with UTF-16 offsets + proptest
      (`apply(old, ops(old,new)) == new`, emoji/CRLF cases)
- [ ] `weft-client` driver: connect, handshake, reconnect, ping, presence
- [ ] Integration test: spawn `weft_server::app` on an ephemeral port, two `DocHandle`s converge;
      kill the server mid-edit, restart, converge
- [ ] Offline mode: `store` + no server → edits persist, sync on next connect

**Effort: M** (most logic exists in `ClientSession`; the diff + store extraction is the real work).

---

## 1. `weft` CLI + TUI (ratatui)

**User value.** Weft docs become Unix citizens. `curl`-able is good; `weft cat | grep` and
`make test 2>&1 | weft append build-log` is better. Terminal users (and SSH sessions, servers,
CI) get first-class live collaboration without a browser. It's also the best dogfooding and
debugging tool for the protocol.

### Commands

```
weft [--server URL] [--name NAME] <command>

  cat    <doc>                 print current text once (waits for SyncStep), exit
  watch  <doc> [--follow]      print text, then stream changes (like `tail -f`); --json emits events
  edit   <doc>                 full-screen ratatui editor with live remote cursors
  edit   <doc> --external      open $EDITOR on a temp file; on each save, diff → ops (live!)
  write  <doc>  < file         replace doc text with stdin (minimal diff, merges with others)
  append <doc>  < stream       append stdin line-by-line as it arrives (live logs into a doc)
  new    [--from file.md]      create a doc with a random id, print its URL
  open   <doc>                 open the doc in the browser
  history <doc> [--at N]       list versions / print text at step N (uses version_at/text_at)
  export <doc> -o file.md      same as /api/docs/{id}/export.md
  sync   <doc> <path.md>       two-way file sync (see §4, Git sync)
  serve                        run weft-server in-process (single binary, see §7)
  mcp                          run the MCP server over stdio (see §6)
```

`<doc>` accepts a bare id (`notes`), a full URL (`https://weft.example/d/notes`), or an alias
from `~/.config/weft/config.toml`:

```toml
server = "https://weft.example"
name   = "ali@laptop"
[alias]
standup = "https://weft.example/d/team-standup"
```

### Design

- **One binary, `crates/weft-cli`**, `clap` derive, binary name `weft`. Commands are thin
  wrappers over `weft-client::DocHandle`.
- `cat`: `open` → `wait_synced(5s)` → print → exit 0. Non-zero exit + message on `Error{code}`.
- `watch`: print snapshot, then for each `Event::Changes` redraw (TTY) or emit NDJSON
  `{ "type": "insert", "pos": 12, "text": "…", "by": 1234 }` (non-TTY / `--json`). Great for
  scripting and for tests.
- `append`: read stdin with `BufReader::lines()`, batch lines per 50 ms, `insert(len_utf16, …)`.
  Ctrl-C → `wait_synced` → exit. This makes "pipe into a doc" live for everyone watching.
- `edit --external`: write text to a temp file, spawn `$EDITOR`, watch the file with `notify`.
  On every save: `replace_all(file_text)`. On remote change while the editor is open: write the
  file only if the editor hasn't modified it since (mtime check), otherwise defer until save
  and three-way merge (§4 algorithm). Works with vim/helix/nano with zero plugins.

### TUI (`weft edit`)

ratatui + crossterm. A focused Markdown editor, not an IDE:

```
┌ team-standup ─────────────────────── ● Ada ● Lin ● you ─── synced ✓ ┐
│ # Standup 2026-10-25                                                 │
│ - Ada: shipping export█                                              │
│ - Lin: ▌reviewing PR                                                 │
│                                                                      │
└ ^S sync now  ^H history  ^P peers  ^Q quit ── Ln 3, Col 22 ── 0 unsynced ┘
```

- **Buffer model**: the TUI keeps a `ropey::Rope` mirror for rendering/cursor math; every local
  keystroke becomes `DocHandle::insert/delete` (convert char idx → UTF-16 via a cached line
  index); every remote `Change` is applied to the rope. The CRDT is the source of truth; the
  rope is a view, exactly like CodeMirror in the web app.
- **Remote cursors**: decode peers' Awareness `cursor.anchor/head` (base64 `Anchor`) with
  `resolve_anchor`, render as colored block/bar in the peer's color (truecolor if supported).
  Publish our own cursor as anchors on every move (throttled to 20 Hz).
- **Markdown styling**: lightweight line-based highlighting (headings bold, `code` dim,
  `**bold**`, links underlined) via `pulldown-cmark` offsets; no WYSIWYG.
- **Widget choice**: either write a small custom editor widget (recommended, ~600 LoC; we need
  control over remote cursors) or start from `tui-textarea`/`edtui` and fork. Ratatui's own
  docs list several terminal editors built on it; none handle multi-cursor remote presence, so
  expect to own the widget.
- **History** (`^H`): side panel with a slider over `version_at(step)`, read-only preview via
  `text_at` — same UX as the web history scrubber.
- Keybindings: arrows, Home/End, PgUp/PgDn, word motion (Alt-←/→), undo/redo via
  `weft_core::UndoManager` (local-only undo, same as web).

### File layout

```
crates/weft-cli/
  Cargo.toml        # clap, ratatui, crossterm, ropey, notify, similar, directories, weft-client
  src/main.rs       # clap dispatch
  src/target.rs     # parse <doc>: id | URL | alias → (server, doc_id)
  src/cmd/{cat,watch,write,append,edit_external,history,sync,new}.rs
  src/tui/{app.rs, editor.rs, cursors.rs, highlight.rs, history.rs}
```

### Plan

- [ ] **P1 (S)**: `weft cat`, `weft write`, `weft export`, `weft new`, target parsing + config
- [ ] **P1 (S)**: `weft watch` (TTY redraw + `--json` NDJSON), `weft append` (live pipe)
- [ ] **P2 (M)**: `weft edit --external` with `notify` + diff-on-save
- [ ] **P3 (L)**: ratatui editor: buffer mirror, local ops, remote changes, status bar
- [ ] **P3**: remote cursors from Awareness anchors; publish own cursor
- [ ] **P3**: history panel, undo/redo, Markdown highlighting
- [ ] **P4 (S)**: release: `cargo dist` → GitHub releases, Homebrew tap, `cargo install weft-cli`,
      shell completions (`clap_complete`), man page (`clap_mangen`)
- [ ] Tests: `assert_cmd` against an in-process server; TUI snapshot tests with ratatui's
      `TestBackend`

**Effort: M for P1–P2, L for the full TUI.**

---

## 2. Desktop (Tauri 2)

**User value.** A real app: dock icon, native menus, `⌘N`, open `.md` files from Finder, works
with no network for days, and your notes are **plain files on your disk** that sync when you're
online. That's the local-first promise from `docs/VISION.md` made literal.

### Design

Tauri 2 wraps the existing `web/dist` UI in the OS webview. The key decision is **where the
CRDT runs**:

| Option | How | Pros | Cons |
|---|---|---|---|
| A. WASM in webview (as today) | ship web build as-is | zero new code, 1 day | storage is webview IndexedDB (opaque), no file access |
| **B. Native engine (target)** | `weft-client` in Rust core; UI talks over Tauri IPC | real files, faster, one engine for CLI/desktop, background sync even with window closed | need an engine abstraction in `web/src/sync` |

Ship A as a week-one preview, then B.

**Engine abstraction in the web app.** Introduce an interface the UI already effectively uses:

```ts
// web/src/sync/engine.ts
export interface DocEngine {
  text(): string;
  insert(pos: number, text: string): void;
  delete(pos: number, len: number): void;
  setAwareness(payload: Uint8Array): void;
  onChanges(cb: (changes: Change[]) => void): () => void;
  onAwareness(cb: (peers: Peer[]) => void): () => void;
  status(): SyncStatus; // online/offline/unsynced count
}
// wasm-engine.ts → current WeftClient path (browser, PWA)
// tauri-engine.ts → invoke('doc_insert', …) + listen('doc://changes', …)
```

Selected at boot via `window.__TAURI_INTERNALS__` presence. CodeMirror's collab binding
(`web/src/sync/collab.ts`) targets `DocEngine` instead of `WeftClient` directly.

**Native side** (`apps/desktop/src-tauri`):

```rust
#[tauri::command]
async fn doc_open(state: State<'_, Docs>, app: AppHandle, doc: String) -> Result<String, String> {
    let h = state.open(&doc).await.map_err(|e| e.to_string())?;   // weft_client::DocHandle
    let mut rx = h.subscribe();
    tauri::async_runtime::spawn(async move {
        while let Ok(ev) = rx.recv().await { let _ = app.emit(&format!("doc://{doc}"), ev); }
    });
    Ok(h.text())
}
#[tauri::command] async fn doc_insert(state: State<'_, Docs>, doc: String, pos: usize, text: String) -> Result<(), String>;
#[tauri::command] async fn doc_delete(state: State<'_, Docs>, doc: String, pos: usize, len: usize) -> Result<(), String>;
```

Use Tauri **channels** (`tauri::ipc::Channel`) for the change stream if event throughput is a
problem; batch changes per animation frame either way.

**Local-first storage layout** (user-chosen "vault" folder, default `~/Documents/Weft`):

```
~/Documents/Weft/
  standup.md                 # plain Markdown mirror, always current, editable by any tool
  ideas/roadmap.md
  .weft/
    docs/standup.log         # CRDT log (DocStore format) – source of truth
    docs/ideas~roadmap.log
    vault.toml               # server URL, doc-id ↔ path map, per-doc sync on/off
    sync-state.json          # last-synced text hash + state vector per file (for 3-way merge)
```

- The `.md` file is a **projection** of the CRDT; external edits to it (from vim, Obsidian, git
  pull) are detected with `notify` and folded back in using the same three-way merge as Git sync
  (§4). One engine, three use-cases.
- Docs can be **local-only** (never leave the machine) or **shared** (bound to a server doc id).
- Optional: "Share on LAN" runs an embedded `weft_server::app` on a random port + shows a QR
  code. Same binary, no cloud.

**Desktop niceties**: native menu (File/Edit/View/Window), `⌘K` palette passthrough, file
association for `.md`, deep links `weft://d/<id>` (`tauri-plugin-deep-link`), single-instance
(`tauri-plugin-single-instance`), tray icon with sync status, auto-update
(`tauri-plugin-updater` + signed releases), window-state persistence.

### File layout

```
apps/desktop/
  package.json            # scripts: tauri dev/build; frontend = ../../web
  src-tauri/
    Cargo.toml            # tauri 2, tauri-plugin-{fs,dialog,deep-link,updater,single-instance}, weft-client
    tauri.conf.json       # frontendDist: ../../web/dist, devUrl: http://localhost:5173
    capabilities/default.json
    src/{main.rs, commands.rs, vault.rs, watcher.rs}
```

### Plan

- [ ] **P1 (S)**: Option A: Tauri shell around `web/dist`, pointed at a configurable server;
      CI builds `.dmg/.msi/.AppImage`
- [ ] **P2 (M)**: `DocEngine` interface in `web/src/sync`; refactor `collab.ts` to it (web unchanged)
- [ ] **P2 (M)**: native engine + IPC commands/events; `tauri-engine.ts`
- [ ] **P3 (M)**: vault: folder picker, `.md` projection, `notify` watcher + three-way fold-in
- [ ] **P3**: doc list sidebar from the vault; local-only vs shared toggle
- [ ] **P4 (M)**: deep links, file associations, tray, updater, code-signing/notarization (macOS),
      Windows signing
- [ ] **P5 (S)**: "Share on LAN" with embedded server

**Effort: L** (signing/notarization alone eats days; budget for it).

---

## 3. Mobile

**User value.** Read and jot on the phone, with offline edits that merge later. Most mobile use
is quick capture and reading, not long-form editing.

### Phase 1: PWA polish (recommended first; cheap, already 80% there)

The app is already a PWA (M5/M6: offline reload verified). Polish:

- **Keyboard & viewport**: use `visualViewport` to keep the caret above the iOS keyboard; a
  Markdown accessory bar above the keyboard (`#`, `**`, `- [ ]`, `` ` ``, indent/outdent, undo).
- **Touch**: larger hit targets in the top bar, long-press on presence avatars, swipe-from-edge
  doc list; avoid hover-only affordances.
- **Install UX**: custom "Add to Home Screen" hint on iOS Safari (no `beforeinstallprompt`),
  maskable icons, splash screens, `display: standalone`, theme-color per light/dark.
- **Share target** (`share_target` in manifest, Android/Chromium): "Share → Weft" appends the
  shared text/URL to a chosen doc (inbox pattern).
- **Storage durability**: call `navigator.storage.persist()`; iOS evicts script-written storage
  for non-installed sites after inactivity, so surface "installed = durable" in the UI.
- **Background**: no reliable background sync on iOS; flush on `visibilitychange` and show the
  unsynced count prominently (already exists).
- [ ] Viewport/keyboard fix + accessory bar
- [ ] Touch-sized UI pass; Lighthouse PWA + a11y ≥ 95 on mobile
- [ ] Share target + "inbox" doc
- [ ] `storage.persist()` + durability hint
- [ ] Real-device test matrix: iOS Safari (installed + not), Android Chrome
- **Effort: M**

### Phase 2: Tauri 2 mobile (iOS/Android)

Tauri 2 ships iOS/Android targets (`tauri ios init`, `tauri android init`) with the same Rust
core and webview frontend, so the desktop native engine (§2 Option B) carries over. Worth it
when we need: App Store presence, real filesystem (Files app integration), share extensions,
background fetch, push notifications on mentions.

- [ ] `tauri android init` / `tauri ios init` on `apps/desktop` (one project, multiple targets)
- [ ] Storage under the app data dir; iOS: expose vault via Files app (`UIFileSharingEnabled`)
- [ ] Mobile-specific capabilities file; test `tauri-plugin-fs` scope on both OSes
- [ ] Share extension / intent filter → append to inbox doc (native plugin code in Swift/Kotlin)
- [ ] Store submission pipeline (Fastlane), TestFlight / internal track
- **Effort: L** (store review, signing, and device QA dominate).

---

## 4. Git sync + editor plugins

### 4a. Git sync (doc ↔ markdown file in a repo, two-way)

**User value.** Docs live where engineering already lives: `docs/rfcs/0042.md` in the repo is
*also* a live Weft doc. Edit in the browser with your team during a meeting; the file updates
and gets committed. Someone edits it in a PR; merge to main, and the live doc updates. No
copy-paste drift.

**The hard part is the merge, and the CRDT makes it easy.** Keep, per binding, the **base**:
the text and the state vector at the last moment file and doc agreed.

```
on file change (or git pull):
    base_text, base_sv = sync_state[path]
    file_text          = read(path)
    ops = text_diff(base_text, file_text)            # what the file side changed since base
    fork = doc.fork_at(&base_sv)                     # replica as of base (time travel)
    upd  = fork.apply_local(ops)                     # ops get CRDT ids rooted at base
    doc.apply_update(&upd)                           # CRDT merges with concurrent web edits
    write(path, doc.text()) if it differs from file_text
    sync_state[path] = (doc.text(), doc.state_vector())

on doc change (debounced 2 s):
    if file unchanged since base: write(path, doc.text()); update base
    else: run the file-change path first (above), then write
```

Because file-side edits are expressed as ops positioned **at the base version**, concurrent
browser edits made since then are preserved and interleaved by the CRDT, never "last writer
wins". Needs one additive core API: `Doc::fork_at(&StateVector) -> Doc` (build from the
subset of ops covered by the SV; `text_at` already computes visibility at a version, so the
machinery exists). Add it to the contract change log.

**Commit policy** (in `.weft.toml` at repo root):

```toml
server = "https://weft.example"
[[bind]]
path = "docs/rfcs/0042-sync.md"
doc  = "rfc-0042"
[commit]
mode = "debounce"          # "debounce" | "manual" | "on-idle"
idle_secs = 300
message = "docs: sync {path} from Weft ({authors})"
branch  = "weft-sync"      # never commit to main directly; open a PR (optional, via gh)
```

**Implementation.** `weft sync <doc> <path>` (single binding, foreground) and
`weft git-sync` (reads `.weft.toml`, daemon). Uses `weft-client` + `notify` for files and
`gix` (pure-Rust git) for status/commit, or shells out to `git` for the MVP. Also a **GitHub
Action** `weft-sync-action`: on push to main, run `weft write <doc> < file` for each binding
(file → doc direction, three-way using a base stored in a git note or in the server).

- [ ] `Doc::fork_at` in weft-core (+ proptest: fork_at(sv).text() == text_at(sv))
- [ ] `weft sync <doc> <file>` foreground, three-way fold-in, state file
- [ ] Tests: concurrent web edit + file edit on the same paragraph → both survive
- [ ] `.weft.toml` multi-binding daemon, commit modes, author list from Awareness names
- [ ] GitHub Action for file → doc on push
- [ ] Line endings (CRLF ↔ LF normalize at the boundary), trailing newline, BOM handling
- **Effort: M** (core fork + CLI) **+ M** (daemon, commits, Action)

### 4b. Obsidian plugin

Obsidian's editor **is CodeMirror 6**, and plugins can add CM6 extensions via
`registerEditorExtension`. Our `web/src/sync/collab.ts` is already a CM6 extension. So:

- Publish the session layer as an npm package `@weft/client` (`weft-wasm` pkg + `web/src/sync`,
  built as an ES module with the wasm inlined or loaded from the plugin folder).
- Plugin: frontmatter `weft: https://weft.example/d/standup` binds a note; command palette
  "Weft: share this note" creates a doc and writes the frontmatter. Remote cursors render via
  the existing CM6 decorations; presence in the status bar.
- On bind, initial reconcile uses the same three-way fold-in (note text vs. doc).
- [ ] Extract `@weft/client` package (shared by web, Obsidian, VS Code webview)
- [ ] Obsidian plugin skeleton (`manifest.json`, `main.ts`), bind/unbind, status bar
- [ ] Mobile Obsidian check (wasm loads in Obsidian mobile)
- [ ] Submit to community plugins
- **Effort: M**

### 4c. VS Code extension

VS Code isn't CM6, so bind at the `TextDocument` level: listen to
`workspace.onDidChangeTextDocument` → ops (content changes already give ranges + text, convert
to UTF-16 offsets, which VS Code also uses), apply remote `Change`s with
`WorkspaceEdit` (guard against echo with a flag). Remote cursors as `TextEditorDecorationType`.
Run `@weft/client` (wasm) in the extension host (Node), or spawn `weft` CLI as a sidecar speaking
NDJSON (`weft watch --json` + a `weft bridge` stdin command mode); the sidecar is simpler to
ship cross-platform if wasm-in-node gets awkward.

- [ ] `weft bridge <doc>` NDJSON stdin/stdout mode in the CLI (also useful for other editors:
      Neovim, Helix, Zed)
- [ ] VS Code extension: open doc as virtual `weft:` URI (FileSystemProvider) or bind a file
- [ ] Remote cursors + presence; publish to Marketplace/Open VSX
- **Effort: M**; Neovim plugin on top of `weft bridge` is **S**.

---

## 5. REST + webhook API

**User value.** Integrations without a WebSocket client: Zapier, cron jobs, Slack bots,
CI annotations, "append the deploy log to #release-notes doc".

### Endpoints (add to `weft_server::app`, under `/api/v1`)

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/v1/docs/{id}` | `{ id, text, version: <base64 SV>, peers, updated_at }` |
| GET | `/api/v1/docs/{id}/text` | `text/markdown` (alias of existing `export.md`) |
| PUT | `/api/v1/docs/{id}/text` | full text; server diffs (§0) → ops; `If-Match: <version>` makes it a three-way merge from that base instead of a blind replace |
| POST | `/api/v1/docs/{id}/append` | `{ text }` → insert at end |
| POST | `/api/v1/docs/{id}/edits` | `[{ op: "insert", pos, text } \| { op: "delete", pos, len } \| { op: "replace", find, with }]` |
| GET | `/api/v1/docs/{id}/history?limit=` | versions with step, timestamp (if tracked), size |
| GET | `/api/v1/docs/{id}/at/{step}` | text at version |
| GET | `/api/v1/docs/{id}/events` | **SSE** stream of changes (for clients that can't do WS) |
| POST/GET/DELETE | `/api/v1/webhooks` | register `{ url, docs: ["*" or ids], events: ["doc.changed"], secret }` |

**How edits enter the room**: REST handlers don't touch `DocStore` directly; they act as a
short-lived **server-side client** of the `Room` (a `ServerClient` with its own client id per API
token) so edits flow through the exact same broadcast + persist path as WebSocket edits. Live
browser users see API edits appear instantly with a presence blip ("API: deploy-bot").

**Webhooks**: emit `doc.changed` **debounced** per doc (e.g. 5 s quiet or 60 s max) with
`{ doc, version, prev_version, summary: { inserted, deleted }, authors, text_url }`. Signed
`X-Weft-Signature: sha256=HMAC(secret, body)`, `X-Weft-Delivery` id, retries with exponential
backoff (5 attempts), delivery log at `GET /api/v1/webhooks/{id}/deliveries`. Implementation: a
`tokio` task with a bounded queue, `reqwest` client; webhook config in `data/webhooks.json`
(or the metadata store if Roadmap auth introduces one).

**Auth** (dependency on the auth/sharing track): bearer tokens `Authorization: Bearer weft_…`,
scoped `docs:read` / `docs:write` / `webhooks`, per-doc allow-lists. Until then, gate the
write API behind `WEFT_API_TOKEN` env (single admin token) and keep it off by default.

**OpenAPI**: generate with `utoipa` → `/api/v1/openapi.json`; this also feeds MCP tool schemas.

- [ ] `text_diff` server-side; `GET/PUT text`, `append`, `edits` via a server-side Room client
- [ ] `If-Match` three-way PUT (reuse `fork_at`)
- [ ] SSE events endpoint
- [ ] Webhooks: registry, debounce, HMAC, retries, delivery log
- [ ] Token auth (interim env token → real scoped tokens later), rate limiting (`tower_governor`)
- [ ] `utoipa` OpenAPI + docs page
- **Effort: M** (+ S for webhooks hardening)

---

## 6. MCP server

**User value.** This is the headline. Claude (Claude Code, Claude Desktop, any MCP host) joins
a Weft doc **as a visible collaborator**: it has a name and a colored cursor, you watch it type
the meeting summary while you fix the intro, its edits merge with yours via the CRDT, and you
can undo them. No copy-paste between chat and doc. "Claude, turn the notes in `standup` into
action items under `## Todo`," and it happens live in front of the whole team.

### Two deployment modes, one implementation

1. **Local stdio**: `weft mcp --server https://weft.example` (in the CLI). Configure in an MCP
   host, e.g. Claude Code:
   `claude mcp add weft -- weft mcp --server https://weft.example --name "Claude"`.
   Internally a `weft-client` per opened doc, so it works offline and against any server.
2. **Remote streamable HTTP**: `weft-server` mounts `/mcp` (feature `mcp`) so hosted users add
   one URL with an OAuth/bearer token; no local install. Internally uses the server-side Room
   client from §5.

Use **`rmcp`** (official Rust MCP SDK; features `server`, `macros`, `transport-io`,
`transport-streamable-http-server`). Crate `crates/weft-mcp`, used by both `weft-cli` and
`weft-server`.

### Tools (designed for LLMs, not for programs)

LLMs are bad at UTF-16 offsets and good at quoting text. So edits are **text-anchored**, not
offset-based:

| Tool | Args | Behavior |
|---|---|---|
| `list_docs` | `query?` | recent/known docs with titles (first heading) |
| `read_doc` | `doc`, `with_line_numbers?` | text + `version` token + who's online |
| `read_section` | `doc`, `heading` | just one section (cheap context for big docs) |
| `outline` | `doc` | heading tree with line ranges |
| `replace_text` | `doc`, `find`, `replace`, `occurrence?` | `find` must match exactly once (or the given occurrence) in the **current** text; otherwise returns an error listing matches, so the model re-reads instead of clobbering |
| `insert_text` | `doc`, `text`, `after?` / `before?` / `at: "start"\|"end"`, `under_heading?` | anchored insert |
| `delete_text` | `doc`, `find` | same uniqueness rule |
| `rewrite_section` | `doc`, `heading`, `new_body` | diffed (§0) so only changed spans move; concurrent human edits elsewhere untouched |
| `create_doc` | `title?`, `text` | returns id + URL |
| `get_changes` | `doc`, `since_version` | what humans changed since the model last read (diff summary) |
| `wait_for_change` | `doc`, `timeout_s` | long-poll; lets an agent "watch" a doc (e.g. respond to `@claude` lines) |
| `history` / `read_at` | `doc`, `step` | time travel for "what did this say yesterday" |

**Resources**: `weft://doc/{id}` (text/markdown) with `resources/subscribe` → push
`notifications/resources/updated` on change, so hosts that support subscriptions keep context
fresh. **Prompts**: `summarize_doc`, `extract_action_items`, `review_doc` as starter templates.

**Live presence**: on any tool call against a doc, the MCP client publishes Awareness
`{ name: "Claude", color: "#d97757", cursor: <anchor at edit site> }`, moves the cursor to the
edit location before applying, and (optional, `--typing`) streams long inserts in ~40-char
chunks at a readable pace so humans *see* it write. Presence expires 30 s after the last call.

**Safety & attribution**:
- Each agent session gets its own client id → author attribution (Roadmap M7 "color text by
  who wrote it") can flag AI-written spans; web UI shows "Claude edited 3 spans · Undo all".
  Implement "undo all by client id" as an `UndoManager` scope keyed on client id.
- Per-token scopes (read-only agents), per-doc allow-list, edit rate limit, max insert size.
- `replace_text` uniqueness + `version` checks prevent the classic "stale offset" corruption.
- Never execute content from docs as instructions in tool descriptions; document prompt
  injection risk ("docs are untrusted input") in the README.

### Sketch

```rust
// crates/weft-mcp/src/lib.rs (rmcp macro style; verify exact 3.x API when implementing)
#[derive(Clone)]
pub struct WeftMcp { docs: Arc<DocPool>, tool_router: ToolRouter<Self> }

#[tool_router]
impl WeftMcp {
    #[tool(description = "Replace an exact, unique passage of text in a Weft doc. \
        Re-read the doc if the passage is not found or is ambiguous.")]
    async fn replace_text(&self, Parameters(a): Parameters<ReplaceArgs>) -> Result<CallToolResult, McpError> {
        let h = self.docs.get(&a.doc).await?;           // weft_client::DocHandle or server Room client
        let text = h.text();
        let pos = unique_match(&text, &a.find, a.occurrence).map_err(to_tool_error)?;
        h.set_presence(Presence::agent_at(pos)).await?;
        h.delete(utf16(&text, pos), utf16_len(&a.find)).await?;
        h.insert(utf16(&text, pos), &a.replace).await?;
        h.wait_synced(Duration::from_secs(3)).await.ok();
        Ok(CallToolResult::success(vec![Content::text(format!("ok, version {}", h.version()))]))
    }
}
```

### Plan

- [ ] **P1 (M)**: `weft-mcp` crate with `read_doc`, `outline`, `read_section`, `replace_text`,
      `insert_text`, `delete_text`, `create_doc` over stdio via `weft mcp`
- [ ] **P1**: presence as "Claude" with cursor at the edit site
- [ ] **P2 (S)**: `rewrite_section` (diffed), `get_changes`, `wait_for_change`, history tools
- [ ] **P2**: resources + subscriptions; prompts
- [ ] **P3 (M)**: `/mcp` streamable HTTP endpoint in weft-server, bearer/OAuth auth, scopes
- [ ] **P3**: "Undo all by Claude" in the web UI (depends on attribution)
- [ ] **P3**: `--typing` streaming mode
- [ ] Evals: scripted scenarios (summarize, insert under heading, concurrent human edit during
      agent edit) checked for convergence + intent; test with Claude Code and the MCP Inspector
- **Effort: M for a great P1–P2; L including hosted HTTP + auth + UI undo.**

---

## 7. Deploy

**User value.** `docker run -p 7878:7878 -v weft:/data ghcr.io/…/weft` or one `fly launch`, and
you have your own Weft. A single static binary for people who don't want containers.

### Single binary with embedded web assets (`rust-embed`)

Today the server reads `WEFT_STATIC_DIR` (default `./web/dist`). Add a cargo feature `embed-web`:

```rust
// crates/weft-server/src/assets.rs
#[cfg(feature = "embed-web")]
#[derive(rust_embed::RustEmbed)]
#[folder = "../../web/dist"]
struct WebDist;

pub async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let file = WebDist::get(path).or_else(|| WebDist::get("index.html")); // SPA fallback
    match file {
        Some(f) => {
            let mime = mime_guess::from_path(if WebDist::get(path).is_some() { path } else { "index.html" })
                .first_or_octet_stream();
            let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
            ([(CONTENT_TYPE, mime.as_ref()), (CACHE_CONTROL, cache), (ETAG, &hex(f.metadata.sha256_hash()))], f.data).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
```

- `WEFT_STATIC_DIR` still overrides (dev, custom builds). `sw.js` and `index.html` must be
  `no-cache` so PWA updates roll out.
- Optionally precompress (`rust-embed` `compression` feature, or build `.br` files in Vite and
  serve them when `Accept-Encoding` allows).
- `weft serve` in the CLI (§1) = same app, so `weft` is the *one* binary for everything.
- Static Linux build: `cargo build --release --target x86_64-unknown-linux-musl --features embed-web`
  (no OpenSSL anywhere: use `rustls` for `reqwest`/`tokio-tungstenite`). Release matrix via
  `cargo dist`: linux x86_64/aarch64 musl, macOS universal, windows.

### Dockerfile (multi-stage, distroless)

```dockerfile
# syntax=docker/dockerfile:1.7
FROM rust:1-bookworm AS chef
RUN cargo install cargo-chef wasm-pack --locked && rustup target add wasm32-unknown-unknown
WORKDIR /src

FROM chef AS plan
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS rust-deps
COPY --from=plan /src/recipe.json .
RUN cargo chef cook --release --recipe-path recipe.json -p weft-server

FROM rust-deps AS wasm
COPY . .
RUN wasm-pack build crates/weft-wasm --release --target web --out-dir ../../web/src/wasm/pkg

FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
COPY --from=wasm /src/web/src/wasm/pkg ./src/wasm/pkg
RUN npm run build

FROM rust-deps AS server
COPY . .
COPY --from=web /src/web/dist ./web/dist
RUN cargo build --release -p weft-server --features embed-web

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=server /src/target/release/weft-server /weft-server
ENV WEFT_ADDR=0.0.0.0:7878 WEFT_DATA_DIR=/data
VOLUME /data
EXPOSE 7878
USER nonroot
ENTRYPOINT ["/weft-server"]
```

(With a musl build, the final stage can be `gcr.io/distroless/static-debian12:nonroot`; image
≈ 10–15 MB.) Add `.dockerignore` (`target/`, `web/node_modules`, `data/`). Healthcheck lives in
the orchestrator (distroless has no shell): Fly checks / k8s probes hit `/healthz`. Note:
`/data` must be writable by uid 65532 (nonroot): pre-create with ownership in the build, or
document `chown` for bind mounts.

### fly.toml

```toml
app = "weft"
primary_region = "iad"
kill_signal = "SIGTERM"
kill_timeout = "30s"

[build]
  dockerfile = "Dockerfile"

[env]
  WEFT_ADDR = "0.0.0.0:7878"
  WEFT_DATA_DIR = "/data"
  RUST_LOG = "info,weft_server=debug"

[mounts]
  source = "weft_data"
  destination = "/data"

[http_service]
  internal_port = 7878
  force_https = true
  auto_stop_machines = "off"     # rooms live in memory; stopping drops live sessions
  auto_start_machines = true
  min_machines_running = 1
  [http_service.concurrency]
    type = "connections"
    soft_limit = 2000
    hard_limit = 5000

[[http_service.checks]]
  grace_period = "10s"
  interval = "15s"
  method = "GET"
  path = "/healthz"
  timeout = "2s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"

[metrics]
  port = 9091
  path = "/metrics"
```

**Single machine only** until multi-node (PLAN M7) lands: rooms are in-process and a Fly volume
attaches to one machine. Document `fly scale count 1`. WebSockets work through Fly's proxy
as-is; the server's ping keepalive keeps idle connections alive.

**Graceful shutdown**: on SIGTERM, stop accepting, send clients a close frame with a
"server restarting" code (client reconnects with backoff, handshake re-syncs), flush/compact
open rooms, exit. `weft-server` already uses `with_graceful_shutdown`, but only on
`tokio::signal::ctrl_c()` (SIGINT, `lib.rs:286`). Docker and Fly send **SIGTERM**, so also listen
on `tokio::signal::unix::signal(SignalKind::terminate())`. Without that, every deploy is a hard kill
(the log format makes it safe, but clients get no clean close).

Other targets: `docker-compose.yml` (server + optional Caddy for TLS), a Render/Railway button,
a k8s example (StatefulSet + PVC, 1 replica), a NixOS module / systemd unit for the binary.

### Plan

- [ ] **P1 (S)**: `embed-web` feature + `static_handler`, cache headers, SPA fallback, tests
- [ ] **P1 (S)**: Dockerfile + `.dockerignore`; image < 40 MB (cc) / < 20 MB (static musl)
- [ ] **P1 (S)**: graceful shutdown with flush + client close code
- [ ] **P2 (S)**: `fly.toml`, `docs/deploy.md` (fly launch, volume, custom domain, backups)
- [ ] **P2 (S)**: GitHub Actions: build multi-arch image (amd64/arm64) → GHCR on tag; `cargo dist`
      binaries; smoke test the image (`docker run` + `web/scripts/smoke.mjs`)
- [ ] **P3 (S)**: compose file with Caddy, systemd unit, k8s example
- **Effort: S–M overall** (the cheapest, highest-leverage item in this track).

---

## 8. Observability + backups

**User value.** Operators know whether Weft is healthy *before* users complain, and nobody ever
loses a doc.

### Metrics (Prometheus)

`metrics` facade + `metrics-exporter-prometheus`, served on a separate listener
(`WEFT_METRICS_ADDR`, default `127.0.0.1:9091`, so it isn't public by accident):

| Metric | Type | Labels |
|---|---|---|
| `weft_connections` | gauge | |
| `weft_rooms_open` | gauge | |
| `weft_ws_messages_total` | counter | `dir` (in/out), `kind` (hello/update/awareness/…) |
| `weft_ws_bytes_total` | counter | `dir` |
| `weft_update_apply_seconds` | histogram | |
| `weft_broadcast_fanout` | histogram | |
| `weft_outbound_queue_dropped_total` | counter | `reason` (backpressure/slow client) |
| `weft_store_append_seconds`, `weft_store_fsync_seconds` | histogram | |
| `weft_store_compactions_total`, `weft_store_log_bytes` | counter / gauge | |
| `weft_room_load_seconds` | histogram | (replay time; catches log bloat) |
| `weft_protocol_errors_total` | counter | `code` |
| `weft_http_requests_total`, `weft_http_request_seconds` | counter / histogram | `route`, `status` |

**No `doc_id` labels** (unbounded cardinality); per-doc stats stay in `/api/stats`. Ship a
Grafana dashboard JSON in `deploy/grafana/weft.json` and a few alert rules (error rate, queue
drops, fsync p99 > 100 ms, rooms_open spikes).

### Traces (OpenTelemetry)

`tracing` is already used. Add `tracing-opentelemetry` + `opentelemetry-otlp` behind feature
`otel`, enabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Spans: `ws.session{doc, conn}`
(long-lived; record events, not child spans per message, to avoid trace explosion), `room.load`,
`room.compact`, `store.append`, HTTP requests via `tower-http::TraceLayer`, and REST/MCP tool
calls (`mcp.tool{name}`). Sample per-message work at a low ratio.

### Structured logs

`tracing-subscriber` with `json` feature: `WEFT_LOG_FORMAT=json|pretty` (json default in Docker,
pretty on TTY). Fields: `doc`, `conn`, `client_id`, `remote_addr` (optionally hashed),
`event`. Log lifecycle (join/leave/load/unload/compact/error), never document contents.

### Backups

The storage model is simple, so backups are too:

- **Snapshot command**: `weft-server backup --out s3://bucket/weft/2026-10-25T00.tar.zst` (or a
  local path): for each doc, take the room lock (or read a compacted log), write
  `encode_full()` records into a tarball + manifest (`doc_id`, state vector, sha256). Consistent
  per-doc, no downtime. `object_store` crate gives S3/GCS/Azure/local with one API.
- **Continuous**: optional background task streams appended log records to object storage every
  N seconds (Litestream-style, per-doc segment files); restore = download segments + replay
  (the log reader already tolerates torn tails).
- **Restore**: `weft-server restore <archive> [--doc id]`, refuses to overwrite newer local
  data without `--force`. Because updates are CRDT ops, restoring an old snapshot into a live doc
  can also be a **merge** (`apply_update`) rather than an overwrite: lost ops come back, nothing
  current is lost.
- **Platform**: Fly volume snapshots are daily by default; document them as a second layer and
  test a restore from one. Scheduled `backup` via Fly machine schedule or a cron sidecar.
- **Verification**: `weft-server verify` replays every log and checks CRCs + decode; run in CI
  against restored backups (a backup you haven't restored isn't a backup).

### Plan

- [ ] **P1 (S)**: JSON logs + `RUST_LOG`/`WEFT_LOG_FORMAT`; request logging via `TraceLayer`
- [ ] **P1 (S)**: Prometheus exporter on a separate port + core metrics above
- [ ] **P2 (S)**: `otel` feature with OTLP exporter; spans for session/room/store
- [ ] **P2 (M)**: `backup` / `restore` / `verify` subcommands, `object_store` S3 support
- [ ] **P3 (M)**: continuous log shipping; restore-as-merge
- [ ] **P3 (S)**: Grafana dashboard + alert rules; docs for Fly snapshots + scheduled backups
- **Effort: M**

---

## 9. Sequencing, effort, risks

### Recommended order

```
            ┌─► 1. CLI P1/P2 ─► 4a. git sync ─► 4b/4c. plugins
0. weft-client ─┼─► 6. MCP (stdio) ───────────────► 6. MCP (HTTP, needs auth)
            └─► 2. Tauri desktop ─► 3. Tauri mobile
7. Deploy + 8. Observability (independent; do in parallel, first week)
5. REST/webhooks (needs text_diff from 0; auth from the auth track)
3. PWA polish (independent; any time)
```

1. **Week 1**: Deploy (§7 P1–P2) + logs/metrics (§8 P1). Unblocks real users and dogfooding.
2. **Weeks 1–2**: `weft-client` + `text_diff` (§0), then CLI P1 (`cat/watch/write/append`).
3. **Weeks 2–3**: **MCP stdio P1–P2**: highest "wow" per day of effort; demos the CRDT story.
4. **Weeks 3–5**: `fork_at` + git sync; REST API; `@weft/client` + Obsidian plugin.
5. **Weeks 5–9**: TUI editor; Tauri desktop (A then B); PWA polish.
6. **Later**: Tauri mobile, hosted MCP with OAuth, continuous backups, VS Code.

### Effort summary

| Item | Effort | Depends on |
|---|---|---|
| 0. weft-client + text_diff + shared store | M | — |
| 1. CLI (cat/watch/write/append/external edit) | M | 0 |
| 1. ratatui TUI editor | L | 0 |
| 2. Tauri desktop (A → B + vault) | L | 0, DocEngine refactor |
| 3. PWA polish | M | — |
| 3. Tauri mobile | L | 2 |
| 4a. Git sync | M+M | 0, `Doc::fork_at` |
| 4b. Obsidian plugin | M | `@weft/client` package |
| 4c. VS Code (+ `weft bridge`) | M | 1 |
| 5. REST + webhooks | M | 0 (text_diff), auth track |
| 6. MCP stdio | M | 0 |
| 6. MCP HTTP + auth + undo-by-agent | L | 5, auth, attribution |
| 7. Deploy (embed, Docker, Fly, CI) | S–M | — |
| 8. Observability + backups | M | — |

### Contract additions (log them in ARCHITECTURE.md when implemented)

- `weft_core::Doc::fork_at(&StateVector) -> Doc` (git/REST three-way merges).
- `weft_core::text_diff` module (pure).
- Shared store crate (move of `DocStore`, format unchanged).
- Web: `DocEngine` interface; `collab.ts` targets it (no wire change).
- Server: `/api/v1/*`, `/mcp`, `/metrics` (separate port), `embed-web` feature. Wire protocol
  unchanged throughout this track; `PROTOCOL_VERSION` stays 1.

### Risks

- **Auth is a prerequisite** for REST writes, webhooks, and hosted MCP. Ship those behind an
  admin env token until the auth/sharing track lands; never expose write APIs unauthenticated.
- **Diff quality**: naive full-text replace would destroy concurrent edits. All "whole text in"
  paths must go through `text_diff` + three-way base. Property-test it.
- **AI edit trust**: agents editing shared docs live need visible presence, attribution, and
  one-click undo, or teams won't allow it. Treat attribution as a P3 must-have for MCP.
- **Single-node**: Fly/k8s deploys must pin 1 replica until multi-node exists; document loudly.
- **Native signing/stores** (desktop/mobile) are slow, bureaucratic, and cost money; schedule
  them early in their phase.
- **Ratatui editor scope creep**: keep it a focused Markdown editor; `--external` mode covers
  power users who want their own editor.

### References

- rmcp (official Rust MCP SDK; `server`, `macros`, `transport-streamable-http-server` features):
  https://docs.rs/crate/rmcp/3.0.1/source/README.md
- Tauri 2.0 stable (iOS/Android templates, Swift/Kotlin plugins): https://v2.tauri.app/blog/tauri-20/
- Tauri plugins (fs, dialog, deep-link, updater, …): https://v2.tauri.app/plugin/
