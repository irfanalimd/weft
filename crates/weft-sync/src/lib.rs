//! Weft wire protocol and sans-IO sync state machines.
//!
//! See `docs/ARCHITECTURE.md` §2 for the frozen contract.
//!
//! NOTE: this file is a contract stub. Signatures are frozen; bodies are `todo!()` until M2 lands.

use serde::{Deserialize, Serialize};
use weft_core::{Change, Doc, Update};

pub const PROTOCOL_VERSION: u16 = 1;

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
        todo!()
    }

    pub fn decode(_bytes: &[u8]) -> Result<Self, SyncError> {
        todo!()
    }
}

#[derive(Debug, Default)]
pub struct ClientOutput {
    pub send: Vec<Message>,
    pub changes: Vec<Change>,
    /// Peer awareness updates; `None` = peer removed.
    pub awareness: Vec<(u64, Option<Vec<u8>>)>,
}

/// Client side of the sync protocol. Owns the replica.
pub struct ClientSession {
    doc_id: String,
    doc: Doc,
}

impl ClientSession {
    pub fn new(doc_id: String, doc: Doc) -> Self {
        ClientSession { doc_id, doc }
    }

    pub fn doc_id(&self) -> &str {
        &self.doc_id
    }

    pub fn doc(&self) -> &Doc {
        &self.doc
    }

    pub fn on_connected(&mut self) -> Vec<Message> {
        todo!()
    }

    pub fn on_disconnected(&mut self) {
        todo!()
    }

    pub fn on_message(&mut self, _msg: Message) -> Result<ClientOutput, SyncError> {
        todo!()
    }

    pub fn insert(&mut self, _pos: usize, _text: &str) -> Vec<Message> {
        todo!()
    }

    pub fn delete(&mut self, _pos: usize, _len: usize) -> Vec<Message> {
        todo!()
    }

    pub fn set_awareness(&mut self, _payload: Vec<u8>) -> Vec<Message> {
        todo!()
    }

    pub fn is_synced(&self) -> bool {
        todo!()
    }

    pub fn unsynced_op_count(&self) -> usize {
        todo!()
    }
}

#[derive(Debug, Default)]
pub struct RoomOutput {
    pub to: Vec<(u64, Message)>,
    pub persist: Vec<Update>,
}

/// Server side, one per document. Connection ids are opaque.
pub struct Room {
    doc_id: String,
    doc: Doc,
}

impl Room {
    pub fn new(doc_id: String, doc: Doc) -> Self {
        Room { doc_id, doc }
    }

    pub fn doc_id(&self) -> &str {
        &self.doc_id
    }

    pub fn doc(&self) -> &Doc {
        &self.doc
    }

    pub fn on_join(&mut self, _conn: u64) {
        todo!()
    }

    pub fn on_leave(&mut self, _conn: u64) -> RoomOutput {
        todo!()
    }

    pub fn on_message(&mut self, _conn: u64, _msg: Message) -> Result<RoomOutput, SyncError> {
        todo!()
    }
}
