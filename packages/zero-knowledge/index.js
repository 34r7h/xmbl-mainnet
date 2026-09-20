// XZK — experimental, UNAUDITED zero-knowledge cube-curve state-commitment.
// Post-quantum (hash-based FRI). COMPOSES WITH MAYO; it is NOT an xid CurveSource
// (that feeds MAYO's public map and is MinRank-broken if geometry-driven). Decoupled:
// imports nothing from xclt/xvsm/xid.
//
// WIRED TO CONTRACTS, OPT-IN (still UNAUDITED ⛔): @xmbl/contracts exposes `verify` to a
// deployed contract through the `zkHost` deploy flag as a synchronous `env.xmbl_zk_verify`
// host call (the proof + public points are chain-staged; the guest supplies the asserted
// coordinate from its own memory, so a contract gates a Verkle state transition on a real
// ZK verdict — see packages/contracts/src/xcl/abi.js HOST_ABI_ZK_INIT_SOURCE and
// reproductions/contract-zk.mjs). This is OPT-IN per contract and MUST NOT gate
// consensus/ledger/sealing; the module stays experimental and UNAUDITED (MAINNET-GATES ⛔)
// until a MAYO/UOV-adjacent ZK cryptographer signs off the simulator + params — see readme.md.
export { setup, blindedCurve, prove, verify } from './src/xzk.js';

// GENERAL-PURPOSE zero knowledge over the same field, commitments and FRI. `xzk` above proves ONE
// statement — a committed curve passes through given points. This proves ARBITRARY computation: a
// caller supplies an execution trace and the polynomial constraints a correct execution satisfies
// (an AIR), and gets a proof that a satisfying trace exists without revealing it. Each column is
// blinded by a multiple of (x^T - 1), which vanishes on every row, so the constraints are untouched
// while the openings stay underdetermined. Batching challenges come from the ~124-bit quartic
// extension, so the composition is extension-valued and FRI runs over it directly.
export {
  setup as airSetup, prove as airProve, verify as airVerify,
  STATEMENTS as AIR_STATEMENTS, statementCtx as airStatementCtx, verifyStatement as airVerifyStatement,
} from './src/air.js';

// The field and the primitives the AIR is written against, so a caller can express constraints.
export { p as FIELD_P, mod as fmod, add as fadd, sub as fsub, mul as fmul, inv as finv, pw as fpow, EXT_BITS, GRIND_BITS } from './src/fri.js';

// THE VERSION OF THE CODE THIS PROCESS LOADED. Read once at import time from this package's own manifest, so a
// running node can report what it is actually executing — an install that lands on disk after this module was
// loaded changes the file, not this constant. Consumed by @xmbl/core's control socket (`status`.versions).
import { readFileSync as __readPkg } from 'node:fs';
export const VERSION = JSON.parse(__readPkg(new URL('./package.json', import.meta.url), 'utf8')).version;
