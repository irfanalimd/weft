//! JSON HTTP API for accounts, notes and admin (`docs/WALL.md` "HTTP API").

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::extract::{FromRequest, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::auth::{
    self, AdminUser, ClientIp, CurrentUser, Session, check_password_rules, valid_username,
};
use crate::db::{AdminUserRow, DbError, NOTE_COLORS, Note, NoteFilter};
use crate::{AppState, RoomKey, valid_doc_id, valid_note_id};

/// `{ "error": "..." }` with a status code (and `Retry-After` for 429).
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
    retry_after: Option<u64>,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        ApiError {
            status,
            message: message.into(),
            retry_after: None,
        }
    }
    pub fn bad_request(m: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, m)
    }
    pub fn unauthorized(m: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, m)
    }
    pub fn forbidden(m: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, m)
    }
    pub fn not_found(m: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, m)
    }
    pub fn conflict(m: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, m)
    }
    pub fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    }
    pub fn db(e: DbError) -> Self {
        tracing::error!(error = %e, "database error");
        Self::internal()
    }
    pub fn too_many(retry_after: u64) -> Self {
        ApiError {
            retry_after: Some(retry_after),
            ..Self::new(
                StatusCode::TOO_MANY_REQUESTS,
                "too many failed attempts; try again later",
            )
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut resp = (self.status, Json(json!({ "error": self.message }))).into_response();
        if let Some(s) = self.retry_after {
            resp.headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(s));
        }
        resp
    }
}

type ApiResult<T = Response> = Result<T, ApiError>;

/// `Json<T>` whose rejection is an [`ApiError`] (JSON body).
pub struct JsonBody<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for JsonBody<T> {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, ApiError> {
        Json::<T>::from_request(req, state)
            .await
            .map(|Json(v)| JsonBody(v))
            .map_err(|e| ApiError::bad_request(e.body_text()))
    }
}

fn with_cookie(mut resp: Response, cookie: HeaderValue) -> Response {
    resp.headers_mut().append(header::SET_COOKIE, cookie);
    resp
}

// ---- auth ----

pub async fn status(
    State(state): State<Arc<AppState>>,
    session: Result<CurrentUser, ApiError>,
) -> ApiResult {
    let users = state.db.user_count().map_err(ApiError::db)?;
    Ok(Json(json!({
        "setup_required": users == 0,
        "anonymous_docs": state.anonymous_docs,
        "user": session.ok().map(|CurrentUser(s)| s.user),
    }))
    .into_response())
}

#[derive(Deserialize)]
pub struct SetupBody {
    token: String,
    username: String,
    password: String,
}

pub async fn setup(
    State(state): State<Arc<AppState>>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    JsonBody(body): JsonBody<SetupBody>,
) -> ApiResult {
    state.throttle.check(ip, None).map_err(ApiError::too_many)?;
    let Some(expected) = state.bootstrap_token.as_deref() else {
        return Err(ApiError::forbidden(
            "setup is disabled: WEFT_BOOTSTRAP_TOKEN is not set",
        ));
    };
    if state.db.user_count().map_err(ApiError::db)? > 0 {
        return Err(ApiError::forbidden("setup has already been completed"));
    }
    if !auth::ct_eq(body.token.as_bytes(), expected.as_bytes()) {
        state.throttle.fail(ip, None);
        tracing::warn!(%ip, "setup with a bad bootstrap token");
        return Err(ApiError::forbidden("bad bootstrap token"));
    }
    if !valid_username(&body.username) {
        return Err(ApiError::bad_request(
            "username must be 3-32 characters: letters, digits, _ . -",
        ));
    }
    check_password_rules(&body.password)?;
    let hash = auth::hash_password(body.password).await?;
    let Some(user) = state
        .db
        .create_first_admin(&body.username, &hash)
        .map_err(ApiError::db)?
    else {
        return Err(ApiError::forbidden("setup has already been completed"));
    };
    tracing::info!(username = user.username, "first admin created");
    let cookie = auth::new_session(&state, user.id, &headers)?;
    Ok(with_cookie(
        Json(json!({ "user": user })).into_response(),
        cookie,
    ))
}

