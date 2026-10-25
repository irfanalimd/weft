# Track 3: Editor & Collaboration Features

> Weft v1 already has: a FugueMax text CRDT in WASM, stable `Anchor`s, `text_at(version)`, a
> CRDT-aware `UndoManager`, live cursors via `Awareness`, a `⌘K` palette (`web/src/ui/palette.ts`,
> `commands.ts`), the history scrubber (`history.ts`), focus mode, presence (`presence.ts`), share,
> export, and an offline PWA. This track turns that into a writing tool people *choose* over
> Google Docs or HackMD for small-team Markdown work.

The guiding idea: **every feature is data in the CRDT, so it inherits offline, sync, convergence,
and time travel for free.** No side database, no "comments service". A comment written on a train
merges on reconnect like any keystroke.

---

## 0. Ranking (usefulness x wow)

| Rank | Feature | Usefulness | Wow | Effort | Depends on |
|---|---|---|---|---|---|
| 0 | **Foundation: LWW map CRDT in `weft-core`** | enabler | - | M (4-6 d) | - |
| 1 | **Author attribution highlighting** | high | high | S (2-3 d) | 0 (names) |
| 2 | **AI co-writer as a CRDT peer (Claude)** | high | very high | L (8-12 d) | 0, nicer with 5 |
| 3 | **Comments & threads on `Anchor` ranges** | very high | medium | M (5-7 d) | 0 |
| 4 | **Named versions + CRDT-native diff** | high | high | M (4-6 d) | 0 |
| 5 | **Suggestion / track-changes mode** | high | high | L (8-10 d) | 0, 3 |
| 6 | **Slash commands, tables, Mermaid/KaTeX** | high | medium | M (5-7 d) | - |
| 7 | **Image paste + blob storage** | high | low | M (3-5 d) | - |
| 8 | **Follow mode** | medium | high | S (1-2 d) | - |
| 9 | **Mentions & notifications** | medium | low | M (3-5 d) | 0, 3 |
| 10 | **Templates** | medium | low | S (1-2 d) | 6 nice |
| 11 | **Folders / workspaces** | medium | low | M (4-6 d) | 0 |
| 12 | **Voice huddle** | low-medium | high | L (6-10 d) | - |

Suggested order: **0 → 1 → 3 → 2 → 4 → 8 → 6 → 5 → 7 → 9 → 10 → 11 → 12.** Attribution is the
cheapest demo win (the data is already there). Comments are the most-requested collaboration
feature. The AI peer is the headline demo. Follow mode is a 1-day wow that lines up with the AI
demo ("follow Claude while it writes").

### Prior art (brief)

- **Google Docs**: comments anchored to ranges, "Suggesting" mode, named versions, @-mentions that
  assign action items. The model to beat for suggestions UX.
- **Notion**: slash commands, block templates, inline comments, Notion AI (summarize, action items).
- **HackMD / HedgeDoc**: Markdown + Mermaid/KaTeX + paste-image-to-upload. Closest to Weft's
  audience. Its comments are weak, which is an opening.
- **Obsidian**: templates, folders, local-first files. Collaboration is a plugin afterthought.
- **Zed**: follow mode ("follow a collaborator's viewport"), channels with voice, and an AI
  assistant that edits buffers inline. Zed is the clearest precedent for "AI as a collaborator in
  a CRDT buffer".
- **Peritext** (Ink & Switch): a rich-text CRDT that stores formatting/comment spans as marks
  anchored to op IDs with explicit "expand" behavior at boundaries. We borrow its anchor semantics
  (start/end with left/right stickiness) for comments and suggestions, without adopting full rich
  text (Markdown stays plain text).
- **Yjs `Y.Map` / Automerge maps / Loro `LoroMap`**: LWW maps alongside sequences in one doc and
  one version vector. That's exactly the foundation below.

---

## 1. Foundation: a second CRDT type (LWW map) in `weft-core`

Comments, suggestions, version names, the client→name map, doc title, folders, and AI job state are
all **small keyed metadata**. Last-writer-wins per key is the right semantics for them. A sequence
CRDT is the wrong tool.

### Data model

```rust
// crates/weft-core/src/map.rs (new, additive to the frozen API)
pub enum Value { Null /* tombstone */, Bool(bool), Int(i64), Str(String), Bytes(Vec<u8>) }

/// One map write. Shares the client's clock space with text ops, so ONE StateVector
/// covers text + metadata: delta sync, pending-queue causality and time travel all just work.
struct MapOp { id: Id, lamport: u64, key: String, value: Value }

pub struct Map { entries: BTreeMap<String, (u64 /*lamport*/, ClientId, Value)> }
```

- **Conflict rule**: highest `(lamport, client)` wins. Lamport = `max(seen)+1` on local write.
- **Keys are paths**, for prefix scans: `meta/title`, `clients/<cid>`, `comments/<tid>`,
  `comments/<tid>/m/<mid>`, `sugg/<sid>`, `versions/<vid>`, `ai/jobs/<jid>`.
- **Values** are encoded bytes (a tiny tagged LEB128 format, consistent with core's "no serde"
  rule). The TS side stores JSON strings in `Str` for convenience.
- **Encoding**: bump the `Update` version byte, add an op-kind tag (`0=insert, 1=delete, 2=map_set`).
  Old clients reject the new version byte cleanly with `SyncError::Version`, which is the existing
  contract.
