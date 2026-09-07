// LNG — the XMBL smart-contract language, standalone.
//
// This subtree is a pure language toolchain with ZERO XMBL dependencies: it lexes,
// parses, type-checks, interprets, and compiles LNG source to either Solidity (EVM) or
// WebAssembly. It is deliberately usable entirely on its own — a caller that only wants
// the language never pulls in state-machine, identity, or the ledger. The XMBL-native
// contract layer (xcl/) is what binds compiled LNG to the running chain.
//
// Determinism gate: on-chain code must be a pure function of inputs + state. Both backends
// (transpile → Solidity, compile → WASM) call assertDeterministic and REFUSE a contract
// that reads wall-clock time, randomness, or otherwise diverges across nodes.

export { run, lex, parse, INT_WIDTHS, isTypeName, intRange, DEC_ONE } from './lng.js';
export { check, checkDeterminism, assertDeterministic } from './typecheck.js';
export { transpile } from './transpile-evm.js';
export { compile } from './compile-wasm.js';
