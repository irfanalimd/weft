//! Weft wire protocol and sans-IO sync state machines.
//!
//! See `docs/ARCHITECTURE.md` §2 for the frozen contract.
//!
//! - [`Message`]: one postcard-encoded message per WebSocket binary frame.
//! - [`ClientSession`]: the client half (owns the replica; no sockets).
//! - [`Room`]: the server half, one per document (owns the server replica).

use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};
use weft_core::{Change, Doc, StateVector, Update};

pub const PROTOCOL_VERSION: u16 = 1;

/// Error codes carried by [`Message::Error`]. (Additive.)
pub mod error_code {
    /// The client speaks a different protocol version.
    pub const PROTOCOL_VERSION: u16 = 1;
    /// The doc id is invalid or doesn't match the room.
    pub const BAD_DOC_ID: u16 = 2;
    /// A frame couldn't be decoded or made no sense in context.
    pub const MALFORMED: u16 = 3;
    /// The server failed internally (e.g. storage).
    pub const INTERNAL: u16 = 4;
}

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("malformed frame: {0}")]
    Malformed(String),
    #[error("protocol version mismatch: got {got}, want {want}")]
    Version { got: u16, want: u16 },
    #[error("bad update: {0}")]
    Update(#[from] weft_core::DecodeError),
    #[error("unexpected message: {0}")]
    Unexpected(String),
}

impl SyncError {
    /// The [`error_code`] to report to the peer for this error. (Additive.)
    pub fn code(&self) -> u16 {
        match self {
            SyncError::Version { .. } => error_code::PROTOCOL_VERSION,
            SyncError::Malformed(_) | SyncError::Update(_) | SyncError::Unexpected(_) => {
                error_code::MALFORMED
            }
        }
    }

