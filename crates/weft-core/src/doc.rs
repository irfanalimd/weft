//! The replica: integration (FugueMax, in its YjsMod formulation), deletes, pending queue,
//! diffs, anchors and time travel.

use crate::encoding::{self, Op};
use crate::seq::{END, Key, LId, Loc, Piece, START, Seq};
use crate::{Anchor, Change, ClientId, DecodeError, Id, StateVector, Update};
use std::collections::{BTreeMap, HashSet};

/// Cap on buffered out-of-order ops: one unit per run plus one per inserted UTF-16 unit or
/// delete target. Beyond it (or [`MAX_PENDING_BYTES`]), `apply_update` returns an error.
pub const MAX_PENDING_UNITS: usize = 100_000;
/// Cap on the estimated memory of buffered out-of-order ops.
pub const MAX_PENDING_BYTES: usize = 8 << 20;

/// Dedup key of a pending op: `(id, len, is_insert)`.
type PendingKey = (Id, u64, bool);

fn pending_key(op: &Op) -> PendingKey {
    (op.id(), op.len(), matches!(op, Op::Insert { .. }))
}

/// `(units, estimated bytes)` an op occupies while pending.
fn pending_cost(op: &Op) -> (usize, usize) {
    match op {
        Op::Insert { content, .. } => (1 + content.len(), 64 + 2 * content.len()),
        Op::Delete { targets, .. } => (1 + targets.len(), 64 + 24 * targets.len()),
    }
}

#[derive(Clone, Debug)]
struct ClientData {
    id: ClientId,
    /// Inserted content indexed by clock. Clocks used by delete ops hold placeholders, so
    /// `content.len()` is always this client's next expected clock.
    content: Vec<u16>,
}

#[derive(Clone, Debug)]
enum LogEntry {
    Insert {
        client: u32,
        clock: u64,
        len: u64,
    },
    Delete {
        client: u32,
        clock: u64,
        targets: Vec<(LId, u64)>,
    },
}

enum Outcome {
    Integrated,
    Blocked(Op),
    Dropped,
}

/// A replica of a collaborative text document.
#[derive(Clone, Debug)]
pub struct Doc {
    client: ClientId,
    clients: Vec<ClientData>,
    client_map: BTreeMap<ClientId, u32>,
    seq: Seq,
    log: Vec<LogEntry>,
    pending: Vec<Op>,
    pending_keys: HashSet<PendingKey>,
    pending_units: usize,
    pending_bytes: usize,
}

fn push_change(changes: &mut Vec<Change>, c: Change) {
    match (changes.last_mut(), &c) {
        (Some(Change::Delete { pos, len }), Change::Delete { pos: p2, len: l2 }) if pos == p2 => {
            *len += l2;
        }
        (Some(Change::Insert { pos, text }), Change::Insert { pos: p2, text: t2 })
            if *pos + text.encode_utf16().count() == *p2 =>
        {
            text.push_str(t2);
        }
        _ => changes.push(c),
    }
}

impl Doc {
    pub fn new(client: ClientId) -> Self {
        let mut d = Doc {
            client,
            clients: Vec::new(),
            client_map: BTreeMap::new(),
            seq: Seq::new(),
            log: Vec::new(),
            pending: Vec::new(),
            pending_keys: HashSet::new(),
            pending_units: 0,
            pending_bytes: 0,
        };
        d.intern(client);
        d
    }

    /// Convenience: a new replica with `update` applied.
    pub fn from_update(client: ClientId, update: &Update) -> Result<Self, DecodeError> {
        let mut d = Doc::new(client);
        d.apply_update(update)?;
        Ok(d)
    }

    pub fn client_id(&self) -> ClientId {
        self.client
    }

    fn intern(&mut self, c: ClientId) -> u32 {
        if let Some(&i) = self.client_map.get(&c) {
            return i;
        }
        let i = self.clients.len() as u32;
        self.clients.push(ClientData {
            id: c,
            content: Vec::new(),
        });
        self.client_map.insert(c, i);
        self.seq.add_client();
        i
    }

    fn me(&self) -> u32 {
        self.client_map[&self.client]
    }

    pub(crate) fn lid(&self, id: Id) -> Option<LId> {
        self.client_map.get(&id.client).map(|&client| LId {
            client,
            clock: id.clock,
        })
    }

