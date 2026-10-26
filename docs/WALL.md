# Weft Wall: private, saved notes with accounts

> Open the site on your phone, sign in once, tap **+**, type. Every note is saved to the server's database,
> syncs live across your devices, works offline, and is private to you. You're the admin and can create accounts
> for other people.

Inspired by [Tephra](https://github.com/championswimmer/tephra): one person on one box, a bootstrap token for the
first admin, private by default, scoped tokens, and sanitized Markdown.

## What the user sees

- **`/` (signed in): the Wall.**
  - A masonry grid of note cards, each showing a title, a preview, its color and when it was last edited. Pinned notes come first.
  - A big "Take a note…" composer at the top (a floating **+** on phones). Tap it and start typing; the note is created instantly.
  - A search box (full text) and filters: All / Pinned / Archived.
  - Card actions: pin, color, archive, delete (with undo). Tap a card to open the full editor at `/n/<id>`.
  - The Wall loads instantly from a local cache and works offline, using the cached list plus the notes stored in IndexedDB.
- **`/` (signed out): the sign-in page.** If `WEFT_ANONYMOUS_DOCS=true`, there's also a quiet "Start a temporary doc" link
  that opens the existing anonymous `/d/<slug>` flow.
- **`/setup`: first run only.** It appears only while no users exist. You enter the bootstrap token from the server's env plus
  your admin username and password.
- **`/admin` (admins only).** Lists users. You can create a user (username + initial password), reset a password,
  disable or enable a user, make someone an admin, or delete a user.
- **Account menu** (the avatar on the Wall): change password, sign out, Admin (if you're an admin).
- **On an anonymous `/d/<slug>` doc while signed in:** a **Save to my wall** button copies the doc into a new private note.

## Security model

- **Passwords:** hashed with Argon2id (OWASP params: m=19 MiB, t=2, p=1), minimum 10 characters, max 256. Hashing runs on `spawn_blocking`.
- **Sessions:** a random 256-bit token sent as cookie `weft_session` with `HttpOnly; Secure; SameSite=Lax; Path=/`, and a 30-day sliding expiry.
  Only `SHA-256(token)` is stored in the DB. Logout and password changes revoke sessions.
- **CSRF:** every state-changing `/api` request must be `Content-Type: application/json` and pass the same Origin check as the
  WebSocket (Origin host == Host, or listed in `WEFT_ALLOWED_ORIGINS`). SameSite=Lax adds a second layer.
- **Login throttling:** at most 5 failed logins/min per IP and 10 per username per 15 min, then `429` with Retry-After.
  The response is the same whether or not the username exists, and hashing time is constant (a dummy hash for unknown users).
- **Private notes** use a separate namespace from anonymous docs:
  - Note logs live in `$WEFT_DATA_DIR/notes/`, anonymous docs in `$WEFT_DATA_DIR/docs/`.
  - Notes sync over `/ws/n/:id`, which **requires** a valid session belonging to the owner (or, later, a share).
  - Anonymous docs stay on `/ws/:id` and never see notes. There is no path from one to the other.
- **Bootstrap:** `WEFT_BOOTSTRAP_TOKEN` (min 32 chars) is set in a root-only env file. `/api/auth/setup` works only while the
  users table is empty, and compares tokens in constant time.
- **Anonymous docs:** `WEFT_ANONYMOUS_DOCS` (default `true` for backward compatibility). A personal instance can turn it off
  to close the "anyone can create docs on my server" abuse vector.

## Storage

SQLite at `$WEFT_DATA_DIR/weft.db` (rusqlite, bundled, WAL mode, `PRAGMA user_version` migrations):

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','user')), disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE sessions (
  token_hash BLOB PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, user_agent TEXT);
CREATE TABLE notes (
  id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'default',
  pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, body);  -- full-text search
```

The note **content** stays in the CRDT log (`notes/<id>.log`, the same DocStore as today), which keeps live sync, offline use and history.
When a note room persists, the server refreshes `title` (the first heading or first line, max 120 chars), `preview` (the first ~280 chars),
`updated_at` and `notes_fts`, debounced to at most once every 2 s per note, plus once when the room unloads.

Timestamps are unix milliseconds. Note ids match `^[1-9A-HJ-NP-Za-km-z]{16}$` (base58). The **client generates** the id, so a
note can be created offline. The server rejects ids that are already taken.

## HTTP API (JSON)

Errors are `{ "error": "message" }` with a proper status code. `401` = not signed in, `403` = not allowed.

| Method & path | Body | Response |
|---|---|---|
| `GET /api/auth/status` | | `{ setup_required, anonymous_docs, user: User \| null }` |
| `POST /api/auth/setup` | `{ token, username, password }` | `200 { user }` + cookie · `403` if users exist or bad token |
| `POST /api/auth/login` | `{ username, password }` | `200 { user }` + cookie · `401` · `429` |
| `POST /api/auth/logout` | | `204`, clears the cookie, deletes the session |
| `POST /api/me/password` | `{ current, new }` | `204` (revokes other sessions) |
| `GET /api/notes?filter=all\|pinned\|archived&q=` | | `Note[]` (pinned first, then `updated_at` desc). `q` uses FTS5 |
| `POST /api/notes` | `{ id, text?, from_doc? }` | `201 Note`. `text` seeds the content. `from_doc` copies an anonymous doc |
| `PATCH /api/notes/:id` | `{ pinned?, color?, archived? }` | `200 Note` |
| `DELETE /api/notes/:id` | | `204` (deletes the metadata and the log) |
| `GET /api/notes/:id/export.md` | | the note's text (owner only) |
| `GET /api/admin/users` | | `AdminUser[]` |
| `POST /api/admin/users` | `{ username, password, role }` | `201 AdminUser` |
| `PATCH /api/admin/users/:id` | `{ password?, role?, disabled? }` | `200 AdminUser`. You can't demote or disable yourself as the last admin |
| `DELETE /api/admin/users/:id` | | `204` (deletes their notes; you can't delete yourself) |

```ts
type User = { id: number; username: string; role: 'admin' | 'user' };
type AdminUser = User & { disabled: boolean; created_at: number; note_count: number };
type Note = { id: string; title: string; preview: string; color: NoteColor; pinned: boolean; archived: boolean;
              created_at: number; updated_at: number };
type NoteColor = 'default'|'red'|'orange'|'yellow'|'green'|'teal'|'blue'|'purple'|'pink'|'gray';
```

Usernames match `^[a-zA-Z0-9_.-]{3,32}$`.

## WebSocket

- `/ws/n/:id`: a private note. It requires the session cookie, and the session's user must own the note (`403` otherwise).
  It uses the same sync protocol as `/ws/:id`. Disabling a user or revoking their session closes their open sockets.
- `/ws/:id`: anonymous docs (only if `WEFT_ANONYMOUS_DOCS=true`). Unchanged.

## Client (web)

- **Routes:** `/` (Wall or sign-in), `/setup`, `/admin`, `/n/:id` (the private note editor), `/d/:slug` (anonymous, unchanged).
- **Sessions:** `openSession(docId, { kind: 'note' })` connects to `/ws/n/:id`, and its IndexedDB keys are namespaced (`note:<id>`).
- **Creating a note:** generate a base58 id, write it to the local Wall cache immediately, `POST /api/notes`, and navigate to `/n/:id`.
  If the POST fails offline, queue it and retry when back online before opening the socket.
- **Wall cache:** `localStorage["weft:wall:<userId>"]` holds the last `Note[]`, so the Wall paints instantly and works offline.
- **Phone-first:** the composer focuses on tap and the Wall uses a 2-column grid on phones. The PWA manifest gets `"start_url": "/"`
  and the app is installable from Add to Home Screen.

## Phases

- [x] **W1 Backend**: SQLite + migrations, users/sessions/auth, admin API, notes API + FTS, `/ws/n/:id` gating, login throttling
- [x] **W2 Frontend**: sign-in/setup pages, Wall grid + composer + search + filters + card actions, note editor route, admin page, account menu, offline cache
- [ ] **W3 Deploy**: EnvironmentFile with the bootstrap token, `WEFT_ANONYMOUS_DOCS` decision, first-admin setup, backups include `weft.db` (use `sqlite3 .backup`, not tar of a live WAL)
- [x] **W4 Security review**: an independent pass over the auth/session/CSRF/IDOR code paths (see `docs/SECURITY-REVIEW-W4.md`)

## Next ideas (Tephra-inspired and beyond)

- **Quick capture:** personal API tokens (scoped and revocable, like Tephra's vault tokens), so an iOS Shortcut or Android share sheet can
  append to a note: `POST /api/notes/:id/append`. Also a PWA `share_target`, so "Share → Weft" creates a note.
- **`[[Wikilinks]]` and backlinks** between notes, with a backlinks panel under the editor; later a graph view.
- **`#tags`** parsed from the text, as filter chips on the Wall.
- **Sharing:** share a note with another user (view/edit), or publish a read-only public page (`/p/<id>`) with sanitized Markdown.
- **Daily note** (`⌘⇧D` → today's note), templates, reminders.
- **Images and attachments:** a content-addressed blob store (SHA-256 verified, as in Tephra) with paste-to-upload.
- **Obsidian sync:** two-way sync of a folder of `.md` files (see roadmap track 5, Git/Obsidian sync).
- **Passkeys (WebAuthn)** as a second sign-in method, and TOTP 2FA for the admin.
