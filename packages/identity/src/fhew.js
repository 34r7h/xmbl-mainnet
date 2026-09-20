// fhew.js — BOOTSTRAPPING. Unbounded-depth homomorphic evaluation.
//
// `bfv.js` is LEVELED: every multiplication consumes noise budget, and after two or three the
// ciphertext stops decrypting. Bootstrapping removes the ceiling. It homomorphically evaluates the
// decryption circuit on an exhausted ciphertext and returns a FRESH one encrypting the same value,
// so a circuit of any depth can be evaluated by refreshing between gates. That is the step between
// leveled and fully homomorphic encryption.
//
// The construction is FHEW/TFHE-style: a gate is computed on small LWE ciphertexts and then
// bootstrapped, so noise is reset after EVERY gate and never accumulates. NAND is functionally
// complete, so a bootstrapped NAND is a universal homomorphic computer.
//
// HOW ONE BOOTSTRAP WORKS
//   1. Modulus-switch the LWE ciphertext down to q = 2N, so its phase is an exponent of X.
//   2. BLIND ROTATION. Start an RLWE accumulator holding a constant test polynomial rotated by −b,
//      then for each secret bit s_i conditionally rotate by X^{a_i} — conditionally, because s_i is
//      only available as an RGSW encryption. Each step is a CMux driven by an external product,
//      which is where the secret is used without being known. The accumulator ends at X^(−φ)·tv,
//      where φ is the plaintext phase.
//   3. SAMPLE EXTRACT the constant coefficient: an LWE ciphertext under the RLWE key whose phase is
//      ±Q/8 according to which half of the ring φ landed in. That sign test IS the decryption
//      circuit, evaluated homomorphically.
//   4. KEY-SWITCH back to the original LWE key, and modulus-switch back to q.
//   Noise at the end depends on the bootstrapping key, NOT on the input's noise. That is the whole
//   point: the output is as clean as a fresh encryption however exhausted the input was.
//
// PARAMETERS are chosen so every product stays exact in double precision ((Q−1)^2 < 2^53), which is
// what makes this fast enough to run in the gate rather than a demonstration of the shape.
//
// SEPARATE FROM bfv.js. This scheme has its own keys and its own parameters; the two share no key
// material and no ciphertext converts between them. bfv is the batched arithmetic path (4096 slots,
// integers mod 65537, bounded depth); this is the unbounded-depth boolean one, one bit per
// ciphertext. A BFV ciphertext cannot be bootstrapped here.
//
// This is a from-scratch implementation under the same ⛔ audit gate as the rest of the crypto here.

import { randomBytes } from 'node:crypto';

// ── Parameters ───────────────────────────────────────────────────────────────────────────────────
export const N = 1024;                 // RLWE ring degree
export const Q = 33550337;             // RLWE modulus, prime, Q = 1 mod 2N, (Q-1)^2 < 2^53
const PSI = 21935027;                  // primitive 2N-th root of unity mod Q
export const n = 512;                  // LWE dimension
export const q = 2 * N;                // LWE modulus during rotation (2048): the phase is an exponent
const BG_BITS = 5, BG = 1 << BG_BITS, LG = 5;       // gadget base 32, 5 digits -> 2^25 >= Q
const KS_BITS = 5, KS_BASE = 1 << KS_BITS, L_KS = 5; // key-switch decomposition
const SIGMA = 3.2;

const mod = (a, m) => ((a % m) + m) % m;
const pw = (b, e, m) => { b %= m; let r = 1; while (e > 0) { if (e & 1) r = (r * b) % m; b = (b * b) % m; e >>= 1; } return r; };
const inv = (a, m) => pw(a, m - 2, m);

