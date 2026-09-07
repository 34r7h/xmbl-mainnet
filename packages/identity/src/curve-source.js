import { createHash } from 'crypto';

/**
 * CurveSource — the seam by which the xid signature scheme requests curve /
 * parameter material derived from the XMBL cubic ledger (xclt).
 *
 * This file defines ONLY the contract (input/output shape) and a deterministic
 * PLACEHOLDER implementation. It is intentionally decoupled: it imports nothing
 * from xclt or any fork/extraction module and takes plain data as input, so the
 * seam stands on its own while the specified construction is designed elsewhere.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NOT FINAL — NO SECURITY PROPERTIES.                                        │
 * │ The placeholder returns deterministic stand-in bytes. It makes NO          │
 * │ cryptographic or security guarantee of any kind. The mixing primitive is   │
 * │ a stand-in for reproducibility only, not a security choice. The specified  │
 * │ construction (curves derived from the cube-of-cubes ledger) is TBD and     │
 * │ must replace this before any parameter material is relied upon.            │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/**
 * Fixed size, in bytes, of a curve parameter block returned by any CurveSource.
 * The seam is defined around a fixed-size opaque block; the internal layout is
 * part of the specified construction (TBD) and deliberately unspecified here.
 * @type {number}
 */
export const CURVE_PARAM_BLOCK_SIZE = 64;

/**
 * Encode a single scalar into a canonical, collision-resistant-by-tagging form.
 * BigInt is handled explicitly (cube addresses/timestamps in xclt are nanosecond
 * BigInts, and JSON.stringify throws on BigInt). Non-finite numbers are rejected
 * so the canonical form — and therefore the output — is stable across nodes.
 *
 * @param {bigint|number|string} v
 * @returns {string}
 */
function encodeScalar(v) {
  if (typeof v === 'bigint') return 'b:' + v.toString();
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('CurveSource: non-finite scalar value');
    return 'n:' + v.toString();
  }
  if (typeof v === 'string') return 's:' + v;
  throw new Error(`CurveSource: unsupported scalar type ${typeof v}`);
}

/**
 * @typedef {Object} CurveRequest
 * @property {bigint|number|string} cubeAddress
 *   Address/id of the cube the parameter material is bound to.
 * @property {Array<{x:number,y:number,z:number,magnitude?:number}>} coordinates
 *   The cube's ORDERED block coordinate/vector set (as produced by xclt geometry).
 *   Order is significant and is preserved; the seam never reorders it.
 */

/**
 * Produce a canonical, order-preserving string for a CurveRequest. Two nodes
 * with identical ledger state produce byte-identical canonical forms, which is
 * what makes the placeholder output deterministic across nodes.
 *
 * @param {CurveRequest} request
 * @returns {string}
 */
export function canonicalizeRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new Error('CurveSource: request must be an object');
  }
  const { cubeAddress, coordinates } = request;
  if (cubeAddress === undefined || cubeAddress === null) {
    throw new Error('CurveSource: request.cubeAddress is required');
  }
  if (!Array.isArray(coordinates)) {
    throw new Error('CurveSource: request.coordinates must be an array');
  }

  const parts = [`addr=${encodeScalar(cubeAddress)}`, `n=${coordinates.length}`];
  // Ordered set: iterate in caller order and never sort. The index prefix pins
  // position so a reordering of identical values yields a different canonical form.
  coordinates.forEach((c, i) => {
    if (!c || typeof c !== 'object') {
      throw new Error(`CurveSource: coordinate[${i}] must be an object`);
    }
    const { x, y, z, magnitude } = c;
    if (x === undefined || y === undefined || z === undefined) {
      throw new Error(`CurveSource: coordinate[${i}] must have x, y, z`);
    }
    let seg = `${i}:${encodeScalar(x)},${encodeScalar(y)},${encodeScalar(z)}`;
    if (magnitude !== undefined) seg += `,m=${encodeScalar(magnitude)}`;
    parts.push(seg);
  });

  return parts.join('|');
}

