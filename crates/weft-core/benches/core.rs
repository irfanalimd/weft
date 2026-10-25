//! Benchmarks: sequential typing, random edits, and the automerge-paper editing trace
//! (259,778 single-character patches; from https://github.com/josephg/editing-traces,
//! `sequential_traces/automerge-paper.json.gz`, converted to `data/automerge-paper.bin` as
//! LEB128 `(pos, del, utf8_len, utf8 bytes)` records). The trace is trusted dev-only data and is
//! read only by this benchmark, never by `weft-core` itself.

use criterion::{BatchSize, Criterion, Throughput, criterion_group, criterion_main};
use rand::{Rng, SeedableRng, rngs::StdRng};
use std::hint::black_box;
use weft_core::{Doc, Update};

struct Patch {
    pos: usize,
    del: usize,
    ins: String,
}

fn load_trace() -> (Vec<Patch>, String) {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/benches/data");
    let bin = std::fs::read(format!("{dir}/automerge-paper.bin")).expect("trace data");
    let end = std::fs::read_to_string(format!("{dir}/automerge-paper.end.txt")).expect("end text");
    let mut patches = Vec::new();
    let mut i = 0;
    let rd = |i: &mut usize| {
        let mut v = 0usize;
        let mut shift = 0;
        loop {
            let b = bin[*i];
            *i += 1;
            v |= ((b & 0x7f) as usize) << shift;
            shift += 7;
            if b & 0x80 == 0 {
                return v;
            }
        }
    };
    while i < bin.len() {
        let pos = rd(&mut i);
        let del = rd(&mut i);
        let n = rd(&mut i);
        let ins = String::from_utf8(bin[i..i + n].to_vec()).unwrap();
        i += n;
        patches.push(Patch { pos, del, ins });
    }
    (patches, end)
}

fn replay_local(patches: &[Patch]) -> (Doc, Vec<Update>) {
    let mut doc = Doc::new(1);
    let mut updates = Vec::with_capacity(patches.len());
    for p in patches {
        if p.del > 0 {
            updates.push(doc.delete(p.pos, p.del));
        }
        if !p.ins.is_empty() {
            updates.push(doc.insert(p.pos, &p.ins));
        }
    }
    (doc, updates)
}

fn benches(c: &mut Criterion) {
    let (patches, end) = load_trace();
    let (doc, updates) = replay_local(&patches);
    assert_eq!(
        doc.text(),
        end,
        "trace replay must reproduce the final document"
    );

    let mut g = c.benchmark_group("trace");
    g.sample_size(10);
    g.throughput(Throughput::Elements(patches.len() as u64));
    g.bench_function("automerge-paper/local", |b| {
        b.iter(|| black_box(replay_local(&patches).0.len_utf16()))
    });
    g.bench_function("automerge-paper/remote", |b| {
        b.iter(|| {
            let mut d = Doc::new(2);
            for u in &updates {
                d.apply_update(u).unwrap();
            }
            black_box(d.len_utf16())
        })
    });
    let full = doc.encode_full();
    g.throughput(Throughput::Bytes(full.0.len() as u64));
    g.bench_function("automerge-paper/encode_full", |b| {
        b.iter(|| black_box(doc.encode_full().0.len()))
    });
    g.bench_function("automerge-paper/load_full", |b| {
        b.iter(|| black_box(Doc::from_update(3, &full).unwrap().len_utf16()))
    });
    g.finish();

    let mut g = c.benchmark_group("edits");
    const N: usize = 10_000;
    g.throughput(Throughput::Elements(N as u64));
    g.bench_function("sequential_typing_10k", |b| {
        b.iter(|| {
            let mut d = Doc::new(1);
            for i in 0..N {
                d.insert(i, "x");
            }
            black_box(d.len_utf16())
        })
    });
    g.bench_function("random_edits_10k", |b| {
        b.iter_batched(
            || StdRng::seed_from_u64(42),
            |mut rng| {
                let mut d = Doc::new(1);
                for _ in 0..N {
                    let len = d.len_utf16();
                    if len > 0 && rng.random_bool(0.3) {
                        let pos = rng.random_range(0..len);
                        d.delete(pos, rng.random_range(1..=(len - pos).min(5)));
                    } else {
                        d.insert(rng.random_range(0..=len), "abc");
                    }
                }
                black_box(d.len_utf16())
            },
            BatchSize::SmallInput,
        )
    });
    g.finish();
}

criterion_group!(core, benches);
criterion_main!(core);
