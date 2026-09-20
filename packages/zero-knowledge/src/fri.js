// FRI low-degree test (hash-based, post-quantum) — the bounded-query primitive that makes hiding
// possible: openings are O(queries·layers), INDEPENDENT of degree, unlike the direct test that opens
// degree+1 points and thus always reconstructs the polynomial.
//
// CHALLENGE SPACE. Every Fiat–Shamir challenge that steers the protocol — the folding coefficients —
// is drawn from the QUARTIC EXTENSION F_p[X]/(X^4 − 11), ~124 bits, not from the 31-bit base field.
// A base-field challenge can be ground: re-roll the committed data ~2^31 times until the challenge
// lands somewhere convenient. That ceiling binds the whole protocol no matter how many queries are
// asked, which is why the extension field comes first and the query count second.
//
// The codeword itself stays in the base field, and so does layer 0's Merkle commitment — that keeps
// the leaf encoding identical to a caller's own `merkle(cw)`, so a caller can bind its evaluation
// commitment to this proof's root (see `xzk.verify`). Layers 1..n live in the extension.
//
// GRINDING. The query transcript is sealed with a proof-of-work nonce (`GRIND_BITS` leading zero
// bits), so re-rolling the query set to dodge unfavourable positions costs 2^GRIND_BITS hashes per
// attempt on top of the query soundness itself.
//
// Self-tests at the bottom (run this file directly).

import { createHash } from 'node:crypto';

export const p = 2013265921n; // 15*2^27+1, FRI-friendly
export const mod = (a) => ((a % p) + p) % p;
export const add = (a, b) => mod(a + b), sub = (a, b) => mod(a - b), mul = (a, b) => mod(a * b);
export const pw = (b, e) => { b = mod(b); let r = 1n; while (e > 0n) { if (e & 1n) r = mul(r, b); b = mul(b, b); e >>= 1n; } return r; };
export const inv = (a) => pw(a, p - 2n);
export const H = (s) => createHash('sha256').update(s).digest('hex');
const inv2 = inv(2n);

// ── Quartic extension F_p[X]/(X^4 − W) ───────────────────────────────────────────────────────────
// W = 11 is the canonical BabyBear quartic non-residue: ord(11) is even and (p−1)/ord(11) is odd,
// which is exactly Serret's criterion for X^4 − 11 to be irreducible over F_p (4 | p−1 holds too).
// An element is [c0,c1,c2,c3] meaning c0 + c1·X + c2·X² + c3·X³. |F_p^4| ≈ 2^124.
export const EW = 11n;
export const EXT_DEGREE = 4;
export const EXT_BITS = 124; // ⌊4·log2(p)⌋ — the usable challenge entropy
export const eFrom = (a) => [mod(a), 0n, 0n, 0n];
export const eAdd = (a, b) => [add(a[0], b[0]), add(a[1], b[1]), add(a[2], b[2]), add(a[3], b[3])];
export const eSub = (a, b) => [sub(a[0], b[0]), sub(a[1], b[1]), sub(a[2], b[2]), sub(a[3], b[3])];
export const eScale = (a, c) => [mul(a[0], c), mul(a[1], c), mul(a[2], c), mul(a[3], c)];
export const eEq = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
export const eStr = (a) => a[0].toString() + ',' + a[1].toString() + ',' + a[2].toString() + ',' + a[3].toString();
export function eMul(a, b) {
  const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
  const b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
  // X^4 = W, so every wrapped term picks up one factor of W.
  const c0 = add(mul(a0, b0), mul(EW, add(add(mul(a1, b3), mul(a2, b2)), mul(a3, b1))));
  const c1 = add(add(mul(a0, b1), mul(a1, b0)), mul(EW, add(mul(a2, b3), mul(a3, b2))));
  const c2 = add(add(add(mul(a0, b2), mul(a1, b1)), mul(a2, b0)), mul(EW, mul(a3, b3)));
  const c3 = add(add(add(mul(a0, b3), mul(a1, b2)), mul(a2, b1)), mul(a3, b0));
  return [c0, c1, c2, c3];
}

