// xzk — EXPERIMENTAL, UNAUDITED ZK cube-curve state-commitment (post-quantum, hash-based).
// Clean library extraction of the verified prototype (fri.mjs + deep-fri-demo.mjs).
//
// ROLE: a STATE-COMMITMENT layer that COMPOSES WITH MAYO (which still signs identities/txs).
// It is NOT xid CurveSource (that feeds MAYO's public map and is MinRank-broken if geometry-
// driven — see cube-curve-mayo-scheme-spec.md §10). Drop-in target for xmbl_testnet as a
// decoupled experimental module; do NOT wire to production paths until a MAYO/UOV-adjacent
// ZK cryptographer signs off the simulator + params (see §12/§12b caveats).
//
// API:
//   ctx = setup(opts?)
//   { Pt, derivedY } = blindedCurve(ctx, { publicPoints, secretPoints, derivedX, blindDegree })
//   proof            = prove(ctx, { Pt, publicPoints, derivedX, derivedY })
//   bool             = verify(ctx, { proof, publicPoints, derivedX, derivedY })
// Statement proven in ZK: "the committed degree-<K curve passes through publicPoints AND
// through (derivedX, derivedY)" — leaking nothing about secretPoints beyond the
// deg(P)+1-|reveal| DOF the public statement itself implies.

import { p, mod, add, sub, mul, inv, polyEval, interpolate, domainOfSize, merkle, mpath, mverify, H, friProve, friVerify } from './fri.js';

const polyAdd = (a, b) => { const n = Math.max(a.length, b.length); return Array.from({ length: n }, (_, i) => add(a[i] || 0n, b[i] || 0n)); };
const polySub = (a, b) => { const n = Math.max(a.length, b.length); return Array.from({ length: n }, (_, i) => sub(a[i] || 0n, b[i] || 0n)); };
const polyMul = (a, b) => { const r = new Array(a.length + b.length - 1).fill(0n); for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) r[i + j] = add(r[i + j], mul(a[i], b[j])); return r; };
const trim = (a) => { const c = a.slice(); while (c.length > 1 && c[c.length - 1] === 0n) c.pop(); return c; };
const vanishing = (roots) => { let v = [1n]; for (const r of roots) v = polyMul(v, [mod(-r), 1n]); return v; };
function polyDivmod(a, b) {
  b = trim(b); const q = new Array(Math.max(1, a.length - b.length + 1)).fill(0n); let r = trim(a); const bInv = inv(b[b.length - 1]);
  for (let g = 0; g < 4096; g++) { r = trim(r); if (r.length < b.length || (r.length === 1 && r[0] === 0n)) break; const sh = r.length - b.length, c = mul(r[r.length - 1], bInv); q[sh] = c; for (let i = 0; i < b.length; i++) r[sh + i] = sub(r[sh + i] || 0n, mul(c, b[i])); }
  return { q: trim(q), r: trim(r) };
}
const fsIdx = (t, N, n) => Array.from({ length: n }, (_, i) => Number(BigInt('0x' + H(t + ':c' + i).slice(0, 12)) % BigInt(N)));

export function setup(opts = {}) {
  const K = opts.degreeBound || 32, N = opts.domainSize || 128, nq = opts.nQueries || 12, nc = opts.nConstraints || 16;
  return { K, N, nq, nc, dom: domainOfSize(N) };
}

// Build the blinded committed curve P̃ = P + Z_R·B through public + secret points.
export function blindedCurve(ctx, { publicPoints, secretPoints, derivedX, blindDegree = 18, blindSeed = 1n }) {
  const P = interpolate([...publicPoints.map((q) => q.x), ...secretPoints.map((q) => q.x)], [...publicPoints.map((q) => q.y), ...secretPoints.map((q) => q.y)]);
  const derivedY = polyEval(P, derivedX);
  const Rxs = [...publicPoints.map((q) => q.x), derivedX];
  const Zr = vanishing(Rxs);
  const B = Array.from({ length: blindDegree + 1 }, (_, i) => mod((blindSeed * BigInt(i * 97 + 13) + 7919n) % p));
  return { Pt: polyAdd(P, polyMul(Zr, B)), derivedY, P, Zr };
}

export function prove(ctx, { Pt, publicPoints, derivedX, derivedY }) {
  const { dom, K, nq, nc, N } = ctx;
  const Rxs = [...publicPoints.map((q) => q.x), derivedX], Rys = [...publicPoints.map((q) => q.y), derivedY];
  const Ir = interpolate(Rxs, Rys), Zr = vanishing(Rxs);
  const { q: C } = polyDivmod(polySub(Pt, Ir), Zr);
  const evP = dom.map((x) => polyEval(Pt, x)), evC = dom.map((x) => polyEval(C, x));
  const comP = merkle(evP), comC = merkle(evC);
  const idxs = fsIdx(comP.root + ':' + comC.root, N, nc);
  return {
    rootP: comP.root, rootC: comC.root,
    friP: friProve(evP, dom, K, nq), friC: friProve(evC, dom, K, nq),
    cons: idxs.map((i) => ({ i, Pv: evP[i], Cv: evC[i], pP: mpath(comP.tree, i), pC: mpath(comC.tree, i) })),
  };
}

export function verify(ctx, { proof, publicPoints, derivedX, derivedY }) {
  const { dom, N, nc } = ctx;
  const Rxs = [...publicPoints.map((q) => q.x), derivedX], Rys = [...publicPoints.map((q) => q.y), derivedY];
  const Ir = interpolate(Rxs, Rys), Zr = vanishing(Rxs);
  if (!friVerify(proof.friP, dom) || !friVerify(proof.friC, dom)) return false;
  const idxs = fsIdx(proof.rootP + ':' + proof.rootC, N, nc);
  for (let k = 0; k < nc; k++) {
    const c = proof.cons[k], i = idxs[k], z = dom[i];
    if (c.i !== i) return false;
    if (!mverify(proof.rootP, c.Pv, i, c.pP) || !mverify(proof.rootC, c.Cv, i, c.pC)) return false;
    if (sub(c.Pv, polyEval(Ir, z)) !== mul(polyEval(Zr, z), c.Cv)) return false;
  }
  return true;
}

// ---- self-test ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const ctx = setup();
  const publicPoints = [{ x: 11n, y: 101n }, { x: 12n, y: 205n }, { x: 13n, y: 313n }, { x: 14n, y: 419n }];
  const secretPoints = [{ x: 21n, y: 55555n }, { x: 22n, y: 66666n }, { x: 23n, y: 77777n }];
  const { Pt, derivedY } = blindedCurve(ctx, { publicPoints, secretPoints, derivedX: 99n });
  const proof = prove(ctx, { Pt, publicPoints, derivedX: 99n, derivedY });
  const ok = (b) => (b ? 'PASS' : 'FAIL');
  console.log(`xzk honest proof verifies:            ${ok(verify(ctx, { proof, publicPoints, derivedX: 99n, derivedY }))}  (want PASS)`);
  console.log(`xzk rejects forged derived y*+1:       ${ok(!verify(ctx, { proof, publicPoints, derivedX: 99n, derivedY: add(derivedY, 1n) }))}  (want PASS->rejected)`);
}
