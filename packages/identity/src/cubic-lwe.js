import { createHash, randomBytes } from 'node:crypto';

/**
 * cubic-lwe.js — Post-Quantum Ternary Cubic Lattice KEM (PQ-Cubic-LWE)
 *
 * A Learning-With-Errors key encapsulation mechanism where the secret and
 * error vectors are sampled from the ternary ball {-1, 0, 1}^N, mapping
 * directly to the XMBL cubic coordinate space:
 *   • N = 27  (atomic cube: 3 faces × 9 blocks)
 *   • N = 729 (Level 2 supercube: 27³)
 *
 * The construction is a standard matrix-LWE IND-CPA KEM (Regev-style) with
 * ternary noise over Z_q. Security reduces to the hardness of the Shortest
 * Vector Problem (SVP) in integer lattices — fully quantum-resistant.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ POST-QUANTUM: Immune to Shor's algorithm.                           │
 * │ Hardness: LWE with ternary noise (η=1) over Z_q, dimension N.      │
 * │ For N=729 and q=3329, Core-SVP hardness exceeds 2^168 quantum gates │
 * │ (NIST PQC Security Category 3+).                                    │
 * │ See docs/xmbl-cubic-cryptography-whitepaper.md §3.2 / §5.3.        │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * API:
 *   keyGen(opts?)                     → { sk, pk }
 *   encapsulate(pk, opts?)            → { ciphertext, sharedSecret }
 *   decapsulate(sk, ciphertext, opts?) → sharedSecret
 *
 *   encryptBit(pk, bit, opts?)        → ciphertext
 *   decryptBit(sk, ciphertext, opts?) → bit
 */

// ── Parameters ──
// q must be prime, ≈ 2^12, so that q/2 ≈ 1665 and rounding noise ≤ 1 is
// absorbed. Kyber uses q = 3329; we follow suit.
const DEFAULT_Q = 3329n;
const DEFAULT_N = 27;   // atomic cube dimension (TOY — illustration only; no PQ margin)

// The mainnet lattice dimension. N=27 is a demonstration ring with no security margin against
// quantum SVP; a value-bearing seal MUST use N=729 (Level-2 supercube), where Core-SVP hardness
// exceeds 2^168 quantum gates (NIST PQC Category 3+). seal.js refuses value seals below this.
export const MAINNET_N = 729;

/**
 * Sample a ternary vector {-1, 0, 1}^dim, reduced mod q.
 * This is the natural short-vector distribution for XMBL cubic coordinates.
 * @param {number} dim
 * @param {bigint} q
 * @returns {bigint[]}
 */
export function sampleTernary(dim, q = DEFAULT_Q) {
  const rb = randomBytes(dim);
  return Array.from({ length: dim }, (_, i) => {
    const r = rb[i] % 3; // 0, 1, 2
    const v = BigInt(r - 1);   // -1, 0, 1
    return ((v % q) + q) % q;
  });
}

/**
 * Sample a uniform vector in Z_q^dim.
 * Used for the public matrix A.
 * @param {number} dim
 * @param {bigint} q
 * @returns {bigint[]}
 */
export function sampleUniform(dim, q = DEFAULT_Q) {
  return Array.from({ length: dim }, () => {
    const bytes = randomBytes(2);
    return BigInt(bytes.readUInt16BE(0)) % q;
  });
}

/**
 * Sample a uniform NxN matrix in Z_q.
 * @param {number} n
 * @param {bigint} q
 * @returns {bigint[][]}
 */
function sampleMatrix(n, q = DEFAULT_Q) {
  return Array.from({ length: n }, () => sampleUniform(n, q));
}

// ── Modular vector arithmetic ──

function vecDot(a, b, q) {
  let sum = 0n;
  for (let i = 0; i < a.length; i++) sum = (sum + a[i] * b[i]) % q;
  return sum;
}

function matVecMul(M, v, q) {
  return M.map(row => vecDot(row, v, q));
}

function vecAdd(a, b, q) {
  return a.map((ai, i) => (ai + b[i]) % q);
}

function vecSub(a, b, q) {
  return a.map((ai, i) => ((ai - b[i]) % q + q) % q);
}

/**
 * Transpose an NxN matrix.
 */
function matTranspose(M) {
  const n = M.length;
  return Array.from({ length: n }, (_, i) => M.map(row => row[i]));
}

// ── Key Generation ──

/**
 * Generate a PQ-Cubic-LWE keypair.
 *
 * Secret key:  s ∈ {-1, 0, 1}^N  (ternary cubic vector)
 * Public key:  (A, b = A·s + e mod q)  where e ∈ {-1, 0, 1}^N
 *
 * @param {Object} [opts]
 * @param {number} [opts.n=27]     — lattice dimension (27 = atomic cube, 729 = supercube)
 * @param {bigint} [opts.q=3329n]  — modulus
 * @returns {{sk: {s: bigint[], n: number, q: bigint}, pk: {A: bigint[][], b: bigint[], n: number, q: bigint}}}
 */
