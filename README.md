# Weft

A real-time collaborative Markdown editor that works offline.

Open a link, start typing, and share it. Everyone sees each other's cursors live. If you lose your connection you can
keep writing, and your edits merge when you're back online. No accounts.

Under the hood, one Rust CRDT engine runs in the browser (compiled to WebAssembly) and on the sync server.

## Run it locally

You need [Rust](https://rustup.rs) and [Node.js](https://nodejs.org) 20+.

```bash
# one-time setup
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
(cd web && npm install)

# build and run
./scripts/build-wasm.sh
(cd web && npm run build)
cargo run --release -p weft-server
```

Then open <http://localhost:7878> in two browser windows and type in both.

Docs are saved in `./data`. Set `WEFT_ADDR` to change the address (default `0.0.0.0:7878`).

## Project layout

- `crates/weft-core`: the CRDT engine
- `crates/weft-sync`: the sync protocol
- `crates/weft-server`: the WebSocket server
- `crates/weft-wasm`: browser bindings
- `web/`: the editor app (TypeScript + CodeMirror)

## License

MIT
