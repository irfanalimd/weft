use proptest::prelude::*;
use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng, rngs::StdRng};
use weft_core::{Doc, Update};

/// UTF-16 offsets that don't split a surrogate pair (including 0 and len).
fn boundaries(doc: &Doc) -> Vec<usize> {
    let units: Vec<u16> = doc.text().encode_utf16().collect();
    let mut b: Vec<usize> = (0..units.len())
        .filter(|&i| !(0xDC00..0xE000).contains(&units[i]))
        .collect();
    b.push(units.len());
    b
}

fn text_strategy() -> impl Strategy<Value = String> {
    prop::collection::vec(
        prop::sample::select(vec!["a", "b", "xyz", "é", "中", "😀", "\n", "👩‍👩‍👧"]),
        1..4,
    )
    .prop_map(|v| v.concat())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Random concurrent edits on 3-4 replicas; updates delivered in random order with
    /// duplicates (and occasional state-vector diffs) must converge to identical text and state.
    #[test]
    fn replicas_converge(
        n in 3usize..5,
        actions in prop::collection::vec((0usize..4, 0u8..11, any::<u64>(), any::<u64>(), text_strategy()), 1..80),
        seed in any::<u64>(),
    ) {
        let mut docs: Vec<Doc> = (0..n).map(|i| Doc::new(0x9e37_79b9_7f4a_7c15u64.wrapping_mul(i as u64 + 1))).collect();
        let mut pool: Vec<Update> = Vec::new();
        for (r, kind, a, b, text) in actions {
            let r = r % n;
            match kind {
                0..=3 => {
                    let bs = boundaries(&docs[r]);
                    let pos = bs[(a % bs.len() as u64) as usize];
                    pool.push(docs[r].insert(pos, &text));
                }
                4..=5 => {
                    let bs = boundaries(&docs[r]);
                    let i = (a % bs.len() as u64) as usize;
                    let j = i + (b % (bs.len() - i) as u64) as usize;
                    let u = docs[r].delete(bs[i], bs[j] - bs[i]);
                    if !u.is_empty() {
                        pool.push(u);
                    }
                }
                6..=7 if !pool.is_empty() => {
                    let u = pool[(a % pool.len() as u64) as usize].clone();
                    docs[r].apply_update(&u).unwrap();
                }
                8..=9 if !pool.is_empty() => {
                    // A merged batch of random updates: overlaps with what the replica has.
                    let k = (a % pool.len() as u64) as usize;
                    let m = Update::merge(&pool[k..]).unwrap();
                    docs[r].apply_update(&m).unwrap();
                }
                _ => {
                    let from = (b % n as u64) as usize;
                    let diff = docs[from].encode_diff(&docs[r].state_vector());
                    docs[r].apply_update(&diff).unwrap();
                }
            }
        }
        let mut rng = StdRng::seed_from_u64(seed);
        for doc in docs.iter_mut() {
            let mut order: Vec<&Update> = pool.iter().chain(pool.iter()).collect();
            order.shuffle(&mut rng);
            for u in order {
                if rng.random_bool(0.1) {
                    doc.apply_update(u).unwrap();
                }
                doc.apply_update(u).unwrap();
            }
            prop_assert!(!doc.has_pending());
        }
        for d in &docs[1..] {
            prop_assert_eq!(d.text(), docs[0].text());
            prop_assert_eq!(d.state_vector(), docs[0].state_vector());
        }
    }
}

/// `apply_update` (and the other decoders) must never panic on arbitrary bytes.
#[test]
fn random_bytes_never_panic() {
    let mut rng = StdRng::seed_from_u64(7);
    let mut doc = Doc::new(1);
    let base = doc.insert(0, "hello 😀 world");
    doc.delete(2, 3);
    let valid = doc.encode_full().0;
    for i in 0..20_000 {
        let bytes: Vec<u8> = if i % 2 == 0 {
            let len = rng.random_range(0..64);
            let mut b: Vec<u8> = (0..len).map(|_| rng.random()).collect();
            if !b.is_empty() && rng.random_bool(0.5) {
                b[0] = 1; // valid version byte, garbage body
            }
            b
        } else {
            // Mutate a valid update.
            let mut b = valid.clone();
            for _ in 0..rng.random_range(1..4) {
                let k = rng.random_range(0..b.len());
                b[k] = rng.random();
            }
            b
        };
        let u = Update(bytes.clone());
        let mut d = Doc::new(2);
        let _ = d.apply_update(&base);
        let _ = d.apply_update(&u);
        let _ = d.text();
        let _ = d.encode_full();
        let _ = u.is_empty();
        let _ = Update::merge(&[base.clone(), u]);
        let _ = weft_core::StateVector::decode(&bytes);
        let _ = weft_core::Anchor::decode(&bytes);
    }
}