    /// The `Error` frame to send to the peer before closing the connection. (Additive.)
    pub fn to_message(&self) -> Message {
        Message::Error {
            code: self.code(),
            message: self.to_string(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum Message {
    Hello {
        protocol: u16,
        doc_id: String,
        client_id: u64,
        state_vector: Vec<u8>,
    },
    SyncStep {
        update: Vec<u8>,
        state_vector: Vec<u8>,
    },
    Update {
        update: Vec<u8>,
    },
    Awareness {
        client_id: u64,
        payload: Vec<u8>,
    },
    AwarenessRemove {
        client_id: u64,
    },
    Error {
        code: u16,
        message: String,
    },
}

impl Message {
    pub fn encode(&self) -> Vec<u8> {
        // Serializing plain enums/vecs into a Vec cannot fail.
        postcard::to_allocvec(self).expect("postcard serialization of Message")
    }

    /// Strict decode: trailing bytes are rejected. Protocol versions are checked by [`Room`]
    /// when it handles `Hello`.
    pub fn decode(bytes: &[u8]) -> Result<Self, SyncError> {
        let (msg, rest) = postcard::take_from_bytes::<Message>(bytes)
            .map_err(|e| SyncError::Malformed(e.to_string()))?;
        if !rest.is_empty() {
            return Err(SyncError::Malformed(format!(
                "{} trailing bytes after message",
                rest.len()
            )));
        }
        Ok(msg)
    }
}

#[derive(Debug, Default)]
pub struct ClientOutput {
    pub send: Vec<Message>,
    pub changes: Vec<Change>,
    /// Peer awareness updates; `None` = peer removed.
    pub awareness: Vec<(u64, Option<Vec<u8>>)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnState {
    Disconnected,
    /// `Hello` sent, waiting for `SyncStep`.
    Handshaking,
    /// Handshake done; local edits stream immediately.
    Live,
}

/// Client side of the sync protocol. Owns the replica.
///
/// Unsynced tracking: every local edit that changes the document records the end of its clock
/// range. An edit counts as confirmed once it's been sent on a live connection (the WebSocket is
/// ordered and reliable) or covered by a `SyncStep` state vector. Each handshake re-derives the
/// truth: the client sends everything not in the server's state vector, so ops that were lost
/// with a dead connection are re-sent.
pub struct ClientSession {
    doc_id: String,
    doc: Doc,
    state: ConnState,
    /// Our latest awareness payload, re-sent after every handshake.
    awareness: Option<Vec<u8>>,
    /// Last known awareness of peers on the current connection.
    peers: BTreeMap<u64, Vec<u8>>,
    /// End clocks (exclusive) of local ops not yet confirmed, ascending.
    local_ops: VecDeque<u64>,
    /// Own clocks below this are confirmed.
    confirmed: u64,
    /// Last `Error` frame from the server, if any.
    last_error: Option<(u16, String)>,
}

impl ClientSession {
    /// Ops already in `doc` from this client id (e.g. loaded from IndexedDB) count as one
    /// unsynced op until the first handshake tells us what the server has.
    pub fn new(doc_id: String, doc: Doc) -> Self {
        let mut s = ClientSession {
            doc_id,
            doc,
            state: ConnState::Disconnected,
            awareness: None,
            peers: BTreeMap::new(),
            local_ops: VecDeque::new(),
            confirmed: 0,
            last_error: None,
        };
        let clock = s.own_clock();
        if clock > 0 {
            s.local_ops.push_back(clock);
        }
        s
    }

    pub fn doc_id(&self) -> &str {
        &self.doc_id
    }

    pub fn doc(&self) -> &Doc {
        &self.doc
    }

    /// True once the handshake has completed on the current connection. (Additive.)
    pub fn is_live(&self) -> bool {
        self.state == ConnState::Live
    }

    /// Known peers' awareness payloads on the current connection. Cleared on (dis)connect;
    /// the server replays them after each handshake. (Additive.)
    pub fn peers(&self) -> impl Iterator<Item = (u64, &[u8])> + '_ {
        self.peers.iter().map(|(id, p)| (*id, p.as_slice()))
    }

    /// The last `Error` frame received from the server, if any. (Additive.)
    pub fn last_error(&self) -> Option<(u16, &str)> {
        self.last_error.as_ref().map(|(c, m)| (*c, m.as_str()))
    }

    /// Starts a new connection: returns `[Hello]`. Safe to call repeatedly.
    pub fn on_connected(&mut self) -> Vec<Message> {
        self.state = ConnState::Handshaking;
        self.peers.clear();
        self.last_error = None;
        vec![Message::Hello {
            protocol: PROTOCOL_VERSION,
            doc_id: self.doc_id.clone(),
            client_id: self.doc.client_id(),
            state_vector: self.doc.state_vector().encode(),
        }]
    }

    /// The connection is gone. Peers are forgotten; the UI should clear its presence list.
    pub fn on_disconnected(&mut self) {
        self.state = ConnState::Disconnected;
        self.peers.clear();
    }

    pub fn on_message(&mut self, msg: Message) -> Result<ClientOutput, SyncError> {
        let mut out = ClientOutput::default();
        match msg {
            Message::SyncStep {
                update,
                state_vector,
            } => {
                let server_sv = StateVector::decode(&state_vector)?;
                out.changes = self.doc.apply_update(&Update(update))?;
                if self.state == ConnState::Disconnected {
                    // A stale frame from a dead connection: keep the data, don't go live.
                    return Ok(out);
                }
                let me = self.doc.client_id();
                self.confirm(server_sv.get(me));
                // Our offline edits (and anything else the server lacks).
                let diff = self.doc.encode_diff(&server_sv);
                if !diff.is_empty() {
                    out.send.push(Message::Update { update: diff.0 });
                }
                if let Some(payload) = &self.awareness {
                    out.send.push(Message::Awareness {
                        client_id: me,
                        payload: payload.clone(),
                    });
                }
                self.state = ConnState::Live;
                let clock = self.own_clock();
                self.confirm(clock);
            }
            Message::Update { update } => {
                out.changes = self.doc.apply_update(&Update(update))?;
            }
            Message::Awareness { client_id, payload } => {
                if client_id != self.doc.client_id() {
                    self.peers.insert(client_id, payload.clone());
                    out.awareness.push((client_id, Some(payload)));
                }
            }
            Message::AwarenessRemove { client_id } => {
                if client_id != self.doc.client_id() {
                    self.peers.remove(&client_id);
                    out.awareness.push((client_id, None));
                }
            }
            Message::Error { code, message } => {
                // Surfaced via `last_error()` (and by the caller inspecting the frame).
                self.last_error = Some((code, message));
            }
            Message::Hello { .. } => {
                return Err(SyncError::Unexpected("Hello sent to a client".into()));
            }
        }
        Ok(out)
    }

    pub fn insert(&mut self, pos: usize, text: &str) -> Vec<Message> {
        let update = self.doc.insert(pos, text);
        self.after_local_edit(update)
    }

    pub fn delete(&mut self, pos: usize, len: usize) -> Vec<Message> {
        let update = self.doc.delete(pos, len);
        self.after_local_edit(update)
    }

    pub fn set_awareness(&mut self, payload: Vec<u8>) -> Vec<Message> {
        self.awareness = Some(payload.clone());
        if self.state == ConnState::Live {
            vec![Message::Awareness {
                client_id: self.doc.client_id(),
                payload,
            }]
        } else {
            Vec::new()
        }
    }

    /// Handshake done and no unconfirmed local ops.
    pub fn is_synced(&self) -> bool {
        self.state == ConnState::Live && self.local_ops.is_empty()
    }

    /// Local ops the server hasn't confirmed.
    pub fn unsynced_op_count(&self) -> usize {
        self.local_ops.len()
    }

    fn own_clock(&self) -> u64 {
        self.doc.state_vector().get(self.doc.client_id())
    }

    fn confirm(&mut self, clock: u64) {
        self.confirmed = self.confirmed.max(clock);
        while self
            .local_ops
            .front()
            .is_some_and(|&end| end <= self.confirmed)
        {
            self.local_ops.pop_front();
        }
    }

    fn after_local_edit(&mut self, update: Update) -> Vec<Message> {
        let clock = self.own_clock();
        if self.local_ops.back().is_none_or(|&end| end < clock) && clock > self.confirmed {
            self.local_ops.push_back(clock);
        }
        if self.state == ConnState::Live && !update.is_empty() {
            self.confirm(clock);
            vec![Message::Update { update: update.0 }]
        } else {
            Vec::new()
        }
    }
}

#[derive(Debug, Default)]
pub struct RoomOutput {
    pub to: Vec<(u64, Message)>,
    pub persist: Vec<Update>,
}

#[derive(Default)]
struct Peer {
    /// Completed `Hello`; only such peers receive broadcasts.
    hello: bool,
    /// Awareness by client id, as sent on this connection.
    awareness: BTreeMap<u64, Vec<u8>>,
}

/// Server side, one per document. Connection ids are opaque.
pub struct Room {
    doc_id: String,
    doc: Doc,
    peers: BTreeMap<u64, Peer>,
}

impl Room {
    pub fn new(doc_id: String, doc: Doc) -> Self {
        Room {
            doc_id,
            doc,
            peers: BTreeMap::new(),
        }
    }

    pub fn doc_id(&self) -> &str {
        &self.doc_id
    }

    pub fn doc(&self) -> &Doc {
        &self.doc
    }

    /// Number of joined connections. (Additive.)
    pub fn connection_count(&self) -> usize {
        self.peers.len()
    }

    pub fn on_join(&mut self, conn: u64) {
        self.peers.entry(conn).or_default();
    }

    /// Removes the connection and tells the others its awareness is gone. If another
    /// connection still carries the same client id (a reconnect racing the old socket's
    /// timeout), its payload is re-broadcast instead.
    pub fn on_leave(&mut self, conn: u64) -> RoomOutput {
        let mut out = RoomOutput::default();
        let Some(peer) = self.peers.remove(&conn) else {
            return out;
        };
        for client_id in peer.awareness.into_keys() {
            let still_here = self
                .peers
                .values()
                .find_map(|p| p.awareness.get(&client_id).cloned());
            let msg = match still_here {
                Some(payload) => Message::Awareness { client_id, payload },
                None => Message::AwarenessRemove { client_id },
            };
            self.broadcast(conn, &msg, &mut out);
        }
        out
    }

    pub fn on_message(&mut self, conn: u64, msg: Message) -> Result<RoomOutput, SyncError> {
        self.on_join(conn);
        let mut out = RoomOutput::default();
        match msg {
            Message::Hello {
                protocol,
                doc_id,
                client_id: _,
                state_vector,
            } => {
                if protocol != PROTOCOL_VERSION {
                    return Err(SyncError::Version {
                        got: protocol,
                        want: PROTOCOL_VERSION,
                    });
                }
                if doc_id != self.doc_id {
                    return Err(SyncError::Unexpected(format!(
                        "Hello for doc {doc_id:?} in room {:?}",
                        self.doc_id
                    )));
                }
                let client_sv = StateVector::decode(&state_vector)?;
                out.to.push((
                    conn,
                    Message::SyncStep {
                        update: self.doc.encode_diff(&client_sv).0,
                        state_vector: self.doc.state_vector().encode(),
                    },
                ));
                for (&other, peer) in &self.peers {
                    if other == conn {
                        continue;
                    }
                    for (&client_id, payload) in &peer.awareness {
                        out.to.push((
                            conn,
                            Message::Awareness {
                                client_id,
                                payload: payload.clone(),
                            },
                        ));
                    }
                }
                if let Some(p) = self.peers.get_mut(&conn) {
                    p.hello = true;
                }
            }
            Message::Update { update } => {
                let update = Update(update);
                let had_pending = self.doc.has_pending();
                let before = self.doc.state_vector();
                self.doc.apply_update(&update)?;
                let after = self.doc.state_vector();
                if after != before {
                    // Forward the client's bytes when they integrated cleanly; otherwise (some
                    // ops are buffered, or buffered ops got unblocked) send exactly what's new.
                    let fresh = if had_pending || self.doc.has_pending() {
                        self.doc.encode_diff(&before)
                    } else {
                        update
                    };
                    self.broadcast(
                        conn,
                        &Message::Update {
                            update: fresh.0.clone(),
                        },
                        &mut out,
                    );
                    out.persist.push(fresh);
                }
            }
            Message::Awareness { client_id, payload } => {
                if let Some(p) = self.peers.get_mut(&conn) {
                    p.awareness.insert(client_id, payload.clone());
                }
                self.broadcast(conn, &Message::Awareness { client_id, payload }, &mut out);
            }
            Message::SyncStep { .. } | Message::AwarenessRemove { .. } | Message::Error { .. } => {
                return Err(SyncError::Unexpected(
                    "server-only message sent by a client".into(),
                ));
            }
        }
        Ok(out)
    }

    fn broadcast(&self, from: u64, msg: &Message, out: &mut RoomOutput) {
        for (&conn, peer) in &self.peers {
            if conn != from && peer.hello {
                out.to.push((conn, msg.clone()));
            }
        }
    }
}