    pub(crate) fn gid(&self, id: LId) -> Id {
        Id {
            client: self.clients[id.client as usize].id,
            clock: id.clock,
        }
    }

    fn next_clock(&self, c: ClientId) -> u64 {
        self.client_map
            .get(&c)
            .map_or(0, |&i| self.clients[i as usize].content.len() as u64)
    }

    fn piece_text(&self, p: &Piece, from: u64, to: u64) -> &[u16] {
        &self.clients[p.client as usize].content[from as usize..to as usize]
    }

    pub fn text(&self) -> String {
        let mut out: Vec<u16> = Vec::with_capacity(self.seq.len() as usize);
        for p in self.seq.pieces() {
            if !p.deleted {
                out.extend_from_slice(self.piece_text(p, p.clock, p.clock + p.len));
            }
        }
        String::from_utf16_lossy(&out)
    }

    pub fn len_utf16(&self) -> usize {
        self.seq.len() as usize
    }

    // ---------------------------------------------------------------- local edits

    /// Insert `text` at UTF-16 position `pos` (clamped to the length). Returns the update to
    /// broadcast.
    pub fn insert(&mut self, pos: usize, text: &str) -> Update {
        let units: Vec<u16> = text.encode_utf16().collect();
        match self.local_insert(pos, &units) {
            Some((op, _)) => Update(encoding::encode_ops(&[op])),
            None => Update::empty(),
        }
    }

    pub(crate) fn local_insert(&mut self, pos: usize, units: &[u16]) -> Option<(Op, u64)> {
        if units.is_empty() {
            return None;
        }
        let pos = (pos as u64).min(self.seq.len());
        let (ol, dest) = if pos == 0 {
            (None, self.seq.first_unit())
        } else {
            let l = self.seq.find_visible(pos - 1)?;
            (Some(l), self.seq.next_unit(l))
        };
        let ol = ol.map(|l| {
            let p = self.seq.piece(l);
            LId {
                client: p.client,
                clock: p.clock + l.off,
            }
        });
        let or = dest.map(|l| {
            let p = self.seq.piece(l);
            LId {
                client: p.client,
                clock: p.clock + l.off,
            }
        });
        let me = self.me();
        let clock = self.clients[me as usize].content.len() as u64;
        let at = self.place(me, clock, ol, or, units, dest);
        let op = Op::Insert {
            id: Id {
                client: self.client,
                clock,
            },
            ol: ol.map(|i| self.gid(i)),
            or: or.map(|i| self.gid(i)),
            content: units.to_vec(),
        };
        Some((op, at))
    }

    /// Delete `len` UTF-16 units starting at `pos` (clamped). Returns the update to broadcast.
    pub fn delete(&mut self, pos: usize, len: usize) -> Update {
        let targets = self.visible_targets(pos as u64, len as u64);
        match self.local_delete_targets(targets, &mut Vec::new()) {
            Some(op) => Update(encoding::encode_ops(&[op])),
            None => Update::empty(),
        }
    }

    /// Ids of the visible units in `pos..pos+len`.
    fn visible_targets(&self, pos: u64, len: u64) -> Vec<(LId, u64)> {
        let mut targets: Vec<(LId, u64)> = Vec::new();
        let len = len.min(self.seq.len().saturating_sub(pos));
        let mut remaining = len;
        let mut cur = if remaining > 0 {
            self.seq.find_visible(pos)
        } else {
            None
        };
        while let (Some(loc), true) = (cur, remaining > 0) {
            let p = self.seq.piece(loc);
            if !p.deleted {
                let n = remaining.min(p.len - loc.off);
                let id = LId {
                    client: p.client,
                    clock: p.clock + loc.off,
                };
                match targets.last_mut() {
                    Some(last)
                        if last.0.client == id.client && last.0.clock + last.1 == id.clock =>
                    {
                        last.1 += n
                    }
                    _ => targets.push((id, n)),
                }
                remaining -= n;
            }
            cur = self.seq.next_piece_start(loc);
        }
        targets
    }