// ── NTT over Z_Q, negacyclic, double-precision exact ─────────────────────────────────────────────
const W = (PSI * PSI) % Q, W_INV = inv(W, Q), PSI_INV = inv(PSI, Q), N_INV = inv(N, Q);
const ROOTS = new Int32Array(N >> 1), IROOTS = new Int32Array(N >> 1);
const PSI_POW = new Int32Array(N), PSI_INV_POW = new Int32Array(N);
{
  let r = 1, ir = 1;
  for (let i = 0; i < (N >> 1); i++) { ROOTS[i] = r; IROOTS[i] = ir; r = (r * W) % Q; ir = (ir * W_INV) % Q; }
  let s = 1, si = 1;
  for (let i = 0; i < N; i++) { PSI_POW[i] = s; PSI_INV_POW[i] = si; s = (s * PSI) % Q; si = (si * PSI_INV) % Q; }
}
function transform(a, roots) {
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = a[i]; a[i] = a[j]; a[j] = t; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1, step = N / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < half; k++) {
        const u = a[i + k], v = (a[i + k + half] * roots[k * step]) % Q;
        a[i + k] = (u + v) % Q;
        a[i + k + half] = (u - v + Q) % Q;
      }
    }
  }
}
/** Forward NTT of a coefficient vector (returns a new array). */
function fwd(p) {
  const A = new Float64Array(N);
  for (let i = 0; i < N; i++) A[i] = (p[i] * PSI_POW[i]) % Q;
  transform(A, ROOTS);
  return A;
}
/** Inverse NTT back to coefficients. */
function invNtt(A) {
  const a = Float64Array.from(A);
  transform(a, IROOTS);
  const out = new Int32Array(N);
  for (let i = 0; i < N; i++) out[i] = (((a[i] * N_INV) % Q) * PSI_INV_POW[i]) % Q;
  return out;
}

// ── Sampling ─────────────────────────────────────────────────────────────────────────────────────
function uniformPoly() {
  const rb = randomBytes(4 * N), out = new Int32Array(N);
  for (let i = 0; i < N; i++) out[i] = rb.readUInt32LE(i * 4) % Q;
  return out;
}
/** Centered binomial with the given eta; stddev sqrt(eta/2). eta=21 -> ~3.24. */
const ETA = 21;
function errPoly() {
  const out = new Int32Array(N), rb = randomBytes(6 * N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let k = 0; k < ETA; k++) {
      const a = (rb[i * 6 + ((2 * k) >> 3)] >> ((2 * k) & 7)) & 1;
      const b = (rb[i * 6 + ((2 * k + 1) >> 3)] >> ((2 * k + 1) & 7)) & 1;
      s += a - b;
    }
    out[i] = mod(s, Q);
  }
  return out;
}
const errScalar = () => { const rb = randomBytes(6); let s = 0; for (let k = 0; k < ETA; k++) s += ((rb[(2 * k) >> 3] >> ((2 * k) & 7)) & 1) - ((rb[(2 * k + 1) >> 3] >> ((2 * k + 1) & 7)) & 1); return s; };
function binaryVec(len) { const rb = randomBytes(len), out = new Int32Array(len); for (let i = 0; i < len; i++) out[i] = rb[i] & 1; return out; }
function binaryPoly() { return binaryVec(N); }

// ── Signed gadget decomposition ──────────────────────────────────────────────────────────────────
// Digits in [−BG/2, BG/2) rather than [0, BG): a centered decomposition halves the noise the
// external product introduces, which is what keeps the bootstrapping output clean.
// The value is CENTERED into (-Q/2, Q/2] first. BG^LG = 2^25 covers [-2^24, 2^24), and Q/2 <
// 2^24, so the digits reconstruct the centered value EXACTLY with nothing carried off the top.
// Decomposing the raw residue in [0, Q) instead would drop a final carry worth 2^25 mod Q = 4095,
// which is not zero — the external product would then be computing on a value 4095 away from the
// one committed, and every bootstrap would return the same wrong bit.
function decompose(poly) {
  const digits = Array.from({ length: LG }, () => new Int32Array(N));
  for (let i = 0; i < N; i++) {
    let v = poly[i] > Q / 2 ? poly[i] - Q : poly[i];
    for (let j = 0; j < LG; j++) {
      let d = ((v % BG) + BG) % BG;
      if (d >= BG / 2) d -= BG;
      digits[j][i] = d;
      v = (v - d) / BG;
    }
  }
  return digits;
}