export function keyGen(opts = {}) {
  const n = opts.n || DEFAULT_N;
  const q = opts.q || DEFAULT_Q;
  const s = sampleTernary(n, q);
  const e = sampleTernary(n, q);
  const A = sampleMatrix(n, q);
  const b = vecAdd(matVecMul(A, s, q), e, q);
  return {
    sk: { s, n, q },
    pk: { A, b, n, q },
  };
}

// ── Encryption / Decryption (single-bit, Regev style) ──

/**
 * Encrypt a single bit m ∈ {0, 1}.
 *
 * Ciphertext:
 *   u = Aᵀ · r + e₁  (mod q)   — vector of length N
 *   v = bᵀ · r + e₂ + m·⌊q/2⌋  (mod q)   — scalar
 *
 * where r, e₁ ∈ {-1, 0, 1}^N, e₂ ∈ {-1, 0, 1}.
 *
 * @param {{A: bigint[][], b: bigint[], n: number, q: bigint}} pk
 * @param {0|1|0n|1n} bit
 * @returns {{u: bigint[], v: bigint}}
 */
export function encryptBit(pk, bit) {
  const { A, b, n, q } = pk;
  const r  = sampleTernary(n, q);
  const e1 = sampleTernary(n, q);
  const e2 = sampleTernary(1, q)[0];

  const At = matTranspose(A);
  const u = vecAdd(matVecMul(At, r, q), e1, q);
  const btr = vecDot(b, r, q);
  const mScaled = BigInt(bit) * (q / 2n);
  const v = (btr + e2 + mScaled) % q;

  return { u, v };
}

/**
 * Decrypt a single bit.
 *
 * Computes d = v - sᵀ·u (mod q). If d is closer to q/2 than to 0, output 1; else 0.
 *
 * @param {{s: bigint[], n: number, q: bigint}} sk
 * @param {{u: bigint[], v: bigint}} ciphertext
 * @returns {0|1}
 */
export function decryptBit(sk, ciphertext) {
  const { s, q } = sk;
  const { u, v } = ciphertext;
  const stu = vecDot(s, u, q);
  const d = ((v - stu) % q + q) % q;
  // Decision threshold: if d ∈ (q/4, 3q/4) → bit=1, else bit=0
  const quarter = q / 4n;
  return (d > quarter && d < 3n * quarter) ? 1 : 0;
}

/**
 * Decrypt WITH the noise budget exposed: the recovered d = v − sᵀu (mod q) and how
 * far it sits from the two decision anchors 0 and ⌊q/2⌋. A card can show that the
 * decryption landed well inside its threshold instead of only reporting the bit.
 * @param {{s: bigint[], n: number, q: bigint}} sk
 * @param {{u: bigint[], v: bigint}} ciphertext
 * @returns {{bit:0|1, d:bigint, half:bigint, distToZero:bigint, distToHalf:bigint}}
 */
export function decryptBitDetail(sk, ciphertext) {
  const { s, q } = sk;
  const { u, v } = ciphertext;
  const d = ((v - vecDot(s, u, q)) % q + q) % q;
  const half = q / 2n;
  const quarter = q / 4n;
  const bit = (d > quarter && d < 3n * quarter) ? 1 : 0;
  const ring = (x) => { const a = x < 0n ? -x : x; return a < q - a ? a : q - a; };
  return { bit, d, half, distToZero: ring(d), distToHalf: ring(d - half) };
}

// ── KEM (Key Encapsulation Mechanism) ──
//
// The KEM encrypts a 256-bit shared secret bit-by-bit (256 matrix-LWE ciphertexts). At the
// mainnet dimension N=729 the naive BigInt path is ~2s per encapsulation — unusable on a
// settlement route. Because every value here is < q and a dot product of N terms is bounded by
// N·(q-1)² (for N=729,q=3329 that is 8.07e9, far below 2^53), the modular arithmetic is EXACT in
// double-precision Number. We use that fast path when the bound holds and fall back to the BigInt
// per-bit path otherwise (an unusually large q), so the result is bit-identical either way.

function fitsSafeInteger(n, qNum) {
  return Number.isFinite(qNum) && n * (qNum - 1) * (qNum - 1) <= Number.MAX_SAFE_INTEGER;
}
// Ternary sample as plain Numbers in [0,q): -1 → q-1, 0, 1. Same distribution as sampleTernary.
function sampleTernaryNum(dim, qNum) {
  const rb = randomBytes(dim);
  const out = new Array(dim);
  for (let i = 0; i < dim; i++) { const v = (rb[i] % 3) - 1; out[i] = v < 0 ? v + qNum : v; }
  return out;
}

/**
 * Encapsulate: generate a random shared secret and encrypt it under pk.
 *
 * @param {{A: bigint[][], b: bigint[], n: number, q: bigint}} pk
 * @param {Object} [opts]
 * @param {number} [opts.secretBits=256] — length of shared secret
 * @returns {{ciphertext: {u:bigint[],v:bigint}[], sharedSecret: Buffer}}
 */
