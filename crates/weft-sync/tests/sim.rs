//! Deterministic network simulator: N `ClientSession`s + 1 `Room` over faulty links.
//!
//! Links model WebSockets: ordered and reliable while alive, but connections die. A "drop" is a
//! connection reset (in-flight frames on both directions are lost, both ends are told), followed
//! by a reconnect with a fresh handshake. On top of that, links may duplicate and reorder frames
//! (harsher than TCP, to prove the protocol is idempotent), delay them, partition clients for a
//! while, and crash the server (it restarts from its persisted log).
//!
//! After the faulty phase we heal (faults off, every link reset, everyone reconnects) and run
//! until quiet. Then every replica must equal the server's text and state vector.
//!
//! Reproduce one seed: `WEFT_SIM_SEED=1234 cargo test -p weft-sync --test sim -- --nocapture`.

use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};

use weft_core::{Change, Doc, Update};
use weft_sync::{ClientSession, Message, Room};

const SERVER_CLIENT_ID: u64 = 0;
const DOC_ID: &str = "sim-doc";

/// SplitMix64: tiny, deterministic everywhere.
struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next_u64() % n }
    }
    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / ((1u64 << 53) as f64)
    }
    fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }
    fn range_f64(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.unit()
    }
}

struct Faults {
    reset: f64,
    dup: f64,
    reorder: f64,
    max_delay: u64,
    disconnect: f64,
    partition: f64,
    crash: f64,
}

impl Faults {
    fn none() -> Self {
        Faults {
            reset: 0.0,
            dup: 0.0,
            reorder: 0.0,
            max_delay: 1,
            disconnect: 0.0,
            partition: 0.0,
            crash: 0.0,
        }
    }
}

struct Packet {
    at: u64,
    seq: u64,
    bytes: Vec<u8>,
}

struct Link {
    client: usize,
    to_server: Vec<Packet>,
    to_client: Vec<Packet>,
    last_to_server: u64,
    last_to_client: u64,
}

struct Client {
    session: ClientSession,
    /// What an editor would show: built only from local edits and returned `Change`s.
    shadow: Vec<u16>,
    conn: Option<u64>,
    reconnect_at: u64,
    partitioned_until: u64,
    awareness_version: u64,
}

struct Sim {
    rng: Rng,
    now: u64,
    seq: u64,
    faults: Faults,
    room: Room,
    log: Vec<Update>,
    clients: Vec<Client>,
    links: BTreeMap<u64, Link>,
    next_conn: u64,
    /// Latest awareness payload per client id.
    awareness: BTreeMap<u64, Vec<u8>>,
}

const PIECES: &[&str] = &[
    "a", "b", "c", "xyz", " ", "\n", "# ", "é", "中文", "😀", "👍🏽", "🧵", "\u{200d}",
];

fn utf16_boundaries(text: &str) -> Vec<usize> {
    let mut out = vec![0];
    let mut pos = 0;
    for ch in text.chars() {
        pos += ch.len_utf16();
        out.push(pos);
    }
    out
}

fn apply_changes(shadow: &mut Vec<u16>, changes: &[Change]) {
    for c in changes {
        match c {
            Change::Insert { pos, text } => {
                assert!(*pos <= shadow.len(), "change insert out of range");
                let units: Vec<u16> = text.encode_utf16().collect();
                shadow.splice(*pos..*pos, units);
            }
            Change::Delete { pos, len } => {
                assert!(pos + len <= shadow.len(), "change delete out of range");
                shadow.drain(*pos..pos + len);
            }
        }
    }
}