/**
 * Abstract contract for a source of curve/parameter material.
 *
 * The signature scheme depends only on this interface: given a {@link CurveRequest},
 * return a fixed-size ({@link CURVE_PARAM_BLOCK_SIZE}) opaque parameter block.
 * Concrete sources (the specified construction, TBD) implement getCurveParams.
 *
 * @abstract
 */
export class CurveSource {
  /**
   * Return a fixed-size curve parameter block for the given request.
   * @param {CurveRequest} _request
   * @returns {Uint8Array} block of exactly CURVE_PARAM_BLOCK_SIZE bytes
   * @abstract
   */
  getCurveParams(_request) {
    throw new Error('CurveSource.getCurveParams is abstract; use a concrete implementation');
  }

  /**
   * Machine-readable self-description of this source. Concrete sources override
   * to advertise their construction and status.
   * @returns {{name:string, blockSize:number, placeholder:boolean, secure:boolean, note:string}}
   */
  describe() {
    return {
      name: 'CurveSource',
      blockSize: CURVE_PARAM_BLOCK_SIZE,
      placeholder: true,
      secure: false,
      note: 'abstract contract; no implementation',
    };
  }
}

// The insecure PlaceholderCurveSource (a deterministic hash stand-in with NO security
// properties) was DELETED for the mainnet repo. Its only consumer was its own test, and
// leaving a zero-security curve source in a package that ships to npm is exactly the
// footgun this repo exists to remove. The seam (abstract CurveSource) and the specified
// construction (CubicCurveSource, below) are what remain. If a deterministic stand-in is
// ever needed for a local benchmark, write it in the test, not in the shipped module.

// ────────────────────────────────────────────────────────────────────────────
// FINITE FIELD ARITHMETIC — shared by CubicCurveSource and downstream modules
// (Cubic-SIG, Cubic-KEM). Operates over 256-bit secp256k1 field or any prime.
// ────────────────────────────────────────────────────────────────────────────

/** @type {bigint} secp256k1 field prime */
export const SECP256K1_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
/** @type {bigint} secp256k1 group order */
export const SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

/**
 * Finite field helper (immutable prime). Exported so Cubic-SIG and Cubic-KEM
 * share one tested implementation rather than inlining mod arithmetic.
 */
export class CubicField {
  /** @param {bigint} prime */
  constructor(prime = SECP256K1_P) { this.p = prime; }
  mod(a)    { return ((a % this.p) + this.p) % this.p; }
  add(a, b) { return this.mod(a + b); }
  sub(a, b) { return this.mod(a - b); }
  mul(a, b) { return this.mod(a * b); }
  pow(b, e) {
    b = this.mod(b); let r = 1n;
    while (e > 0n) { if (e & 1n) r = this.mul(r, b); b = this.mul(b, b); e >>= 1n; }
    return r;
  }
  inv(a) { return this.pow(a, this.p - 2n); }

  /** Hash arbitrary scalars/strings into F_p. Domain-tagged SHA-256. */
  hashToField(...args) {
    const h = createHash('sha256');
    for (const a of args) {
      if (typeof a === 'bigint') h.update(a.toString(16).padStart(64, '0'));
      else if (typeof a === 'string') h.update(a);
      else if (a instanceof Uint8Array || Buffer.isBuffer(a)) h.update(a);
      else h.update(String(a));
    }
    return this.mod(BigInt('0x' + h.digest('hex')));
  }

