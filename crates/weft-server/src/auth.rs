//! Passwords (Argon2id), sessions (cookie `weft_session`, SHA-256 stored), login throttling,
//! the `/api` middleware (CSRF + session lookup) and the [`CurrentUser`] / [`AdminUser`]
//! extractors. See `docs/WALL.md` "Security model".

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use sha2::{Digest, Sha256};

use crate::api::ApiError;
use crate::db::{User, now_ms};
use crate::{AppState, client_ip, origin_allowed};

pub const COOKIE: &str = "weft_session";
pub const SESSION_TTL_MS: i64 = 30 * 24 * 3600 * 1000;
/// Sliding expiry: extend (and re-send the cookie) once a session is this old since its last
/// extension.
const EXTEND_AFTER_MS: i64 = 24 * 3600 * 1000;

pub const PASSWORD_MIN: usize = 10;
pub const PASSWORD_MAX: usize = 256;

fn argon2() -> Argon2<'static> {
    // OWASP: m = 19 MiB, t = 2, p = 1.
    let params = Params::new(19 * 1024, 2, 1, None).expect("valid argon2 params");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

fn hash_sync(password: &str) -> String {
    let salt = SaltString::encode_b64(&rand::random::<[u8; 16]>()).expect("salt");
    argon2()
        .hash_password(password.as_bytes(), &salt)
        .expect("argon2 hash")
        .to_string()
}

fn verify_sync(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(h) => argon2().verify_password(password.as_bytes(), &h).is_ok(),
        Err(_) => false,
    }
}

/// A hash of a random password, verified against for unknown users so timing matches.
fn dummy_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| hash_sync(&format!("{:x}", rand::random::<u128>())))
}

/// Caps concurrent Argon2 runs (19 MiB each): without it, a burst of unauthenticated logins
/// fills the blocking pool (512 threads, ~10 GB) before the throttle records a single failure.
fn hash_slots() -> &'static tokio::sync::Semaphore {
    static SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| {
        let n = std::thread::available_parallelism().map_or(1, |n| n.get());
        tokio::sync::Semaphore::new(n.clamp(1, 4))
    })
}

/// Runs `f` on the blocking pool once a hashing slot is free (`503` after waiting 10 s).
async fn with_hash_slot<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, ApiError> {
    let busy = || {
        ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "server is busy; try again",
        )
    };
    let _permit = tokio::time::timeout(Duration::from_secs(10), hash_slots().acquire())
        .await
        .map_err(|_| busy())?
        .map_err(|_| ApiError::internal())?;
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| ApiError::internal())
}

pub async fn hash_password(password: String) -> Result<String, ApiError> {
    with_hash_slot(move || hash_sync(&password)).await
}

/// Verifies against `hash`, or against the dummy hash when `None` (always false then).
pub async fn verify_password(password: String, hash: Option<String>) -> Result<bool, ApiError> {
    with_hash_slot(move || match hash {
        Some(h) => verify_sync(&password, &h),
        None => {
            let _ = verify_sync(&password, dummy_hash());
            false
        }
    })
    .await
}

/// Warms the dummy hash so the first unknown-user login isn't measurably slower.
pub fn warm_up() {
    tokio::task::spawn_blocking(|| {
        let _ = dummy_hash();
    });
}

pub fn valid_username(u: &str) -> bool {
    (3..=32).contains(&u.len())
        && u.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

pub fn check_password_rules(p: &str) -> Result<(), ApiError> {
    let n = p.chars().count();
    if n < PASSWORD_MIN {
        return Err(ApiError::bad_request(format!(
            "password must be at least {PASSWORD_MIN} characters"
        )));
    }
    if n > PASSWORD_MAX {
        return Err(ApiError::bad_request(format!(
            "password must be at most {PASSWORD_MAX} characters"
        )));
    }
    Ok(())
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// Constant-time comparison of two secrets (compares their SHA-256 so lengths don't leak).
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    let (a, b) = (sha256(a), sha256(b));
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Creates a session for `user_id`; returns the `Set-Cookie` value.
pub fn new_session(
    state: &AppState,
    user_id: i64,
    headers: &HeaderMap,
) -> Result<HeaderValue, ApiError> {
    let token = hex(&rand::random::<[u8; 32]>());
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(256).collect::<String>());
    state
        .db
        .create_session(
            &sha256(token.as_bytes()),
            user_id,
            now_ms() + SESSION_TTL_MS,
            ua.as_deref(),
        )
        .map_err(ApiError::db)?;
    Ok(session_cookie(&token))
}

pub fn session_cookie(token: &str) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{COOKIE}={token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age={}",
        SESSION_TTL_MS / 1000
    ))
    .expect("cookie header")
}