    /// Create a local delete op over `targets` (only still-visible units are kept).
    pub(crate) fn local_delete_targets(
        &mut self,
        targets: Vec<(LId, u64)>,
        changes: &mut Vec<Change>,
    ) -> Option<Op> {
        let total: u64 = targets.iter().map(|t| t.1).sum();
        if total == 0 {
            return None;
        }
        let me = self.me();
        let clock = self.clients[me as usize].content.len() as u64;
        let op = Op::Delete {
            id: Id {
                client: self.client,
                clock,
            },
            targets: targets.iter().map(|&(t, n)| (self.gid(t), n)).collect(),
        };
        self.apply_delete(me, clock, total, targets, changes);
        Some(op)
    }

    // ---------------------------------------------------------------- integration

    /// Find where an insert with origins `ol`/`or` belongs (FugueMax / YjsMod rule).
    /// Returns `None` if an origin doesn't resolve to a known unit, else the destination
    /// (`Some(None)` = end of document).
    fn find_dest(&self, client: ClientId, ol: Option<LId>, or: Option<LId>) -> Option<Option<Loc>> {
        let left = match ol {
            Some(id) => Some(self.seq.find(id)?),
            None => None,
        };
        let right = match or {
            Some(id) => Some(self.seq.find(id)?),
            None => None,
        };
        let left_key = left.map_or(START, |l| self.seq.key(l));
        let right_key = right.map_or(END, |l| self.seq.key(l));
        let key_of = |id: Option<LId>, none: Key| -> Key {
            match id {
                None => none,
                Some(id) => self.seq.find(id).map_or(none, |l| self.seq.key(l)),
            }
        };
        let mut cur = match left {
            Some(l) => self.seq.next_unit(l),
            None => self.seq.first_unit(),
        };
        let mut dest = cur;
        let mut scanning = false;
        loop {
            if !scanning {
                dest = cur;
            }
            let Some(loc) = cur else { break };
            let k = self.seq.key(loc);
            if k == right_key {
                break;
            }
            let p = self.seq.piece(loc);
            let oleft = if loc.off > 0 {
                (k.0, k.1, k.2 - 1)
            } else {
                key_of(p.ol, START)
            };
            if oleft < left_key {
                break;
            }
            if oleft == left_key {
                let oright = key_of(p.or, END);
                if oright < right_key {
                    scanning = true;
                } else if oright == right_key {
                    if client < self.clients[p.client as usize].id {
                        break;
                    }
                    scanning = false;
                } else {
                    scanning = false;
                }
            }
            // The rest of this piece has left origins inside the piece (> left): skip it,
            // unless the right origin lies within it.
            if let Some(r) = right
                && r.chunk == loc.chunk
                && r.idx == loc.idx
                && r.off > loc.off
            {
                cur = Some(r);
                continue;
            }
            cur = self.seq.next_piece_start(loc);
        }
        Some(dest)
    }

    /// Place a new insert run at `dest` and record it. Returns its visible position.
    fn place(
        &mut self,
        client: u32,
        clock: u64,
        ol: Option<LId>,
        or: Option<LId>,
        units: &[u16],
        dest: Option<Loc>,
    ) -> u64 {
        let len = units.len() as u64;
        self.clients[client as usize]
            .content
            .extend_from_slice(units);
        let pos = self.seq.insert(
            dest,
            Piece {
                client,
                clock,
                len,
                ol,
                or,
                deleted: false,
            },
        );
        self.log.push(LogEntry::Insert { client, clock, len });
        pos
    }

    fn apply_delete(
        &mut self,
        client: u32,
        clock: u64,
        len: u64,
        targets: Vec<(LId, u64)>,
        changes: &mut Vec<Change>,
    ) {
        let content = &mut self.clients[client as usize].content;
        content.resize(content.len() + len as usize, 0);
        for &(t, n) in &targets {
            self.seq.delete(t.client, t.clock, n, &mut |pos, len| {
                push_change(
                    changes,
                    Change::Delete {
                        pos: pos as usize,
                        len: len as usize,
                    },
                )
            });
        }
        self.log.push(LogEntry::Delete {
            client,
            clock,
            targets,
        });
    }