#[derive(Deserialize)]
pub struct LoginBody {
    username: String,
    password: String,
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    JsonBody(body): JsonBody<LoginBody>,
) -> ApiResult {
    let name_ok = valid_username(&body.username);
    let throttle_name = name_ok.then_some(body.username.as_str());
    state
        .throttle
        .attempt(ip, throttle_name)
        .map_err(ApiError::too_many)?;
    let creds = if name_ok && body.password.len() <= 4 * auth::PASSWORD_MAX {
        state.db.credentials(&body.username).map_err(ApiError::db)?
    } else {
        None
    };
    let hash = creds.as_ref().map(|c| c.password_hash.clone());
    let password = body.password.chars().take(4 * auth::PASSWORD_MAX).collect();
    if !auth::verify_password(password, hash).await? {
        tracing::info!(%ip, "failed login");
        return Err(ApiError::unauthorized("invalid username or password"));
    }
    state.throttle.forgive(ip, throttle_name);
    let creds = creds.expect("verified against a real hash");
    if creds.disabled {
        return Err(ApiError::unauthorized("this account is disabled"));
    }
    let cookie = auth::new_session(&state, creds.user.id, &headers)?;
    Ok(with_cookie(
        Json(json!({ "user": creds.user })).into_response(),
        cookie,
    ))
}

pub async fn logout(
    State(state): State<Arc<AppState>>,
    session: Result<CurrentUser, ApiError>,
) -> ApiResult {
    if let Ok(CurrentUser(s)) = session {
        state
            .db
            .delete_session(&s.token_hash)
            .map_err(ApiError::db)?;
        state.kill_sockets(|r| r.session == s.token_hash);
    }
    Ok(with_cookie(
        StatusCode::NO_CONTENT.into_response(),
        auth::clear_cookie(),
    ))
}

#[derive(Deserialize)]
pub struct PasswordBody {
    current: String,
    new: String,
}

pub async fn change_password(
    State(state): State<Arc<AppState>>,
    ClientIp(ip): ClientIp,
    CurrentUser(s): CurrentUser,
    JsonBody(body): JsonBody<PasswordBody>,
) -> ApiResult {
    let name = Some(s.user.username.as_str());
    state
        .throttle
        .attempt(ip, name)
        .map_err(ApiError::too_many)?;
    let hash = state.db.password_hash(s.user.id).map_err(ApiError::db)?;
    if !auth::verify_password(body.current, hash).await? {
        return Err(ApiError::forbidden("current password is incorrect"));
    }
    state.throttle.forgive(ip, name);
    check_password_rules(&body.new)?;
    let hash = auth::hash_password(body.new).await?;
    state
        .db
        .set_password(s.user.id, &hash)
        .map_err(ApiError::db)?;
    revoke_sessions(&state, s.user.id, Some(&s))?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Deletes a user's sessions (except `keep`) and closes their sockets on those sessions.
fn revoke_sessions(state: &AppState, user_id: i64, keep: Option<&Session>) -> ApiResult<()> {
    let keep = keep.map(|s| s.token_hash);
    state
        .db
        .delete_user_sessions(user_id, keep.as_ref())
        .map_err(ApiError::db)?;
    state.kill_sockets(|r| r.user_id == user_id && Some(r.session) != keep);
    Ok(())
}

// ---- notes ----

pub async fn list_notes(
    State(state): State<Arc<AppState>>,
    CurrentUser(s): CurrentUser,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult {
    let filter = match q.get("filter").map(String::as_str) {
        None | Some("") | Some("all") => NoteFilter::All,
        Some("pinned") => NoteFilter::Pinned,
        Some("archived") => NoteFilter::Archived,
        Some(_) => {
            return Err(ApiError::bad_request(
                "filter must be all, pinned or archived",
            ));
        }
    };
    let notes = state
        .db
        .list_notes(s.user.id, filter, q.get("q").map(String::as_str))
        .map_err(ApiError::db)?;
    Ok(Json(notes).into_response())
}

#[derive(Deserialize)]
pub struct CreateNoteBody {
    id: String,
    text: Option<String>,
    from_doc: Option<String>,
}

pub async fn create_note(
    State(state): State<Arc<AppState>>,
    CurrentUser(s): CurrentUser,
    JsonBody(body): JsonBody<CreateNoteBody>,
) -> ApiResult {
    if !valid_note_id(&body.id) {
        return Err(ApiError::bad_request("invalid note id"));
    }
    let text = match (body.text, body.from_doc) {
        (Some(_), Some(_)) => return Err(ApiError::bad_request("give text or from_doc, not both")),
        (Some(t), None) => t,
        (None, Some(doc)) => {
            if !state.anonymous_docs || !valid_doc_id(&doc) {
                return Err(ApiError::not_found("no such doc"));
            }
            match state.current_text(&RoomKey::Doc(doc)) {
                Ok(Some(t)) => t,
                Ok(None) => return Err(ApiError::not_found("no such doc")),
                Err(e) => {
                    tracing::error!(error = %e, "reading doc for from_doc failed");
                    return Err(ApiError::internal());
                }
            }
        }
        (None, None) => String::new(),
    };
    if text.len() as u64 > state.limits.max_doc_bytes / 2 {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "note text is too large",
        ));
    }
    if !state
        .db
        .insert_note(&body.id, s.user.id)
        .map_err(ApiError::db)?
    {
        return Err(ApiError::conflict("note id already taken"));
    }
    if let Err(e) = state.seed_note(&body.id, &text) {
        tracing::error!(note = body.id, error = %e, "seeding note log failed");
        let _ = state.db.delete_note(&body.id, s.user.id);
        return Err(ApiError::internal());
    }
    state.refresh_note_meta(&body.id, &text);
    let note = get_note(&state, &body.id, s.user.id)?;
    Ok((StatusCode::CREATED, Json(note)).into_response())
}

