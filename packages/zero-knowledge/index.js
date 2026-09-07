// XZK — experimental, UNAUDITED zero-knowledge cube-curve state-commitment.
// Post-quantum (hash-based FRI). COMPOSES WITH MAYO; it is NOT an xid CurveSource
// (that feeds MAYO's public map and is MinRank-broken if geometry-driven). Decoupled:
// imports nothing from xclt/xvsm/xid. NOT WIRED TO PRODUCTION — see readme.md.
export { setup, blindedCurve, prove, verify } from './src/xzk.js';