// ── RLWE / RGSW ──────────────────────────────────────────────────────────────────────────────────
// An RLWE ciphertext is { a, b } with b = a·z + e + mu. An RGSW ciphertext is 2·LG RLWE rows with
// the gadget added: rows 0..LG-1 carry m·BG^j in a, rows LG..2LG-1 carry m·BG^j in b. Rows are kept
// in the NTT domain, since every one of them is multiplied on every CMux and never added in place.
function rlweZero(z) {
  const a = uniformPoly(), e = errPoly(), A = fwd(a), Z = fwd(z);
  const bN = new Float64Array(N);
  for (let i = 0; i < N; i++) bN[i] = (A[i] * Z[i]) % Q;
  const b = invNtt(bN);
  for (let i = 0; i < N; i++) b[i] = (b[i] + e[i]) % Q;
  return { a, b };
}
function rgswEncrypt(z, m) {
  const rows = [];
  let g = 1;
  for (let j = 0; j < LG; j++) {
    const r = rlweZero(z);
    r.a[0] = mod(r.a[0] + m * g, Q);
    rows.push({ A: fwd(r.a), B: fwd(r.b) });
    g = (g * BG) % Q;
  }
  g = 1;
  for (let j = 0; j < LG; j++) {
    const r = rlweZero(z);
    r.b[0] = mod(r.b[0] + m * g, Q);
    rows.push({ A: fwd(r.a), B: fwd(r.b) });
    g = (g * BG) % Q;
  }
  return rows;
}
/** C ⊡ ct — the external product. RGSW(m) ⊡ RLWE(mu) = RLWE(m·mu). */
function externalProduct(C, ct) {
  const da = decompose(ct.a), db = decompose(ct.b);
  const accA = new Float64Array(N), accB = new Float64Array(N);
  for (let j = 0; j < 2 * LG; j++) {
    const d = j < LG ? da[j] : db[j - LG];
    let nz = false;
    for (let i = 0; i < N; i++) if (d[i] !== 0) { nz = true; break; }
    if (!nz) continue;
    const tmp = new Int32Array(N);
    for (let i = 0; i < N; i++) tmp[i] = mod(d[i], Q);
    const D = fwd(tmp), row = C[j];
    for (let i = 0; i < N; i++) {
      accA[i] = (accA[i] + D[i] * row.A[i]) % Q;
      accB[i] = (accB[i] + D[i] * row.B[i]) % Q;
    }
  }
  return { a: invNtt(accA), b: invNtt(accB) };
}
/** Multiply an RLWE ciphertext by X^k in Z_Q[X]/(X^N+1) — a negacyclic rotation. */
function rotatePoly(p, k) {
  const out = new Int32Array(N);
  const r = mod(k, 2 * N);
  for (let i = 0; i < N; i++) {
    let j = i + r, sign = 1;
    if (j >= 2 * N) j -= 2 * N;
    if (j >= N) { j -= N; sign = -1; }
    out[j] = sign === 1 ? p[i] : mod(-p[i], Q);
  }
  return out;
}
const rotate = (ct, k) => ({ a: rotatePoly(ct.a, k), b: rotatePoly(ct.b, k) });
const rlweSub = (x, y) => { const a = new Int32Array(N), b = new Int32Array(N); for (let i = 0; i < N; i++) { a[i] = mod(x.a[i] - y.a[i], Q); b[i] = mod(x.b[i] - y.b[i], Q); } return { a, b }; };
const rlweAdd = (x, y) => { const a = new Int32Array(N), b = new Int32Array(N); for (let i = 0; i < N; i++) { a[i] = (x.a[i] + y.a[i]) % Q; b[i] = (x.b[i] + y.b[i]) % Q; } return { a, b }; };
/** CMux(C, d0, d1) = d0 + C ⊡ (d1 − d0) — selects d1 when C encrypts 1, d0 when it encrypts 0. */
const cmux = (C, d0, d1) => rlweAdd(d0, externalProduct(C, rlweSub(d1, d0)));

