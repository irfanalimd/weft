// One-time WASM initialisation. The rest of src/sync imports WeftClient from here.

import init, { WeftClient } from '../wasm/pkg/weft_wasm.js';

export { WeftClient };
export type { ClientOutputJs, ChangeJs, AwarenessJs } from '../wasm/pkg/weft_wasm.js';

let ready: Promise<void> | null = null;

/** Load and instantiate the wasm module once; later calls share the same promise. */
export function initWasm(): Promise<void> {
  ready ??= init().then(() => undefined);
  return ready;
}
