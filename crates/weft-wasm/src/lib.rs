//! Browser bindings for Weft. See `docs/ARCHITECTURE.md` §4.
//!
//! One class, [`WeftClient`], wraps a [`weft_sync::ClientSession`]. Byte arrays cross the boundary
//! as `Uint8Array`; outputs are plain JS objects built with `js-sys` (no serde in the wasm path).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use js_sys::{Array, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;
use weft_core::{Anchor, Change, Doc, StateVector, Update};
use weft_sync::{ClientSession, Message};

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &str = r#"
export type ChangeJs = { insert: { pos: number; text: string } } | { delete: { pos: number; len: number } };
export interface AwarenessJs { clientId: bigint; payload: string | null }
export interface ClientOutputJs {
  send: Uint8Array[];
  changes: ChangeJs[];
  awareness: AwarenessJs[];
  /** Set when the server sent a fatal `Error` frame. */
  error?: { code: number; message: string };
}
"#;

#[wasm_bindgen]
pub fn weft_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
pub struct WeftClient {
    session: ClientSession,
    /// Version before the first local edit not yet handed out by `takeLocalUpdate`.
    local_since: Option<StateVector>,
}

fn set(obj: &Object, key: &str, value: &JsValue) {
    // Setting a property on a fresh plain object cannot fail.
    let _ = Reflect::set(obj, &JsValue::from_str(key), value);
}

fn frames(msgs: Vec<Message>) -> Array {
    msgs.iter()
        .map(|m| JsValue::from(Uint8Array::from(m.encode().as_slice())))
        .collect()
}

fn change_js(c: &Change) -> JsValue {
    let inner = Object::new();
    let outer = Object::new();
    match c {
        Change::Insert { pos, text } => {
            set(&inner, "pos", &JsValue::from(*pos as u32));
            set(&inner, "text", &JsValue::from_str(text));
            set(&outer, "insert", &inner);
        }
        Change::Delete { pos, len } => {
            set(&inner, "pos", &JsValue::from(*pos as u32));
            set(&inner, "len", &JsValue::from(*len as u32));
            set(&outer, "delete", &inner);
        }
    }
    outer.into()
}

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
impl WeftClient {
    #[wasm_bindgen(constructor)]
    pub fn new(doc_id: String, client_id: u64) -> WeftClient {
        Self::wrap(ClientSession::new(doc_id, Doc::new(client_id)))
    }

    /// Load from a persisted full state (as produced by `encodeState`).
    #[wasm_bindgen(js_name = fromState)]
    pub fn from_state(doc_id: String, client_id: u64, state: &[u8]) -> Result<WeftClient, JsError> {
        let mut doc = Doc::new(client_id);
        doc.apply_update(&Update(state.to_vec())).map_err(err)?;
        Ok(Self::wrap(ClientSession::new(doc_id, doc)))
    }

    /// Additive: load from several persisted states (e.g. one per tab), merged.
    #[wasm_bindgen(js_name = fromStates)]
    pub fn from_states(
        doc_id: String,
        client_id: u64,
        states: Vec<Uint8Array>,
    ) -> Result<WeftClient, JsError> {
        let mut doc = Doc::new(client_id);
        for s in states {
            doc.apply_update(&Update(s.to_vec())).map_err(err)?;
        }
        Ok(Self::wrap(ClientSession::new(doc_id, doc)))
    }

    fn wrap(session: ClientSession) -> WeftClient {
        WeftClient {
            session,
            local_since: None,
        }
    }

    #[wasm_bindgen(getter, js_name = clientId)]
    pub fn client_id(&self) -> u64 {
        self.session.doc().client_id()
    }

    pub fn text(&self) -> String {
        self.session.doc().text()
    }

    #[wasm_bindgen(js_name = lenUtf16)]
    pub fn len_utf16(&self) -> u32 {
        self.session.doc().len_utf16() as u32
    }

    #[wasm_bindgen(js_name = encodeState)]
    pub fn encode_state(&self) -> Vec<u8> {
        self.session.doc().encode_full().0
    }

    // ---- transport ----

    #[wasm_bindgen(js_name = onConnected, unchecked_return_type = "Uint8Array[]")]
    pub fn on_connected(&mut self) -> Array {
        frames(self.session.on_connected())
    }

    #[wasm_bindgen(js_name = onDisconnected)]
    pub fn on_disconnected(&mut self) {
        self.session.on_disconnected();
    }

    #[wasm_bindgen(js_name = onMessage, unchecked_return_type = "ClientOutputJs")]
    pub fn on_message(&mut self, frame: &[u8]) -> Result<JsValue, JsError> {
        let msg = Message::decode(frame).map_err(err)?;
        let error = match &msg {
            Message::Error { code, message } => Some((*code, message.clone())),
            _ => None,
        };
        let out = self.session.on_message(msg).map_err(err)?;
        let obj = Object::new();
        set(&obj, "send", &frames(out.send));
        let changes: Array = out.changes.iter().map(change_js).collect();
        set(&obj, "changes", &changes);
        let awareness: Array = out
            .awareness
            .into_iter()
            .map(|(id, payload)| {
                let a = Object::new();
                set(&a, "clientId", &JsValue::from(id));
                let p = match payload {
                    Some(bytes) => JsValue::from_str(&String::from_utf8_lossy(&bytes)),
                    None => JsValue::NULL,
                };
                set(&a, "payload", &p);
                JsValue::from(a)
            })
            .collect();
        set(&obj, "awareness", &awareness);
        if let Some((code, message)) = error {
            let e = Object::new();
            set(&e, "code", &JsValue::from(code));
            set(&e, "message", &JsValue::from_str(&message));
            set(&obj, "error", &e);
        }
        Ok(obj.into())
    }