pub fn clear_cookie() -> HeaderValue {
    HeaderValue::from_static("weft_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0")
}

/// The `weft_session` token from the `Cookie` header(s).
pub fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| v.trim().to_string())
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The authenticated session of a request (set by [`api_middleware`]).
#[derive(Clone, Debug)]
pub struct Session {
    pub user: User,
    pub token_hash: [u8; 32],
}

/// Looks up the request's session (and slides its expiry). Returns the session and, if it
/// was extended, the cookie to re-send.
fn lookup_session(state: &AppState, headers: &HeaderMap) -> (Option<Session>, Option<HeaderValue>) {
    let Some(token) = session_token(headers) else {
        return (None, None);
    };
    let token_hash = sha256(token.as_bytes());
    match state.db.session_user(&token_hash) {
        Ok(Some((user, expires_at))) => {
            let now = now_ms();
            let mut cookie = None;
            if expires_at - now < SESSION_TTL_MS - EXTEND_AFTER_MS {
                if let Err(e) = state.db.extend_session(&token_hash, now + SESSION_TTL_MS) {
                    tracing::warn!(error = %e, "extending session failed");
                } else {
                    cookie = Some(session_cookie(&token));
                }
            }
            (Some(Session { user, token_hash }), cookie)
        }
        Ok(None) => (None, None),
        Err(e) => {
            tracing::error!(error = %e, "session lookup failed");
            (None, None)
        }
    }
}

fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|m| m.trim().eq_ignore_ascii_case("application/json"))
}

/// Runs on `/api/*` and `/ws/n/*`: CSRF checks for state-changing requests (same `Origin`
/// check as the WebSocket, plus `Content-Type: application/json`, except for logout), then
/// the session lookup (stored as an `Option<Session>` request extension).
pub async fn api_middleware(
    State(state): State<Arc<AppState>>,
    mut req: Request,
    next: Next,
) -> Response {
    let headers = req.headers();
    if !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        // Browsers always send `Origin` on these methods, so a cookie-bearing request without
        // one is not from our page; cookieless clients (curl login) may omit it.
        let cookie_without_origin =
            !headers.contains_key(header::ORIGIN) && session_token(headers).is_some();
        if cookie_without_origin || !origin_allowed(headers, &state.limits.allowed_origins) {
            return ApiError::forbidden("origin not allowed").into_response();
        }
        if req.uri().path() != "/api/auth/logout" && !is_json(headers) {
            return ApiError::new(
                axum::http::StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Content-Type must be application/json",
            )
            .into_response();
        }
    }
    let (session, cookie) = lookup_session(&state, headers);
    req.extensions_mut().insert(session);
    let mut resp = next.run(req).await;
    if let Some(c) = cookie
        && !resp.headers().contains_key(header::SET_COOKIE)
    {
        resp.headers_mut().append(header::SET_COOKIE, c);
    }
    resp
}

/// Any signed-in, enabled user; `401` otherwise.
pub struct CurrentUser(pub Session);

impl<S: Send + Sync> FromRequestParts<S> for CurrentUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, ApiError> {
        match parts.extensions.get::<Option<Session>>() {
            Some(Some(s)) => Ok(CurrentUser(s.clone())),
            _ => Err(ApiError::unauthorized("not signed in")),
        }
    }
}

/// A signed-in admin; `401` if signed out, `403` if not an admin.
pub struct AdminUser(pub Session);

impl<S: Send + Sync> FromRequestParts<S> for AdminUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, s: &S) -> Result<Self, ApiError> {
        let CurrentUser(session) = CurrentUser::from_request_parts(parts, s).await?;
        if !session.user.is_admin() {
            return Err(ApiError::forbidden("admins only"));
        }
        Ok(AdminUser(session))
    }
}

/// The real client IP (same logic as the WebSocket limits).
pub struct ClientIp(pub IpAddr);

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, ApiError> {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0)
            .ok_or_else(ApiError::internal)?;
        Ok(ClientIp(client_ip(peer, &parts.headers)))
    }
}

/// Sliding-window failure counters.
struct Window {
    max: usize,
    span: Duration,
}

