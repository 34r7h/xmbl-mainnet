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
