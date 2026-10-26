//! SQLite metadata store (`$WEFT_DATA_DIR/weft.db`): users, sessions, note metadata and the
//! full-text index. Note *content* lives in the CRDT logs (`notes/<id>.log`), not here.
//!
//! One `Mutex<Connection>` with short queries; fine for a personal server. Migrations are
//! numbered by `PRAGMA user_version`.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

pub use rusqlite::Error as DbError;
pub type DbResult<T> = Result<T, DbError>;

/// Ordered migrations; `user_version` = number applied.
const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','user')), disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE sessions (
  token_hash BLOB PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, user_agent TEXT);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);
CREATE TABLE notes (
  id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'default',
  pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX notes_owner ON notes(owner_id, pinned, updated_at);
-- rowid of a notes_fts row == rowid of its notes row.
CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, body);
"#];

pub const NOTE_COLORS: &[&str] = &[
    "default", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "gray",
];

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub role: String,
}

impl User {
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct AdminUserRow {
    pub id: i64,
    pub username: String,
    pub role: String,
    pub disabled: bool,
    pub created_at: i64,
    pub note_count: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub color: String,
    pub pinned: bool,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A user row with its password hash (login only).
pub struct Credentials {
    pub user: User,
    pub password_hash: String,
    pub disabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoteFilter {
    All,
    Pinned,
    Archived,
}

pub struct Db {
    conn: Mutex<Connection>,
}

const NOTE_COLS: &str =
    "n.id, n.title, n.preview, n.color, n.pinned, n.archived, n.created_at, n.updated_at";

fn note_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        title: r.get(1)?,
        preview: r.get(2)?,
        color: r.get(3)?,
        pinned: r.get(4)?,
        archived: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

const ADMIN_COLS: &str = "u.id, u.username, u.role, u.disabled, u.created_at, \
     (SELECT COUNT(*) FROM notes WHERE owner_id = u.id)";

fn admin_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AdminUserRow> {
    Ok(AdminUserRow {
        id: r.get(0)?,
        username: r.get(1)?,
        role: r.get(2)?,
        disabled: r.get(3)?,
        created_at: r.get(4)?,
        note_count: r.get(5)?,
    })
}

/// Turns user input into a safe FTS5 query: each whitespace-separated term becomes a quoted
/// prefix query (`"term"*`), ANDed. Returns `None` if nothing searchable remains.
pub fn fts_query(q: &str) -> Option<String> {
    let terms: Vec<String> = q
        .split_whitespace()
        .map(|t| t.replace('"', ""))
        .filter(|t| !t.is_empty())
        .take(16)
        .map(|t| format!("\"{t}\"*"))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

impl Db {
    pub fn open(path: &Path) -> DbResult<Db> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", true)?;
        let db = Db {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn migrate(&self) -> DbResult<()> {
        let mut conn = self.lock();
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version.max(0) as usize) {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", (i + 1) as i64)?;
            tx.commit()?;
            tracing::info!(version = i + 1, "database migrated");
        }
        Ok(())
    }

    // ---- users ----

    pub fn user_count(&self) -> DbResult<i64> {
        self.lock()
            .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
    }

    /// Creates the first admin, only if there are no users yet (atomic under the lock).
    /// `Ok(None)` if users already exist.
    pub fn create_first_admin(&self, username: &str, hash: &str) -> DbResult<Option<User>> {
        let conn = self.lock();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
        if n > 0 {
            return Ok(None);
        }
        Self::insert_user(&conn, username, hash, "admin").map(Some)
    }

    fn insert_user(conn: &Connection, username: &str, hash: &str, role: &str) -> DbResult<User> {
        let now = now_ms();
        conn.execute(
            "INSERT INTO users (username, password_hash, role, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![username, hash, role, now],
        )?;
        Ok(User {
            id: conn.last_insert_rowid(),
            username: username.to_string(),
            role: role.to_string(),
        })
    }

    /// `Ok(None)` if the username is taken.
    pub fn create_user(&self, username: &str, hash: &str, role: &str) -> DbResult<Option<i64>> {
        let conn = self.lock();
        match Self::insert_user(&conn, username, hash, role) {
            Ok(u) => Ok(Some(u.id)),
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }

    pub fn credentials(&self, username: &str) -> DbResult<Option<Credentials>> {
        self.lock()
            .query_row(
                "SELECT id, username, role, password_hash, disabled FROM users WHERE username = ?1",
                [username],
                |r| {
                    Ok(Credentials {
                        user: User {
                            id: r.get(0)?,
                            username: r.get(1)?,
                            role: r.get(2)?,
                        },
                        password_hash: r.get(3)?,
                        disabled: r.get(4)?,
                    })
                },
            )
            .optional()
    }

    pub fn password_hash(&self, user_id: i64) -> DbResult<Option<String>> {
        self.lock()
            .query_row(
                "SELECT password_hash FROM users WHERE id = ?1",
                [user_id],
                |r| r.get(0),
            )
            .optional()
    }

    pub fn set_password(&self, user_id: i64, hash: &str) -> DbResult<()> {
        self.lock().execute(
            "UPDATE users SET password_hash = ?2, updated_at = ?3 WHERE id = ?1",
            params![user_id, hash, now_ms()],
        )?;
        Ok(())
    }

    pub fn list_users(&self) -> DbResult<Vec<AdminUserRow>> {
        let conn = self.lock();
        let mut st = conn.prepare(&format!("SELECT {ADMIN_COLS} FROM users u ORDER BY u.id"))?;
        st.query_map([], admin_row)?.collect()
    }

    pub fn admin_user(&self, id: i64) -> DbResult<Option<AdminUserRow>> {
        self.lock()
            .query_row(
                &format!("SELECT {ADMIN_COLS} FROM users u WHERE u.id = ?1"),
                [id],
                admin_row,
            )
            .optional()
    }

    /// Enabled admins other than `except`.
    pub fn other_active_admins(&self, except: i64) -> DbResult<i64> {
        self.lock().query_row(
            "SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?1",
            [except],
            |r| r.get(0),
        )
    }

    pub fn update_user(&self, id: i64, role: Option<&str>, disabled: Option<bool>) -> DbResult<()> {
        let conn = self.lock();
        let now = now_ms();
        if let Some(role) = role {
            conn.execute(
                "UPDATE users SET role = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, role, now],
            )?;
        }
        if let Some(d) = disabled {
            conn.execute(
                "UPDATE users SET disabled = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, d, now],
            )?;
        }
        Ok(())
    }

    /// Deletes a user (sessions and notes cascade) and returns the ids of their notes.
    pub fn delete_user(&self, id: i64) -> DbResult<Vec<String>> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let ids: Vec<String> = {
            let mut st = tx.prepare("SELECT id FROM notes WHERE owner_id = ?1")?;
            st.query_map([id], |r| r.get(0))?.collect::<DbResult<_>>()?
        };
        tx.execute(
            "DELETE FROM notes_fts WHERE rowid IN (SELECT rowid FROM notes WHERE owner_id = ?1)",
            [id],
        )?;
        tx.execute("DELETE FROM users WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(ids)
    }

    // ---- sessions ----

    pub fn create_session(
        &self,
        token_hash: &[u8; 32],
        user_id: i64,
        expires_at: i64,
        user_agent: Option<&str>,
    ) -> DbResult<()> {
        self.lock().execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![&token_hash[..], user_id, now_ms(), expires_at, user_agent],
        )?;
        Ok(())
    }

    /// The (enabled) user and expiry of an unexpired session.
    pub fn session_user(&self, token_hash: &[u8; 32]) -> DbResult<Option<(User, i64)>> {
        self.lock()
            .query_row(
                "SELECT u.id, u.username, u.role, s.expires_at FROM sessions s \
                 JOIN users u ON u.id = s.user_id \
                 WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.disabled = 0",
                params![&token_hash[..], now_ms()],
                |r| {
                    Ok((
                        User {
                            id: r.get(0)?,
                            username: r.get(1)?,
                            role: r.get(2)?,
                        },
                        r.get(3)?,
                    ))
                },
            )
            .optional()
    }

    pub fn extend_session(&self, token_hash: &[u8; 32], expires_at: i64) -> DbResult<()> {
        self.lock().execute(
            "UPDATE sessions SET expires_at = ?2 WHERE token_hash = ?1",
            params![&token_hash[..], expires_at],
        )?;
        Ok(())
    }

    pub fn delete_session(&self, token_hash: &[u8; 32]) -> DbResult<()> {
        self.lock().execute(
            "DELETE FROM sessions WHERE token_hash = ?1",
            [&token_hash[..]],
        )?;
        Ok(())
    }

    /// Deletes all of a user's sessions except `keep`.
    pub fn delete_user_sessions(&self, user_id: i64, keep: Option<&[u8; 32]>) -> DbResult<()> {
        let keep: &[u8] = keep.map(|k| &k[..]).unwrap_or(&[]);
        self.lock().execute(
            "DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2",
            params![user_id, keep],
        )?;
        Ok(())
    }

    pub fn purge_expired_sessions(&self) -> DbResult<usize> {
        self.lock()
            .execute("DELETE FROM sessions WHERE expires_at <= ?1", [now_ms()])
    }

    // ---- notes ----

    /// `Ok(false)` if the id is taken.
    pub fn insert_note(&self, id: &str, owner: i64) -> DbResult<bool> {
        let now = now_ms();
        let r = self.lock().execute(
            "INSERT INTO notes (id, owner_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![id, owner, now],
        );
        match r {
            Ok(_) => Ok(true),
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Ok(false)
            }
            Err(e) => Err(e),
        }
    }

    pub fn note_owner(&self, id: &str) -> DbResult<Option<i64>> {
        self.lock()
            .query_row("SELECT owner_id FROM notes WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()
    }

    /// The note if it exists and belongs to `owner`.
    pub fn note(&self, id: &str, owner: i64) -> DbResult<Option<Note>> {
        self.lock()
            .query_row(
                &format!("SELECT {NOTE_COLS} FROM notes n WHERE n.id = ?1 AND n.owner_id = ?2"),
                params![id, owner],
                note_row,
            )
            .optional()
    }

    pub fn list_notes(
        &self,
        owner: i64,
        filter: NoteFilter,
        q: Option<&str>,
    ) -> DbResult<Vec<Note>> {
        let cond = match filter {
            NoteFilter::All => "n.archived = 0",
            NoteFilter::Pinned => "n.pinned = 1 AND n.archived = 0",
            NoteFilter::Archived => "n.archived = 1",
        };
        let conn = self.lock();
        match q.and_then(fts_query) {
            Some(fts) => {
                let mut st = conn.prepare(&format!(
                    "SELECT {NOTE_COLS} FROM notes_fts f JOIN notes n ON n.rowid = f.rowid \
                     WHERE notes_fts MATCH ?2 AND n.owner_id = ?1 AND {cond} \
                     ORDER BY n.pinned DESC, n.updated_at DESC LIMIT 500"
                ))?;
                st.query_map(params![owner, fts], note_row)?.collect()
            }
            None => {
                let mut st = conn.prepare(&format!(
                    "SELECT {NOTE_COLS} FROM notes n WHERE n.owner_id = ?1 AND {cond} \
                     ORDER BY n.pinned DESC, n.updated_at DESC"
                ))?;
                st.query_map([owner], note_row)?.collect()
            }
        }
    }

    pub fn patch_note(
        &self,
        id: &str,
        owner: i64,
        pinned: Option<bool>,
        color: Option<&str>,
        archived: Option<bool>,
    ) -> DbResult<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE notes SET pinned = COALESCE(?3, pinned), color = COALESCE(?4, color), \
             archived = COALESCE(?5, archived) WHERE id = ?1 AND owner_id = ?2",
            params![id, owner, pinned, color, archived],
        )?;
        Ok(())
    }

    /// Refreshes title/preview/updated_at and the FTS row (no-op if the note was deleted).
    pub fn refresh_note(&self, id: &str, title: &str, preview: &str, body: &str) -> DbResult<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE notes SET title = ?2, preview = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, title, preview, now_ms()],
        )?;
        if changed > 0 {
            tx.execute(
                "DELETE FROM notes_fts WHERE rowid = (SELECT rowid FROM notes WHERE id = ?1)",
                [id],
            )?;
            tx.execute(
                "INSERT INTO notes_fts (rowid, id, body) SELECT rowid, id, ?2 FROM notes WHERE id = ?1",
                params![id, body],
            )?;
        }
        tx.commit()
    }

    /// `Ok(false)` if there was no such note of `owner`.
    pub fn delete_note(&self, id: &str, owner: i64) -> DbResult<bool> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM notes_fts WHERE rowid = \
             (SELECT rowid FROM notes WHERE id = ?1 AND owner_id = ?2)",
            params![id, owner],
        )?;
        let n = tx.execute(
            "DELETE FROM notes WHERE id = ?1 AND owner_id = ?2",
            params![id, owner],
        )?;
        tx.commit()?;
        Ok(n > 0)
    }
}

/// Title (first non-empty line, heading markers stripped, max 120 chars) and preview (the
/// text after that line, whitespace-trimmed, max 280 chars).
pub fn title_and_preview(text: &str) -> (String, String) {
    let mut lines = text.lines();
    let mut title = String::new();
    for line in lines.by_ref() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let t = t.trim_start_matches('#').trim();
        title = truncate(t, 120);
        break;
    }
    let rest: Vec<&str> = lines.collect();
    let preview = truncate(rest.join("\n").trim(), 280);
    (title, preview)
}

fn truncate(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}
