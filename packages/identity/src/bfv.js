// bfv.js — LEVELED HOMOMORPHIC ENCRYPTION over a ring (BFV), post-quantum.
//
// WHAT THIS ADDS. `cubic-lwe.js` is additively homomorphic and nothing more: it adds two
// ciphertexts, on one bit, and 1+1 wraps to 0. This module adds the other operation. A ciphertext
// here holds an integer mod `T`, and two ciphertexts can be ADDED and MULTIPLIED without any secret
// key, to a bounded multiplicative depth. That is leveled FHE — unbounded depth additionally needs
// bootstrapping, which is not implemented here and is called out in `depthBudget()`.
//
// WHY A DIFFERENT RING. Multiplication needs polynomial arithmetic in R_q = Z_q[X]/(X^N+1) with a
// power-of-two N, because that is the ring where the negacyclic NTT exists and where ciphertext
// products stay one ring element instead of a growing matrix. XMBL's cubic dimensions (27 = 3^3,
// 729 = 3^6) are not powers of two and cannot host this; they remain what they are — the lattice
// dimension of the identity KEM and of sealing (`cubic-lwe.js`, `seal.js`), which are unchanged by
// this file. The cube is the identity, not the FHE ring.
//
// PARAMETERS come from the HomomorphicEncryption.org security standard rather than from this
// repository: at N=4096 with a uniform ternary secret, log2(q) <= 109 is the listed bound for
// 128-bit classical security. q is that size and NTT-friendly (q = 1 mod 2N).
//
// SCOPE. Every homomorphic operation is deterministic (no randomness outside encryption and key
// generation), so independent nodes computing on the same ciphertexts produce identical bytes.
// Plaintexts are encoded in the constant coefficient, so add/multiply are integer add/multiply mod
// T; SIMD batching (T = 1 mod 2N is already satisfied) is not wired.
//
// SEPARATE FROM fhew.js. That module bootstraps, and does it on its own LWE scheme with its own
// keys. The two share no key material and there is no conversion between their ciphertexts: BFV is
// the batched arithmetic path, FHEW is the unbounded-depth boolean one. A BFV ciphertext cannot be
// handed to `fhew.bootstrap`.
//
// This is a from-scratch implementation and carries the same ⛔ audit gate as the rest of the
// crypto in this repo. A production deployment should bind an audited library (OpenFHE, SEAL,
// Lattigo, tfhe-rs) behind this same interface.

import { randomBytes } from 'node:crypto';

// ── Ring parameters ──────────────────────────────────────────────────────────────────────────────
export const N = 4096;                                              // ring degree, power of two
export const Q = 649037107316853453566312040923137n;                // 109-bit, Q = 1 mod 2N
export const T = 65537n;                                            // plaintext modulus, 1 mod 2N
export const DELTA = Q / T;                                         // scaling factor floor(Q/T)
const PSI_Q = 181145884629300350837539773330249n;                   // primitive 2N-th root mod Q
// Lifting modulus for the ciphertext tensor product, which must be computed over the INTEGERS
// before it is scaled by T/Q. Coefficients there reach ~N·(Q/2)^2 ≈ 2^120; P is 233 bits.
// P IS NOT PART OF THE SECURITY ANALYSIS. It is an arithmetic workspace: no key, ciphertext or
// plaintext is ever reduced mod P and nothing mod P leaves `mulCipher` — the lift goes in, the
// product comes back centered and is immediately scaled into Z_Q. The parameter that carries the
// hardness assumption is Q (109 bits at N=4096), and it is unaffected by the width of P.
const P = 13803492693581127574869511724554050904902217944340773110325048446550017n;
const PSI_P = 8669121704055414691083489645901562672527146056326585486711437215039666n;
// Relinearization decomposition base: 109 bits of modulus in 4 digits of 32 bits.
const LOG_W = 32n, W = 1n << LOG_W, L = 4;

