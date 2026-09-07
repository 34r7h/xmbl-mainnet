// @xmbl/contracts — the XMBL Contract LAYER (XCL).
//
// Binds compiled contracts to the running chain: deterministic cubic placement, the
// storage-slot ↔ Verkle-key mapping, and read-set/write-set staging. It DELEGATES the
// contract LANGUAGE to @xmbl/lng (a standalone package), sandboxed execution to
// @xmbl/storage-compute, and state to @xmbl/state-machine — it re-implements none of them.
//
// The language is NOT re-exported from here: to compile a contract, depend on @xmbl/lng
// directly. This package is the binding layer, and keeping the surfaces separate is what
// lets each be used on its own.
export * from './src/xcl/index.js';
