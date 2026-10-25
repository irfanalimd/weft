//! Weft CRDT engine.
//!
//! A run-length-encoded sequence CRDT for collaborative text. Positions are UTF-16 code units.
//! See `docs/ARCHITECTURE.md` §1 for the frozen contract.
//!
//! Algorithm: FugueMax (in the equivalent YjsMod formulation) over run-length-encoded items with
//! left/right origins. Deletes are ops with their own ids, so a [`StateVector`] identifies a
//! version exactly; that enables delta sync ([`Doc::encode_diff`]) and time travel
//! ([`Doc::text_at`]).

mod doc;
mod encoding;
mod merge;
mod seq;
mod undo;

pub use doc::Doc;
pub use undo::{UndoManager, UndoResult};

use encoding::{Reader, VERSION, err, write_var};
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
pub struct StateVector(pub(crate) BTreeMap<ClientId, u64>);

impl StateVector {
    pub fn get(&self, client: ClientId) -> u64 {
        self.0.get(&client).copied().unwrap_or(0)
    }

    pub fn contains(&self, id: Id) -> bool {
        id.clock < self.get(id.client)
    }

    /// `[version][varint n][(varint client, varint clock) x n]`, sorted by client.
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = vec![VERSION];
        write_var(&mut buf, self.0.len() as u64);
        for (&c, &k) in &self.0 {
            write_var(&mut buf, c);
            write_var(&mut buf, k);
        }
        buf
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut r = Reader::new(bytes);
        if r.u8()? != VERSION {
            return Err(err("unsupported state vector version"));
        }
        let n = r.count()?;
        let mut m = BTreeMap::new();
        for _ in 0..n {
            let c = r.var()?;
            let k = r.var()?;
            if k > 0 {
                let e = m.entry(c).or_insert(0);
                *e = k.max(*e);
            }
        }
        r.finish()?;
        Ok(StateVector(m))
    }

    /// Set the next expected clock for `client` (0 removes the entry).
    pub fn set(&mut self, client: ClientId, clock: u64) {
        if clock == 0 {
            self.0.remove(&client);
        } else {
            self.0.insert(client, clock);
        }
    }

    /// True if every op in `other` is also in `self`.
    pub fn covers(&self, other: &StateVector) -> bool {
        other.iter().all(|(c, k)| self.get(c) >= k)
    }

    pub fn iter(&self) -> impl Iterator<Item = (ClientId, u64)> + '_ {
        self.0.iter().map(|(c, k)| (*c, *k))
    }
}

/// An opaque, self-contained, encoded batch of ops.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Update(pub Vec<u8>);

impl Update {
    /// True if the update contains no ops (or is zero bytes long).
    pub fn is_empty(&self) -> bool {
        self.0.is_empty() || encoding::op_count(&self.0) == Ok(0)
    }

    /// Merge several updates into one compact update without a `Doc`. Applying the result is
    /// equivalent to applying each input.
    pub fn merge(updates: &[Update]) -> Result<Update, DecodeError> {
        merge::merge(updates)
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
    /// `[version][tag: 0 Start | 1 End | 2 After][varint client, varint clock]`.
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = vec![VERSION];
        match self {
            Anchor::Start => buf.push(0),
            Anchor::End => buf.push(1),
            Anchor::After(id) => {
                buf.push(2);
                write_var(&mut buf, id.client);
                write_var(&mut buf, id.clock);
            }
        }
        buf
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut r = Reader::new(bytes);
        if r.u8()? != VERSION {
            return Err(err("unsupported anchor version"));
        }
        let a = match r.u8()? {
            0 => Anchor::Start,
            1 => Anchor::End,
            2 => Anchor::After(Id {
                client: r.var()?,
                clock: r.var()?,
            }),
            _ => return Err(err("bad anchor tag")),
        };
        r.finish()?;
        Ok(a)
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