  /**
   * Modular square root via Tonelli–Shanks. Returns a root r with r² ≡ n (mod p)
   * when n is a quadratic residue, otherwise null. Used to prove a derived curve
   * actually carries points: pick an x, solve for y, verify y² == x³+ax+b.
   * @param {bigint} n
   * @returns {bigint|null}
   */
  sqrt(n) {
    n = this.mod(n);
    if (n === 0n) return 0n;
    const p = this.p;
    // Euler's criterion: n is a QR iff n^((p-1)/2) == 1
    if (this.pow(n, (p - 1n) / 2n) !== 1n) return null;
    // secp256k1's p ≡ 3 (mod 4), so the root is n^((p+1)/4). Keep the general
    // Tonelli–Shanks branch for any other prime a caller might construct.
    if (p % 4n === 3n) {
      const r = this.pow(n, (p + 1n) / 4n);
      return this.mul(r, r) === n ? r : null;
    }
    let q = p - 1n, s = 0n;
    while (q % 2n === 0n) { q /= 2n; s += 1n; }
    let z = 2n;
    while (this.pow(z, (p - 1n) / 2n) !== p - 1n) z += 1n;
    let m = s, c = this.pow(z, q), t = this.pow(n, q), r = this.pow(n, (q + 1n) / 2n);
    while (t !== 1n) {
      let i = 0n, tt = t;
      while (tt !== 1n) { tt = this.mul(tt, tt); i += 1n; if (i === m) return null; }
      const b = this.pow(c, this.pow(2n, m - i - 1n));
      m = i; c = this.mul(b, b); t = this.mul(t, c); r = this.mul(r, b);
    }
    return this.mul(r, r) === n ? r : null;
  }
}

/**
 * Rank of a matrix over F_p by Gaussian elimination. Rows is an array of BigInt
 * arrays (all the same length). Pure function, no allocation of the caller's rows.
 * Used by the MinRank cryptanalysis proof to MEASURE — not assert — the algebraic
 * rank of the naive geometric outer-product vs. the hash-expanded public block.
 * @param {bigint[][]} rows
 * @param {bigint} p
 * @returns {number} rank in [0, min(#rows, #cols)]
 */
export function matrixRankModP(rows, p) {
  const F = new CubicField(p);
  const m = rows.map((r) => r.map((v) => F.mod(v)));   // work on a copy
  const nRows = m.length;
  const nCols = nRows ? m[0].length : 0;
  let rank = 0;
  for (let col = 0; col < nCols && rank < nRows; col++) {
    // find a pivot at or below `rank` in this column
    let pivot = -1;
    for (let r = rank; r < nRows; r++) { if (m[r][col] !== 0n) { pivot = r; break; } }
    if (pivot === -1) continue;
    [m[rank], m[pivot]] = [m[pivot], m[rank]];
    const inv = F.inv(m[rank][col]);
    for (let c = col; c < nCols; c++) m[rank][c] = F.mul(m[rank][c], inv);
    for (let r = 0; r < nRows; r++) {
      if (r === rank || m[r][col] === 0n) continue;
      const factor = m[r][col];
      for (let c = col; c < nCols; c++) m[r][c] = F.sub(m[r][c], F.mul(factor, m[rank][c]));
    }
    rank++;
  }
  return rank;
}

// ────────────────────────────────────────────────────────────────────────────
// CubicCurveSource — THE SPECIFIED CONSTRUCTION (replaces PlaceholderCurveSource)
//
// Given ≥ 3 transaction coordinates in the XMBL cubic lattice, derives a
// verifiable, non-singular elliptic curve E: y² = x³ + a·x + b (mod p).
//
// Construction:
//   1. Plane normal  n = (P₂ − P₁) × (P₃ − P₁)  over F_p
//   2. Consensus seed  S = H("XMBL-CUBIC-CURVE-v1" ‖ n ‖ cubeAddress ‖ coords)
//   3. Curve params  a = H(S ‖ 0x01),  b = H(S ‖ 0x02)  in F_p
//   4. Discriminant check  Δ = 4a³ + 27b²  ≠ 0  (non-singular)
//   5. Pack 64-byte block:  [32-byte a_be, 32-byte b_be]
//
// Cryptanalytic notes (see docs/xmbl-cubic-cryptography-whitepaper.md §2):
//   • Raw coordinates have < 10 bits entropy — they are NOT secret material.
//     They serve as verifiable PUBLIC evaluation points only.
//   • The hash extension H() defeats MinRank: no low-rank outer-product
//     matrices are ever constructed from the geometric vectors.
//   • Discriminant ≠ 0 rules out singular (nodal/cuspidal) curves.
//   • The seed is deterministic given the same ledger state across nodes.
// ────────────────────────────────────────────────────────────────────────────

const CUBIC_DOMAIN = 'xmbl/xid/cubic-curve-source/v1';

