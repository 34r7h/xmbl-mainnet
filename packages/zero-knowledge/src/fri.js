// Minimal but real FRI low-degree test (hash-based, post-quantum) — the bounded-query
// primitive that makes hiding possible (openings are O(queries·layers), INDEPENDENT of
// degree, unlike the direct test that opens degree+1 points and thus always reconstructs).
// Exported for the ZK cube-curve demo. Self-tests at the bottom (run this file directly).

import { createHash } from 'node:crypto';

export const p = 2013265921n; // 15*2^27+1, FRI-friendly
export const mod = (a) => ((a % p) + p) % p;
export const add = (a, b) => mod(a + b), sub = (a, b) => mod(a - b), mul = (a, b) => mod(a * b);
export const pw = (b, e) => { b = mod(b); let r = 1n; while (e > 0n) { if (e & 1n) r = mul(r, b); b = mul(b, b); e >>= 1n; } return r; };
export const inv = (a) => pw(a, p - 2n);
export const H = (s) => createHash('sha256').update(s).digest('hex');
const inv2 = inv(2n);

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
export const mpath = (tree, idx) => { const path = []; for (let l = 0; l < tree.length - 1; l++) { path.push(tree[l][idx ^ 1]); idx >>= 1; } return path; };
export function mverify(root, val, idx, path) { let h = H('l:' + val.toString()); for (const s of path) { h = (idx & 1) ? H(s + h) : H(h + s); idx >>= 1; } return h === root; }
export const fsField = (t) => mod(BigInt('0x' + H(t).slice(0, 16)));
export const fsIndex = (t, N) => Number(BigInt('0x' + H(t).slice(0, 12)) % BigInt(N));

// FRI prove: codeword cw over domain dom (size N), claimed degree < K. Folds log2(K) times
// to a constant, commits every layer, then answers `nq` queries with Merkle-authenticated
// pair openings along the fold chain.
export function friProve(cw, dom, K, nq) {
  const layers = [cw]; const doms = [dom]; const coms = [merkle(cw)];
  let transcript = coms[0].root;
  const nFold = Math.log2(K);
  const betas = [];
  for (let f = 0; f < nFold; f++) {
    const beta = fsField(transcript + ':fold' + f); betas.push(beta);
    const cur = layers[f], d = doms[f], N = cur.length, half = N / 2;
    const nxt = new Array(half);
    for (let j = 0; j < half; j++) { const a = cur[j], b = cur[j + half]; const even = mul(add(a, b), inv2); const odd = mul(mul(sub(a, b), inv2), inv(d[j])); nxt[j] = add(even, mul(beta, odd)); }
    layers.push(nxt); doms.push(d.slice(0, half).map((x) => mul(x, x))); coms.push(merkle(nxt)); transcript = H(transcript + coms[f + 1].root);
  }
  const finalWord = layers[layers.length - 1]; // should be constant (all equal)
  const queries = [];
  for (let q = 0; q < nq; q++) {
    const idx0 = fsIndex(transcript + ':q' + q, doms[0].length / 2);
    const steps = [];
    for (let f = 0; f < nFold; f++) {
      const N = layers[f].length, half = N / 2, i = idx0 % half;
      steps.push({ i, a: layers[f][i], b: layers[f][i + half], pa: mpath(coms[f].tree, i), pb: mpath(coms[f].tree, i + half) });
    }
    queries.push({ idx0, steps });
  }
  return { roots: coms.map((c) => c.root), finalWord, queries, K, N: dom.length };
}

export function friVerify(proof, dom0) {
  const { roots, finalWord, queries, K, N } = proof;
  const nFold = Math.log2(K);
  if (roots.length !== nFold + 1) return false;
  if (!finalWord.every((v) => v === finalWord[0])) return false; // final layer constant
  // recompute betas + query transcript exactly as prover
  let transcript = roots[0]; const betas = [];
  for (let f = 0; f < nFold; f++) { betas.push(fsField(transcript + ':fold' + f)); transcript = H(transcript + roots[f + 1]); }
  // rebuild per-layer domains
  const doms = [dom0]; for (let f = 0; f < nFold; f++) doms.push(doms[f].slice(0, doms[f].length / 2).map((x) => mul(x, x)));
  for (let q = 0; q < queries.length; q++) {
    const query = queries[q];
    if (query.idx0 !== fsIndex(transcript + ':q' + q, N / 2)) return false;
    for (let f = 0; f < nFold; f++) {
      const N_f = doms[f].length, half = N_f / 2, i = query.idx0 % half, st = query.steps[f];
      if (st.i !== i) return false;
      if (!mverify(roots[f], st.a, i, st.pa)) return false;
      if (!mverify(roots[f], st.b, i + half, st.pb)) return false;
      // fold relation must equal next-layer value at index i (mod next half)
      const even = mul(add(st.a, st.b), inv2), odd = mul(mul(sub(st.a, st.b), inv2), inv(doms[f][i]));
      const folded = add(even, mul(betas[f], odd));
      const nextHalf = doms[f + 1].length / 2;
      const nextVal = (f + 1 < nFold) ? query.steps[f + 1][(i % nextHalf) === query.steps[f + 1].i ? 'a' : 'a'] : null;
      // check against next layer: if not last fold, the folded value is layer f+1 at index i.
      if (f + 1 < nFold) {
        const iNext = i % (doms[f + 1].length / 2);
        const stn = query.steps[f + 1];
        const nv = (stn.i === iNext) ? stn.a : (stn.i + doms[f + 1].length / 2 === i ? stn.b : null);
        // simplest robust check: recompute expected next value and compare to whichever opened value sits at index i of layer f+1
        const openedNext = (stn.i === i) ? stn.a : (stn.i + (doms[f + 1].length / 2) === i ? stn.b : null);
        if (openedNext === null || openedNext !== folded) return false;
      } else {
        if (folded !== finalWord[i]) return false;
      }
    }
  }
  return true;
}

// ----------------- self-tests -----------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const K = 32, blowup = 4, N = K * blowup; // 128
  const dom = domainOfSize(N);
  const ok = (b) => (b ? 'PASS' : 'FAIL');
  // genuine low-degree: random poly of degree < K
  const coeffs = Array.from({ length: K }, (_, i) => mod(BigInt(7 * i + 3)));
  const lowCw = dom.map((x) => polyEval(coeffs, x));
  const p1 = friProve(lowCw, dom, K, 12);
  console.log(`FRI accepts genuine degree-<${K} codeword: ${ok(friVerify(p1, dom))}  (want PASS)`);
  // NOT low-degree: tamper a few points (now far from any degree-<K poly)
  const badCw = lowCw.slice(); for (let t = 0; t < N; t += 5) badCw[t] = add(badCw[t], 1n);
  const p2 = friProve(badCw, dom, K, 12);
  console.log(`FRI rejects a non-low-degree codeword:    ${ok(!friVerify(p2, dom))}  (want PASS -> rejected)`);
  // exact-degree boundary: degree K (one too high) should be rejected
  const hiCoeffs = Array.from({ length: K + 8 }, (_, i) => mod(BigInt(5 * i + 1)));
  const hiCw = dom.map((x) => polyEval(hiCoeffs, x));
  const p3 = friProve(hiCw, dom, K, 16);
  console.log(`FRI rejects a degree-${K + 7} codeword (>K):   ${ok(!friVerify(p3, dom))}  (want PASS -> rejected)`);
}