// ── LWE ──────────────────────────────────────────────────────────────────────────────────────────
// ct = { a: Int32Array(dim), b } over modulus m, with b = <a,s> + e + mu.
function lweEncrypt(s, mu, m) {
  const dim = s.length, a = new Int32Array(dim);
  const rb = randomBytes(4 * dim);
  let acc = 0;
  for (let i = 0; i < dim; i++) { a[i] = rb.readUInt32LE(i * 4) % m; acc = (acc + a[i] * s[i]) % m; }
  return { a, b: mod(acc + mu + errScalar(), m) };
}
function lwePhase(s, ct, m) {
  let acc = 0;
  for (let i = 0; i < ct.a.length; i++) acc = (acc + ct.a[i] * s[i]) % m;
  return mod(ct.b - acc, m);
}
/** Round every component from modulus `from` to modulus `to`. */
function modSwitch(ct, from, to) {
  const a = new Int32Array(ct.a.length);
  for (let i = 0; i < ct.a.length; i++) a[i] = mod(Math.round((ct.a[i] * to) / from), to);
  return { a, b: mod(Math.round((ct.b * to) / from), to) };
}

// ── Keys ─────────────────────────────────────────────────────────────────────────────────────────
/**
 * Generate everything a bootstrapped evaluator needs.
 *   sk  — the LWE secret (binary, dimension n). Only the key holder has it.
 *   bsk — the BOOTSTRAPPING key: an RGSW encryption of each bit of sk under the RLWE key. Public:
 *         it is what lets an evaluator use the secret inside a CMux without learning it.
 *   ksk — the KEY-SWITCHING key, taking a ciphertext under the RLWE key back to sk.
 * Generation is the slow part (n RGSW encryptions); it happens once.
 */
export function keyGen() {
  const s = binaryVec(n);
  const z = binaryPoly();
  const bsk = new Array(n);
  for (let i = 0; i < n; i++) bsk[i] = rgswEncrypt(z, s[i]);
  // key switch: LWE under z (dim N, mod Q) -> LWE under s (dim n, mod Q)
  const ksk = new Array(N);
  for (let i = 0; i < N; i++) {
    ksk[i] = new Array(L_KS);
    let g = 1;
    for (let j = 0; j < L_KS; j++) { ksk[i][j] = lweEncrypt(s, mod(z[i] * g, Q), Q); g = (g * KS_BASE) % Q; }
  }
  return { sk: s, z, bsk, ksk };
}

// ── Encrypt / decrypt a BIT ──────────────────────────────────────────────────────────────────────
/** Encrypt a bit as an LWE ciphertext mod q, with the message at m·q/4. */
export const encryptBit = (sk, bit) => lweEncrypt(sk, (bit & 1) * (q >> 2), q);
/** Decrypt: the phase is nearest q/4 for 1, nearest 0 for 0. */
export function decryptBit(sk, ct) {
  const phi = lwePhase(sk, ct, q);
  return (phi > q / 8 && phi < (3 * q) / 8) ? 1 : 0;
}
/** Distance from the phase to the nearer decision anchor — how much noise room is left. */
export function noiseMargin(sk, ct) {
  const phi = lwePhase(sk, ct, q);
  const d0 = Math.min(phi, q - phi), d1 = Math.abs(phi - q / 4);
  return Math.min(Math.abs(d0 - q / 8), Math.abs(d1 - q / 8)) === 0 ? 0 : Math.round(q / 8 - Math.min(d0, d1) > 0 ? Math.min(d0, d1) : q / 8 - Math.min(d0, d1));
}