export const polyEval = (c, x) => { let r = 0n; for (let i = c.length - 1; i >= 0; i--) r = add(mul(r, x), c[i]); return r; };
export function interpolate(xs, ys) {
  const n = xs.length; let res = new Array(n).fill(0n);
  for (let i = 0; i < n; i++) {
    let num = [1n], den = 1n;
    for (let j = 0; j < n; j++) if (j !== i) {
      const nn = new Array(num.length + 1).fill(0n);
      for (let k = 0; k < num.length; k++) { nn[k] = add(nn[k], mul(num[k], mod(-xs[j]))); nn[k + 1] = add(nn[k + 1], num[k]); }
      num = nn; den = mul(den, sub(xs[i], xs[j]));
    }
    const s = mul(ys[i], inv(den));
    for (let k = 0; k < num.length; k++) res[k] = add(res[k], mul(num[k], s));
  }
  return res;
}

// subgroup domain of size N=2^k (closed under squaring -> half-size subgroup)
export function domainOfSize(N) {
  const omega = pw(31n, (p - 1n) / BigInt(N));
  const dom = new Array(N); let cur = 1n;
  for (let i = 0; i < N; i++) { dom[i] = cur; cur = mul(cur, omega); }
  return dom;
}

export function merkle(leaves) {
  let level = leaves.map((v) => H('l:' + v.toString()));
  const tree = [level];
  while (level.length > 1) { const nx = []; for (let i = 0; i < level.length; i += 2) nx.push(H(level[i] + level[i + 1])); level = nx; tree.push(level); }
  return { root: level[0], tree };
}
// Extension-valued commitment. A DISTINCT leaf tag ('e:') so an extension leaf can never be read as
// a base-field one — domain separation between the two encodings.
export function merkleExt(leaves) {
  let level = leaves.map((v) => H('e:' + eStr(v)));
  const tree = [level];
  while (level.length > 1) { const nx = []; for (let i = 0; i < level.length; i += 2) nx.push(H(level[i] + level[i + 1])); level = nx; tree.push(level); }
  return { root: level[0], tree };
}
export const mpath = (tree, idx) => { const path = []; for (let l = 0; l < tree.length - 1; l++) { path.push(tree[l][idx ^ 1]); idx >>= 1; } return path; };
function mverifyTagged(root, leafHash, idx, path) { let h = leafHash; for (const s of path) { h = (idx & 1) ? H(s + h) : H(h + s); idx >>= 1; } return h === root; }
export function mverify(root, val, idx, path) { return mverifyTagged(root, H('l:' + val.toString()), idx, path); }
export function mverifyExt(root, val, idx, path) { return mverifyTagged(root, H('e:' + eStr(val)), idx, path); }

export const fsField = (t) => mod(BigInt('0x' + H(t).slice(0, 16)));
/** A Fiat–Shamir challenge in F_p^4 — four independently hashed limbs, ~124 bits of entropy. */
export const fsExt = (t) => [0, 1, 2, 3].map((i) => mod(BigInt('0x' + H(t + ':limb' + i).slice(0, 16))));
export const fsIndex = (t, N) => Number(BigInt('0x' + H(t).slice(0, 12)) % BigInt(N));

/** Proof-of-work bits sealing the query transcript. Raises the cost of re-rolling the query set. */
export const GRIND_BITS = 20;
const leadingZeroBits = (hex) => {
  let n = 0;
  for (const ch of hex) { const v = parseInt(ch, 16); if (v === 0) { n += 4; continue; } n += Math.clz32(v) - 28; break; }
  return n;
};
const grindOk = (transcript, nonce, bits) => leadingZeroBits(H(transcript + ':grind:' + nonce)) >= bits;