const mod = (a, m) => ((a % m) + m) % m;
const pw = (b, e, m) => { b = mod(b, m); let r = 1n; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; };
const inv = (a, m) => pw(a, m - 2n, m);
/** Centered representative in (−m/2, m/2] — the lift used before any integer-domain arithmetic. */
const center = (a, m) => (a > m / 2n ? a - m : a);
/** Round a/b to the nearest integer (b > 0), correct for negative a (BigInt division truncates). */
const divRound = (a, b) => (a >= 0n ? (a + b / 2n) / b : -((-a + b / 2n) / b));

// ── Negacyclic NTT ───────────────────────────────────────────────────────────────────────────────
function nttTables(m, psi) {
  const w = (psi * psi) % m, wInv = inv(w, m), psiInv = inv(psi, m);
  const half = N >> 1;
  const roots = new Array(half), iroots = new Array(half);
  const psiPow = new Array(N), psiInvPow = new Array(N);
  let r = 1n, ir = 1n;
  for (let i = 0; i < half; i++) { roots[i] = r; iroots[i] = ir; r = (r * w) % m; ir = (ir * wInv) % m; }
  let s = 1n, si = 1n;
  for (let i = 0; i < N; i++) { psiPow[i] = s; psiInvPow[i] = si; s = (s * psi) % m; si = (si * psiInv) % m; }
  return { m, roots, iroots, psiPow, psiInvPow, nInv: inv(BigInt(N), m) };
}
function transform(a, m, roots) {
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = a[i]; a[i] = a[j]; a[j] = t; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const halfLen = len >> 1, step = N / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < halfLen; k++) {
        const u = a[i + k], v = (a[i + k + halfLen] * roots[k * step]) % m;
        a[i + k] = (u + v) % m;
        a[i + k + halfLen] = (u - v + m) % m;
      }
    }
  }
}
/** Negacyclic product in Z_m[X]/(X^N+1) via psi-twisted NTT. */
function ringMul(a, b, tb) {
  const { m, roots, iroots, psiPow, psiInvPow, nInv } = tb;
  const A = new Array(N), B = new Array(N);
  for (let i = 0; i < N; i++) { A[i] = (a[i] * psiPow[i]) % m; B[i] = (b[i] * psiPow[i]) % m; }
  transform(A, m, roots); transform(B, m, roots);
  for (let i = 0; i < N; i++) A[i] = (A[i] * B[i]) % m;
  transform(A, m, iroots);
  for (let i = 0; i < N; i++) A[i] = (((A[i] * nInv) % m) * psiInvPow[i]) % m;
  return A;
}
const TB_Q = nttTables(Q, PSI_Q);
const TB_P = nttTables(P, PSI_P);
// The PLAINTEXT ring also splits: T = 65537 and T − 1 = 2^16 is divisible by 2N = 8192, so
// Z_T[X]/(X^N+1) factors into N independent copies of Z_T. That is what makes batching possible —
// one ciphertext carries N values and ONE homomorphic multiply multiplies all N of them.
const PSI_T = 6561n;
const TB_T = nttTables(T, PSI_T);

// ── Polynomial helpers ───────────────────────────────────────────────────────────────────────────
const zero = () => new Array(N).fill(0n);
const rAdd = (a, b, m = Q) => { const c = new Array(N); for (let i = 0; i < N; i++) c[i] = (a[i] + b[i]) % m; return c; };
const rSub = (a, b, m = Q) => { const c = new Array(N); for (let i = 0; i < N; i++) c[i] = mod(a[i] - b[i], m); return c; };
const rNeg = (a, m = Q) => a.map((x) => mod(-x, m));
const lift = (a, m = Q) => a.map((x) => center(x, m));
const reduce = (a, m = Q) => a.map((x) => mod(x, m));

