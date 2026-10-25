//! The item sequence: run-length-encoded pieces (insert runs, possibly tombstoned) in document
//! order, stored in a chunked list with cached visible (UTF-16) lengths per chunk, plus a per-client
//! index from piece start clock to chunk for O(log n) id lookup.

use std::collections::BTreeMap;

/// Internal id: client is an index into the doc's client table.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct LId {
    pub client: u32,
    pub clock: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Piece {
    pub client: u32,
    pub clock: u64,
    pub len: u64,
    /// Left origin of the first unit (later units' left origin is the previous unit).
    pub ol: Option<LId>,
    /// Right origin shared by all units of the piece.
    pub or: Option<LId>,
    pub deleted: bool,
}

impl Piece {
    #[inline]
    pub fn vis(&self) -> u64 {
        if self.deleted { 0 } else { self.len }
    }
}

/// Can `b` be appended to `a` as one run?
#[inline]
fn can_append(a: &Piece, b: &Piece) -> bool {
    a.client == b.client
        && a.clock + a.len == b.clock
        && a.deleted == b.deleted
        && a.or == b.or
        && b.ol
            == Some(LId {
                client: a.client,
                clock: b.clock - 1,
            })
}

/// Location of a unit: chunk (slab id), piece index within chunk, offset within piece.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Loc {
    pub chunk: u32,
    pub idx: usize,
    pub off: u64,
}

/// Totally ordered position key: (chunk order + 1, piece index, offset). `START` < all < `END`.
pub(crate) type Key = (usize, usize, u64);
pub(crate) const START: Key = (0, 0, 0);
pub(crate) const END: Key = (usize::MAX, 0, 0);

const MAX_PIECES: usize = 64;

#[derive(Clone, Debug)]
struct Chunk {
    pieces: Vec<Piece>,
    order: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct Seq {
    chunks: Vec<Chunk>,
    /// Chunk slab ids in document order.
    order: Vec<u32>,
    /// Visible length of each chunk, indexed by order position.
    vis: Vec<u64>,
    total_vis: u64,
    /// Per client: piece start clock -> chunk slab id.
    index: Vec<BTreeMap<u64, u32>>,
    /// Cursor cache: (order position, visible units before that chunk).
    cache: std::cell::Cell<(usize, u64)>,
}

impl Seq {
    pub fn new() -> Self {
        Seq {
            chunks: vec![Chunk {
                pieces: Vec::new(),
                order: 0,
            }],
            order: vec![0],
            vis: vec![0],
            total_vis: 0,
            index: Vec::new(),
            cache: std::cell::Cell::new((0, 0)),
        }
    }

    pub fn add_client(&mut self) {
        self.index.push(BTreeMap::new());
    }

    pub fn len(&self) -> u64 {
        self.total_vis
    }

    pub fn pieces(&self) -> impl Iterator<Item = &Piece> + '_ {
        self.order
            .iter()
            .flat_map(move |&c| self.chunks[c as usize].pieces.iter())
    }

    #[inline]
    pub fn piece(&self, loc: Loc) -> &Piece {
        &self.chunks[loc.chunk as usize].pieces[loc.idx]
    }

    #[inline]
    pub fn key(&self, loc: Loc) -> Key {
        (self.chunks[loc.chunk as usize].order + 1, loc.idx, loc.off)
    }

    pub fn find(&self, id: LId) -> Option<Loc> {
        let (&start, &chunk) = self
            .index
            .get(id.client as usize)?
            .range(..=id.clock)
            .next_back()?;
        let pieces = &self.chunks[chunk as usize].pieces;
        let idx = pieces
            .iter()
            .position(|p| p.clock == start && p.client == id.client)?;
        let off = id.clock - start;
        if off >= pieces[idx].len {
            return None;
        }
        Some(Loc { chunk, idx, off })
    }

    /// The smallest piece start clock of `client` in `(after, before)`.
    pub fn next_start(&self, client: u32, after: u64, before: u64) -> Option<u64> {
        if after.saturating_add(1) >= before {
            return None;
        }
        self.index
            .get(client as usize)?
            .range(after + 1..before)
            .next()
            .map(|(&k, _)| k)
    }

