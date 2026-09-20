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

import { randomBytes } from 'node:crypto';
import { p, mod, add, sub, mul, inv, polyEval, interpolate, domainOfSize, merkle, mpath, mverify, H, friProve, friVerify, GRIND_BITS, EXT_BITS } from './fri.js';

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

// Shipped parameters. Rate rho = K/N = 1/16; every folding challenge is drawn from the ~124-bit
// quartic extension (fri.js), and the query transcript carries GRIND_BITS of proof-of-work.
//   query soundness (provable, unique-decoding): delta <= (1-rho)/2 = 0.469
//     -> nq * log2(1/(1-delta)) = 88 * 0.912 ~ 80 bits, + 20 grind ~ 100 bits
//   query soundness (list-decoding, conjectured): nq * log2(1/rho) = 88 * 4 = 352 bits
//   constraint check: nc random points, false-accept ~ (deg/N)^nc -> 32 * log2(512/50) ~ 107 bits
//   challenge grinding: bounded by the extension field, ~124 bits (was 31 over the base field)
export function setup(opts = {}) {
  const K = opts.degreeBound || 32, N = opts.domainSize || 512, nq = opts.nQueries || 88, nc = opts.nConstraints || 32;
  const grind = opts.grindBits === undefined ? GRIND_BITS : opts.grindBits;
  return { K, N, nq, nc, grind, extBits: EXT_BITS, dom: domainOfSize(N) };
}

// Build the blinded committed curve P̃ = P + Z_R·B through public + secret points.
//
// THE BLIND IS FRESH RANDOMNESS. Every coefficient of B is drawn independently, and by default the
// seed comes from the system CSPRNG, so re-committing the same secret points yields an unrelated
// P̃ away from the revealed set. An omitted seed used to fall back to a constant, which made B a
// publicly recomputable vector: the masking term was present in the algebra and absent in effect.
// `blindSeed` remains accepted so a test can reproduce a specific blind; passing one in production
// re-creates exactly the problem this replaced. Note Z_R vanishes on the revealed x's, so no blind
// can move the public points or derivedY — only the committed curve away from them.
function blindCoeffs(blindDegree, blindSeed) {
  const n = blindDegree + 1;
  if (blindSeed === undefined) {
    // 32 bytes per coefficient, reduced mod p: bias below 2^-90, far under any bound that matters.
    const rb = randomBytes(32 * n);
    return Array.from({ length: n }, (_, i) => mod(BigInt('0x' + rb.subarray(i * 32, i * 32 + 32).toString('hex'))));
  }
  return Array.from({ length: n }, (_, i) => mod(BigInt('0x' + H('xzk:blind:' + blindSeed.toString() + ':' + i))));
}
export function blindedCurve(ctx, { publicPoints, secretPoints, derivedX, blindDegree = 18, blindSeed }) {
  const P = interpolate([...publicPoints.map((q) => q.x), ...secretPoints.map((q) => q.x)], [...publicPoints.map((q) => q.y), ...secretPoints.map((q) => q.y)]);
  const derivedY = polyEval(P, derivedX);
  const Rxs = [...publicPoints.map((q) => q.x), derivedX];
  const Zr = vanishing(Rxs);
  const B = blindCoeffs(blindDegree, blindSeed);
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
    friP: friProve(evP, dom, K, nq, ctx.grind), friC: friProve(evC, dom, K, nq, ctx.grind),
    cons: idxs.map((i) => ({ i, Pv: evP[i], Cv: evC[i], pP: mpath(comP.tree, i), pC: mpath(comC.tree, i) })),
  };
}

export function verify(ctx, { proof, publicPoints, derivedX, derivedY }) {
  const { dom, N, nc } = ctx;
  const Rxs = [...publicPoints.map((q) => q.x), derivedX], Rys = [...publicPoints.map((q) => q.y), derivedY];
  const Ir = interpolate(Rxs, Rys), Zr = vanishing(Rxs);
  // The constraint openings are authenticated against rootP/rootC while the low-degree test runs on
  // the FRI proof's own layer-0 commitment. Bind them: without this the two halves of the argument
  // could be about DIFFERENT codewords — a low-degree proof of one polynomial with constraint
  // openings from another. Layer 0 keeps the base-field leaf encoding precisely so this can be checked.
  if (proof.friP.roots[0] !== proof.rootP || proof.friC.roots[0] !== proof.rootC) return false;
  // K/N/nq/grind are the verifier's agreed parameters — pass them so the proof cannot declare its own.
  if (!friVerify(proof.friP, dom, ctx.K, ctx.nq, ctx.grind) || !friVerify(proof.friC, dom, ctx.K, ctx.nq, ctx.grind)) return false;
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