- **Time travel**: `map_at(&StateVector)` replays map ops whose `id` is in the vector. The history
  scrubber can then show comments appearing and resolving over time.

### API (additive)

```rust
impl Doc {
    pub fn map_set(&mut self, key: &str, value: Value) -> Update;
    pub fn map_delete(&mut self, key: &str) -> Update;          // writes Value::Null
    pub fn map_get(&self, key: &str) -> Option<&Value>;
    pub fn map_scan(&self, prefix: &str) -> impl Iterator<Item = (&str, &Value)>;
    pub fn map_at(&self, version: &StateVector) -> Map;
}
// apply_update additionally reports map changes:
pub enum Change { Insert{..}, Delete{..}, MapSet { key: String } }   // additive variant
```

> `Change` is frozen; adding a variant is a contract change. Log it in ARCHITECTURE.md's change
> log. The alternative is a separate `apply_update_ex` returning `(Vec<Change>, Vec<String>)`.

### WASM / TS

```ts
// weft-wasm: client.map_set(key, json) -> frames; client.map_scan(prefix) -> [key, json][]
// web/src/sync/meta.ts
export class MetaStore {
  constructor(private s: DocSession) {}
  get<T>(k: string): T | undefined { const v = this.s.client.map_get(k); return v ? JSON.parse(v) : undefined; }
  set(k: string, v: unknown) { this.s.send(this.s.client.map_set(k, JSON.stringify(v))); }
  scan<T>(prefix: string): [string, T][] { return this.s.client.map_scan(prefix).map(([k, v]) => [k, JSON.parse(v)]); }
  onChange(prefix: string, cb: () => void) { /* fired from DocSession when MapSet keys match */ }
}
```

### Plan

