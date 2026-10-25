//! Weft sync server. See `docs/ARCHITECTURE.md` §3.
//!
//! One [`weft_sync::Room`] per open document lives behind a `std::sync::Mutex` that is only held
//! for synchronous work (apply, persist, enqueue); it is never held across an `.await`. Each
//! connection has a bounded outbound queue; a peer whose queue is full is dropped instead of
//! slowing the room down (it resyncs on reconnect).
//!
//! Abuse limits ([`Limits`]): frame size, global and per-IP connection caps, a per-connection
//! message token bucket, a `Hello` deadline, an `Origin` check, a per-doc size quota, a cap on
//! loaded rooms, and presence bound to the connection's `Hello` client id.

pub mod store;

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use tokio::sync::mpsc;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use weft_core::Doc;
use weft_sync::{Message, Room, error_code};

pub use store::{DocLog, DocStore};

/// Outbound frames buffered per connection before it's considered too slow and dropped.
const OUTBOUND_QUEUE: usize = 1024;
const PING_EVERY: Duration = Duration::from_secs(20);
/// Close a connection that hasn't sent anything (incl. pongs) for this long.
const PEER_TIMEOUT: Duration = Duration::from_secs(60);
/// Max WebSocket message and frame size accepted from clients.
const MAX_FRAME: usize = 1 << 20;

/// Abuse limits. Each one can be overridden by the env var named in its doc.
#[derive(Clone, Debug)]
pub struct Limits {
    /// `WEFT_LIMIT_CONNS`: concurrent WebSockets, server-wide.
    pub max_conns: usize,
    /// `WEFT_LIMIT_CONNS_PER_IP`: concurrent WebSockets per client IP (IPv6 grouped per /64).
    pub max_conns_per_ip: usize,
    /// `WEFT_LIMIT_MSG_RATE`: sustained incoming messages per second per connection.
    pub msg_rate: f64,
    /// `WEFT_LIMIT_MSG_BURST`: token-bucket burst size per connection.
    pub msg_burst: f64,
    /// `WEFT_LIMIT_HELLO_SECS`: a connection must send a valid `Hello` within this long.
    pub hello_timeout: Duration,
    /// `WEFT_LIMIT_DOC_BYTES`: updates are rejected once a doc's stored log would exceed this.
    pub max_doc_bytes: u64,
    /// `WEFT_LIMIT_ROOMS`: documents loaded in memory at once.
    pub max_rooms: usize,
    /// `WEFT_ALLOWED_ORIGINS`: extra allowed `Origin`s (full origins or bare hosts), besides
    /// same-host. Comma-separated.
    pub allowed_origins: Vec<String>,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_conns: 10_000,
            max_conns_per_ip: 64,
            msg_rate: 300.0,
            msg_burst: 600.0,
            hello_timeout: Duration::from_secs(10),
            max_doc_bytes: 16 << 20,
            max_rooms: 2000,
            allowed_origins: Vec::new(),
        }
    }
}

fn env_num<T: std::str::FromStr>(name: &str, default: T) -> Result<T, String>
where
    T::Err: std::fmt::Display,
{
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => v
            .trim()
            .parse()
            .map_err(|e| format!("bad {name} {v:?}: {e}")),
        _ => Ok(default),
    }
}