    fn first_in_order_from(&self, order_pos: usize) -> Option<Loc> {
        for &c in &self.order[order_pos..] {
            if !self.chunks[c as usize].pieces.is_empty() {
                return Some(Loc {
                    chunk: c,
                    idx: 0,
                    off: 0,
                });
            }
        }
        None
    }

    pub fn first_unit(&self) -> Option<Loc> {
        self.first_in_order_from(0)
    }

    pub fn next_piece_start(&self, loc: Loc) -> Option<Loc> {
        let ch = &self.chunks[loc.chunk as usize];
        if loc.idx + 1 < ch.pieces.len() {
            return Some(Loc {
                chunk: loc.chunk,
                idx: loc.idx + 1,
                off: 0,
            });
        }
        self.first_in_order_from(ch.order + 1)
    }

    pub fn next_unit(&self, loc: Loc) -> Option<Loc> {
        if loc.off + 1 < self.piece(loc).len {
            return Some(Loc {
                off: loc.off + 1,
                ..loc
            });
        }
        self.next_piece_start(loc)
    }

    /// Visible units before the chunk at order position `o`.
    fn prefix(&self, o: usize) -> u64 {
        let (co, cv) = self.cache.get();
        // Walk from the cached point, or from whichever end is closer.
        let v = if o >= co {
            if o - co <= self.order.len() - o {
                cv + self.vis[co..o].iter().sum::<u64>()
            } else {
                self.total_vis - self.vis[o..].iter().sum::<u64>()
            }
        } else if co - o <= o {
            cv - self.vis[o..co].iter().sum::<u64>()
        } else {
            self.vis[..o].iter().sum::<u64>()
        };
        self.cache.set((o, v));
        v
    }

    /// Adjust the cursor cache after the visible length of chunk at order `o` changed by `d`.
    fn vis_changed(&mut self, o: usize, add: u64, sub: u64) {
        self.vis[o] = self.vis[o] + add - sub;
        self.total_vis = self.total_vis + add - sub;
        let (co, cv) = self.cache.get();
        if co > o {
            self.cache.set((co, cv + add - sub));
        }
    }

    /// Location of the `p`-th visible unit (0-based).
    pub fn find_visible(&self, p: u64) -> Option<Loc> {
        if p >= self.total_vis {
            return None;
        }
        let (mut o, mut cum) = self.cache.get();
        // Move backwards / forwards from the cached chunk.
        while cum > p {
            o -= 1;
            cum -= self.vis[o];
        }
        while cum + self.vis[o] <= p {
            cum += self.vis[o];
            o += 1;
        }
        self.cache.set((o, cum));
        let c = self.order[o];
        for (idx, piece) in self.chunks[c as usize].pieces.iter().enumerate() {
            let v = piece.vis();
            if p < cum + v {
                return Some(Loc {
                    chunk: c,
                    idx,
                    off: p - cum,
                });
            }
            cum += v;
        }
        None
    }

    /// Number of visible units strictly before `loc`.
    pub fn visible_pos(&self, loc: Loc) -> u64 {
        let ch = &self.chunks[loc.chunk as usize];
        let mut v = self.prefix(ch.order);
        for p in &ch.pieces[..loc.idx] {
            v += p.vis();
        }
        if !ch.pieces[loc.idx].deleted {
            v += loc.off;
        }
        v
    }

    fn split(&mut self, chunk: u32, idx: usize, off: u64) {
        let p = &mut self.chunks[chunk as usize].pieces[idx];
        let right = Piece {
            client: p.client,
            clock: p.clock + off,
            len: p.len - off,
            ol: Some(LId {
                client: p.client,
                clock: p.clock + off - 1,
            }),
            or: p.or,
            deleted: p.deleted,
        };
        p.len = off;
        self.index[right.client as usize].insert(right.clock, chunk);
        self.chunks[chunk as usize].pieces.insert(idx + 1, right);
    }

