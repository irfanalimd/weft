//! Local undo/redo. Undoing an insert deletes those items; undoing a delete re-inserts the deleted
//! text as new items. Only ops passed to [`UndoManager::track`] are undoable, so remote edits are
//! never undone.

use crate::encoding::{self, Op};
use crate::seq::{Key, LId};
use crate::{Change, Doc, Id, Update};

#[derive(Clone, Debug)]
enum UndoOp {
    /// Units that were inserted.
    Inserted(Vec<(Id, u64)>),
    /// Units that were deleted.
    Deleted(Vec<(Id, u64)>),
}

/// What an undo/redo did: the update to broadcast and the changes to apply to the view.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UndoResult {
    pub update: Update,
    pub changes: Vec<Change>,
}

/// Undo/redo stack for one replica's local edits.
#[derive(Clone, Debug)]
pub struct UndoManager {
    undo: Vec<Vec<UndoOp>>,
    redo: Vec<Vec<UndoOp>>,
    capture_ms: u64,
    last_ms: Option<u64>,
}

impl Default for UndoManager {
    fn default() -> Self {
        Self::new()
    }
}

impl UndoManager {
    /// New manager; edits tracked with [`track_at`](Self::track_at) within 500 ms are grouped.
    pub fn new() -> Self {
        Self::with_capture_timeout(500)
    }

    pub fn with_capture_timeout(capture_ms: u64) -> Self {
        UndoManager {
            undo: Vec::new(),
            redo: Vec::new(),
            capture_ms,
            last_ms: None,
        }
    }

    /// Record a local update (as returned by `Doc::insert`/`Doc::delete`) as its own undo step.
    pub fn track(&mut self, update: &Update) {
        self.last_ms = None;
        self.push(update, false);
    }

    /// Record a local update made at `now_ms`; it joins the previous step if that was tracked
    /// less than the capture timeout ago.
    pub fn track_at(&mut self, update: &Update, now_ms: u64) {
        let join = self
            .last_ms
            .is_some_and(|t| now_ms.saturating_sub(t) < self.capture_ms);
        self.last_ms = Some(now_ms);
        self.push(update, join);
    }

    /// The next tracked edit starts a new undo step.
    pub fn stop_capturing(&mut self) {
        self.last_ms = None;
    }

    fn push(&mut self, update: &Update, join: bool) {
        let Ok(ops) = encoding::decode_ops(&update.0) else {
            return;
        };
        let mut group: Vec<UndoOp> = ops
            .into_iter()
            .map(|op| match op {
                Op::Insert { id, content, .. } => {
                    UndoOp::Inserted(vec![(id, content.len() as u64)])
                }
                Op::Delete { targets, .. } => UndoOp::Deleted(targets),
            })
            .collect();
        if group.is_empty() {
            return;
        }
        self.redo.clear();
        match self.undo.last_mut() {
            Some(last) if join => last.append(&mut group),
            _ => self.undo.push(group),
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.last_ms = None;
    }

    /// Undo the last step. Returns `None` if there is nothing (left) to undo.
    pub fn undo(&mut self, doc: &mut Doc) -> Option<UndoResult> {
        self.last_ms = None;
        Self::step(doc, &mut self.undo, &mut self.redo)
    }

    pub fn redo(&mut self, doc: &mut Doc) -> Option<UndoResult> {
        self.last_ms = None;
        Self::step(doc, &mut self.redo, &mut self.undo)
    }

    fn step(
        doc: &mut Doc,
        from: &mut Vec<Vec<UndoOp>>,
        to: &mut Vec<Vec<UndoOp>>,
    ) -> Option<UndoResult> {
        while let Some(group) = from.pop() {
            let mut ops = Vec::new();
            let mut changes = Vec::new();
            let mut inverse = Vec::new();
            for u in group.iter().rev() {
                invert(doc, u, &mut ops, &mut changes, &mut inverse);
            }
            if ops.is_empty() {
                continue; // already undone by others; try the next step
            }
            to.push(inverse);
            let update = Update(encoding::encode_ops(&encoding::coalesce(ops)));
            return Some(UndoResult { update, changes });
        }
        None
    }
}

fn invert(
    doc: &mut Doc,
    u: &UndoOp,
    ops: &mut Vec<Op>,
    changes: &mut Vec<Change>,
    inverse: &mut Vec<UndoOp>,
) {
    match u {
        UndoOp::Inserted(ranges) => {
            // Delete whatever of those units is still visible.
            let mut targets: Vec<(LId, u64)> = Vec::new();
            for &(id, n) in ranges {
                if let Some(l) = doc.lid(id) {
                    doc.segments(l, n, &mut |s, len, deleted| {
                        if !deleted {
                            targets.push((s, len));
                        }
                    });
                }
            }
            let gids: Vec<(Id, u64)> = targets.iter().map(|&(t, n)| (doc.gid(t), n)).collect();
            if let Some(op) = doc.local_delete_targets(targets, changes) {
                ops.push(op);
                inverse.push(UndoOp::Deleted(gids));
            }
        }
        UndoOp::Deleted(ranges) => {
            // Re-insert the deleted text where its tombstones are, grouped by visible position.
            let mut segs: Vec<(Key, u64, LId, u64)> = Vec::new();
            for &(id, n) in ranges {
                let Some(l) = doc.lid(id) else { continue };
                let mut found = Vec::new();
                doc.segments(l, n, &mut |s, len, deleted| {
                    if deleted {
                        found.push((s, len));
                    }
                });
                for (s, len) in found {
                    if let Some((pos, _, key)) = doc.locate(s) {
                        segs.push((key, pos, s, len));
                    }
                }
            }
            segs.sort_unstable_by_key(|s| s.0);
            let mut groups: Vec<(u64, Vec<u16>)> = Vec::new();
            for (_, pos, s, len) in segs {
                let content = doc.unit_content(s, len);
                match groups.last_mut() {
                    Some(g) if g.0 == pos => g.1.extend_from_slice(content),
                    _ => groups.push((pos, content.to_vec())),
                }
            }
            let mut inserted = Vec::new();
            // Insert from the back so earlier positions stay valid.
            let mut local_changes = Vec::new();
            for (pos, units) in groups.into_iter().rev() {
                if let Some((op, at)) = doc.local_insert(pos as usize, &units) {
                    inserted.push((op.id(), units.len() as u64));
                    local_changes.push(Change::Insert {
                        pos: at as usize,
                        text: String::from_utf16_lossy(&units),
                    });
                    ops.push(op);
                }
            }
            changes.extend(local_changes);
            if !inserted.is_empty() {
                inverse.push(UndoOp::Inserted(inserted));
            }
        }
    }
}
