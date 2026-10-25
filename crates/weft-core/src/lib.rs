//! Weft CRDT engine.
//!
//! A run-length-encoded sequence CRDT for collaborative text. Positions are UTF-16 code units.
//! See `docs/ARCHITECTURE.md` §1 for the frozen contract.
//!
//! NOTE: this file is a contract stub. Signatures are frozen; bodies are `todo!()` until M1 lands.

use std::collections::BTreeMap;
use std::fmt;

pub type ClientId = u64;

/// Identifier of a single operation unit: `(client, clock)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Id {
    pub client: ClientId,
    pub clock: u64,
}

/// `client -> next expected clock`. Identifies a version of a document.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StateVector(BTreeMap<ClientId, u64>);

impl StateVector {
    pub fn get(&self, client: ClientId) -> u64 {
        self.0.get(&client).copied().unwrap_or(0)
    }

    pub fn contains(&self, id: Id) -> bool {
        id.clock < self.get(id.client)
    }

    pub fn encode(&self) -> Vec<u8> {
        todo!()
    }

    pub fn decode(_bytes: &[u8]) -> Result<Self, DecodeError> {
        todo!()
    }

    pub fn iter(&self) -> impl Iterator<Item = (ClientId, u64)> + '_ {
        self.0.iter().map(|(c, k)| (*c, *k))
    }
}

/// An opaque, self-contained, encoded batch of ops.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Update(pub Vec<u8>);

impl Update {
    pub fn is_empty(&self) -> bool {
        todo!()
    }

    pub fn merge(_updates: &[Update]) -> Result<Update, DecodeError> {
        todo!()
    }
}

/// A change to apply to a view, in UTF-16 positions, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Insert { pos: usize, text: String },
    Delete { pos: usize, len: usize },
}

/// A stable position that survives concurrent edits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Anchor {
    Start,
    End,
    /// Just after the unit with this id.
    After(Id),
}

impl Anchor {
    pub fn encode(&self) -> Vec<u8> {
        todo!()
    }

    pub fn decode(_bytes: &[u8]) -> Result<Self, DecodeError> {
        todo!()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodeError {
    pub message: String,
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "decode error: {}", self.message)
    }
}

impl std::error::Error for DecodeError {}

/// A replica of a collaborative text document.
pub struct Doc {
    client: ClientId,
}

impl Doc {
    pub fn new(client: ClientId) -> Self {
        Doc { client }
    }

    pub fn client_id(&self) -> ClientId {
        self.client
    }

    pub fn text(&self) -> String {
        todo!()
    }

    pub fn len_utf16(&self) -> usize {
        todo!()
    }

    /// Insert `text` at UTF-16 position `pos`. Returns the update to broadcast.
    pub fn insert(&mut self, _pos: usize, _text: &str) -> Update {
        todo!()
    }

    /// Delete `len` UTF-16 units starting at `pos`. Returns the update to broadcast.
    pub fn delete(&mut self, _pos: usize, _len: usize) -> Update {
        todo!()
    }

    pub fn state_vector(&self) -> StateVector {
        todo!()
    }

    /// All ops not covered by `since`.
    pub fn encode_diff(&self, _since: &StateVector) -> Update {
        todo!()
    }

    pub fn encode_full(&self) -> Update {
        self.encode_diff(&StateVector::default())
    }

    /// Idempotent and commutative. Returns the changes to apply to a view.
    pub fn apply_update(&mut self, _update: &Update) -> Result<Vec<Change>, DecodeError> {
        todo!()
    }

    pub fn has_pending(&self) -> bool {
        todo!()
    }

    pub fn anchor_at(&self, _pos: usize) -> Anchor {
        todo!()
    }

    pub fn resolve_anchor(&self, _anchor: &Anchor) -> Option<usize> {
        todo!()
    }

    /// Number of op runs integrated, in local (causal) integration order.
    pub fn op_count(&self) -> usize {
        todo!()
    }

    /// Version after the first `step` integrated op runs.
    pub fn version_at(&self, _step: usize) -> StateVector {
        todo!()
    }

    pub fn text_at(&self, _version: &StateVector) -> String {
        todo!()
    }
}