#[derive(Default)]
struct ThrottleMaps {
    by_ip: HashMap<IpAddr, VecDeque<Instant>>,
    by_user: HashMap<String, VecDeque<Instant>>,
}

/// Login throttling: 5 failures/min per IP, 10 per 15 min per username.
pub struct Throttle {
    maps: Mutex<ThrottleMaps>,
    ip: Window,
    user: Window,
}

impl Default for Throttle {
    fn default() -> Self {
        Throttle {
            maps: Mutex::default(),
            ip: Window {
                max: 5,
                span: Duration::from_secs(60),
            },
            user: Window {
                max: 10,
                span: Duration::from_secs(15 * 60),
            },
        }
    }
}

/// Drops expired entries; returns the seconds until a new attempt is allowed, if blocked.
fn blocked(q: &mut VecDeque<Instant>, w: &Window, now: Instant) -> Option<u64> {
    while q.front().is_some_and(|t| now.duration_since(*t) >= w.span) {
        q.pop_front();
    }
    (q.len() >= w.max).then(|| {
        let oldest = *q.front().expect("non-empty");
        (w.span - now.duration_since(oldest)).as_secs().max(1)
    })
}

impl Throttle {
    fn lock(&self) -> std::sync::MutexGuard<'_, ThrottleMaps> {
        self.maps.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `Err(retry_after_secs)` if this IP or username is currently blocked.
    pub fn check(&self, ip: IpAddr, username: Option<&str>) -> Result<(), u64> {
        let now = Instant::now();
        let mut m = self.lock();
        let mut wait = 0;
        if let Some(q) = m.by_ip.get_mut(&ip) {
            wait = wait.max(blocked(q, &self.ip, now).unwrap_or(0));
        }
        if let Some(u) = username
            && let Some(q) = m.by_user.get_mut(&u.to_ascii_lowercase())
        {
            wait = wait.max(blocked(q, &self.user, now).unwrap_or(0));
        }
        if wait > 0 { Err(wait) } else { Ok(()) }
    }

    pub fn fail(&self, ip: IpAddr, username: Option<&str>) {
        let mut m = self.lock();
        self.record(&mut m, ip, username);
    }

    /// [`check`](Self::check) and count the attempt as a failure in one step, so concurrent
    /// requests can't all pass the check before any of them fails. Call
    /// [`forgive`](Self::forgive) if it succeeds.
    pub fn attempt(&self, ip: IpAddr, username: Option<&str>) -> Result<(), u64> {
        let now = Instant::now();
        let mut m = self.lock();
        let mut wait = blocked(m.by_ip.entry(ip).or_default(), &self.ip, now).unwrap_or(0);
        if let Some(u) = username {
            let q = m.by_user.entry(u.to_ascii_lowercase()).or_default();
            wait = wait.max(blocked(q, &self.user, now).unwrap_or(0));
        }
        if wait > 0 {
            return Err(wait);
        }
        self.record(&mut m, ip, username);
        Ok(())
    }

    /// Takes back the failure counted by a successful [`attempt`](Self::attempt).
    pub fn forgive(&self, ip: IpAddr, username: Option<&str>) {
        let mut m = self.lock();
        m.by_ip.get_mut(&ip).map(VecDeque::pop_back);
        if let Some(u) = username {
            m.by_user
                .get_mut(&u.to_ascii_lowercase())
                .map(VecDeque::pop_back);
        }
    }

    fn record(&self, m: &mut ThrottleMaps, ip: IpAddr, username: Option<&str>) {
        let now = Instant::now();
        if m.by_ip.len() + m.by_user.len() > 100_000 {
            self.sweep_locked(m, now); // bound memory between the hourly sweeps
        }
        m.by_ip.entry(ip).or_default().push_back(now);
        if let Some(u) = username {
            m.by_user
                .entry(u.to_ascii_lowercase())
                .or_default()
                .push_back(now);
        }
    }

    /// Forgets windows that have fully expired.
    pub fn sweep(&self) {
        let mut m = self.lock();
        self.sweep_locked(&mut m, Instant::now());
    }

    fn sweep_locked(&self, m: &mut ThrottleMaps, now: Instant) {
        let (ip, user) = (self.ip.span, self.user.span);
        m.by_ip
            .retain(|_, q| q.back().is_some_and(|t| now.duration_since(*t) < ip));
        m.by_user
            .retain(|_, q| q.back().is_some_and(|t| now.duration_since(*t) < user));
    }
}