// FRI prove: codeword cw over domain dom (size N), claimed degree < K. Folds log2(K) times to a
// constant, commits every layer, seals the transcript with `grindBits` of proof-of-work, then answers
// `nq` queries with Merkle-authenticated pair openings along the fold chain.
export function friProve(cw, dom, K, nq, grindBits = GRIND_BITS) {
  const layers = [cw]; const doms = [dom]; const coms = [merkle(cw)];
  let transcript = coms[0].root;
  const nFold = Math.log2(K);
  const betas = [];
  for (let f = 0; f < nFold; f++) {
    const beta = fsExt(transcript + ':fold' + f); betas.push(beta);   // ~124-bit challenge
    const cur = layers[f], d = doms[f], N = cur.length, half = N / 2;
    const nxt = new Array(half);
    for (let j = 0; j < half; j++) {
      const a = cur[j], b = cur[j + half], sc = mul(inv2, inv(d[j]));
      // Layer 0 is base-field; every later layer is already in the extension.
      const even = f === 0 ? eFrom(mul(add(a, b), inv2)) : eScale(eAdd(a, b), inv2);
      const odd  = f === 0 ? eFrom(mul(sub(a, b), sc))   : eScale(eSub(a, b), sc);
      nxt[j] = eAdd(even, eMul(beta, odd));
    }
    layers.push(nxt); doms.push(d.slice(0, half).map((x) => mul(x, x))); coms.push(merkleExt(nxt)); transcript = H(transcript + coms[f + 1].root);
  }
  // Seal the query transcript with proof-of-work before any index is derived.
  let nonce = 0; while (!grindOk(transcript, nonce, grindBits)) nonce++;
  const qt = H(transcript + ':grind:' + nonce);
  const finalWord = layers[layers.length - 1]; // should be constant (all equal)
  const queries = [];
  for (let q = 0; q < nq; q++) {
    const idx0 = fsIndex(qt + ':q' + q, doms[0].length / 2);
    const steps = [];
    for (let f = 0; f < nFold; f++) {
      const half = layers[f].length / 2, i = idx0 % half, tree = coms[f].tree;
      steps.push({ i, a: layers[f][i], b: layers[f][i + half], pa: mpath(tree, i), pb: mpath(tree, i + half) });
    }
    queries.push({ idx0, steps });
  }
  return { roots: coms.map((c) => c.root), finalWord, queries, K, N: dom.length, nonce, grindBits };
}

// The degree bound and domain size are the VERIFIER's parameters, never the prover's. `expectK` is
// REQUIRED and is compared against the bound the proof claims: without it a prover simply declares a
// larger K (folding one extra round), and a codeword that is rejected at the agreed bound verifies
// against its own inflated one — the committed curve then carries more degrees of freedom than the
// statement allows. Omitting `expectK` is fail-closed (returns false) so no caller can reintroduce it.
// `expectNq` and `expectGrind` are verifier-side for the same reason: a proof may not thin out its
// own query set or lower its own proof-of-work.
export function friVerify(proof, dom0, expectK, expectNq, expectGrind = GRIND_BITS) {
  const { roots, finalWord, queries, K, N, nonce } = proof;
  if (!Number.isInteger(expectK) || K !== expectK) return false;   // prover does NOT choose the bound
  if (N !== dom0.length) return false;                             // nor the domain
  if (Number.isInteger(expectNq) && queries.length !== expectNq) return false; // nor the query count
  if (proof.grindBits !== expectGrind) return false;               // nor the proof-of-work
  const nFold = Math.log2(K);
  if (roots.length !== nFold + 1) return false;
  if (!finalWord.every((v) => eEq(v, finalWord[0]))) return false; // final layer constant
  // recompute betas + query transcript exactly as prover
  let transcript = roots[0]; const betas = [];
  for (let f = 0; f < nFold; f++) { betas.push(fsExt(transcript + ':fold' + f)); transcript = H(transcript + roots[f + 1]); }
  if (!grindOk(transcript, nonce, expectGrind)) return false;      // the transcript seal must hold
  const qt = H(transcript + ':grind:' + nonce);
  // rebuild per-layer domains
  const doms = [dom0]; for (let f = 0; f < nFold; f++) doms.push(doms[f].slice(0, doms[f].length / 2).map((x) => mul(x, x)));
  for (let q = 0; q < queries.length; q++) {
    const query = queries[q];
    if (query.idx0 !== fsIndex(qt + ':q' + q, N / 2)) return false;
    for (let f = 0; f < nFold; f++) {
      const half = doms[f].length / 2, i = query.idx0 % half, st = query.steps[f];
      if (st.i !== i) return false;
      const openOk = f === 0
        ? mverify(roots[0], st.a, i, st.pa) && mverify(roots[0], st.b, i + half, st.pb)
        : mverifyExt(roots[f], st.a, i, st.pa) && mverifyExt(roots[f], st.b, i + half, st.pb);
      if (!openOk) return false;
      // The folded value must equal the NEXT layer at index i mod (next half).
      const sc = mul(inv2, inv(doms[f][i]));
      const even = f === 0 ? eFrom(mul(add(st.a, st.b), inv2)) : eScale(eAdd(st.a, st.b), inv2);
      const odd  = f === 0 ? eFrom(mul(sub(st.a, st.b), sc))   : eScale(eSub(st.a, st.b), sc);
      const folded = eAdd(even, eMul(betas[f], odd));
      if (f + 1 < nFold) {
        // Layer f+1 has half the points of layer f; the opened pair there sits at (i mod nextHalf)
        // and (i mod nextHalf) + nextHalf, so exactly one of the two openings IS index i.
        const nextHalf = doms[f + 1].length / 2, stn = query.steps[f + 1];
        const openedNext = stn.i === i ? stn.a : (stn.i + nextHalf === i ? stn.b : null);
        if (openedNext === null || !eEq(openedNext, folded)) return false;
      } else {
        if (!eEq(folded, finalWord[i])) return false;
      }
    }
  }
  return true;
}