// ── Sampling ─────────────────────────────────────────────────────────────────────────────────────
/** Uniform in Z_Q. */
function sampleUniform() {
  const bytes = 16, rb = randomBytes(bytes * N), out = new Array(N);
  for (let i = 0; i < N; i++) out[i] = BigInt('0x' + rb.subarray(i * bytes, i * bytes + bytes).toString('hex')) % Q;
  return out;
}
/** Ternary {−1,0,1}^N — the secret distribution the parameter standard's ternary column assumes. */
function sampleTernary() {
  const rb = randomBytes(N), out = new Array(N);
  for (let i = 0; i < N; i++) out[i] = mod(BigInt((rb[i] % 3) - 1), Q);
  return out;
}
/** Centered binomial, eta = 21 → stddev sqrt(eta/2) ≈ 3.24, matching the standard's sigma ≈ 3.2. */
const ETA = 21;
function sampleError() {
  const need = Math.ceil((2 * ETA) / 8), rb = randomBytes(need * N), out = new Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let k = 0; k < ETA; k++) {
      const bitA = (rb[i * need + ((2 * k) >> 3)] >> ((2 * k) & 7)) & 1;
      const bitB = (rb[i * need + ((2 * k + 1) >> 3)] >> ((2 * k + 1) & 7)) & 1;
      s += bitA - bitB;
    }
    out[i] = mod(BigInt(s), Q);
  }
  return out;
}

// ── Keys ─────────────────────────────────────────────────────────────────────────────────────────
/**
 * Generate a BFV keypair plus the relinearization key the multiplication needs.
 * sk = s (ternary); pk = (−(a·s + e), a); rlk_i = (−(a_i·s + e_i) + W^i·s², a_i).
 * The relinearization key is PUBLIC: it is what lets a party with no secret key shrink a product
 * back to two components.
 * @returns {{sk:{s:bigint[]}, pk:{b:bigint[],a:bigint[]}, rlk:{b:bigint[],a:bigint[]}[]}}
 */
export function keyGen() {
  const s = sampleTernary();
  const a = sampleUniform(), e = sampleError();
  const b = rNeg(rAdd(ringMul(a, s, TB_Q), e));
  // s² in the ring, needed by every relinearization digit
  const s2 = ringMul(s, s, TB_Q);
  const rlk = [];
  let wi = 1n;
  for (let i = 0; i < L; i++) {
    const ai = sampleUniform(), ei = sampleError();
    const bi = rAdd(rNeg(rAdd(ringMul(ai, s, TB_Q), ei)), s2.map((x) => (x * wi) % Q));
    rlk.push({ b: bi, a: ai });
    wi = (wi * W) % Q;
  }
  return { sk: { s }, pk: { b, a }, rlk };
}

// ── Encoding ─────────────────────────────────────────────────────────────────────────────────────
/** Encode an integer as the constant coefficient of a plaintext polynomial mod T. */
export function encode(v) { const m = zero(); m[0] = mod(BigInt(v), T); return m; }
/** Decode the constant coefficient back to an integer in [0, T). */
export function decode(m) { return m[0]; }

// ── SIMD batching ────────────────────────────────────────────────────────────────────────────────
// Slot i of a plaintext is its evaluation at the i-th primitive root; ring multiplication is
// pointwise on those evaluations, so ONE homomorphic multiply multiplies N=4096 pairs of integers
// at once and one addition adds 4096 pairs. Without batching each ciphertext carries a single
// value in the constant coefficient and a ~250 ms multiply buys one product; with it the same
// ~250 ms buys 4096, which is the difference between a demonstration and a usable cost per value.

/** Pack up to N integers into a plaintext polynomial, one per slot. */
export function encodeBatch(values) {
  const { m, iroots, psiInvPow, nInv } = TB_T;
  const A = new Array(N).fill(0n);
  for (let i = 0; i < values.length && i < N; i++) A[i] = mod(BigInt(values[i]), T);
  transform(A, m, iroots);
  for (let i = 0; i < N; i++) A[i] = (((A[i] * nInv) % m) * psiInvPow[i]) % m;
  return A;
}
/** Unpack a plaintext polynomial back into its N slot values. */
export function decodeBatch(poly) {
  const { m, roots, psiPow } = TB_T;
  const A = new Array(N);
  for (let i = 0; i < N; i++) A[i] = (mod(poly[i], m) * psiPow[i]) % m;
  transform(A, m, roots);
  return A;
}
/** Number of independent values one ciphertext carries. */
export const SLOTS = N;