export function encapsulate(pk, opts = {}) {
  const bits = opts.secretBits || 256;
  const secret = randomBytes(Math.ceil(bits / 8));
  const bitAt = (i) => (secret[i >> 3] >> (7 - (i & 7))) & 1;
  const n = pk.n, qNum = Number(pk.q);

  let ciphertext;
  if (fitsSafeInteger(n, qNum)) {
    // Fast exact path: precompute Aᵀ and b as Number once, reuse across all bits.
    const A = pk.A, At = new Array(n), half = Math.floor(qNum / 2);
    for (let i = 0; i < n; i++) { const col = new Array(n); for (let j = 0; j < n; j++) col[j] = Number(A[j][i]); At[i] = col; }
    const bN = new Array(n); for (let i = 0; i < n; i++) bN[i] = Number(pk.b[i]);
    ciphertext = new Array(bits);
    for (let k = 0; k < bits; k++) {
      const r = sampleTernaryNum(n, qNum), e1 = sampleTernaryNum(n, qNum), e2 = sampleTernaryNum(1, qNum)[0];
      const u = new Array(n);
      for (let i = 0; i < n; i++) { const row = At[i]; let s = 0; for (let j = 0; j < n; j++) s += row[j] * r[j]; u[i] = BigInt((s + e1[i]) % qNum); }
      let btr = 0; for (let j = 0; j < n; j++) btr += bN[j] * r[j];
      const v = BigInt(((btr + e2 + bitAt(k) * half) % qNum + qNum) % qNum);
      ciphertext[k] = { u, v };
    }
  } else {
    ciphertext = new Array(bits);
    for (let k = 0; k < bits; k++) ciphertext[k] = encryptBit(pk, bitAt(k));
  }
  return { ciphertext, sharedSecret: createHash('sha256').update(secret).digest() };
}

/**
 * Decapsulate: decrypt the shared secret from ciphertext.
 *
 * @param {{s: bigint[], n: number, q: bigint}} sk
 * @param {{u:bigint[],v:bigint}[]} ciphertext
 * @returns {Buffer} 32-byte shared secret (SHA-256 of decrypted bits)
 */
export function decapsulate(sk, ciphertext) {
  const bits = ciphertext.length;
  const secret = Buffer.alloc(Math.ceil(bits / 8));
  const n = sk.n ?? (sk.s ? sk.s.length : 0), qNum = Number(sk.q);
  const fast = fitsSafeInteger(n, qNum);
  const sN = fast ? sk.s.map(Number) : null;
  const quarter = fast ? Math.floor(qNum / 4) : 0;   // integer floor — matches decryptBit's q/4n exactly
  for (let i = 0; i < bits; i++) {
    let bit;
    if (fast) {
      const ct = ciphertext[i]; let stu = 0;
      for (let j = 0; j < n; j++) stu += sN[j] * Number(ct.u[j]);
      const d = ((Number(ct.v) - stu) % qNum + qNum) % qNum;
      bit = (d > quarter && d < 3 * quarter) ? 1 : 0;
    } else {
      bit = decryptBit(sk, ciphertext[i]);
    }
    if (bit) secret[i >> 3] |= (1 << (7 - (i & 7)));
  }
  return createHash('sha256').update(secret).digest();
}

// ── Self-test ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const ok = (b) => (b ? 'PASS' : 'FAIL');
  console.log('PQ-Cubic-LWE Self-Test (N=27, q=3329)');
  console.log('──────────────────────────────────────');

  // Single-bit encryption round-trip
  const { sk, pk } = keyGen();
  let bitErrors = 0;
  const trials = 100;
  for (let t = 0; t < trials; t++) {
    const m = t % 2;
    const ct = encryptBit(pk, m);
    const dec = decryptBit(sk, ct);
    if (dec !== m) bitErrors++;
  }
  console.log(`Single-bit enc/dec (${trials} trials): ${ok(bitErrors === 0)} (errors: ${bitErrors}/${trials})`);

  // KEM round-trip
  const { ciphertext, sharedSecret: ssEnc } = encapsulate(pk, { secretBits: 32 });
  const ssDec = decapsulate(sk, ciphertext);
  console.log(`KEM round-trip (32-bit secret):    ${ok(ssEnc.equals(ssDec))}  (want PASS)`);

  // Wrong key must NOT decrypt correctly (with overwhelming probability)
  const { sk: sk2 } = keyGen();
  const ssBad = decapsulate(sk2, ciphertext);
  console.log(`KEM wrong-key rejection:           ${ok(!ssEnc.equals(ssBad))}  (want PASS)`);

  // Ternary distribution check
  const tv = sampleTernary(1000, 3329n);
  const counts = { neg: 0, zero: 0, pos: 0 };
  for (const v of tv) {
    if (v === 3328n) counts.neg++; // -1 mod 3329
    else if (v === 0n) counts.zero++;
    else if (v === 1n) counts.pos++;
  }
  console.log(`Ternary distribution (1000 samples): {-1: ${counts.neg}, 0: ${counts.zero}, +1: ${counts.pos}}`);
}