// ── Key switch + sample extract ──────────────────────────────────────────────────────────────────
/** Extract the constant coefficient of an RLWE ciphertext as an LWE ciphertext under z. */
function sampleExtract(ct) {
  const a = new Int32Array(N);
  a[0] = ct.a[0];
  for (let i = 1; i < N; i++) a[i] = mod(-ct.a[N - i], Q);
  return { a, b: ct.b[0] };
}
/** LWE under z (dim N) -> LWE under sk (dim n), same modulus Q. */
function keySwitch(ct, ksk) {
  const a = new Int32Array(n);
  let b = ct.b;
  for (let i = 0; i < N; i++) {
    // Centered, exactly as in decompose() and for the same reason.
    let v = ct.a[i] > Q / 2 ? ct.a[i] - Q : ct.a[i];
    for (let j = 0; j < L_KS; j++) {
      let d = ((v % KS_BASE) + KS_BASE) % KS_BASE;
      if (d >= KS_BASE / 2) d -= KS_BASE;
      const nv = (v - d) / KS_BASE;
      v = nv;
      if (d === 0) continue;
      const k = ksk[i][j];
      for (let t = 0; t < n; t++) a[t] = mod(a[t] - d * k.a[t], Q);
      b = mod(b - d * k.b, Q);
    }
  }
  return { a, b };
}

// ── BOOTSTRAP ────────────────────────────────────────────────────────────────────────────────────
/**
 * Refresh a ciphertext: return a new one encrypting the same bit, with noise set by the
 * bootstrapping key rather than by the input. The input may be arbitrarily exhausted.
 *
 * The test polynomial is the constant Q/8. Negacyclicity (X^N = −1) turns that constant into a SIGN
 * TEST: extracting coefficient 0 of X^(−φ')·tv yields +Q/8 when φ' lands in the first half of the
 * ring and −Q/8 in the second. Adding Q/8 to b maps those to Q/4 and 0 — exactly the encoding of 1
 * and 0. The half-ring boundary is placed at N/2 by starting the rotation at b − N/2, so the two
 * phases a NAND produces for "true" sit inside one half and the "false" phase sits outside it.
 */
export function bootstrap(ct, bsk, ksk) {
  const bq = mod(ct.b - N / 2, q);
  const tv = new Int32Array(N).fill(Math.floor(Q / 8));
  let acc = { a: new Int32Array(N), b: rotatePoly(tv, -bq) };   // trivial RLWE: a = 0
  for (let i = 0; i < n; i++) {
    if (ct.a[i] === 0) continue;                 // X^0 = identity: the CMux cannot change anything
    acc = cmux(bsk[i], acc, rotate(acc, ct.a[i]));
  }
  const extracted = sampleExtract(acc);
  extracted.b = mod(extracted.b + Math.floor(Q / 8), Q);
  return modSwitch(keySwitch(extracted, ksk), Q, q);
}

/**
 * Refresh a ciphertext that is not the output of a gate combination.
 *
 * `bootstrap` puts the decision boundary where the GATES put their phases — at {q/8, 3q/8, 5q/8},
 * each a quarter-ring from the edge. A plain encryption's phases are 0 and q/4, and 0 sits exactly
 * ON that boundary, so the sign of its noise alone would decide the answer. Shifting by q/8 first
 * moves both plain phases a safe q/8 from the edge. Gates must NOT use this: their phases are
 * already centered and a second shift would push them onto the boundary instead.
 */
export function refresh(ct, bsk, ksk) {
  return bootstrap({ a: ct.a, b: mod(ct.b + q / 8, q) }, bsk, ksk);
}