    /// Additive: apply a raw encoded `Update` (not a frame), e.g. a second persisted state.
    #[wasm_bindgen(js_name = applyUpdate, unchecked_return_type = "ClientOutputJs")]
    pub fn apply_update(&mut self, update: Vec<u8>) -> Result<JsValue, JsError> {
        let frame = Message::Update { update }.encode();
        self.on_message(&frame)
    }

    // ---- local edits ----

    #[wasm_bindgen(unchecked_return_type = "Uint8Array[]")]
    pub fn insert(&mut self, pos: u32, text: &str) -> Array {
        self.mark_local();
        frames(self.session.insert(pos as usize, text))
    }

    #[wasm_bindgen(unchecked_return_type = "Uint8Array[]")]
    pub fn delete(&mut self, pos: u32, len: u32) -> Array {
        self.mark_local();
        frames(self.session.delete(pos as usize, len as usize))
    }

    #[wasm_bindgen(js_name = setAwareness, unchecked_return_type = "Uint8Array[]")]
    pub fn set_awareness(&mut self, json: &str) -> Array {
        frames(self.session.set_awareness(json.as_bytes().to_vec()))
    }

    fn mark_local(&mut self) {
        if self.local_since.is_none() {
            self.local_since = Some(self.session.doc().state_vector());
        }
    }

    /// Additive: an `Update` frame with every local edit since the previous call (works offline
    /// too). Used to forward edits to other tabs over BroadcastChannel.
    #[wasm_bindgen(js_name = takeLocalUpdate)]
    pub fn take_local_update(&mut self) -> Option<Vec<u8>> {
        let since = self.local_since.take()?;
        let update = self.session.doc().encode_diff(&since);
        Some(Message::Update { update: update.0 }.encode())
    }

    /// Additive: encoded state vector of this replica.
    #[wasm_bindgen(js_name = stateVector)]
    pub fn state_vector(&self) -> Vec<u8> {
        self.session.doc().state_vector().encode()
    }

    /// Additive: number of op units (UTF-16 units inserted or deleted) this replica has that `sv`
    /// doesn't cover. With the server's last confirmed state vector, this counts edits that survive
    /// a reload but that the current session's `unsyncedOpCount` can't see (they have older client ids).
    #[wasm_bindgen(js_name = countNotIn)]
    /// An empty `sv` means the empty version (nothing confirmed).
    pub fn count_not_in(&self, sv: &[u8]) -> Result<u32, JsError> {
        let sv = if sv.is_empty() {
            StateVector::default()
        } else {
            StateVector::decode(sv).map_err(err)?
        };
        let n: u64 = self
            .session
            .doc()
            .state_vector()
            .iter()
            .map(|(client, clock)| clock.saturating_sub(sv.get(client)))
            .sum();
        Ok(n.min(u32::MAX as u64) as u32)
    }

    /// Additive: an `Update` frame with everything not covered by `sv`, or undefined if nothing.
    #[wasm_bindgen(js_name = encodeDiffFrame)]
    pub fn encode_diff_frame(&self, sv: &[u8]) -> Result<Option<Vec<u8>>, JsError> {
        let sv = StateVector::decode(sv).map_err(err)?;
        let update = self.session.doc().encode_diff(&sv);
        if update.is_empty() {
            return Ok(None);
        }
        Ok(Some(Message::Update { update: update.0 }.encode()))
    }

    #[wasm_bindgen(js_name = isSynced)]
    pub fn is_synced(&self) -> bool {
        self.session.is_synced()
    }

    /// Additive: handshake completed on the current connection.
    #[wasm_bindgen(js_name = isLive)]
    pub fn is_live(&self) -> bool {
        self.session.is_live()
    }

    #[wasm_bindgen(js_name = unsyncedOpCount)]
    pub fn unsynced_op_count(&self) -> u32 {
        self.session.unsynced_op_count() as u32
    }

    // ---- cursors ----

    #[wasm_bindgen(js_name = anchorAt)]
    pub fn anchor_at(&self, pos: u32) -> String {
        B64.encode(self.session.doc().anchor_at(pos as usize).encode())
    }

    #[wasm_bindgen(js_name = resolveAnchor)]
    pub fn resolve_anchor(&self, anchor: &str) -> Option<u32> {
        let bytes = B64.decode(anchor).ok()?;
        let a = Anchor::decode(&bytes).ok()?;
        self.session.doc().resolve_anchor(&a).map(|p| p as u32)
    }

    // ---- history ----

    #[wasm_bindgen(js_name = opCount)]
    pub fn op_count(&self) -> u32 {
        self.session.doc().op_count() as u32
    }

    #[wasm_bindgen(js_name = textAtStep)]
    pub fn text_at_step(&self, step: u32) -> String {
        let doc = self.session.doc();
        let step = (step as usize).min(doc.op_count());
        doc.text_at(&doc.version_at(step))
    }
}