impl Sim {
    fn new(seed: u64) -> Self {
        let mut rng = Rng(seed);
        let n_clients = 2 + rng.below(4) as usize;
        let faults = Faults {
            reset: rng.range_f64(0.0, 0.08),
            dup: rng.range_f64(0.0, 0.1),
            reorder: rng.range_f64(0.0, 0.15),
            max_delay: 1 + rng.below(6),
            disconnect: rng.range_f64(0.0, 0.02),
            partition: rng.range_f64(0.0, 0.01),
            crash: rng.range_f64(0.0, 0.003),
        };
        let clients = (0..n_clients)
            .map(|i| Client {
                // Distinct, non-zero ids that don't sort in creation order.
                session: ClientSession::new(
                    DOC_ID.into(),
                    Doc::new((i as u64 + 1).wrapping_mul(0x9E37_79B9) ^ seed.rotate_left(17) | 1),
                ),
                shadow: Vec::new(),
                conn: None,
                reconnect_at: rng.below(5),
                partitioned_until: 0,
                awareness_version: 0,
            })
            .collect();
        Sim {
            rng,
            now: 0,
            seq: 0,
            faults,
            room: Room::new(DOC_ID.into(), Doc::new(SERVER_CLIENT_ID)),
            log: Vec::new(),
            clients,
            links: BTreeMap::new(),
            next_conn: 1,
            awareness: BTreeMap::new(),
        }
    }

    fn schedule(&mut self, conn: u64, to_server: bool, msg: &Message) {
        let copies = if self.rng.chance(self.faults.dup) {
            2
        } else {
            1
        };
        for _ in 0..copies {
            let delay = 1 + self.rng.below(self.faults.max_delay);
            let reorder = self.rng.chance(self.faults.reorder);
            self.seq += 1;
            let seq = self.seq;
            let now = self.now;
            let Some(link) = self.links.get_mut(&conn) else {
                return;
            };
            let last = if to_server {
                &mut link.last_to_server
            } else {
                &mut link.last_to_client
            };
            // FIFO unless this frame is chosen to be reordered.
            let at = if reorder {
                now + delay
            } else {
                (now + delay).max(*last)
            };
            *last = (*last).max(at);
            let pkt = Packet {
                at,
                seq,
                bytes: msg.encode(),
            };
            if to_server {
                link.to_server.push(pkt);
            } else {
                link.to_client.push(pkt);
            }
        }
    }

    fn send_from_client(&mut self, i: usize, msgs: Vec<Message>) {
        if let Some(conn) = self.clients[i].conn {
            for m in &msgs {
                self.schedule(conn, true, m);
            }
        } else {
            assert!(msgs.is_empty(), "offline client produced frames: {msgs:?}");
        }
    }

    fn connect(&mut self, i: usize) {
        let conn = self.next_conn;
        self.next_conn += 1;
        self.links.insert(
            conn,
            Link {
                client: i,
                to_server: Vec::new(),
                to_client: Vec::new(),
                last_to_server: 0,
                last_to_client: 0,
            },
        );
        self.clients[i].conn = Some(conn);
        self.room.on_join(conn);
        let hello = self.clients[i].session.on_connected();
        assert!(matches!(hello.as_slice(), [Message::Hello { .. }]));
        self.send_from_client(i, hello);
    }

    /// Kill a connection: both directions lose in-flight frames; both ends are told.
    fn reset(&mut self, conn: u64) {
        let Some(link) = self.links.remove(&conn) else {
            return;
        };
        let c = &mut self.clients[link.client];
        c.conn = None;
        c.session.on_disconnected();
        assert!(!c.session.is_synced(), "synced while disconnected");
        c.reconnect_at = self.now + 1 + self.rng.below(10);
        let out = self.room.on_leave(conn);
        assert!(out.persist.is_empty());
        self.route(out.to);
    }

    fn route(&mut self, to: Vec<(u64, Message)>) {
        for (conn, msg) in to {
            self.schedule(conn, false, &msg);
        }
    }

    fn crash_server(&mut self) {
        let conns: Vec<u64> = self.links.keys().copied().collect();
        for conn in conns {
            self.reset(conn);
        }
        let mut doc = Doc::new(SERVER_CLIENT_ID);
        for u in &self.log {
            doc.apply_update(u).expect("persisted update must decode");
        }
        self.room = Room::new(DOC_ID.into(), doc);
    }

