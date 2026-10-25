//! Binary encoding: LEB128 varints, a client table, and run-length-encoded ops.
//!
//! Update layout (version 2):
//!
//! ```text
//! u8      version (= 2)
//! varint  n_clients, then n_clients x varint ClientId      (client table)
//! varint  n_ops, then n_ops x op
//! op:
//!   u8 flags      bit0: 0 = insert, 1 = delete
//!                 insert only: bit1 has origin-left, bit2 has origin-right, bit3 raw UTF-16 content
//!   varint client (table index), varint clock
//!   insert: [ol: varint client, zigzag(clock - op clock)] [or: same]
//!           content: utf8  -> varint byte_len, bytes
//!                    raw   -> varint unit_len, unit_len x u16 LE   (only for lone surrogates)
//!   delete: varint n_targets, n_targets x (varint client, zigzag(clock - base), varint len)
//!           where base starts at the op's clock and becomes each target's end clock
//! ```

use crate::{ClientId, DecodeError, Id};
use std::collections::BTreeMap;

/// Version byte of state vectors and anchors.
pub(crate) const VERSION: u8 = 1;
/// Version byte of updates (2: origin/target clocks are zigzag deltas).
pub(crate) const UPDATE_VERSION: u8 = 2;

/// Reversible signed delta of two clocks, zigzag-encoded.
fn zz(clock: u64, base: u64) -> u64 {
    let d = clock.wrapping_sub(base) as i64;
    ((d << 1) ^ (d >> 63)) as u64
}

fn unzz(v: u64, base: u64) -> u64 {
    let d = ((v >> 1) as i64) ^ -((v & 1) as i64);
    base.wrapping_add(d as u64)
}

const F_DELETE: u8 = 1;
const F_OL: u8 = 2;
const F_OR: u8 = 4;
const F_RAW: u8 = 8;

pub(crate) fn err(msg: &str) -> DecodeError {
    DecodeError {
        message: msg.to_string(),
    }
}

pub(crate) fn write_var(buf: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        buf.push((v as u8) | 0x80);
        v >>= 7;
    }
    buf.push(v as u8);
}

