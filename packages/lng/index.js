// @xmbl/lng — the XMBL smart-contract language, a STANDALONE module.
//
// A pure language toolchain with ZERO XMBL dependencies: it lexes, parses, type-checks,
// interprets, and compiles LNG source to either Solidity (EVM) or WebAssembly. It is
// deliberately usable entirely on its own — a caller that only wants the language never
// pulls in state-machine, identity, the ledger, or even @xmbl/contracts. The XMBL-native
// contract layer (@xmbl/contracts, XCL) DEPENDS ON this package to compile contracts; the
// dependency runs one way only (contracts → lng), never back.
//
// Determinism gate: on-chain code must be a pure function of inputs + state. Both backends
// (transpile → Solidity, compile → WASM) call assertDeterministic and REFUSE a contract
// that reads wall-clock time, randomness, or otherwise diverges across nodes.

export { run, lex, parse, INT_WIDTHS, isTypeName, intRange, DEC_ONE } from './src/lng.js';
export { check, checkDeterminism, assertDeterministic } from './src/typecheck.js';
export { transpile } from './src/transpile-evm.js';
export { compile } from './src/compile-wasm.js';