    fn maybe_split_chunk(&mut self, chunk: u32) {
        if self.chunks[chunk as usize].pieces.len() <= MAX_PIECES {
            return;
        }
        let new_id = self.chunks.len() as u32;
        let ch = &mut self.chunks[chunk as usize];
        let half = ch.pieces.len() / 2;
        let moved = ch.pieces.split_off(half);
        let o = ch.order;
        let moved_vis: u64 = moved.iter().map(Piece::vis).sum();
        for p in &moved {
            self.index[p.client as usize].insert(p.clock, new_id);
        }
        self.chunks.push(Chunk {
            pieces: moved,
            order: o + 1,
        });
        self.order.insert(o + 1, new_id);
        self.vis[o] -= moved_vis;
        self.vis.insert(o + 1, moved_vis);
        for k in o + 2..self.order.len() {
            self.chunks[self.order[k] as usize].order = k;
        }
        let (co, cv) = self.cache.get();
        if co > o {
            self.cache.set((co + 1, cv));
        }
    }

    /// Insert `piece` before the unit at `dest` (or at the end if `None`). Returns the visible
    /// position of its first unit.
    pub fn insert(&mut self, dest: Option<Loc>, piece: Piece) -> u64 {
        let (chunk, idx) = match dest {
            Some(l) if l.off > 0 => {
                self.split(l.chunk, l.idx, l.off);
                (l.chunk, l.idx + 1)
            }
            Some(l) if l.idx == 0 && self.chunks[l.chunk as usize].order > 0 => {
                // Prefer appending to the previous chunk so the run can merge with its predecessor.
                let prev = self.order[self.chunks[l.chunk as usize].order - 1];
                (prev, self.chunks[prev as usize].pieces.len())
            }
            Some(l) => (l.chunk, l.idx),
            None => {
                let last = *self.order.last().unwrap();
                (last, self.chunks[last as usize].pieces.len())
            }
        };
        let o = self.chunks[chunk as usize].order;
        let mut pos = self.prefix(o);
        let ch = &mut self.chunks[chunk as usize];
        for p in &ch.pieces[..idx] {
            pos += p.vis();
        }
        let len = piece.len;
        if idx > 0 && can_append(&ch.pieces[idx - 1], &piece) {
            ch.pieces[idx - 1].len += len;
        } else {
            self.index[piece.client as usize].insert(piece.clock, chunk);
            ch.pieces.insert(idx, piece);
        }
        self.vis_changed(o, len, 0);
        self.maybe_split_chunk(chunk);
        pos
    }

    /// Tombstone units `client:start..start+len`. Calls `out(pos, len)` for each newly deleted
    /// visible segment, with positions valid when applied sequentially.
    pub fn delete(&mut self, client: u32, start: u64, len: u64, out: &mut impl FnMut(u64, u64)) {
        let end = start + len;
        let mut k = start;
        while k < end {
            let Some(loc) = self.find(LId { client, clock: k }) else {
                match self.next_start(client, k, end) {
                    Some(s) => {
                        k = s;
                        continue;
                    }
                    None => break,
                }
            };
            let p = self.piece(loc);
            let seg_end = end.min(p.clock + p.len);
            if p.deleted {
                k = seg_end;
                continue;
            }
            let chunk = loc.chunk;
            let mut idx = loc.idx;
            if loc.off > 0 {
                self.split(chunk, idx, loc.off);
                idx += 1;
            }
            let seg = seg_end - k;
            if seg < self.chunks[chunk as usize].pieces[idx].len {
                self.split(chunk, idx, seg);
            }
            let pos = self.visible_pos(Loc { chunk, idx, off: 0 });
            let o = self.chunks[chunk as usize].order;
            self.chunks[chunk as usize].pieces[idx].deleted = true;
            self.vis_changed(o, 0, seg);
            out(pos, seg);
            // Re-merge tombstones with their neighbours.
            let pieces = &mut self.chunks[chunk as usize].pieces;
            if idx + 1 < pieces.len() && can_append(&pieces[idx], &pieces[idx + 1]) {
                let n = pieces.remove(idx + 1);
                pieces[idx].len += n.len;
                self.index[n.client as usize].remove(&n.clock);
            }
            if idx > 0 && can_append(&pieces[idx - 1], &pieces[idx]) {
                let n = pieces.remove(idx);
                pieces[idx - 1].len += n.len;
                self.index[n.client as usize].remove(&n.clock);
            }
            self.maybe_split_chunk(chunk);
            k = seg_end;
        }
    }
}