export class CubicCurveSource extends CurveSource {
  /**
   * @param {CurveRequest} request
   * @returns {Uint8Array} 64-byte parameter block [a_be(32) | b_be(32)]
   */
  getCurveParams(request) {
    const { cubeAddress, coordinates } = request;
    if (!Array.isArray(coordinates) || coordinates.length < 3) {
      throw new Error('CubicCurveSource: requires ≥ 3 transaction coordinates');
    }

    const F = new CubicField(SECP256K1_P);
    const [c0, c1, c2] = coordinates;

    // ── Step 1: Plane normal via cross product ──
    // Lift integer coordinates to F_p (negative values wrap correctly via mod)
    const dx12 = [F.mod(BigInt(c1.x - c0.x)), F.mod(BigInt(c1.y - c0.y)), F.mod(BigInt(c1.z - c0.z))];
    const dx13 = [F.mod(BigInt(c2.x - c0.x)), F.mod(BigInt(c2.y - c0.y)), F.mod(BigInt(c2.z - c0.z))];
    const nx = F.sub(F.mul(dx12[1], dx13[2]), F.mul(dx12[2], dx13[1]));
    const ny = F.sub(F.mul(dx12[2], dx13[0]), F.mul(dx12[0], dx13[2]));
    const nz = F.sub(F.mul(dx12[0], dx13[1]), F.mul(dx12[1], dx13[0]));

    // A zero normal means the 3 points are COLLINEAR — there is no plane to cut
    // the cubic hypersurface with, so the "planar section" is undefined. Reject it
    // rather than hashing a zero normal and reporting "derived a curve from a plane".
    if (nx === 0n && ny === 0n && nz === 0n) {
      throw new Error('CubicCurveSource: the 3 transaction coordinates are collinear (plane normal = 0); no planar section exists');
    }

    // ── Step 2: Consensus seed ──
    // The canonical form (from canonicalizeRequest) is order-preserving and
    // collision-resistant. We layer CUBIC_DOMAIN + plane normal on top.
    const canonical = canonicalizeRequest(request);
    const seed = F.hashToField(
      CUBIC_DOMAIN, canonical,
      nx, ny, nz,
      encodeScalar(cubeAddress),
    );

    // ── Step 3: Derive curve parameters a, b ──
    let a = F.hashToField(seed, 1n);
    let b = F.hashToField(seed, 2n);

    // ── Step 4: Non-singularity check (discriminant Δ = 4a³ + 27b² ≠ 0) ──
    // Retry with incremented counter if singular (probability ≈ 1/p, negligible,
    // but we guard it deterministically for correctness).
    let attempts = 0;
    while (true) {
      const delta = F.add(F.mul(4n, F.pow(a, 3n)), F.mul(27n, F.pow(b, 2n)));
      if (delta !== 0n) break;
      attempts++;
      b = F.hashToField(seed, BigInt(2 + attempts));
      if (attempts > 255) throw new Error('CubicCurveSource: failed to find non-singular curve (should never happen)');
    }

    // ── Step 5: Pack 64-byte block ──
    const out = Buffer.alloc(CURVE_PARAM_BLOCK_SIZE);
    const aHex = a.toString(16).padStart(64, '0');
    const bHex = b.toString(16).padStart(64, '0');
    out.write(aHex, 0, 32, 'hex');
    out.write(bHex, 32, 32, 'hex');
    return new Uint8Array(out);
  }

  /**
   * Unpack a 64-byte parameter block back into (a, b) bigints.
   * Useful for downstream primitives (Cubic-SIG, Cubic-KEM) that need the
   * actual curve coefficients, not just the opaque block.
   * @param {Uint8Array} block
   * @returns {{a: bigint, b: bigint}}
   */
  static unpackParams(block) {
    if (!block || block.length !== CURVE_PARAM_BLOCK_SIZE) {
      throw new Error('CubicCurveSource.unpackParams: block must be exactly 64 bytes');
    }
    const buf = Buffer.from(block);
    const a = BigInt('0x' + buf.subarray(0, 32).toString('hex'));
    const b = BigInt('0x' + buf.subarray(32, 64).toString('hex'));
    return { a, b };
  }