    /// Delete targets must be insert units and must not overlap each other. This bounds the
    /// clock space a delete op can consume by the number of inserted units.
    fn valid_targets(&self, targets: &[(LId, u64)]) -> bool {
        let mut sorted: Vec<(LId, u64)> = targets.to_vec();
        sorted.sort_unstable();
        for w in sorted.windows(2) {
            if w[0].0.client == w[1].0.client && w[0].0.clock + w[0].1 > w[1].0.clock {
                return false;
            }
        }
        targets.iter().all(|&(t, n)| {
            let mut covered = 0;
            self.segments(t, n, &mut |_, len, _| covered += len);
            covered == n
        })
    }

    fn contains(&self, id: Id) -> bool {
        id.clock < self.next_clock(id.client)
    }

    fn try_integrate(&mut self, mut op: Op, changes: &mut Vec<Change>) -> Outcome {
        let id = op.id();
        let len = op.len();
        let have = self.next_clock(id.client);
        if have >= id.clock + len {
            return Outcome::Dropped;
        }
        if have < id.clock {
            return Outcome::Blocked(op);
        }
        if have > id.clock {
            op.trim_front(have - id.clock);
        }
        match op {
            Op::Insert {
                id,
                ol,
                or,
                content,
            } => {
                if ol.is_some_and(|o| !self.contains(o)) || or.is_some_and(|o| !self.contains(o)) {
                    return Outcome::Blocked(Op::Insert {
                        id,
                        ol,
                        or,
                        content,
                    });
                }
                let ol_l = ol.and_then(|o| self.lid(o));
                let or_l = or.and_then(|o| self.lid(o));
                let Some(dest) = self.find_dest(id.client, ol_l, or_l) else {
                    return Outcome::Dropped; // origin is not an insert unit: invalid op
                };
                let c = self.intern(id.client);
                let pos = self.place(c, id.clock, ol_l, or_l, &content, dest);
                push_change(
                    changes,
                    Change::Insert {
                        pos: pos as usize,
                        text: String::from_utf16_lossy(&content),
                    },
                );
                Outcome::Integrated
            }
            Op::Delete { id, targets } => {
                if targets
                    .iter()
                    .any(|(t, n)| self.next_clock(t.client) < t.clock + n)
                {
                    return Outcome::Blocked(Op::Delete { id, targets });
                }
                let ltargets: Vec<(LId, u64)> = targets
                    .iter()
                    .map(|&(t, n)| (self.lid(t).expect("known client"), n))
                    .collect();
                if !self.valid_targets(&ltargets) {
                    return Outcome::Dropped;
                }
                let c = self.intern(id.client);
                let n = ltargets.iter().map(|t| t.1).sum();
                self.apply_delete(c, id.clock, n, ltargets, changes);
                Outcome::Integrated
            }
        }
    }

    // ---------------------------------------------------------------- sync

    pub fn state_vector(&self) -> StateVector {
        let mut m = BTreeMap::new();
        for c in &self.clients {
            if !c.content.is_empty() {
                m.insert(c.id, c.content.len() as u64);
            }
        }
        StateVector(m)
    }

    /// All integrated ops not covered by `since`.
    pub fn encode_diff(&self, since: &StateVector) -> Update {
        Update(encoding::encode_ops(&self.diff_ops(since, usize::MAX)))
    }

    pub fn encode_full(&self) -> Update {
        self.encode_diff(&StateVector::default())
    }

    pub(crate) fn diff_ops(&self, since: &StateVector, steps: usize) -> Vec<Op> {
        let mut ops = Vec::new();
        for e in self.log.iter().take(steps) {
            match e {
                LogEntry::Insert { client, clock, len } => {
                    let s = since.get(self.clients[*client as usize].id);
                    let end = clock + len;
                    if s < end {
                        self.emit_insert(*client, s.max(*clock), end, &mut ops);
                    }
                }
                LogEntry::Delete {
                    client,
                    clock,
                    targets,
                } => {
                    let cid = self.clients[*client as usize].id;
                    let s = since.get(cid);
                    let len: u64 = targets.iter().map(|t| t.1).sum();
                    if s >= clock + len {
                        continue;
                    }
                    let mut op = Op::Delete {
                        id: Id {
                            client: cid,
                            clock: *clock,
                        },
                        targets: targets.iter().map(|&(t, n)| (self.gid(t), n)).collect(),
                    };
                    if s > *clock {
                        op.trim_front(s - clock);
                    }
                    ops.push(op);
                }
            }
        }
        encoding::coalesce(ops)
    }