fn get_note(state: &AppState, id: &str, owner: i64) -> ApiResult<Note> {
    if !valid_note_id(id) {
        return Err(ApiError::not_found("no such note"));
    }
    state
        .db
        .note(id, owner)
        .map_err(ApiError::db)?
        .ok_or_else(|| ApiError::not_found("no such note"))
}

#[derive(Deserialize)]
pub struct PatchNoteBody {
    pinned: Option<bool>,
    color: Option<String>,
    archived: Option<bool>,
}

pub async fn patch_note(
    State(state): State<Arc<AppState>>,
    CurrentUser(s): CurrentUser,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<PatchNoteBody>,
) -> ApiResult {
    get_note(&state, &id, s.user.id)?;
    if let Some(c) = &body.color
        && !NOTE_COLORS.contains(&c.as_str())
    {
        return Err(ApiError::bad_request("unknown color"));
    }
    state
        .db
        .patch_note(
            &id,
            s.user.id,
            body.pinned,
            body.color.as_deref(),
            body.archived,
        )
        .map_err(ApiError::db)?;
    Ok(Json(get_note(&state, &id, s.user.id)?).into_response())
}

pub async fn delete_note(
    State(state): State<Arc<AppState>>,
    CurrentUser(s): CurrentUser,
    Path(id): Path<String>,
) -> ApiResult {
    get_note(&state, &id, s.user.id)?;
    if !state.db.delete_note(&id, s.user.id).map_err(ApiError::db)? {
        return Err(ApiError::not_found("no such note"));
    }
    state.drop_note_content(&id);
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn export_note(
    State(state): State<Arc<AppState>>,
    CurrentUser(s): CurrentUser,
    Path(id): Path<String>,
) -> ApiResult {
    get_note(&state, &id, s.user.id)?;
    let text = state
        .current_text(&RoomKey::Note(id))
        .map_err(|e| {
            tracing::error!(error = %e, "note export failed");
            ApiError::internal()
        })?
        .unwrap_or_default();
    Ok((
        [(header::CONTENT_TYPE, "text/markdown; charset=utf-8")],
        text,
    )
        .into_response())
}

// ---- admin ----

fn valid_role(r: &str) -> bool {
    r == "admin" || r == "user"
}

fn admin_user(state: &AppState, id: i64) -> ApiResult<AdminUserRow> {
    state
        .db
        .admin_user(id)
        .map_err(ApiError::db)?
        .ok_or_else(|| ApiError::not_found("no such user"))
}

pub async fn admin_list(State(state): State<Arc<AppState>>, _: AdminUser) -> ApiResult {
    Ok(Json(state.db.list_users().map_err(ApiError::db)?).into_response())
}

#[derive(Deserialize)]
pub struct AdminCreateBody {
    username: String,
    password: String,
    role: String,
}

pub async fn admin_create(
    State(state): State<Arc<AppState>>,
    AdminUser(admin): AdminUser,
    JsonBody(body): JsonBody<AdminCreateBody>,
) -> ApiResult {
    if !valid_username(&body.username) {
        return Err(ApiError::bad_request(
            "username must be 3-32 characters: letters, digits, _ . -",
        ));
    }
    if !valid_role(&body.role) {
        return Err(ApiError::bad_request("role must be admin or user"));
    }
    check_password_rules(&body.password)?;
    let hash = auth::hash_password(body.password).await?;
    let Some(id) = state
        .db
        .create_user(&body.username, &hash, &body.role)
        .map_err(ApiError::db)?
    else {
        return Err(ApiError::conflict("username already taken"));
    };
    tracing::info!(
        by = admin.user.username,
        username = body.username,
        "user created"
    );
    Ok((StatusCode::CREATED, Json(admin_user(&state, id)?)).into_response())
}

#[derive(Deserialize)]
pub struct AdminPatchBody {
    password: Option<String>,
    role: Option<String>,
    disabled: Option<bool>,
}

pub async fn admin_patch(
    State(state): State<Arc<AppState>>,
    AdminUser(admin): AdminUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<AdminPatchBody>,
) -> ApiResult {
    let target = admin_user(&state, id)?;
    if let Some(r) = &body.role
        && !valid_role(r)
    {
        return Err(ApiError::bad_request("role must be admin or user"));
    }
    if let Some(p) = &body.password {
        check_password_rules(p)?;
    }
    let removes_admin = body.role.as_deref() == Some("user") || body.disabled == Some(true);
    if target.role == "admin"
        && !target.disabled
        && removes_admin
        && state.db.other_active_admins(id).map_err(ApiError::db)? == 0
    {
        return Err(ApiError::forbidden(
            "can't demote or disable the last admin",
        ));
    }
    let keep = (id == admin.user.id).then_some(&admin);
    if let Some(p) = body.password {
        let hash = auth::hash_password(p).await?;
        state.db.set_password(id, &hash).map_err(ApiError::db)?;
        revoke_sessions(&state, id, keep)?;
    }
    state
        .db
        .update_user(id, body.role.as_deref(), body.disabled)
        .map_err(ApiError::db)?;
    if body.disabled == Some(true) {
        revoke_sessions(&state, id, None)?;
    }
    Ok(Json(admin_user(&state, id)?).into_response())
}

pub async fn admin_delete(
    State(state): State<Arc<AppState>>,
    AdminUser(admin): AdminUser,
    Path(id): Path<i64>,
) -> ApiResult {
    if id == admin.user.id {
        return Err(ApiError::forbidden("you can't delete yourself"));
    }
    let target = admin_user(&state, id)?;
    if target.role == "admin"
        && !target.disabled
        && state.db.other_active_admins(id).map_err(ApiError::db)? == 0
    {
        return Err(ApiError::forbidden("can't delete the last admin"));
    }
    let notes = state.db.delete_user(id).map_err(ApiError::db)?;
    state.kill_sockets(|r| r.user_id == id);
    for note in &notes {
        state.drop_note_content(note);
    }
    tracing::info!(
        by = admin.user.username,
        username = target.username,
        notes = notes.len(),
        "user deleted"
    );
    Ok(StatusCode::NO_CONTENT.into_response())
}
