// @xmbl/contracts — the XMBL smart-contract module.
//
// Two layers, each usable on its own:
//   - LNG (./src/lng): the contract LANGUAGE. Lex/parse/typecheck/interpret + compile to
//     Solidity (EVM) or WASM. Zero XMBL dependencies — a pure language toolchain.
//   - XCL (./src/xcl): the XMBL Contract LAYER. Binds compiled contracts to the running
//     chain — deterministic cubic placement, the storage-slot ↔ Verkle-key mapping, and
//     read-set/write-set staging. It DELEGATES sandboxed execution to @xmbl/storage-compute
//     and state to @xmbl/state-machine rather than re-implementing either.
export * from './src/lng/index.js';
export * from './src/xcl/index.js';
