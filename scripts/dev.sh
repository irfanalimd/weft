#!/usr/bin/env bash
# Build wasm, then run the sync server (:7878) and the Vite dev server (:5173) together.
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/build-wasm.sh --dev
cargo run -p weft-server &
server=$!
trap 'kill $server 2>/dev/null' EXIT
cd web && npm run dev
