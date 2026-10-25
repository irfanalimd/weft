//! Weft sync server. See `docs/ARCHITECTURE.md` §3.
//!
//! One [`weft_sync::Room`] per open document lives behind a `std::sync::Mutex` that is only held
//! for synchronous work (apply, persist, enqueue); it is never held across an `.await`. Each
//! connection has a bounded outbound queue; a peer whose queue is full is dropped instead of
//! slowing the room down (it resyncs on reconnect).

pub mod store;

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
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
const MAX_FRAME: usize = 16 << 20;

#[derive(Clone, Debug)]
pub struct Config {
    pub addr: SocketAddr,
    pub data_dir: PathBuf,
    pub static_dir: PathBuf,
    /// Unload a room after it has had no connections for this long.
    pub idle_unload: Duration,
}

impl Config {
    /// `WEFT_ADDR` (default `0.0.0.0:7878`), `WEFT_DATA_DIR` (`./data`),
    /// `WEFT_STATIC_DIR` (`./web/dist`).
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
}

impl AppState {
    pub fn new(store: DocStore, idle_unload: Duration) -> Arc<Self> {
        Arc::new(AppState {
            store,
            rooms: Mutex::new(HashMap::new()),
            started: Instant::now(),
            connections: AtomicUsize::new(0),
            next_conn: AtomicU64::new(1),
            idle_unload,
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

    /// Joins `conn` to the room, loading it from disk on first use.
    fn join(&self, doc_id: &str, conn: u64, tx: mpsc::Sender<Bytes>) -> io::Result<Arc<RoomSlot>> {
        let mut rooms = self.rooms();
        let slot = match rooms.get(doc_id) {
            Some(slot) => slot.clone(),
            None => {
                let slot = Arc::new(RoomSlot {
                    inner: Mutex::new(self.load_room(doc_id)?),
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
        let mut rooms = self.rooms();
        rooms.retain(|doc_id, slot| {
            let inner = slot.lock();
            let idle = inner.outbound.is_empty()
                && inner.room.connection_count() == 0
                && inner
                    .idle_since
                    .is_some_and(|t| t.elapsed() >= self.idle_unload);
            if idle {
                if let Err(e) = inner.log.sync() {
                    tracing::warn!(doc_id, error = %e, "fsync on unload failed");
                }
                tracing::info!(doc_id, "room unloaded (idle)");
            }
            !idle
        });
    }

    fn sync_all(&self) {
        for slot in self.rooms().values() {
            let _ = slot.lock().log.sync();
        }
    }
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
fn handle_frame(slot: &RoomSlot, conn: u64, frame: &[u8]) -> Result<(), Message> {
    let msg = Message::decode(frame).map_err(|e| e.to_message())?;
    let mut inner = slot.lock();
    if !inner.outbound.contains_key(&conn) {
        // We were dropped as a slow consumer; the connection is about to close.
        return Ok(());
    }
    let out = inner
        .room
        .on_message(conn, msg)
        .map_err(|e| e.to_message())?;
    let doc_id = inner.room.doc_id().to_string();
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
    let state = AppState::new(store, config.idle_unload);
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
    axum::serve(listener, app(state.clone(), config.static_dir))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down");
        })
        .await?;
    state.sync_all();
    Ok(())
}

async fn ws_route(
    Path(doc_id): Path<String>,
    State(state): State<Arc<AppState>>,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    if !valid_doc_id(&doc_id) {
        return (StatusCode::BAD_REQUEST, "invalid doc id").into_response();
    }
    match ws {
        Ok(ws) => ws
            .max_message_size(MAX_FRAME)
            .on_upgrade(move |socket| connection(state, doc_id, socket)),
        Err(rejection) => rejection.into_response(),
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
}

async fn connection(state: Arc<AppState>, doc_id: String, mut socket: WebSocket) {
    let conn = state.next_conn.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::channel::<Bytes>(OUTBOUND_QUEUE);
    let slot = match state.join(&doc_id, conn, tx) {
        Ok(slot) => slot,
        Err(e) => {
            tracing::error!(doc_id, error = %e, "failed to load room");
            let msg = Message::Error {
                code: error_code::INTERNAL,
                message: "failed to load document".into(),
            };
            close_with(&mut socket, msg).await;
            return;
        }
    };
    state.connections.fetch_add(1, Ordering::Relaxed);
    tracing::info!(doc_id, conn, "connected");

    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await; // first tick is immediate
    let mut last_seen = Instant::now();
    let reason = loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(WsMessage::Binary(frame))) => {
                    last_seen = Instant::now();
                    if let Err(err) = handle_frame(&slot, conn, &frame) {
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
    state.connections.fetch_sub(1, Ordering::Relaxed);
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
