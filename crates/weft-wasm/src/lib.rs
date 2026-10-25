//! Browser bindings for Weft. See `docs/ARCHITECTURE.md` §4. (Stub until M4 lands.)

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn weft_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