  /**
   * Full derivation trace — EVERY intermediate value, as exact bigints, so a
   * verifier can recompute the curve by hand rather than trust a boolean. Same
   * math as getCurveParams(), but it returns the work instead of the packed block.
   *
   * @param {CurveRequest} request
   * @returns {{
   *   p: bigint, canonical: string,
   *   d12: bigint[], d13: bigint[], normal: {nx:bigint,ny:bigint,nz:bigint},
   *   seed: bigint, a: bigint, b: bigint, delta: bigint, nonSingular: boolean,
   *   attempts: number, point: {x:bigint,y:bigint}|null, pointOnCurve: boolean
   * }}
   */
  describeDerivation(request) {
    const { cubeAddress, coordinates } = request;
    if (!Array.isArray(coordinates) || coordinates.length < 3) {
      throw new Error('CubicCurveSource: requires ≥ 3 transaction coordinates');
    }
    const F = new CubicField(SECP256K1_P);
    const [c0, c1, c2] = coordinates;
    const d12 = [F.mod(BigInt(c1.x - c0.x)), F.mod(BigInt(c1.y - c0.y)), F.mod(BigInt(c1.z - c0.z))];
    const d13 = [F.mod(BigInt(c2.x - c0.x)), F.mod(BigInt(c2.y - c0.y)), F.mod(BigInt(c2.z - c0.z))];
    const nx = F.sub(F.mul(d12[1], d13[2]), F.mul(d12[2], d13[1]));
    const ny = F.sub(F.mul(d12[2], d13[0]), F.mul(d12[0], d13[2]));
    const nz = F.sub(F.mul(d12[0], d13[1]), F.mul(d12[1], d13[0]));
    if (nx === 0n && ny === 0n && nz === 0n) {
      throw new Error('CubicCurveSource: the 3 transaction coordinates are collinear (plane normal = 0); no planar section exists');
    }
    const canonical = canonicalizeRequest(request);
    const seed = F.hashToField(CUBIC_DOMAIN, canonical, nx, ny, nz, encodeScalar(cubeAddress));
    const a = F.hashToField(seed, 1n);
    let b = F.hashToField(seed, 2n);
    let attempts = 0, delta;
    while (true) {
      delta = F.add(F.mul(4n, F.pow(a, 3n)), F.mul(27n, F.pow(b, 2n)));
      if (delta !== 0n) break;
      attempts++; b = F.hashToField(seed, BigInt(2 + attempts));
      if (attempts > 255) throw new Error('CubicCurveSource: failed to find non-singular curve');
    }
    // Prove the curve carries points: scan x until x³+ax+b is a quadratic residue,
    // then take its square root and check y² == RHS. This is a real point on E.
    let point = null;
    for (let xi = 1n; xi <= 64n; xi++) {
      const rhs = F.add(F.add(F.pow(xi, 3n), F.mul(a, xi)), b);
      const y = F.sqrt(rhs);
      if (y !== null) { point = { x: xi, y }; break; }
    }
    const pointOnCurve = point !== null &&
      F.mul(point.y, point.y) === F.add(F.add(F.pow(point.x, 3n), F.mul(a, point.x)), b);
    return { p: F.p, canonical, d12, d13, normal: { nx, ny, nz }, seed, a, b, delta, nonSingular: delta !== 0n, attempts, point, pointOnCurve };
  }

  /** @returns {{name:string, blockSize:number, placeholder:boolean, secure:boolean, audited:boolean, note:string}} */
  describe() {
    return {
      name: 'CubicCurveSource',
      blockSize: CURVE_PARAM_BLOCK_SIZE,
      placeholder: false,
      // NOT a security assertion. This is a novel construction (curves derived from
      // the cube-of-cubes ledger) with NO third-party cryptanalysis. `secure` stays
      // false and `audited` stays false until an external audit closes MAINNET-GATES.md
      // §"Cubic construction". A module must never claim its own security in metadata.
      secure: false,
      audited: false,
      note: '3-point planar section on cubic hypersurface; construction is verifiable-nonsingular but UNAUDITED; do not rely on for value until MAINNET-GATES.md is closed; see whitepaper §3.1',
    };
  }
}