impl Limits {
    pub fn from_env() -> Result<Self, String> {
        let d = Limits::default();
        let limits = Limits {
            max_conns: env_num("WEFT_LIMIT_CONNS", d.max_conns)?,
            max_conns_per_ip: env_num("WEFT_LIMIT_CONNS_PER_IP", d.max_conns_per_ip)?,
            msg_rate: env_num("WEFT_LIMIT_MSG_RATE", d.msg_rate)?,
            msg_burst: env_num("WEFT_LIMIT_MSG_BURST", d.msg_burst)?,
            hello_timeout: Duration::from_secs(env_num(
                "WEFT_LIMIT_HELLO_SECS",
                d.hello_timeout.as_secs(),
            )?),
            max_doc_bytes: env_num("WEFT_LIMIT_DOC_BYTES", d.max_doc_bytes)?,
            max_rooms: env_num("WEFT_LIMIT_ROOMS", d.max_rooms)?,
            allowed_origins: std::env::var("WEFT_ALLOWED_ORIGINS")
                .unwrap_or_default()
                .split(',')
                .map(|o| o.trim().trim_end_matches('/').to_ascii_lowercase())
                .filter(|o| !o.is_empty())
                .collect(),
        };
        if !(limits.msg_rate > 0.0 && limits.msg_burst >= 1.0) {
            return Err("WEFT_LIMIT_MSG_RATE must be > 0 and WEFT_LIMIT_MSG_BURST >= 1".into());
        }
        Ok(limits)
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub addr: SocketAddr,
    pub data_dir: PathBuf,
    pub static_dir: PathBuf,
    /// Unload a room after it has had no connections for this long.
    pub idle_unload: Duration,
    pub limits: Limits,
}

impl Config {
    /// `WEFT_ADDR` (default `0.0.0.0:7878`), `WEFT_DATA_DIR` (`./data`),
    /// `WEFT_STATIC_DIR` (`./web/dist`), plus the [`Limits`] env vars.
    pub fn from_env() -> Result<Self, String> {
        let addr = std::env::var("WEFT_ADDR").unwrap_or_else(|_| "0.0.0.0:7878".into());
        Ok(Config {
            addr: addr
                .parse()
                .map_err(|e| format!("bad WEFT_ADDR {addr:?}: {e}"))?,
            data_dir: std::env::var_os("WEFT_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| "./data".into()),
            static_dir: std::env::var_os("WEFT_STATIC_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| "./web/dist".into()),
            idle_unload: Duration::from_secs(60),
            limits: Limits::from_env()?,
        })
    }
}

/// `^[A-Za-z0-9_-]{1,64}$`
pub fn valid_doc_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

struct RoomInner {
    room: Room,
    log: DocLog,
    outbound: HashMap<u64, mpsc::Sender<Bytes>>,
    idle_since: Option<Instant>,
}

struct RoomSlot {
    inner: Mutex<RoomInner>,
}

impl RoomSlot {
    fn lock(&self) -> MutexGuard<'_, RoomInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub struct AppState {
    store: DocStore,
    rooms: Mutex<HashMap<String, Arc<RoomSlot>>>,
    started: Instant,
    connections: AtomicUsize,
    next_conn: AtomicU64,
    idle_unload: Duration,
    limits: Limits,
    /// Open WebSockets per client IP bucket (guarded together with `connections`).
    per_ip: Mutex<HashMap<IpAddr, usize>>,
}

impl AppState {
    pub fn new(store: DocStore, idle_unload: Duration) -> Arc<Self> {
        Self::with_limits(store, idle_unload, Limits::default())
    }

    pub fn with_limits(store: DocStore, idle_unload: Duration, limits: Limits) -> Arc<Self> {
        Arc::new(AppState {
            store,
            rooms: Mutex::new(HashMap::new()),
            started: Instant::now(),
            connections: AtomicUsize::new(0),
            next_conn: AtomicU64::new(1),
            idle_unload,
            limits,
            per_ip: Mutex::new(HashMap::new()),
        })
    }

    /// Reserves a connection slot for `ip`, or returns the `Error` frame to close with.
    fn admit(self: &Arc<Self>, ip: IpAddr) -> Result<ConnPermit, Message> {
        let mut per_ip = self.per_ip.lock().unwrap_or_else(|e| e.into_inner());
        if self.connections.load(Ordering::Relaxed) >= self.limits.max_conns {
            return Err(Message::Error {
                code: error_code::OVERLOADED,
                message: "server is at its connection limit; try again later".into(),
            });
        }
        let n = per_ip.entry(ip).or_insert(0);
        if *n >= self.limits.max_conns_per_ip {
            return Err(Message::Error {
                code: error_code::RATE_LIMITED,
                message: "too many connections from your network".into(),
            });
        }
        *n += 1;
        self.connections.fetch_add(1, Ordering::Relaxed);
        Ok(ConnPermit {
            state: self.clone(),
            ip,
        })
    }

    fn rooms(&self) -> MutexGuard<'_, HashMap<String, Arc<RoomSlot>>> {
        self.rooms.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn load_room(&self, doc_id: &str) -> io::Result<RoomInner> {
        let (records, mut log) = self.store.open(doc_id)?;
        let mut doc = Doc::new(rand::random::<u64>() | 1);
        let mut bad = 0usize;
        for rec in &records {
            if doc.apply_update(rec).is_err() {
                bad += 1;
            }
        }
        if bad > 0 {
            tracing::warn!(doc_id, bad, "skipped undecodable log records");
        }
        if log.needs_compaction() {
            log.compact(&doc.encode_full())?;
        }
        tracing::info!(doc_id, records = records.len(), "room loaded");
        Ok(RoomInner {
            room: Room::new(doc_id.to_string(), doc),
            log,
            outbound: HashMap::new(),
            idle_since: None,
        })
    }

    /// Joins `conn` to the room, loading it from disk on first use. `Err` is the `Error` frame
    /// to close with.
    fn join(
        &self,
        doc_id: &str,
        conn: u64,
        tx: mpsc::Sender<Bytes>,
    ) -> Result<Arc<RoomSlot>, Message> {
        let mut rooms = self.rooms();
        let slot = match rooms.get(doc_id) {
            Some(slot) => slot.clone(),
            None => {
                if rooms.len() >= self.limits.max_rooms {
                    // Make room by unloading every room nobody is connected to.
                    unload_rooms(&mut rooms, |_| true);
                }
                if rooms.len() >= self.limits.max_rooms {
                    tracing::warn!(doc_id, rooms = rooms.len(), "room limit reached");
                    return Err(Message::Error {
                        code: error_code::OVERLOADED,
                        message: "server has too many documents open; try again later".into(),
                    });
                }
                let inner = self.load_room(doc_id).map_err(|e| {
                    tracing::error!(doc_id, error = %e, "failed to load room");
                    Message::Error {
                        code: error_code::INTERNAL,
                        message: "failed to load document".into(),
                    }
                })?;
                let slot = Arc::new(RoomSlot {
                    inner: Mutex::new(inner),
                });
                rooms.insert(doc_id.to_string(), slot.clone());
                slot
            }
        };
        let mut inner = slot.lock();
        inner.room.on_join(conn);
        inner.outbound.insert(conn, tx);
        inner.idle_since = None;
        drop(inner);
        Ok(slot)
    }

    /// Unloads rooms that have had no connections for `idle_unload`.
    fn reap_idle(&self) {
        unload_rooms(&mut self.rooms(), |inner| {
            inner
                .idle_since
                .is_some_and(|t| t.elapsed() >= self.idle_unload)
        });
    }

    fn sync_all(&self) {
        for slot in self.rooms().values() {
            let _ = slot.lock().log.sync();
        }
    }
}

/// Unloads (after an fsync) every room with no connections for which `pick` returns true.
fn unload_rooms(rooms: &mut HashMap<String, Arc<RoomSlot>>, pick: impl Fn(&RoomInner) -> bool) {
    rooms.retain(|doc_id, slot| {
        let inner = slot.lock();
        let idle = inner.outbound.is_empty() && inner.room.connection_count() == 0 && pick(&inner);
        if idle {
            if let Err(e) = inner.log.sync() {
                tracing::warn!(doc_id, error = %e, "fsync on unload failed");
            }
            tracing::info!(doc_id, "room unloaded (idle)");
        }
        !idle
    });
}

/// A reserved connection slot; released on drop.
struct ConnPermit {
    state: Arc<AppState>,
    ip: IpAddr,
}

impl Drop for ConnPermit {
    fn drop(&mut self) {
        let mut per_ip = self.state.per_ip.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = per_ip.get_mut(&self.ip) {
            *n -= 1;
            if *n == 0 {
                per_ip.remove(&self.ip);
            }
        }
        self.state.connections.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Token bucket for incoming messages on one connection.
struct TokenBucket {
    tokens: f64,
    rate: f64,
    burst: f64,
    last: Instant,
}

impl TokenBucket {
    fn new(rate: f64, burst: f64) -> Self {
        TokenBucket {
            tokens: burst,
            rate,
            burst,
            last: Instant::now(),
        }
    }

    fn take(&mut self) -> bool {
        let now = Instant::now();
        let dt = now.duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + dt * self.rate).min(self.burst);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// The client's IP: the left-most `X-Forwarded-For` entry when the TCP peer is loopback (our
/// reverse proxy on the same box overwrites that header), otherwise the peer address. IPv6 is
/// grouped per /64, since one host usually owns a whole /64.
fn client_ip(peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
    let mut ip = peer.ip().to_canonical();
    if ip.is_loopback()
        && let Some(fwd) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .and_then(|v| v.trim().parse::<IpAddr>().ok())
    {
        ip = fwd.to_canonical();
    }
    match ip {
        IpAddr::V6(v6) => {
            let bits = u128::from(v6) & !((1u128 << 64) - 1);
            IpAddr::V6(Ipv6Addr::from(bits))
        }
        v4 => v4,
    }
}

/// Browser WebSockets carry `Origin`; it must be same-host or allow-listed. Native clients
/// send none, which is allowed.
fn origin_allowed(headers: &HeaderMap, allowed: &[String]) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let origin = origin.trim().trim_end_matches('/').to_ascii_lowercase();
    let Some((_, origin_host)) = origin.split_once("://") else {
        return false; // e.g. "null"
    };
    if origin_host.is_empty() {
        return false;
    }
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(|h| h.trim().to_ascii_lowercase());
    host.as_deref() == Some(origin_host) || allowed.iter().any(|a| *a == origin || a == origin_host)
}

fn human_bytes(n: u64) -> String {
    if n >= 1 << 20 {
        format!("{} MiB", n >> 20)
    } else {
        format!("{} KiB", n.div_ceil(1024))
    }
}

/// Per-connection state used by [`handle_frame`].
#[derive(Default)]
struct ConnCtx {
    /// The client id from this connection's first valid `Hello`.
    hello_client: Option<u64>,
}

/// Sends directed messages; drops any connection whose queue is full (and tells the others).
fn deliver(inner: &mut RoomInner, mut to: Vec<(u64, Message)>) {
    while !to.is_empty() {
        let mut more = Vec::new();
        for (conn, msg) in to {
            let Some(tx) = inner.outbound.get(&conn) else {
                continue;
            };
            if tx.try_send(Bytes::from(msg.encode())).is_err() {
                tracing::warn!(conn, "dropping slow or closed connection");
                inner.outbound.remove(&conn);
                more.extend(inner.room.on_leave(conn).to);
            }
        }
        to = more;
    }
}

/// Handles one binary frame. `Err` carries the `Error` frame to send before closing.
fn handle_frame(
    slot: &RoomSlot,
    conn: u64,
    frame: &[u8],
    ctx: &mut ConnCtx,
    limits: &Limits,
) -> Result<(), Message> {
    let msg = Message::decode(frame).map_err(|e| e.to_message())?;
    if let Message::Awareness { client_id, .. } = &msg
        && ctx.hello_client != Some(*client_id)
    {
        // Presence may only be sent for the client id this connection said hello as.
        tracing::debug!(
            conn,
            client_id,
            "dropping awareness for a foreign client id"
        );
        return Ok(());
    }
    let mut inner = slot.lock();
    if !inner.outbound.contains_key(&conn) {
        // We were dropped as a slow consumer; the connection is about to close.
        return Ok(());
    }
    let doc_id = inner.room.doc_id().to_string();
    if let Message::Update { update } = &msg {
        let incoming = update.len() as u64;
        if inner.log.bytes() + incoming > limits.max_doc_bytes && inner.log.records() > 1 {
            // The log may be mostly redundant; measure the compacted state before refusing.
            let full = inner.room.doc().encode_full();
            if let Err(e) = inner.log.compact(&full) {
                tracing::error!(doc_id, error = %e, "compaction failed");
            }
        }
        if inner.log.bytes() + incoming > limits.max_doc_bytes {
            tracing::warn!(
                doc_id,
                conn,
                bytes = inner.log.bytes(),
                "doc size quota hit"
            );
            return Err(Message::Error {
                code: error_code::TOO_LARGE,
                message: format!(
                    "this document has reached the size limit ({}); new edits can't be saved",
                    human_bytes(limits.max_doc_bytes)
                ),
            });
        }
    }
    let hello_id = match &msg {
        Message::Hello { client_id, .. } => Some(*client_id),
        _ => None,
    };
    let out = inner
        .room
        .on_message(conn, msg)
        .map_err(|e| e.to_message())?;
    if ctx.hello_client.is_none() {
        ctx.hello_client = hello_id;
    }
    for update in &out.persist {
        if let Err(e) = inner.log.append(update) {
            tracing::error!(doc_id, error = %e, "log append failed");
            return Err(Message::Error {
                code: error_code::INTERNAL,
                message: "storage failure".into(),
            });
        }
    }
    if !out.persist.is_empty() && inner.log.needs_compaction() {
        let full = inner.room.doc().encode_full();
        match inner.log.compact(&full) {
            Ok(()) => tracing::info!(doc_id, bytes = full.0.len(), "log compacted"),
            Err(e) => tracing::error!(doc_id, error = %e, "compaction failed"),
        }
    }
    deliver(&mut inner, out.to);
    Ok(())
}

fn leave(slot: &RoomSlot, conn: u64) {
    let mut inner = slot.lock();
    inner.outbound.remove(&conn);
    let out = inner.room.on_leave(conn);
    deliver(&mut inner, out.to);
    if inner.outbound.is_empty() {
        inner.idle_since = Some(Instant::now());
    }
}

pub fn app(state: Arc<AppState>, static_dir: PathBuf) -> Router {
    let spa = ServeDir::new(&static_dir).fallback(ServeFile::new(static_dir.join("index.html")));
    Router::new()
        .route("/ws/{doc_id}", get(ws_route))
        .route("/api/docs/{doc_id}/export.md", get(export_route))
        .route("/api/stats", get(stats_route))
        .route("/api/{*rest}", any(|| async { StatusCode::NOT_FOUND }))
        .route("/healthz", get(|| async { "ok" }))
        .fallback_service(spa)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Binds `config.addr` and serves until Ctrl-C.
pub async fn run(config: Config) -> io::Result<()> {
    let store = DocStore::new(&config.data_dir)?;
    let state = AppState::with_limits(store, config.idle_unload, config.limits.clone());
    let reaper = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        loop {
            tick.tick().await;
            reaper.reap_idle();
        }
    });
    let listener = tokio::net::TcpListener::bind(config.addr).await?;
    tracing::info!(
        addr = %listener.local_addr()?,
        data_dir = %config.data_dir.display(),
        static_dir = %config.static_dir.display(),
        "weft-server listening"
    );
    let service =
        app(state.clone(), config.static_dir).into_make_service_with_connect_info::<SocketAddr>();
    axum::serve(listener, service)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    state.sync_all();
    Ok(())
}

/// Resolves on Ctrl-C, or on SIGTERM (what systemd, Docker and Fly send to stop a service).
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
    tracing::info!("shutting down");
}

/// Requires the router to be served with `into_make_service_with_connect_info::<SocketAddr>()`.
async fn ws_route(
    Path(doc_id): Path<String>,
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    if !valid_doc_id(&doc_id) {
        return (StatusCode::BAD_REQUEST, "invalid doc id").into_response();
    }
    if !origin_allowed(&headers, &state.limits.allowed_origins) {
        tracing::warn!(doc_id, origin = ?headers.get(header::ORIGIN), "rejected WebSocket Origin");
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    let ws = match ws {
        Ok(ws) => ws.max_message_size(MAX_FRAME).max_frame_size(MAX_FRAME),
        Err(rejection) => return rejection.into_response(),
    };
    let ip = client_ip(peer, &headers);
    match state.admit(ip) {
        Ok(permit) => ws.on_upgrade(move |socket| connection(state, doc_id, socket, permit)),
        Err(err) => {
            tracing::warn!(doc_id, %ip, ?err, "connection refused by limits");
            ws.on_upgrade(move |mut socket| async move { close_with(&mut socket, err).await })
        }
    }
}

async fn close_with(socket: &mut WebSocket, msg: Message) {
    let reason = match &msg {
        Message::Error { message, .. } => message.clone(),
        _ => String::new(),
    };
    let _ = socket
        .send(WsMessage::Binary(Bytes::from(msg.encode())))
        .await;
    let _ = socket
        .send(WsMessage::Close(Some(CloseFrame {
            code: 1008,
            reason: reason.chars().take(100).collect::<String>().into(),
        })))
        .await;
    // Drain briefly until the peer acknowledges: dropping a socket with unread input makes the
    // kernel send RST, and the client would never see the Error frame.
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        while let Some(Ok(m)) = socket.recv().await {
            if matches!(m, WsMessage::Close(_)) {
                break;
            }
        }
    })
    .await;
}

async fn connection(
    state: Arc<AppState>,
    doc_id: String,
    mut socket: WebSocket,
    permit: ConnPermit,
) {
    let conn = state.next_conn.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::channel::<Bytes>(OUTBOUND_QUEUE);
    let slot = match state.join(&doc_id, conn, tx) {
        Ok(slot) => slot,
        Err(msg) => {
            close_with(&mut socket, msg).await;
            return;
        }
    };
    let limits = &state.limits;
    tracing::info!(doc_id, conn, ip = %permit.ip, "connected");

    let mut ctx = ConnCtx::default();
    let mut bucket = TokenBucket::new(limits.msg_rate, limits.msg_burst);
    let hello_deadline = tokio::time::sleep(limits.hello_timeout);
    tokio::pin!(hello_deadline);

    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await; // first tick is immediate
    let mut last_seen = Instant::now();
    let reason = loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(_)) if !bucket.take() => {
                    tracing::warn!(doc_id, conn, ip = %permit.ip, "message rate limit exceeded");
                    let err = Message::Error {
                        code: error_code::RATE_LIMITED,
                        message: "too many messages; slow down".into(),
                    };
                    close_with(&mut socket, err).await;
                    break "rate limited";
                }
                Some(Ok(WsMessage::Binary(frame))) => {
                    last_seen = Instant::now();
                    if let Err(err) = handle_frame(&slot, conn, &frame, &mut ctx, limits) {
                        tracing::warn!(doc_id, conn, ?err, "closing connection on bad frame");
                        close_with(&mut socket, err).await;
                        break "bad frame";
                    }
                }
                Some(Ok(WsMessage::Text(_))) => {
                    let err = Message::Error {
                        code: error_code::MALFORMED,
                        message: "text frames are not supported".into(),
                    };
                    close_with(&mut socket, err).await;
                    break "text frame";
                }
                Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_))) => last_seen = Instant::now(),
                Some(Ok(WsMessage::Close(_))) | None => break "closed by peer",
                Some(Err(_)) => break "socket error",
            },
            out = rx.recv() => match out {
                Some(frame) => {
                    if socket.send(WsMessage::Binary(frame)).await.is_err() {
                        break "send failed";
                    }
                }
                None => break "dropped as slow consumer",
            },
            _ = &mut hello_deadline, if ctx.hello_client.is_none() => {
                let err = Message::Error {
                    code: error_code::MALFORMED,
                    message: "no Hello received in time".into(),
                };
                close_with(&mut socket, err).await;
                break "no hello";
            }
            _ = ping.tick() => {
                if last_seen.elapsed() > PEER_TIMEOUT {
                    break "timed out";
                }
                if socket.send(WsMessage::Ping(Bytes::new())).await.is_err() {
                    break "ping failed";
                }
            }
        }
    };
    leave(&slot, conn);
    drop(permit);
    tracing::info!(doc_id, conn, reason, "disconnected");
}