    fn random_edit(&mut self, i: usize) {
        let text = self.clients[i].session.doc().text();
        let bounds = utf16_boundaries(&text);
        let rng = &mut self.rng;
        let delete = bounds.len() > 1 && rng.chance(0.35);
        let msgs = if delete {
            let a = rng.below(bounds.len() as u64 - 1) as usize;
            let b = a + 1 + rng.below((bounds.len() - a - 1).min(8) as u64) as usize;
            let (pos, len) = (bounds[a], bounds[b] - bounds[a]);
            let c = &mut self.clients[i];
            c.shadow.drain(pos..pos + len);
            c.session.delete(pos, len)
        } else {
            let pos = bounds[rng.below(bounds.len() as u64) as usize];
            let mut s = String::new();
            for _ in 0..1 + rng.below(3) {
                s.push_str(PIECES[rng.below(PIECES.len() as u64) as usize]);
            }
            let c = &mut self.clients[i];
            let units: Vec<u16> = s.encode_utf16().collect();
            c.shadow.splice(pos..pos, units);
            c.session.insert(pos, &s)
        };
        let c = &self.clients[i];
        if c.session.is_live() {
            assert_eq!(msgs.len(), 1, "live edit must stream exactly one Update");
            assert_eq!(c.session.unsynced_op_count(), 0, "live edits count as sent");
        } else {
            assert!(msgs.is_empty());
            assert!(
                c.session.unsynced_op_count() > 0,
                "offline edit not counted"
            );
        }
        self.send_from_client(i, msgs);
    }

    fn random_awareness(&mut self, i: usize) {
        let c = &mut self.clients[i];
        c.awareness_version += 1;
        let id = c.session.doc().client_id();
        let payload = format!("{{\"name\":\"c{i}\",\"v\":{}}}", c.awareness_version).into_bytes();
        self.awareness.insert(id, payload.clone());
        let msgs = self.clients[i].session.set_awareness(payload);
        self.send_from_client(i, msgs);
    }

    /// Delivers every packet due by `now`, in (time, seq) order. Returns whether any moved.
    fn deliver_due(&mut self) -> bool {
        let mut due: Vec<(u64, u64, u64, bool)> = Vec::new();
        for (&conn, link) in &self.links {
            for p in &link.to_server {
                if p.at <= self.now {
                    due.push((p.at, p.seq, conn, true));
                }
            }
            for p in &link.to_client {
                if p.at <= self.now {
                    due.push((p.at, p.seq, conn, false));
                }
            }
        }
        due.sort();
        let any = !due.is_empty();
        for (_, seq, conn, to_server) in due {
            let Some(link) = self.links.get_mut(&conn) else {
                continue; // reset earlier in this batch
            };
            let queue = if to_server {
                &mut link.to_server
            } else {
                &mut link.to_client
            };
            let Some(idx) = queue.iter().position(|p| p.seq == seq) else {
                continue;
            };
            let pkt = queue.remove(idx);
            let client = link.client;
            if self.rng.chance(self.faults.reset) {
                self.reset(conn); // the frame is lost with the connection
                continue;
            }
            let msg = Message::decode(&pkt.bytes).expect("frame decodes");
            if to_server {
                let out = match self.room.on_message(conn, msg) {
                    Ok(out) => out,
                    Err(e) => panic!("room rejected a frame: {e}"),
                };
                self.log.extend(out.persist);
                self.route(out.to);
            } else {
                let c = &mut self.clients[client];
                let out = match c.session.on_message(msg) {
                    Ok(out) => out,
                    Err(e) => panic!("client rejected a frame: {e}"),
                };
                apply_changes(&mut c.shadow, &out.changes);
                self.send_from_client(client, out.send);
            }
        }
        any
    }