// ── Encrypt / decrypt ────────────────────────────────────────────────────────────────────────────
/**
 * Encrypt a plaintext polynomial. ct = (b·u + e1 + DELTA·m, a·u + e2).
 * @param {{b:bigint[],a:bigint[]}} pk
 * @param {bigint[]} m plaintext polynomial with coefficients in [0, T)
 */
export function encrypt(pk, m) {
  const u = sampleTernary(), e1 = sampleError(), e2 = sampleError();
  const scaled = m.map((x) => (x * DELTA) % Q);
  return {
    c: [rAdd(rAdd(ringMul(pk.b, u, TB_Q), e1), scaled), rAdd(ringMul(pk.a, u, TB_Q), e2)],
  };
}
/** Encrypt an integer directly. */
export const encryptInt = (pk, v) => encrypt(pk, encode(v));
/** Encrypt a VECTOR of up to N integers into one ciphertext (batched). */
export const encryptVec = (pk, values) => encrypt(pk, encodeBatch(values));

/**
 * Decrypt. m = round(T · (c0 + c1·s) / Q) mod T, for a 2-component ciphertext, and with the extra
 * s² term for an un-relinearized 3-component one.
 */
export function decrypt(sk, ct) {
  let acc = ct.c[0];
  if (ct.c.length > 1) acc = rAdd(acc, ringMul(ct.c[1], sk.s, TB_Q));
  if (ct.c.length > 2) acc = rAdd(acc, ringMul(ct.c[2], ringMul(sk.s, sk.s, TB_Q), TB_Q));
  return lift(acc).map((x) => mod(divRound(x * T, Q), T));
}
/** Decrypt to an integer. */
export const decryptInt = (sk, ct) => decode(decrypt(sk, ct));
/** Decrypt a batched ciphertext back to its N slot values. */
export const decryptVec = (sk, ct) => decodeBatch(decrypt(sk, ct));

/**
 * Remaining noise budget in bits: log2(Q/T) minus the size of the current error. Decryption is
 * correct while this stays above zero, so it is the real measure of how many more operations a
 * ciphertext can take. Needs the secret key, so it is a diagnostic, not a chain-side call.
 */
export function noiseBudget(sk, ct) {
  let acc = ct.c[0];
  if (ct.c.length > 1) acc = rAdd(acc, ringMul(ct.c[1], sk.s, TB_Q));
  if (ct.c.length > 2) acc = rAdd(acc, ringMul(ct.c[2], ringMul(sk.s, sk.s, TB_Q), TB_Q));
  // error = acc − DELTA·m, recovered by rounding acc to the nearest multiple of DELTA
  let maxErr = 0n;
  for (const x of lift(acc)) {
    const m = divRound(x * T, Q);
    const err = x - m * DELTA;
    const abs = err < 0n ? -err : err;
    if (abs > maxErr) maxErr = abs;
  }
  const budget = Q / (2n * T) / (maxErr === 0n ? 1n : maxErr);
  return budget <= 1n ? 0 : budget.toString(2).length - 1;
}