async fn export_route(Path(doc_id): Path<String>, State(state): State<Arc<AppState>>) -> Response {
    if !valid_doc_id(&doc_id) {
        return (StatusCode::BAD_REQUEST, "invalid doc id").into_response();
    }
    let loaded = state.rooms().get(&doc_id).cloned();
    let text = match loaded {
        Some(slot) => slot.lock().room.doc().text(),
        None => {
            if !state.store.exists(&doc_id) {
                return (StatusCode::NOT_FOUND, "no such doc").into_response();
            }
            let records = match state.store.read(&doc_id) {
                Ok(r) => r,
                Err(e) => {
                    tracing::error!(doc_id, error = %e, "export read failed");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            };
            let mut doc = Doc::new(1);
            for rec in &records {
                let _ = doc.apply_update(rec);
            }
            doc.text()
        }
    };
    (
        [(header::CONTENT_TYPE, "text/markdown; charset=utf-8")],
        text,
    )
        .into_response()
}

async fn stats_route(State(state): State<Arc<AppState>>) -> Response {
    let body = serde_json::json!({
        "docs_open": state.rooms().len(),
        "connections": state.connections.load(Ordering::Relaxed),
        "uptime_secs": state.started.elapsed().as_secs(),
    });
    axum::Json(body).into_response()
}