    fn tick(&mut self, faulty: bool) {
        self.now += 1;
        if faulty {
            for i in 0..self.clients.len() {
                if self.rng.chance(0.25) {
                    self.random_edit(i);
                }
                if self.rng.chance(0.03) {
                    self.random_awareness(i);
                }
                if let Some(conn) = self.clients[i].conn {
                    if self.rng.chance(self.faults.disconnect) {
                        self.reset(conn);
                    } else if self.rng.chance(self.faults.partition) {
                        self.reset(conn);
                        self.clients[i].partitioned_until = self.now + 10 + self.rng.below(60);
                    }
                }
            }
            if self.rng.chance(self.faults.crash) {
                self.crash_server();
            }
        }
        for i in 0..self.clients.len() {
            let c = &self.clients[i];
            if c.conn.is_none() && self.now >= c.reconnect_at && self.now >= c.partitioned_until {
                self.connect(i);
            }
        }
        self.deliver_due();
    }

    fn in_flight(&self) -> bool {
        self.links
            .values()
            .any(|l| !l.to_server.is_empty() || !l.to_client.is_empty())
    }

    fn heal_and_quiesce(&mut self) {
        self.faults = Faults::none();
        let conns: Vec<u64> = self.links.keys().copied().collect();
        for conn in conns {
            self.reset(conn);
        }
        for c in &mut self.clients {
            c.partitioned_until = 0;
            c.reconnect_at = 0;
        }
        for _ in 0..10_000 {
            self.tick(false);
            let all_live = self.clients.iter().all(|c| c.session.is_live());
            if all_live && !self.in_flight() {
                return;
            }
        }
        panic!("did not quiesce");
    }

    fn check(&self) {
        let server = self.room.doc();
        let text = server.text();
        let sv = server.state_vector();
        assert!(!server.has_pending(), "server still has pending ops");
        for (i, c) in self.clients.iter().enumerate() {
            let d = c.session.doc();
            assert_eq!(d.text(), text, "client {i} text differs from server");
            assert_eq!(d.state_vector(), sv, "client {i} state vector differs");
            assert!(!d.has_pending(), "client {i} has pending ops");
            assert!(c.session.is_synced(), "client {i} not synced");
            assert_eq!(c.session.unsynced_op_count(), 0, "client {i} unsynced ops");
            assert_eq!(
                String::from_utf16(&c.shadow).expect("shadow is valid UTF-16"),
                text,
                "client {i}: applying returned Changes doesn't reproduce the text"
            );
            let me = d.client_id();
            let expected: BTreeMap<u64, Vec<u8>> = self
                .awareness
                .iter()
                .filter(|(id, _)| **id != me)
                .map(|(id, p)| (*id, p.clone()))
                .collect();
            let got: BTreeMap<u64, Vec<u8>> =
                c.session.peers().map(|(id, p)| (id, p.to_vec())).collect();
            assert_eq!(got, expected, "client {i} awareness view");
        }
        // The persisted log alone reproduces the server replica.
        let mut replay = Doc::new(SERVER_CLIENT_ID);
        for u in &self.log {
            replay.apply_update(u).expect("persisted update decodes");
        }
        assert_eq!(replay.text(), text, "log replay text");
        assert_eq!(replay.state_vector(), sv, "log replay state vector");
    }
}

fn run_seed(seed: u64) {
    let mut sim = Sim::new(seed);
    let ticks = 100 + sim.rng.below(200);
    for _ in 0..ticks {
        sim.tick(true);
    }
    sim.heal_and_quiesce();
    sim.check();
}

fn run_seeds(seeds: impl Iterator<Item = u64>) {
    let seeds: Vec<u64> = match std::env::var("WEFT_SIM_SEED") {
        Ok(s) => vec![s.parse().expect("WEFT_SIM_SEED must be a u64")],
        Err(_) => seeds.collect(),
    };
    for seed in seeds {
        if catch_unwind(AssertUnwindSafe(|| run_seed(seed))).is_err() {
            panic!("simulation failed for seed {seed}; reproduce with WEFT_SIM_SEED={seed}");
        }
    }
}

#[test]
fn simulated_network_converges() {
    run_seeds(0..200);
}

#[test]
#[ignore = "long: 10k seeds; run with --ignored (ideally --release)"]
fn simulated_network_converges_10k() {
    run_seeds(0..10_000);
}
