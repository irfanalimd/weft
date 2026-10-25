//! `Update::merge`: dedupe overlapping ops and emit them in a dependency-respecting order.

use crate::encoding::{self, Op};
use crate::{ClientId, DecodeError, Id, Update};
use std::collections::BTreeMap;

pub(crate) fn merge(updates: &[Update]) -> Result<Update, DecodeError> {
    let mut by: BTreeMap<ClientId, Vec<Op>> = BTreeMap::new();
    for u in updates {
        if u.0.is_empty() {
            continue;
        }
        for op in encoding::decode_ops(&u.0)? {
            by.entry(op.id().client).or_default().push(op);
        }
    }
    // Per client: sort by clock and drop/trim overlaps.
    let mut lists: Vec<Vec<Op>> = Vec::with_capacity(by.len());
    let mut spans: Vec<Vec<(u64, u64)>> = Vec::with_capacity(by.len());
    let mut index: BTreeMap<ClientId, usize> = BTreeMap::new();
    for (c, mut ops) in by {
        ops.sort_by_key(|o| o.id().clock);
        let mut out: Vec<Op> = Vec::with_capacity(ops.len());
        let mut covered = 0u64;
        for mut op in ops {
            let start = op.id().clock;
            let end = start + op.len();
            if !out.is_empty() && start < covered {
                if end <= covered {
                    continue;
                }
                op.trim_front(covered - start);
            }
            covered = end;
            out.push(op);
        }
        index.insert(c, lists.len());
        spans.push(
            out.iter()
                .map(|o| (o.id().clock, o.id().clock + o.len()))
                .collect(),
        );
        lists.push(out);
    }

    let mut emitted = vec![0usize; lists.len()];
    // Is every op in the set that covers part of `client:start..end` already emitted?
    let ready_range = |emitted: &[usize], id: Id, len: u64| -> bool {
        let Some(&ci) = index.get(&id.client) else {
            return true;
        };
        let sp = &spans[ci];
        let end = id.clock.saturating_add(len);
        let j = sp.partition_point(|r| r.0 < end);
        // ops [0, j) start before `end`; the last of them matters if it reaches into the range.
        j == 0 || sp[j - 1].1 <= id.clock || j <= emitted[ci]
    };
    let ready = |emitted: &[usize], op: &Op| -> bool {
        match op {
            Op::Insert { ol, or, .. } => ol
                .iter()
                .chain(or.iter())
                .all(|o| ready_range(emitted, *o, 1)),
            Op::Delete { targets, .. } => targets.iter().all(|t| ready_range(emitted, t.0, t.1)),
        }
    };
    let total: usize = lists.iter().map(Vec::len).sum();
    let mut out: Vec<Op> = Vec::with_capacity(total);
    while out.len() < total {
        let mut progress = false;
        for ci in 0..lists.len() {
            while emitted[ci] < lists[ci].len() && ready(&emitted, &lists[ci][emitted[ci]]) {
                out.push(lists[ci][emitted[ci]].clone());
                emitted[ci] += 1;
                progress = true;
            }
        }
        if !progress {
            // Unsatisfiable dependencies (invalid input): emit something to make progress.
            let ci = (0..lists.len())
                .find(|&ci| emitted[ci] < lists[ci].len())
                .expect("ops remain");
            out.push(lists[ci][emitted[ci]].clone());
            emitted[ci] += 1;
        }
    }
    Ok(Update(encoding::encode_ops(&encoding::coalesce(out))))
}
