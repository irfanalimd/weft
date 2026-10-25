#!/usr/bin/env bash
# Build weft-wasm into web/src/wasm/pkg. Pass --dev for a fast unoptimized build.
set -euo pipefail
cd "$(dirname "$0")/.."
mode="--release"
[[ "${1:-}" == "--dev" ]] && mode="--dev"
wasm-pack build crates/weft-wasm --target web $mode --out-dir ../../web/src/wasm/pkg --no-pack