// ----------------- self-tests -----------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const K = 32, blowup = 16, N = K * blowup; // 512, rate 1/16
  const NQ = 88;
  const dom = domainOfSize(N);
  const ok = (b) => (b ? 'PASS' : 'FAIL');

  // extension-field sanity: X^4 = W, and multiplication behaves
  const X = [0n, 1n, 0n, 0n];
  const X4 = eMul(eMul(X, X), eMul(X, X));
  console.log(`F_p^4: X^4 === W:                          ${ok(eEq(X4, eFrom(EW)))}  (want PASS)`);
  const r1 = [7n, 11n, 13n, 17n], r2 = [19n, 23n, 29n, 31n];
  console.log(`F_p^4: multiplication is commutative:      ${ok(eEq(eMul(r1, r2), eMul(r2, r1)))}  (want PASS)`);
  console.log(`F_p^4: challenge entropy (bits):           ${EXT_BITS}  (base field was 31)`);

  // genuine low-degree: random poly of degree < K
  const coeffs = Array.from({ length: K }, (_, i) => mod(BigInt(7 * i + 3)));
  const lowCw = dom.map((x) => polyEval(coeffs, x));
  const p1 = friProve(lowCw, dom, K, NQ);
  console.log(`FRI accepts genuine degree-<${K} codeword: ${ok(friVerify(p1, dom, K, NQ))}  (want PASS)`);
  // NOT low-degree: tamper a few points (now far from any degree-<K poly)
  const badCw = lowCw.slice(); for (let t = 0; t < N; t += 5) badCw[t] = add(badCw[t], 1n);
  const p2 = friProve(badCw, dom, K, NQ);
  console.log(`FRI rejects a non-low-degree codeword:    ${ok(!friVerify(p2, dom, K, NQ))}  (want PASS -> rejected)`);
  // exact-degree boundary: degree K (one too high) should be rejected
  const hiCoeffs = Array.from({ length: K + 8 }, (_, i) => mod(BigInt(5 * i + 1)));
  const hiCw = dom.map((x) => polyEval(hiCoeffs, x));
  const p3 = friProve(hiCw, dom, K, NQ);
  console.log(`FRI rejects a degree-${K + 7} codeword (>K):   ${ok(!friVerify(p3, dom, K, NQ))}  (want PASS -> rejected)`);
  // the proof-of-work seal is verifier-side: a stripped nonce must not verify
  console.log(`FRI rejects a broken grind seal:          ${ok(!friVerify({ ...p1, nonce: p1.nonce + 1 }, dom, K, NQ))}  (want PASS -> rejected)`);
  console.log(`FRI rejects a lowered grind claim:        ${ok(!friVerify({ ...p1, grindBits: 0 }, dom, K, NQ))}  (want PASS -> rejected)`);
}