pub(crate) struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(b: &'a [u8]) -> Self {
        Reader { b, pos: 0 }
    }

    pub(crate) fn remaining(&self) -> usize {
        self.b.len() - self.pos
    }

    pub(crate) fn u8(&mut self) -> Result<u8, DecodeError> {
        let v = *self
            .b
            .get(self.pos)
            .ok_or_else(|| err("unexpected end of input"))?;
        self.pos += 1;
        Ok(v)
    }

    pub(crate) fn var(&mut self) -> Result<u64, DecodeError> {
        let mut v = 0u64;
        for i in 0..10 {
            let byte = self.u8()?;
            let part = (byte & 0x7f) as u64;
            if i == 9 && part > 1 {
                return Err(err("varint overflow"));
            }
            v |= part << (7 * i);
            if byte & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err(err("varint too long"))
    }

    /// A varint that is used as a count/length of items that each take >= 1 byte.
    pub(crate) fn count(&mut self) -> Result<usize, DecodeError> {
        let v = self.var()?;
        if v > self.remaining() as u64 {
            return Err(err("count exceeds input size"));
        }
        Ok(v as usize)
    }

    pub(crate) fn bytes(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        if n > self.remaining() {
            return Err(err("unexpected end of input"));
        }
        let s = &self.b[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    pub(crate) fn finish(&self) -> Result<(), DecodeError> {
        if self.remaining() != 0 {
            return Err(err("trailing bytes"));
        }
        Ok(())
    }
}

/// A decoded operation run, using global client ids.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Op {
    Insert {
        id: Id,
        ol: Option<Id>,
        or: Option<Id>,
        content: Vec<u16>,
    },
    Delete {
        id: Id,
        targets: Vec<(Id, u64)>,
    },
}

impl Op {
    pub(crate) fn id(&self) -> Id {
        match self {
            Op::Insert { id, .. } | Op::Delete { id, .. } => *id,
        }
    }

    pub(crate) fn len(&self) -> u64 {
        match self {
            Op::Insert { content, .. } => content.len() as u64,
            Op::Delete { targets, .. } => targets.iter().map(|t| t.1).sum(),
        }
    }

    /// Drop the first `n` units (0 < n < len).
    pub(crate) fn trim_front(&mut self, n: u64) {
        match self {
            Op::Insert {
                id, ol, content, ..
            } => {
                content.drain(..n as usize);
                id.clock += n;
                *ol = Some(Id {
                    client: id.client,
                    clock: id.clock - 1,
                });
            }
            Op::Delete { id, targets } => {
                id.clock += n;
                let mut n = n;
                while n > 0 {
                    let t = &mut targets[0];
                    if t.1 <= n {
                        n -= t.1;
                        targets.remove(0);
                    } else {
                        t.0.clock += n;
                        t.1 -= n;
                        n = 0;
                    }
                }
            }
        }
    }
}

/// Merge adjacent ops that are continuations of each other.
pub(crate) fn coalesce(ops: Vec<Op>) -> Vec<Op> {
    let mut out: Vec<Op> = Vec::with_capacity(ops.len());
    for op in ops {
        if let Some(prev) = out.last_mut() {
            match (prev, &op) {
                (
                    Op::Insert {
                        id: pid,
                        or: por,
                        content: pc,
                        ..
                    },
                    Op::Insert {
                        id,
                        ol,
                        or,
                        content,
                    },
                ) => {
                    let pend = pid.clock + pc.len() as u64;
                    if pid.client == id.client
                        && pend == id.clock
                        && *ol
                            == Some(Id {
                                client: id.client,
                                clock: pend - 1,
                            })
                        && por == or
                    {
                        pc.extend_from_slice(content);
                        continue;
                    }
                }
                (
                    Op::Delete {
                        id: pid,
                        targets: pt,
                    },
                    Op::Delete { id, targets },
                ) => {
                    let plen: u64 = pt.iter().map(|t| t.1).sum();
                    if pid.client == id.client && pid.clock + plen == id.clock {
                        for &t in targets {
                            push_target(pt, t.0, t.1);
                        }
                        continue;
                    }
                }
                _ => {}
            }
        }
        out.push(op);
    }
    out
}

pub(crate) fn push_target(targets: &mut Vec<(Id, u64)>, id: Id, len: u64) {
    if let Some(last) = targets.last_mut()
        && last.0.client == id.client
        && last.0.clock + last.1 == id.clock
    {
        last.1 += len;
        return;
    }
    targets.push((id, len));
}

struct ClientTable {
    ids: Vec<ClientId>,
    map: BTreeMap<ClientId, u64>,
}

impl ClientTable {
    fn add(&mut self, c: ClientId) {
        if !self.map.contains_key(&c) {
            self.map.insert(c, self.ids.len() as u64);
            self.ids.push(c);
        }
    }
    fn idx(&self, c: ClientId) -> u64 {
        self.map[&c]
    }
}

pub(crate) fn encode_ops(ops: &[Op]) -> Vec<u8> {
    let mut table = ClientTable {
        ids: Vec::new(),
        map: BTreeMap::new(),
    };
    for op in ops {
        table.add(op.id().client);
        match op {
            Op::Insert { ol, or, .. } => {
                if let Some(o) = ol {
                    table.add(o.client);
                }
                if let Some(o) = or {
                    table.add(o.client);
                }
            }
            Op::Delete { targets, .. } => {
                for t in targets {
                    table.add(t.0.client);
                }
            }
        }
    }
    let mut buf = Vec::with_capacity(16 + ops.len() * 8);
    buf.push(UPDATE_VERSION);
    write_var(&mut buf, table.ids.len() as u64);
    for &c in &table.ids {
        write_var(&mut buf, c);
    }
    write_var(&mut buf, ops.len() as u64);
    let write_id = |buf: &mut Vec<u8>, id: Id| {
        write_var(buf, table.idx(id.client));
        write_var(buf, id.clock);
    };
    let write_rel = |buf: &mut Vec<u8>, id: Id, base: u64| {
        write_var(buf, table.idx(id.client));
        write_var(buf, zz(id.clock, base));
    };
    for op in ops {
        match op {
            Op::Insert {
                id,
                ol,
                or,
                content,
            } => {
                let utf8 = String::from_utf16(content).ok();
                let mut flags = 0u8;
                if ol.is_some() {
                    flags |= F_OL;
                }
                if or.is_some() {
                    flags |= F_OR;
                }
                if utf8.is_none() {
                    flags |= F_RAW;
                }
                buf.push(flags);
                write_id(&mut buf, *id);
                if let Some(o) = ol {
                    write_rel(&mut buf, *o, id.clock);
                }
                if let Some(o) = or {
                    write_rel(&mut buf, *o, id.clock);
                }
                match utf8 {
                    Some(s) => {
                        write_var(&mut buf, s.len() as u64);
                        buf.extend_from_slice(s.as_bytes());
                    }
                    None => {
                        write_var(&mut buf, content.len() as u64);
                        for u in content {
                            buf.extend_from_slice(&u.to_le_bytes());
                        }
                    }
                }
            }
            Op::Delete { id, targets } => {
                buf.push(F_DELETE);
                write_id(&mut buf, *id);
                write_var(&mut buf, targets.len() as u64);
                let mut base = id.clock;
                for t in targets {
                    write_rel(&mut buf, t.0, base);
                    write_var(&mut buf, t.1);
                    base = t.0.clock.wrapping_add(t.1);
                }
            }
        }
    }
    buf
}

/// Parse the header and return (client table, op count, reader positioned at first op).
fn decode_header(bytes: &[u8]) -> Result<(Vec<ClientId>, usize, Reader<'_>), DecodeError> {
    let mut r = Reader::new(bytes);
    let v = r.u8()?;
    if v != UPDATE_VERSION {
        return Err(err("unsupported update version"));
    }
    let n_clients = r.count()?;
    let mut clients = Vec::with_capacity(n_clients);
    for _ in 0..n_clients {
        clients.push(r.var()?);
    }
    let n_ops = r.count()?;
    Ok((clients, n_ops, r))
}

pub(crate) fn op_count(bytes: &[u8]) -> Result<usize, DecodeError> {
    decode_header(bytes).map(|h| h.1)
}

pub(crate) fn decode_ops(bytes: &[u8]) -> Result<Vec<Op>, DecodeError> {
    let (clients, n_ops, mut r) = decode_header(bytes)?;
    let read_id = |r: &mut Reader| -> Result<Id, DecodeError> {
        let ci = r.var()?;
        let client = *clients
            .get(usize::try_from(ci).map_err(|_| err("bad client index"))?)
            .ok_or_else(|| err("client index out of range"))?;
        Ok(Id {
            client,
            clock: r.var()?,
        })
    };
    let read_rel = |r: &mut Reader, base: u64| -> Result<Id, DecodeError> {
        let id = read_id(r)?;
        Ok(Id {
            clock: unzz(id.clock, base),
            ..id
        })
    };
    let mut ops = Vec::with_capacity(n_ops);
    for _ in 0..n_ops {
        let flags = r.u8()?;
        if flags & F_DELETE != 0 {
            if flags != F_DELETE {
                return Err(err("bad op flags"));
            }
            let id = read_id(&mut r)?;
            let n = r.count()?;
            if n == 0 {
                return Err(err("empty delete"));
            }
            let mut targets = Vec::with_capacity(n);
            let mut total = 0u64;
            let mut base = id.clock;
            for _ in 0..n {
                let t = read_rel(&mut r, base)?;
                let len = r.var()?;
                if len == 0 || t.clock.checked_add(len).is_none() {
                    return Err(err("bad delete target length"));
                }
                total = total
                    .checked_add(len)
                    .ok_or_else(|| err("delete length overflow"))?;
                base = t.clock + len;
                targets.push((t, len));
            }
            if id.clock.checked_add(total).is_none() {
                return Err(err("clock overflow"));
            }
            ops.push(Op::Delete { id, targets });
        } else {
            if flags & !(F_OL | F_OR | F_RAW) != 0 {
                return Err(err("bad op flags"));
            }
            let id = read_id(&mut r)?;
            let ol = if flags & F_OL != 0 {
                Some(read_rel(&mut r, id.clock)?)
            } else {
                None
            };
            let or = if flags & F_OR != 0 {
                Some(read_rel(&mut r, id.clock)?)
            } else {
                None
            };
            let content: Vec<u16> = if flags & F_RAW != 0 {
                let n = r.count()?;
                let raw = r.bytes(n.checked_mul(2).ok_or_else(|| err("length overflow"))?)?;
                raw.as_chunks::<2>()
                    .0
                    .iter()
                    .map(|c| u16::from_le_bytes(*c))
                    .collect()
            } else {
                let n = r.count()?;
                let s = std::str::from_utf8(r.bytes(n)?).map_err(|_| err("invalid utf-8"))?;
                s.encode_utf16().collect()
            };
            if content.is_empty() {
                return Err(err("empty insert"));
            }
            if id.clock.checked_add(content.len() as u64).is_none() {
                return Err(err("clock overflow"));
            }
            ops.push(Op::Insert {
                id,
                ol,
                or,
                content,
            });
        }
    }
    r.finish()?;
    Ok(ops)
}