    fn emit_insert(&self, client: u32, start: u64, end: u64, ops: &mut Vec<Op>) {
        let cid = self.clients[client as usize].id;
        let mut k = start;
        while k < end {
            let Some(loc) = self.seq.find(LId { client, clock: k }) else {
                break;
            };
            let p = self.seq.piece(loc);
            let n = (p.clock + p.len).min(end) - k;
            let ol = if loc.off > 0 {
                Some(Id {
                    client: cid,
                    clock: k - 1,
                })
            } else {
                p.ol.map(|o| self.gid(o))
            };
            ops.push(Op::Insert {
                id: Id {
                    client: cid,
                    clock: k,
                },
                ol,
                or: p.or.map(|o| self.gid(o)),
                content: self.piece_text(p, k, k + n).to_vec(),
            });
            k += n;
        }
    }

    /// Idempotent and commutative. Returns the changes to apply to a view.
    ///
    /// Ops whose dependencies are missing are buffered, up to [`MAX_PENDING_UNITS`] /
    /// [`MAX_PENDING_BYTES`]. If this update would overflow that, the ops that don't fit are
    /// discarded and an error is returned; ops that could integrate stay integrated (so a view
    /// bound to this doc should resync from [`Doc::text`]).
    pub fn apply_update(&mut self, update: &Update) -> Result<Vec<Change>, DecodeError> {
        let ops = encoding::decode_ops(&update.0)?;
        let mut changes = Vec::new();
        let mut progressed = false;
        let mut overflow = false;
        for op in ops {
            match self.try_integrate(op, &mut changes) {
                Outcome::Integrated => progressed = true,
                Outcome::Blocked(op) => {
                    if !self.push_pending(op) {
                        overflow = true;
                    }
                }
                Outcome::Dropped => {}
            }
        }
        while progressed && !self.pending.is_empty() {
            progressed = false;
            for op in std::mem::take(&mut self.pending) {
                self.forget_pending(&op);
                match self.try_integrate(op, &mut changes) {
                    Outcome::Integrated => progressed = true,
                    // Only ever re-adds at most what was just removed, so it can't overflow.
                    Outcome::Blocked(op) => {
                        self.push_pending(op);
                    }
                    Outcome::Dropped => {}
                }
            }
        }
        if overflow {
            return Err(encoding::err(
                "too many out-of-order ops buffered (pending queue full)",
            ));
        }
        Ok(changes)
    }

    /// Buffers `op` unless it's a duplicate. Returns `false` if it didn't fit under the caps.
    fn push_pending(&mut self, op: Op) -> bool {
        let key = pending_key(&op);
        if self.pending_keys.contains(&key) {
            return true;
        }
        let (units, bytes) = pending_cost(&op);
        if self.pending_units + units > MAX_PENDING_UNITS
            || self.pending_bytes + bytes > MAX_PENDING_BYTES
        {
            return false;
        }
        self.pending_keys.insert(key);
        self.pending_units += units;
        self.pending_bytes += bytes;
        self.pending.push(op);
        true
    }

    /// Removes `op`'s accounting (the caller has already taken it out of `pending`).
    fn forget_pending(&mut self, op: &Op) {
        self.pending_keys.remove(&pending_key(op));
        let (units, bytes) = pending_cost(op);
        self.pending_units -= units;
        self.pending_bytes -= bytes;
    }

    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Number of buffered op runs awaiting dependencies.
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    // ---------------------------------------------------------------- cursors

    /// An anchor sticking to the character left of `pos` (`Start` at position 0).
    pub fn anchor_at(&self, pos: usize) -> Anchor {
        let pos = (pos as u64).min(self.seq.len());
        if pos == 0 {
            return Anchor::Start;
        }
        match self.seq.find_visible(pos - 1) {
            Some(l) => {
                let p = self.seq.piece(l);
                Anchor::After(self.gid(LId {
                    client: p.client,
                    clock: p.clock + l.off,
                }))
            }
            None => Anchor::End,
        }
    }

    pub fn resolve_anchor(&self, anchor: &Anchor) -> Option<usize> {
        match anchor {
            Anchor::Start => Some(0),
            Anchor::End => Some(self.len_utf16()),
            Anchor::After(id) => {
                let loc = self.seq.find(self.lid(*id)?)?;
                let vis = !self.seq.piece(loc).deleted as u64;
                Some((self.seq.visible_pos(loc) + vis) as usize)
            }
        }
    }