// ── Homomorphic operations (NO secret key) ───────────────────────────────────────────────────────
/** ENC(a) + ENC(b) = ENC(a+b). Componentwise; noise adds. */
export function addCipher(x, y) {
  const n = Math.max(x.c.length, y.c.length), c = [];
  for (let i = 0; i < n; i++) c.push(rAdd(x.c[i] || zero(), y.c[i] || zero()));
  return { c };
}
/** ENC(a) − ENC(b) = ENC(a−b). */
export function subCipher(x, y) {
  const n = Math.max(x.c.length, y.c.length), c = [];
  for (let i = 0; i < n; i++) c.push(rSub(x.c[i] || zero(), y.c[i] || zero()));
  return { c };
}
/** ENC(a) + b for a cleartext b — cheaper than encrypting b, and adds no noise to speak of. */
export function addPlain(x, m) {
  const c = x.c.slice();
  c[0] = rAdd(c[0], m.map((v) => (v * DELTA) % Q));
  return { c };
}
/** ENC(a) · b for a cleartext b. */
export function mulPlain(x, m) {
  const mm = reduce(m);
  return { c: x.c.map((ci) => ringMul(ci, mm, TB_Q)) };
}

/**
 * ENC(a) · ENC(b) = ENC(a·b) — the operation `cubic-lwe.js` does not have.
 *
 * The tensor product must be computed over the INTEGERS and then scaled by T/Q; doing it mod Q
 * would destroy the scaling. Coefficients reach ~N·(Q/2)² ≈ 2^120, so the three products are taken
 * in a 233-bit lifting ring and brought back. The result has THREE components (it is a quadratic
 * form in s); `rlk` shrinks it back to two, which is what keeps depth from blowing up the size.
 * Omit `rlk` to keep the 3-component form — `decrypt` handles it either way.
 */
export function mulCipher(x, y, rlk) {
  const c0 = lift(x.c[0]), c1 = lift(x.c[1]), d0 = lift(y.c[0]), d1 = lift(y.c[1]);
  const toP = (v) => v.map((z) => mod(z, P));
  const [pc0, pc1, pd0, pd1] = [toP(c0), toP(c1), toP(d0), toP(d1)];
  const r0 = ringMul(pc0, pd0, TB_P);
  const r1 = rAdd(ringMul(pc0, pd1, TB_P), ringMul(pc1, pd0, TB_P), P);
  const r2 = ringMul(pc1, pd1, TB_P);
  const scale = (r) => lift(r, P).map((z) => mod(divRound(z * T, Q), Q));
  const out = { c: [scale(r0), scale(r1), scale(r2)] };
  return rlk ? relinearize(out, rlk) : out;
}

/**
 * Split a ring element into L digits base W, so that sum(digits[i] * W^i) === the original mod Q.
 * L*log2(W) = 128 >= log2(Q) = 109, so nothing is truncated. Exported because the reconstruction
 * identity is the one step of the multiply path with no observable output of its own — a silent
 * truncation at the top digit would show only as slightly worse noise, never as a wrong answer.
 * @param {bigint[]} poly coefficients in [0, Q)
 * @returns {bigint[][]} L digit-polynomials, each coefficient in [0, W)
 */
export function decompose(poly) {
  const digits = new Array(L);
  for (let i = 0; i < L; i++) digits[i] = new Array(N);
  for (let j = 0; j < N; j++) {
    let v = poly[j];
    for (let i = 0; i < L; i++) { digits[i][j] = v % W; v /= W; }
  }
  return digits;
}
/** Rebuild a ring element from {@link decompose}'s digits — the identity a test asserts. */
export function recompose(digits) {
  const out = zero();
  let wi = 1n;
  for (let i = 0; i < L; i++) { for (let j = 0; j < N; j++) out[j] = (out[j] + digits[i][j] * wi) % Q; wi = (wi * W) % Q; }
  return out;
}

/**
 * Shrink a 3-component ciphertext back to 2 using the public relinearization key. c2 is split into
 * L digits base W and each digit is paired with the key digit that carries W^i·s², so the s² term
 * is absorbed without ever touching s.
 */
export function relinearize(ct, rlk) {
  if (ct.c.length < 3) return ct;
  const c2 = ct.c[2];
  let b = ct.c[0], a = ct.c[1];
  const digits = decompose(c2);
  for (let i = 0; i < L; i++) {
    b = rAdd(b, ringMul(rlk[i].b, digits[i], TB_Q));
    a = rAdd(a, ringMul(rlk[i].a, digits[i], TB_Q));
  }
  return { c: [b, a] };
}