- [ ] `map.rs` with LWW semantics, Lamport clock on `Doc`, encode/decode of `MapOp`
- [ ] Share the clock space with text ops; extend the pending queue (map ops depend only on the same client's prior clock)
- [ ] Property tests: convergence for random concurrent `map_set`s over N replicas with duplicates/reordering (reuse the existing harness)
- [ ] `map_at(version)` plus a time-travel invariant test
- [ ] `Update::merge` and server compaction handle map ops (last value per key wins; older ops can be dropped in snapshots)
- [ ] WASM bindings + `MetaStore` in TS
- [ ] Migrate the doc title (currently derived from the first heading) to an optional `meta/title` override

**Effort:** M, 4-6 days. **Risk:** encoding version bump; IndexedDB states from v1 need a one-shot
upgrade path (decode v1, re-encode v2).

---

## 2. Author attribution highlighting ("who wrote what")

**User value.** "Who wrote this paragraph?" comes up constantly in group projects and reviews.
Students and teachers especially want it. Nearly free for Weft, because **every item already carries
its `client` id**.

**UX.**
- `⌘K → Show authors` (or a toggle in the presence bar) tints text with each author's color at about 15% alpha.
- Hovering a span shows "Ali · 3 min ago". Clicking an avatar in the presence bar dims everyone
  else's text ("show only Ali's contributions").
- Gutter mode: a thin colored bar per line showing the majority author (git-blame style). Less noisy.
- A stats popover: "Ali 62% · Sam 30% · Claude 8%".
- Works inside the history scrubber: attribution at any past version.

**Data model.**
- Attribution comes from the item ids, so no new storage is needed for *who*.
- **Names**: `clients/<cid> = {name, color, kind: "human"|"ai", since}` in the LWW map. Each session
  writes its own entry on rename and first edit. This beats awareness, which disappears when the
  peer leaves.
- **Identity across sessions**: `ClientId` is per session. Add a persistent `authorId` (random, in
  localStorage) to the `clients/<cid>` value so one person's many sessions merge into one author.
- **When**: optional `clients/<cid>.firstSeen`. For per-op timestamps, add a coarse
  `ts/<cid>/<clock-bucket>` entry every N ops (about 1 per minute). That's cheap and gives
  "edited 3 min ago" without timestamps on every item.

**Implementation sketch.**

```rust
// weft-core: walk visible pieces, RLE by client
pub struct AuthorSpan { pub start: usize, pub len: usize, pub client: ClientId }
impl Doc {
    pub fn authors(&self) -> Vec<AuthorSpan>;                       // current text
    pub fn authors_at(&self, v: &StateVector) -> Vec<AuthorSpan>;   // time travel
}
```

```ts
// web/src/editor/attribution.ts
const setSpans = StateEffect.define<AuthorSpan[]>();
export const attribution = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);                     // cheap between recomputes
    for (const e of tr.effects) if (e.is(setSpans))
      deco = Decoration.set(e.value.map(s =>
        Decoration.mark({ class: `wa-${s.client}` }).range(s.start, s.start + s.len)), true);
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});
// Recompute from wasm on idle (requestIdleCallback, debounce ~300ms); inject per-client CSS vars.
```

**Plan.**
- [ ] `Doc::authors()` / `authors_at()` with tests (spans cover `text()` exactly)
- [ ] `clients/<cid>` entries written on session start and rename (`presence.ts`)
- [ ] `authorId` persistence plus grouping sessions by author
- [ ] CM6 decoration field, toggle command in `commands.ts`, hover tooltip
- [ ] Gutter mode and contribution % popover
- [ ] Attribution in the history scrubber view

**Effort:** S, 2-3 days after the foundation (about 1.5 d of it is UI). **Risk:** decoration cost on
100k-char docs. Mitigate by computing only for the visible range (`view.visibleRanges`).

---

## 3. AI co-writer: Claude as a CRDT peer

**User value + wow.** This is the headline demo. Claude joins the doc like a person: it gets an
avatar in the presence bar, a labelled cursor, and text that streams in character by character as
real CRDT ops. Humans keep typing elsewhere at the same time with no conflicts, because Claude is
just another replica. Everything it writes is attributed (feature 2), undoable by author ("reject
all of Claude's edits"), and visible in time travel.

**UX.**
- **Invoke**: `⌘K → Ask Claude…`, `/ai` slash command, or select text and press `⌘J`.
- **Actions**:
  - *Continue writing* at the cursor.
  - *Rewrite selection* (shorter / clearer / formal / fix grammar / custom prompt).
    Lands as a **suggestion** (feature 6) when that exists, otherwise as a direct edit.
  - *Summarize doc*: inserts a `> **Summary**` callout at the top, or posts it as a comment.
  - *Meeting notes → action items*: extracts `- [ ] @owner task (due)` checklist items into an
    `## Action items` section, with @-mentions resolving to `clients/` names (feature 9).
  - *Answer a comment*: mention `@claude` in a comment thread to get a threaded reply.
- **Presence**: "Claude" avatar with a sparkle badge and its own color. Its cursor moves to where
  it's writing. Follow mode (feature 8) lets you watch it.
- **Control**: a floating chip "Claude is writing… [Stop] [Undo]". Stop cancels the stream. Undo
  deletes exactly the items with Claude's client id from that job.

**Architecture.** Claude runs **server-side as a replica** (the API key never reaches the browser):

```
Browser ──(Message::AiRequest)──► weft-server Room ──► AiAgent task
                                                    │  own ClientId, own weft-core Doc replica
                                                    │  Anthropic Messages API, stream: true
                                                    ▼
   text_delta chunks → doc.insert(resolve_anchor(cursor), chunk) → Room broadcast as Update
   cursor moves      → Awareness { client_id: ai, payload: {name:"Claude", cursor: anchor} }
```

- The agent's insertion point is an **`Anchor`**, not an index. Humans editing above it shift its
  position, and `resolve_anchor` keeps it correct. After each chunk, the new anchor is "after the
  last unit I inserted", so a continuous stream stays one contiguous, non-interleaved run. This is
  the FugueMax property we already test.
- **Batching**: coalesce deltas every ~40-60 ms into one `Update` (fewer frames, still feels live).
- **Rewrite selection** = stream the replacement *after* the selection end anchor, then delete the
  original range in one op when the stream completes. With suggestion mode, both become a
  suggestion instead.
- **Structured edits** (action items, multi-location edits): use tool use with tools such as
  `insert_at(anchor_hint, text)`, `replace(quote, text)`, `add_comment(quote, body)`. Tool inputs
  quote text, never raw offsets. The server maps quotes to anchors by searching the *current* text,
  so model latency can't produce stale offsets.

**Model choice.**
| Action | Model | Why |
|---|---|---|
| Continue / autocomplete, fix grammar | `claude-haiku-5-5` | low latency, cheap, streams fast |
| Rewrite, summarize, action items | `claude-sonnet-5-5` | quality/speed default |
| Whole-doc restructure, long specs, "review this RFC" | `claude-opus-5-5` | hardest reasoning |

- **Prompt caching**: put the document text in a cached system block, so repeated actions on the
  same doc reuse the cache. The selection and instruction go in the uncached user turn.
- **Context**: send `text()` plus a marker for cursor/selection (e.g. `⟦CURSOR⟧`), the doc title,
  and the author list. Long docs: send the selection's section plus an outline of headings.

**Implementation sketch (Rust, `crates/weft-server/src/ai.rs`).**

```rust
pub struct AiJob { id: String, kind: AiKind, at: Anchor, end: Option<Anchor>, prompt: String, model: &'static str }

async fn run_job(room: RoomHandle, job: AiJob, http: reqwest::Client, key: &str) -> anyhow::Result<()> {
    let body = json!({
        "model": job.model, "max_tokens": 4096, "stream": true,
        "system": [{ "type": "text", "text": SYSTEM_PROMPT },
                   { "type": "text", "text": room.text().await, "cache_control": {"type": "ephemeral"} }],
        "messages": [{ "role": "user", "content": job.user_turn() }],
    });
    let mut es = http.post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key).header("anthropic-version", "2023-06-01")
        .json(&body).send().await?.bytes_stream().eventsource();  // eventsource-stream crate
    let mut anchor = job.at; let mut buf = String::new(); let mut tick = interval(Duration::from_millis(50));
    loop { select! {
        ev = es.next() => match ev {
            Some(Ok(e)) if e.event == "content_block_delta" => buf.push_str(delta_text(&e.data)?),
            Some(Ok(e)) if e.event == "message_stop" => break,
            Some(Err(e)) => return Err(e.into()), None => break, _ => {}
        },
        _ = tick.tick(), if !buf.is_empty() => { anchor = room.ai_insert(anchor, &std::mem::take(&mut buf)).await?; }
        _ = job.cancelled() => break,
    }}
    if !buf.is_empty() { room.ai_insert(anchor, &buf).await?; }
    room.map_set(&format!("ai/jobs/{}", job.id), done_value()).await;   // UI shows ✓
    Ok(())
}
// RoomHandle::ai_insert: pos = ai_doc.resolve_anchor(&anchor); update = ai_doc.insert(pos, chunk);
// broadcast(update); set awareness cursor; return ai_doc.anchor_at(pos + chunk.len_utf16()).
```

- **Protocol**: add `Message::AiRequest { job: Vec<u8> }` and `Message::AiCancel { id }` (additive
  to the frozen wire enum, so log it in the change log). Job state lives in `ai/jobs/<id>` so every
  peer, including offline-then-online ones, sees status.
- **UTF-16**: convert chunk lengths with `encode_utf16().count()`. Never split a surrogate pair
  across batch boundaries (hold back a trailing high surrogate).
- **Safety**: a per-doc rate limit, max tokens per job, `WEFT_ANTHROPIC_KEY` env (feature disabled
  when absent), and a visible "AI can see this doc" notice. **Conflict with E2EE (track 2):** an
  encrypted doc can't use the server agent. Offer a browser-side bring-your-own-key mode where the
  *tab* runs the agent loop as a second local `ClientId`, or disable AI for E2EE docs.

```ts
// web/src/ui/ai.ts
registerCommand({ id: "ai.rewrite", title: "Claude: Rewrite selection…", key: "Mod-j", run: async () => {
  const { from, to } = view.state.selection.main;
  const instr = await promptInput("How should Claude rewrite this?", "Make it clearer");
  session.send(client.ai_request(JSON.stringify({
    kind: "rewrite", at: client.anchor_at(from), end: client.anchor_at(to), prompt: instr })));
}});
// The streaming text arrives as normal remote Updates; nothing AI-specific is needed in collab.ts.
```

**Plan.**
- [ ] Phase A, *Continue writing*: `ai.rs` agent with its own replica in the room, SSE streaming, anchor-following inserts, 50 ms batching, presence + cursor, Stop
- [ ] Phase A: `clients/<ai-cid> = {name:"Claude", kind:"ai"}` so attribution shows AI text distinctly
- [ ] Phase A: deterministic test with a mock SSE server; a human edits concurrently above/at the AI anchor and all replicas converge
- [ ] Phase B, *Rewrite selection*, *Summarize*, *Action items* (tool use; quote→anchor mapping)
- [ ] Phase B: "Undo Claude's job" (delete items by `(ai client, clock range)` recorded in `ai/jobs/<id>`)
- [ ] Phase C: rewrites land as suggestions (needs feature 6); `@claude` in comment threads
- [ ] Phase C: model picker in settings, prompt caching, per-doc token budget, usage display
- [ ] Phase D: browser-side BYO-key mode for E2EE docs; inline ghost-text autocomplete with Haiku (opt-in)

**Effort:** L, 8-12 days (A: 4 d, B: 3 d, C/D: 4 d). **Risks:** cost/abuse on a public demo (rate
limits plus a server-side kill switch); model latency vs "instant" principle (always stream;
Haiku for the interactive paths); stale context (always quote→anchor, never trust offsets).

---

## 4. Comments & threads anchored to `Anchor` ranges

**User value.** Most collaborative review happens in comments. Today Weft users have to write
"(Sam: is this right?)" inline. Comments are the most-requested feature for any editor of this kind.

**UX.**
- Select text, press `⌘⌥M` or the floating "Comment" bubble, type, Enter. The range gets a soft
  yellow underline highlight.
- A right margin rail shows comment cards aligned to their anchors (wide screens). On narrow
  screens/phones, tapping a highlight opens a bottom sheet.
- Threads support replies, emoji reactions, resolve/reopen, and edit/delete-own. A filter shows
  open / resolved / mine. `⌘K → Next comment` (`]c`) jumps between threads.
- **Orphaned comments**: if the commented text is deleted, the card stays, collapsed to a
  zero-width marker at the deletion point and labelled "text was deleted", with the original quote.
- Comments appear in time travel, and in exports as optional Markdown footnotes.

**Data model (LWW map).**

```
comments/<tid>        = { start: Anchor, end: Anchor, quote: "orig text", author, ts, resolved: bool }
comments/<tid>/m/<mid>= { author, ts, body: "markdown", edited?: ts, deleted?: bool }
comments/<tid>/r/<emoji>/<authorId> = true
```

- One key per message, so concurrent replies never clobber each other (LWW is per key). Message
  order = `(ts, mid)`.
- **Anchor semantics (Peritext-style)**: `start = anchor_at(from)` with **right** stickiness (the
  comment starts at the first selected char, so typing just before it stays outside), and
  `end = anchor_at(to)` with **left** stickiness (`After(last selected char)`). Today's
  `Anchor::After(id)` is left-sticky, so add `Anchor::Before(id)` (additive variant) for the start.
- Resolution of tombstoned ids: `resolve_anchor` must return the position where the tombstone
  *would* be. That's what makes orphan detection work (`start >= end` means orphaned).

**Implementation sketch.**

```rust
pub enum Anchor { Start, End, After(Id), Before(Id) }   // additive variant; encode tag 3
impl Doc { pub fn anchor_before(&self, pos: usize) -> Anchor; }
```

```ts
// web/src/editor/comments.ts
const threads = StateField.define<DecorationSet>({ /* map through changes; rebuild on MapSet("comments/") */ });
function rebuild(meta: MetaStore, client: WeftClient) {
  return Decoration.set(meta.scan<Thread>("comments/").filter(([k]) => !k.includes("/m/"))
    .flatMap(([k, t]) => { const a = client.resolve_anchor(t.start), b = client.resolve_anchor(t.end);
      return a != null && b != null && a < b && !t.resolved
        ? [Decoration.mark({ class: "cm-comment", attributes: { "data-tid": k } }).range(a, b)] : []; }), true);
}
// web/src/ui/comments.ts: margin rail positioned with view.coordsAtPos(start); virtualized.
```

**Plan.**
- [ ] `Anchor::Before`, `anchor_before`, tombstone-aware `resolve_anchor` (with tests for orphaning)
- [ ] Data model + `MetaStore` helpers (`createThread`, `reply`, `resolve`, `react`)
- [ ] CM6 highlight field, selection bubble, `⌘⌥M` command
- [ ] Margin rail (desktop) and bottom sheet (mobile), next/prev comment navigation
- [ ] Orphan handling + "show original quote"
- [ ] Export as footnotes; comments in the history scrubber
- [ ] E2E: two tabs comment concurrently on overlapping ranges, both offline, then merge

**Effort:** M, 5-7 days. **Risk:** the margin layout is fiddly (overlap/stacking). Start with a simple
side panel list, then add the aligned rail.

---

## 5. Named versions / snapshots and diff view

**User value.** "Submitted draft", "Before Sam's rewrite", "v1.0 spec". Restoring and comparing these
is how people trust a shared doc. The scrubber shows *every* step but has no landmarks.

**UX.**
- `⌘K → Name this version…` → "Draft for review". It shows up as a labelled tick on the history
  scrubber and in a "Versions" list.
- Pick two versions, or one version vs now, to get the **diff view**: inline green insertions and
  red strikethrough deletions, **colored and labelled by author**, with a "3 insertions, 2 deletions
  by Sam" summary. Toggle unified/side-by-side.
- From a version: *Restore* (as new edits, already supported), *Copy as Markdown*, *Open read-only
  link* (`/d/xyz@v/<vid>`).
- Auto-versions (unnamed, collapsible): when a session ends after >N ops, or when someone returns
  after more than 1 hour away, so "what changed since I was last here?" becomes one click.

**Data model.** `versions/<vid> = { name, sv: <StateVector bytes>, author, ts, auto: bool }`.
A state vector fully identifies a version (deletes have ids), so a snapshot is just a few bytes.
**Server compaction must not GC history below a named version** (it currently keeps everything,
but track 4's history checkpoints must respect pinned versions).

**CRDT-native diff (the wow part).** Weft doesn't need a heuristic Myers diff. Every unit has an id
and every delete is an op with an id, so a unit's visibility at version V is exact:
`visible_at(V) = V.contains(item.id) && !deleted_by_op_in(V)`. A single walk over items gives an
exact, attributed, intention-preserving diff, even for moved-around concurrent edits, at O(items):

```rust
pub enum DiffKind { Same, Inserted, Deleted }
pub struct DiffSpan { pub kind: DiffKind, pub text: String, pub author: ClientId /* inserter or deleter */ }
impl Doc {
    pub fn diff(&self, from: &StateVector, to: &StateVector) -> Vec<DiffSpan>;
}
// Implementation: requires the deleter id per tombstone (store `deleted_by: Id` alongside the
// tombstone bit in seq.rs pieces, RLE-friendly since delete runs are contiguous).
```

```ts
// web/src/ui/diff.ts: render read-only CM6 view; spans -> Decoration.mark (ins) / widget (del)
const spans: DiffSpan[] = JSON.parse(client.diff(svA, svB));
```

**Plan.**
- [ ] `versions/` entries + "Name this version" command + scrubber ticks (`history.ts`)
- [ ] Track `deleted_by` per tombstone in `seq.rs` (memory check on the 260k-op trace bench)
- [ ] `Doc::diff(from, to)` with property tests: applying the diff to `text_at(from)` gives `text_at(to)`
- [ ] Diff view UI (inline, author-colored), summary counts, side-by-side toggle
- [ ] Read-only version links `/d/:id@v/:vid` and `GET /api/docs/:id/export.md?v=<vid>`
- [ ] Auto-versions + "Changes since your last visit" banner (store last-seen SV in IndexedDB)

**Effort:** M, 4-6 days. **Risk:** the memory for `deleted_by` (mitigate: RLE, or a side table keyed
by delete-op id ranges, which already exist as ops).

---

## 6. Suggestion / track-changes mode

**User value.** Reviewing someone's writing without trampling it. Teachers, editors, and spec
reviewers expect it, and it's also the safe landing zone for AI rewrites.

**UX.**
- A mode switch in the top bar: **Editing ▾ / Suggesting / Viewing** (`⌘⇧E`).
- In Suggesting, typed text appears green-underlined. Deleted text is not removed but shown red and
  struck through. A margin card per suggestion shows "Sam: replace 'quick' with 'fast'
  [✓ Accept] [✕ Reject]", plus a reply thread (reuses comments).
- "Accept all / Reject all", filter by author ("Accept all from Claude").
- Export and the `text()` used by `export.md` show the doc **without** pending suggestions by
  default ("Final"), or with them ("Markup").

**Data model.** Suggestions are **real CRDT ops plus metadata**, so they sync, merge, and work
offline like everything else:

```
sugg/<sid> = { author, ts, status: "open"|"accepted"|"rejected",
               ins: [[client, clockStart, len], ...],     // exact item id ranges inserted as suggestion
               del: [[startAnchor, endAnchor], ...],      // ranges proposed for deletion (NOT deleted yet)
               thread?: <tid> }
```

- **Insert suggestion**: a normal insert, with its id range recorded in `ins`. Rendering hides or
  marks it by id. That's exact and needs no anchors.
- **Delete suggestion**: no delete op. The range is recorded as anchors and rendered struck through.
- **Accept**: insertions are already in the text, so set status, then issue real deletes for the
  `del` ranges. **Reject**: delete the `ins` items (by id → position) and set status.
- Concurrent accept + reject on the same suggestion: LWW on `status`. The loser's ops are reverted by
  an idempotent reconciliation pass (each client re-derives the text effect from the winning
  status). Tested in the simulator.
- **"Final" text**: `Doc::text_filtered(|id| !pending_ins.contains(id))`, i.e. text minus open
  suggestion insertions, plus open deletions included (they were never deleted).

**Implementation sketch.**
```ts
// web/src/sync/collab.ts: in suggest mode, intercept local transactions
EditorState.transactionFilter.of(tr => {
  if (mode !== "suggest" || !tr.docChanged || tr.annotation(remote)) return tr;
  // deletions -> cancel the change, emit sugg del-range; insertions -> allow, record id range
  return rewriteAsSuggestion(tr);
});
```
```rust
impl Doc {
    pub fn ids_in_range(&self, pos: usize, len: usize) -> Vec<(ClientId, u64, u64)>; // for `ins`
    pub fn text_filtered(&self, hide: &dyn Fn(Id) -> bool) -> String;
    pub fn positions_of(&self, client: ClientId, clock: u64, len: u64) -> Vec<(usize, usize)>; // for reject
}
```

**Plan.**
- [ ] Core helpers: `ids_in_range`, `positions_of`, `text_filtered` (+ tests)
- [ ] `sugg/` data model; mode switch UI; transaction filter for suggest mode
- [ ] Rendering: insert marks by id set, delete strike-through widgets by anchors
- [ ] Accept/reject (single, all, by author) + reconciliation for concurrent decisions
- [ ] Integrate with comments (thread per suggestion) and AI (rewrites as suggestions)
- [ ] Export "Final" vs "Markup"; simulator tests for concurrent accept/reject/edit-inside-suggestion
- [ ] Edge cases: typing inside someone else's suggestion (joins it vs nested), suggesting over a pending delete

**Effort:** L, 8-10 days. **Risk:** highest semantic complexity in this track. Keep v1 narrow:
insert/delete suggestions only, no nested suggestions, and an edit inside another author's
suggestion becomes a separate suggestion.

---

## 7. Slash commands, tables, Mermaid / KaTeX

**User value.** Faster structure without memorizing Markdown, plus HackMD parity for engineers
(diagrams, math).

**UX.**
- **Slash menu**: `/` at the start of a line (or after a space) opens a fuzzy menu (reuse
  `fuzzy.ts`): Heading 1-3, Todo, Bullet, Numbered, Quote, Code block, Table, Mermaid diagram, Math
  block, Divider, Image, Date, Template…, **Ask Claude…**. Enter inserts Markdown and places the
  cursor sensibly. *Conflict*: VISION says `/` opens a fresh doc. Keep that only in the empty state
  (`emptyState.ts`); in the editor, `/` is the slash menu.
- **Tables**: `/table` inserts a 3x3 pipe table. While the cursor is inside it, Tab/Shift-Tab move
  between cells and Enter adds a row. Columns auto-align on blur, using a single replace change so
  it stays CRDT-friendly and only touches whitespace. A small toolbar handles add/remove row or
  column and alignment.
- **Mermaid / KaTeX**: fenced ```` ```mermaid ```` and `$$…$$` / `$…$` render as widgets when the cursor is
  outside the block. Click to edit the source. Render errors show inline in a muted style.
  Lazy-load both libraries (Mermaid is about 1 MB, so load only on first use, and the service worker
  caches it for offline).

**Data model.** None. It's all Markdown text, which keeps export and `curl` output honest.

**Implementation sketch.**
```ts
// web/src/editor/slash.ts
autocompletion({ override: [ctx => {
  const m = ctx.matchBefore(/(?:^|\s)\/\w*$/); if (!m) return null;
  return { from: m.from + m.text.indexOf("/"), options: SLASH_ITEMS.map(i => ({ label: i.label, detail: i.hint,
    apply: (view, _c, from, to) => i.apply(view, from, to) })) };
}]});
// web/src/editor/render.ts: ViewPlugin scanning syntaxTree for FencedCode(info=mermaid) / Math nodes,
// Decoration.replace({ widget: new MermaidWidget(src), block: true }) unless selection intersects.
```

**Plan.**
- [ ] Slash menu with core blocks + keyboard nav; resolve the `/` empty-state conflict
- [ ] Table editing helpers (Tab nav, add row, auto-align on blur)
- [ ] KaTeX inline/block widgets (lazy)
- [ ] Mermaid widgets (lazy, render in idle callback, cache by source hash)
- [ ] Export-as-HTML renders diagrams/math (`exportDoc.ts`)
- [ ] Precache libs in the PWA service worker after first use

**Effort:** M, 5-7 days. **Risk:** bundle size (keep the core bundle unchanged by using dynamic
`import()`), and widget/cursor jank with remote edits inside a diagram (re-render debounced).

---

## 8. Image paste + blob storage

**User value.** Screenshots in notes and bug reports. Without this, people leave for another tool.

**UX.** Paste or drop an image. A placeholder `![Uploading screenshot.png…]()` appears instantly
and is replaced by `![screenshot.png](/b/3f9a…c1.png)` when the upload finishes. Images render inline
below the line (CM6 widget). Offline: the image shows from a local blob and uploads on reconnect.

**Data model.** Content-addressed blobs: `sha256(bytes)` is the name, so dedup is free, retries
are idempotent, and the Markdown link is final **before** upload. That's what makes offline paste
work. No CRDT change.

**Implementation sketch.**
- Rust: `PUT /api/blobs/:sha256` (verify hash, size cap 10 MB, MIME sniff to images only, store
  under `data/blobs/ab/cd…`) and `GET /b/:sha256.:ext` with immutable cache headers.
- TS: paste handler hashes with `crypto.subtle.digest`, stores the blob in an IndexedDB `blobs`
  store, inserts the final link, and queues the upload. The service worker serves `/b/*` from
  IndexedDB when it's not uploaded yet.
- With E2EE (track 2): encrypt the blob client-side and put the key in the link fragment.

**Plan.**
- [ ] Server blob endpoints + size/MIME limits + per-IP rate limit
- [ ] Paste/drop handler, hashing, IndexedDB queue, upload on reconnect
- [ ] Inline image widget; resize via `![alt|300](…)` syntax (Obsidian-compatible)
- [ ] Export `.md` bundle as a zip with images (`exportDoc.ts`)
- [ ] GC of unreferenced blobs (scan docs at compaction)

**Effort:** M, 3-5 days.

---

## 9. Follow mode

**User value + wow.** "Follow me" in a meeting, or watch Claude write. One click on an avatar, and
your viewport tracks theirs. Zed and Figma made this beloved.

**UX.** Click an avatar → "Following Sam" banner, with Sam's color outlining the editor. Your view
scrolls with Sam's viewport and cursor. Any local scroll or keystroke stops following (Esc too).
Following yourself is a no-op. "Ask everyone to follow me" (presenter mode) sends a request toast.

**Data model.** Ephemeral, so it goes in the **awareness** payload, not the CRDT:
`{ ..., viewport: { top: Anchor, bottom: Anchor }, followRequest?: ts }`. Anchors (not pixels) so
different window sizes and fonts still line up.

**Implementation sketch.** In `presence.ts`, throttle (100 ms) publishing
`viewport = { top: anchor_at(view.viewport.from), bottom: anchor_at(view.viewport.to) }`. The follower:
`view.dispatch({ effects: EditorView.scrollIntoView(resolve(top), { y: "start" }) })` on each
awareness update, smoothed with `requestAnimationFrame`. Reuses the existing "click to jump to
cursor".

**Plan.**
- [ ] Publish viewport anchors in awareness
- [ ] Follow state + banner + stop-on-interaction
- [ ] Presenter mode ("everyone follow me" request)
- [ ] Follow Claude by default while an AI job runs (opt-in setting)

**Effort:** S, 1-2 days.

---

## 10. Mentions & notifications

**User value.** "@Sam can you check this?" without leaving the doc. Pairs with action items.

**UX.** Typing `@` in the editor or in a comment autocompletes names from `clients/` (deduped by
`authorId`). Mentions render as colored pills. With no accounts, notifications are local-first:
- **In-doc**: when you open a doc, a badge shows "2 mentions since your last visit", computed by
  scanning comments/text for your `authorId` with ops not in your last-seen state vector.
- **Cross-doc inbox** (`⌘K → Inbox`): the client checks recent docs (from `storage.ts`) in the
  background against the server, using a cheap `GET /api/docs/:id/sv` per doc.
- **Optional push**: Web Push subscription stored server-side per `authorId` for docs you've opted
  into. The server matches mentions when it integrates updates. That's the one place that needs
  server-side parsing, and it isn't available for E2EE docs.

**Data model.** Mention syntax in text: `@[Sam](weft:author/<authorId>)`, which degrades gracefully
in other Markdown viewers. Comment bodies use the same syntax. Read state stays local (IndexedDB).

**Plan.**
- [ ] `@` autocomplete (editor + comments) from `clients/`
- [ ] Mention pill rendering + "jump to mention"
- [ ] "Since your last visit" mentions badge
- [ ] Inbox across recent docs
- [ ] Web Push (opt-in; VAPID keys; disabled for E2EE)

**Effort:** M, 3-5 days (push adds 2 d).

---

## 11. Templates

**User value.** Meeting notes, RFC/spec, retro, lecture notes, and bug report in one keystroke.

**UX.** `⌘K → New from template…` or `/template`. A gallery shows built-ins plus "My templates".
Variables like `{{date}}`, `{{me}}`, `{{cursor}}` are filled on insert. "Save this doc as
template" and "Share template link" (`/new?t=<docId>` clones a doc's current text).

**Data model.** Built-ins are bundled Markdown. User templates are docs flagged with
`meta/template = true` (LWW map). Cloning copies `text()` into a fresh doc as new ops, not history,
so the clone doesn't inherit the template's authors.

**Plan.**
- [ ] 5 built-in templates + variable expansion
- [ ] Template gallery in palette; `/template` slash item
- [ ] Save-as-template + share-template link
- [ ] Meeting-notes template wired to "Claude: extract action items"

**Effort:** S, 1-2 days.

---

## 12. Doc folders / workspaces

**User value.** More than 20 docs need organizing. A class or team wants one shared space.

**UX.** A collapsible left sidebar (hidden in focus mode) shows a tree of folders and docs, with
drag to reorder/move. A workspace has its own link (`/w/<id>`) that you share once, and everyone
sees the same tree. "Recent" stays local.

**Data model.** A **workspace is itself a Weft doc** whose LWW map holds the tree, so it gets sync,
offline, and convergence for free:
```
nodes/<nodeId> = { kind: "folder"|"doc", name, parent: <nodeId>|null, order: "<fractional index>", docId? }
```
- Moves are LWW on `parent`. Cycles from concurrent moves (A into B while B into A) are resolved
  deterministically at read time: detect the cycle and reparent the node with the lowest
  `(lamport, id)` to the root (the Kleppmann move-op approach is a later upgrade).
- Ordering uses fractional indexing strings (no sequence CRDT needed for sibling order).

**Plan.**
- [ ] Workspace doc type (`meta/kind = "workspace"`) + `/w/:id` route (`router.ts`)
- [ ] Sidebar tree UI, create/rename/move/delete, drag & drop
- [ ] Cycle-safe read-time tree builder + simulator test for concurrent moves
- [ ] Full-text search across workspace docs (client-side, over cached docs)
- [ ] "Add to workspace" from share menu

**Effort:** M, 4-6 days.

---

## 13. Voice huddle

**User value + wow.** Talk while you write, without a separate Zoom link. It's the Zed channels /
Slack huddle feel. It's lower priority because most groups already have a call open.

**UX.** A headphone button in the presence bar starts a huddle. Speaking avatars get a pulsing ring,
with mute/deafen controls. Auto-follow the speaker (optional, uses feature 9). Up to 6 people.

**Data model.** Ephemeral only. `inHuddle`, `muted`, and `speaking` go in awareness. Signalling uses
a new `Message::Signal { to: ClientId, payload }` relayed by the room (additive to the wire enum).

**Implementation sketch.** WebRTC full mesh (`RTCPeerConnection` per peer, Opus audio only), with
SDP/ICE relayed over the existing WebSocket. Use public STUN plus optional TURN (`coturn`) config.
Beyond about 6 peers, use an SFU (LiveKit/mediasoup), which is out of scope here. Track 1's P2P
WebRTC data channels can share the signalling path.

**Plan.**
- [ ] `Message::Signal` relay in `weft-sync` Room (+ simulator test that it's not persisted)
- [ ] Mesh audio with mute/deafen; speaking detection via `AnalyserNode`
- [ ] Presence UI; follow-speaker option
- [ ] TURN config + docs; graceful failure behind strict NATs

**Effort:** L, 6-10 days (NAT traversal is the long tail).

---

## Cross-cutting concerns

- **Contract changes** (log each in ARCHITECTURE.md): new `Update` version byte + `MapSet` op;
  `Change::MapSet`; `Anchor::Before`; `Message::AiRequest/AiCancel/Signal`. All are additive except
  the encoding version bump.
- **Performance budget**: decorations (attribution, comments, suggestions) are computed for
  `view.visibleRanges` only and recomputed on idle. Keep the 260k-op trace bench within 10% after
  adding `deleted_by` and map ops.
- **Track 2 (E2EE) interaction**: server-side AI, push mentions, and blob GC need plaintext. Each
  needs a browser-side fallback or a clear "unavailable in encrypted docs" state.
- **Testing**: every metadata feature gets a deterministic-simulator convergence test (concurrent,
  offline, reordered) plus one Playwright E2E with two tabs.
- **Principles check**: "The document is the UI". Every panel (comments rail, versions, sidebar,
  diff) is hidden by default and reachable from `⌘K`.

## Milestones

- [ ] **M1, Foundation + quick wins (about 1.5 wk)**: LWW map, client name map, attribution, follow mode
- [ ] **M2, Review workflow (about 2 wk)**: comments & threads, named versions, CRDT-native diff
- [ ] **M3, Headline AI (about 2 wk)**: Claude peer (continue, rewrite, summarize, action items), follow Claude
- [ ] **M4, Authoring power (about 2 wk)**: slash commands, tables, Mermaid/KaTeX, image paste, templates
- [ ] **M5, Suggestions (about 2 wk)**: suggestion mode, AI rewrites as suggestions
- [ ] **M6, Organization & social (about 2-3 wk)**: mentions/inbox, workspaces, voice huddle