    /// Visible position of the unit `id` and whether it's deleted.
    pub(crate) fn locate(&self, id: LId) -> Option<(u64, bool, Key)> {
        let loc = self.seq.find(id)?;
        Some((
            self.seq.visible_pos(loc),
            self.seq.piece(loc).deleted,
            self.seq.key(loc),
        ))
    }

    /// Calls `f(id, len, deleted)` for the pieces covering `client:start..start+len`.
    pub(crate) fn segments(&self, id: LId, len: u64, f: &mut impl FnMut(LId, u64, bool)) {
        let end = id.clock + len;
        let mut k = id.clock;
        while k < end {
            let Some(loc) = self.seq.find(LId { clock: k, ..id }) else {
                match self.seq.next_start(id.client, k, end) {
                    Some(s) => {
                        k = s;
                        continue;
                    }
                    None => break,
                }
            };
            let p = self.seq.piece(loc);
            let n = (p.clock + p.len).min(end) - k;
            f(LId { clock: k, ..id }, n, p.deleted);
            k += n;
        }
    }

    pub(crate) fn unit_content(&self, id: LId, len: u64) -> &[u16] {
        &self.clients[id.client as usize].content[id.clock as usize..(id.clock + len) as usize]
    }

    // ---------------------------------------------------------------- history

    /// Number of op runs integrated, in local (causal) integration order.
    pub fn op_count(&self) -> usize {
        self.log.len()
    }

    /// Version after the first `step` integrated op runs.
    pub fn version_at(&self, step: usize) -> StateVector {
        let mut m = BTreeMap::new();
        for e in self.log.iter().take(step) {
            let (client, end) = match e {
                LogEntry::Insert { client, clock, len } => (*client, clock + len),
                LogEntry::Delete {
                    client,
                    clock,
                    targets,
                } => (*client, clock + targets.iter().map(|t| t.1).sum::<u64>()),
            };
            m.insert(self.clients[client as usize].id, end);
        }
        StateVector(m)
    }

    /// The text as of `version`.
    pub fn text_at(&self, version: &StateVector) -> String {
        let have = |c: u32| version.get(self.clients[c as usize].id);
        // Units deleted by delete ops inside `version`: per client, sorted disjoint ranges.
        let mut deleted: Vec<Vec<(u64, u64)>> = vec![Vec::new(); self.clients.len()];
        for e in &self.log {
            if let LogEntry::Delete {
                client,
                clock,
                targets,
            } = e
            {
                let mut budget = have(*client).saturating_sub(*clock);
                for &(t, n) in targets {
                    if budget == 0 {
                        break;
                    }
                    let n = n.min(budget);
                    budget -= n;
                    deleted[t.client as usize].push((t.clock, t.clock + n));
                }
            }
        }
        for d in &mut deleted {
            d.sort_unstable();
            let mut merged: Vec<(u64, u64)> = Vec::with_capacity(d.len());
            for &(a, b) in d.iter() {
                match merged.last_mut() {
                    Some(last) if a <= last.1 => last.1 = last.1.max(b),
                    _ => merged.push((a, b)),
                }
            }
            *d = merged;
        }
        let mut out: Vec<u16> = Vec::new();
        for p in self.seq.pieces() {
            let end = (p.clock + p.len).min(have(p.client));
            let mut k = p.clock;
            if k >= end {
                continue;
            }
            let ranges = &deleted[p.client as usize];
            let mut i = ranges.partition_point(|r| r.1 <= k);
            while k < end {
                let (seg_end, skip) = match ranges.get(i) {
                    Some(&(a, b)) if a <= k => (b.min(end), true),
                    Some(&(a, _)) => (a.min(end), false),
                    None => (end, false),
                };
                if skip {
                    i += 1;
                } else {
                    out.extend_from_slice(self.piece_text(p, k, seg_end));
                }
                k = seg_end;
            }
        }
        String::from_utf16_lossy(&out)
    }
}

impl Update {
    pub(crate) fn empty() -> Update {
        Update(encoding::encode_ops(&[]))
    }
}