// ── Serialization (for a host/contract boundary) ─────────────────────────────────────────────────
/** Ciphertext -> flat BigInt array, components concatenated. Length is c.length * N. */
export const serialize = (ct) => ({ parts: ct.c.length, data: ct.c.flat() });
/** Inverse of {@link serialize}. */
export const deserialize = ({ parts, data }) => ({ c: Array.from({ length: parts }, (_, i) => data.slice(i * N, (i + 1) * N)) });

/** The shipped parameters, for a caller that needs to state them. */
export const params = () => ({ n: N, slots: SLOTS, q: Q, t: T, delta: DELTA, logQ: Q.toString(2).length, logT: T.toString(2).length, digits: L, logW: Number(LOG_W), eta: ETA });

// ── Self-test ────────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const ok = (b) => (b ? 'PASS' : 'FAIL');
  const t0 = Date.now();
  const { sk, pk, rlk } = keyGen();
  console.log(`keygen ms                              : ${Date.now() - t0}`);
  const p = params();
  console.log(`ring                                   : Z_q[X]/(X^${p.n}+1), log2 q = ${p.logQ}, t = ${p.t}`);

  const a = 1234n, b = 5678n;
  const ca = encryptInt(pk, a), cb = encryptInt(pk, b);
  console.log(`decrypt(ENC(${a}))                      : ${ok(decryptInt(sk, ca) === a)}`);
  console.log(`ENC(a) + ENC(b) = ENC(a+b)             : ${ok(decryptInt(sk, addCipher(ca, cb)) === a + b)}`);
  console.log(`ENC(a) - ENC(b) = ENC(a-b)             : ${ok(decryptInt(sk, subCipher(ca, cb)) === mod(a - b, T))}`);

  const tm = Date.now();
  const prod = mulCipher(ca, cb, rlk);
  const mulMs = Date.now() - tm;
  const want = (a * b) % T;
  console.log(`ENC(a) * ENC(b) = ENC(a*b)             : ${ok(decryptInt(sk, prod) === want)}  (${a}*${b} mod ${T} = ${want}, ${mulMs} ms)`);
  console.log(`relinearized back to 2 components      : ${ok(prod.c.length === 2)}`);
  console.log(`fresh noise budget (bits)              : ${noiseBudget(sk, ca)}`);
  console.log(`after one multiply (bits)              : ${noiseBudget(sk, prod)}`);

  // depth: keep squaring until decryption stops matching
  let acc = encryptInt(pk, 3n), expect = 3n, depth = 0;
  for (let i = 0; i < 8; i++) {
    acc = mulCipher(acc, acc, rlk); expect = (expect * expect) % T;
    if (decryptInt(sk, acc) !== expect) break;
    depth++;
  }
  console.log(`multiplicative depth (repeated square) : ${depth}  (budget left ${noiseBudget(sk, acc)} bits)`);

  // 200 additions must not wrap or exhaust the budget
  let sum = encryptInt(pk, 0n), want2 = 0n;
  for (let i = 1; i <= 200; i++) { sum = addCipher(sum, encryptInt(pk, BigInt(i))); want2 = (want2 + BigInt(i)) % T; }
  console.log(`200 homomorphic additions              : ${ok(decryptInt(sk, sum) === want2)}  (sum = ${want2})`);
  const hex = (ct) => serialize(ct).data.map((x) => x.toString(16)).join(',');
  console.log(`determinism: same inputs, same bytes   : ${ok(hex(mulCipher(ca, cb, rlk)) === hex(prod))}`);
  const rt = deserialize(serialize(prod));
  console.log(`serialize -> deserialize round-trips   : ${ok(decryptInt(sk, rt) === want)}`);
}