// ── Gates ────────────────────────────────────────────────────────────────────────────────────────
const lweCombine = (sign1, c1, sign2, c2, constB) => {
  const a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = mod(sign1 * c1.a[i] + sign2 * c2.a[i], q);
  return { a, b: mod(constB + sign1 * c1.b + sign2 * c2.b, q) };
};
/** NAND — functionally complete, so this one gate plus bootstrapping is a universal evaluator. */
export const nand = (c1, c2, bsk, ksk) => bootstrap(lweCombine(-1, c1, -1, c2, Math.floor((5 * q) / 8)), bsk, ksk);
/** AND = NOT(NAND). */
export const and = (c1, c2, bsk, ksk) => not(nand(c1, c2, bsk, ksk));
// OR adds the two phases and offsets by q/8. The three possible sums then sit at q/8, 3q/8 and
// 5q/8; after the bootstrap's q/4 shift they are 7q/8, q/8 and 3q/8, so only the both-zero case
// lands in the far half of the ring. Every case keeps a q/8 margin from the decision boundary.
export const or = (c1, c2, bsk, ksk) => bootstrap(lweCombine(1, c1, 1, c2, Math.floor(q / 8)), bsk, ksk);
/** XOR = (a OR b) AND (a NAND b). */
export const xor = (c1, c2, bsk, ksk) => and(or(c1, c2, bsk, ksk), nand(c1, c2, bsk, ksk), bsk, ksk);
/** NOT is free: negate the phase around q/4. No bootstrap, no noise growth. */
export function not(ct) {
  const a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = mod(-ct.a[i], q);
  return { a, b: mod(q / 4 - ct.b, q) };
}

export const params = () => ({ N, Q, n, q, gadgetBase: BG, gadgetDigits: LG, ksBase: KS_BASE, ksDigits: L_KS, eta: ETA, sigma: SIGMA });

// ── Self-test ────────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const ok = (b) => (b ? 'PASS' : 'FAIL');
  const t0 = Date.now();
  const { sk, bsk, ksk } = keyGen();
  console.log(`keygen ms                                : ${Date.now() - t0}`);
  const p = params();
  console.log(`params                                   : N=${p.N} Q=${p.Q} n=${p.n} q=${p.q}`);

  console.log(`decrypt(encrypt(0))                      : ${ok(decryptBit(sk, encryptBit(sk, 0)) === 0)}`);
  console.log(`decrypt(encrypt(1))                      : ${ok(decryptBit(sk, encryptBit(sk, 1)) === 1)}`);

  const tb = Date.now();
  const one = encryptBit(sk, 1), zero = encryptBit(sk, 0);
  const r = refresh(one, bsk, ksk);
  console.log(`bootstrap ms                             : ${Date.now() - tb}`);
  console.log(`refresh preserves the value              : ${ok(decryptBit(sk, r) === 1 && decryptBit(sk, refresh(zero, bsk, ksk)) === 0)}`);

  let all = true;
  for (const [x, y, want] of [[0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 0]]) {
    const got = decryptBit(sk, nand(encryptBit(sk, x), encryptBit(sk, y), bsk, ksk));
    if (got !== want) all = false;
    console.log(`  NAND(${x},${y}) = ${got}  want ${want}`);
  }
  console.log(`NAND truth table                         : ${ok(all)}`);

  // UNBOUNDED DEPTH: chain gates far past any leveled budget and keep decrypting correctly.
  const DEPTH = 40;
  let acc = encryptBit(sk, 1), expect = 1;
  const t2 = Date.now();
  for (let i = 0; i < DEPTH; i++) {
    const bit = i % 3 === 0 ? 0 : 1;
    acc = nand(acc, encryptBit(sk, bit), bsk, ksk);
    expect = 1 - (expect & bit);
  }
  const ms = Date.now() - t2;
  console.log(`${DEPTH} chained NAND gates                    : ${ok(decryptBit(sk, acc) === expect)}  (got ${decryptBit(sk, acc)}, want ${expect}, ${ms} ms, ${(ms / DEPTH).toFixed(0)} ms/gate)`);
}
