# Weft: working agreement

Weft is a real-time, offline-first collaborative Markdown editor. A Rust CRDT runs in the browser (WASM) and on the
sync server. Read these before doing anything:

- `docs/VISION.md`: what we're building and why (product principles, signature features).
- `docs/ARCHITECTURE.md`: layout and the **frozen contracts** between components.
- `PLAN.md`: milestone checklist with owners.

## Rules

1. **Stay in your lane.** Each owner edits only their own directories (see PLAN.md owners and the ARCHITECTURE layout).
   If you need something from another component, code against its contract. If the contract is missing something,
   make an *additive* change to the contract docs/stub and record it in the change log in ARCHITECTURE.md.
2. **Never break a frozen signature** without updating ARCHITECTURE.md and its change log in the same change.
3. **Check boxes in PLAN.md** only when the item is done *and verified* (tests pass or behavior was confirmed).
   Add a line to the PLAN.md progress log when you finish a chunk of work. Edit only your own milestone's lines,
   plus append-only rows in the log.
4. **Keep it simple and fast.** Minimal dependencies (no frameworks in `web/`, no serde in `weft-core`). Measure before
   and after anything performance-related.
5. **Minimal tests.** Write a test only when it's truly important. The ones we keep are the CRDT convergence proptest,
   the decode-garbage no-panic test, the sync network simulator, and the `web/scripts/smoke.mjs` end-to-end script.
   Verify everything else by running it.
6. **Quality bar** before calling something done: `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`,
   the tests above still pass, and `cd web && npm run typecheck` for web changes.
7. Several agents may be building at once. Cargo's build lock may make you wait, and that's fine. Don't `cargo clean`,
   don't delete others' files, and don't run `npm install` changes without need (coordinate via ARCHITECTURE.md notes).

## Environment

- Rust: `. ~/.cargo/env` first if `cargo` isn't on PATH. Target `wasm32-unknown-unknown` and `wasm-pack` are installed.
- Node 22 + npm. Vite 8, TypeScript 7.
- Ports: server `7878`, Vite dev `5173` (proxies `/ws` and `/api`).

## Commands

| Task | Command |
|---|---|
| Rust tests | `cargo test --workspace` |
| Lint | `cargo clippy --workspace --all-targets -- -D warnings` |
| Build wasm | `./scripts/build-wasm.sh [--dev]` → `web/src/wasm/pkg` |
| Web | `cd web && npm run dev` / `npm run typecheck` / `npm run build` |
| Server | `cargo run -p weft-server` |
| All | `./scripts/dev.sh` |
