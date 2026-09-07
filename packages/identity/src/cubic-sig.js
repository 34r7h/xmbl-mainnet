import { createHash, randomBytes } from 'node:crypto';
import {
  CubicCurveSource, CubicField, canonicalizeRequest,
  CURVE_PARAM_BLOCK_SIZE, SECP256K1_P, SECP256K1_N,
} from './curve-source.js';

/**
 * cubic-sig.js — Geometric Vector Schnorr Signature (Cubic-SIG)
 *
 * A Schnorr-style digital signature scheme where the Fiat-Shamir challenge
 * is bound to the 3D planar section of the XMBL cubic ledger geometry.
 * Signatures produced by this module are INVALID if replayed outside their
 * native cube/face/plane — the geometric coordinates and plane normal are
 * hashed into the challenge.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ SECURITY: EUF-CMA under ECDLP in the Random Oracle Model.           │
 * │ See docs/xmbl-cubic-cryptography-whitepaper.md §5.2 for the proof.  │
 * │ CLASSICAL ONLY — vulnerable to Shor. For PQ, use cubic-lwe.js.      │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * API:
 *   keyGen()                              → { sk, pk }
 *   sign(message, sk, pk, cubeContext)     → { R, s, e }
 *   verify(message, sig, pk, cubeContext)  → boolean
 *
 * cubeContext = { cubeAddress, coordinates: [{x,y,z}, {x,y,z}, {x,y,z}, ...] }
 *   — the same CurveRequest shape that CubicCurveSource consumes.
 */

const DOMAIN_SIG = 'xmbl/xid/cubic-sig/v1';

const F = new CubicField(SECP256K1_P);
const Fn = new CubicField(SECP256K1_N);

// ── secp256k1 base point G ──
const G = {
  x: 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n,
  y: 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n,
};

// ── Elliptic curve point operations on y² = x³ + a·x + b (mod p) ──

function ecAdd(P, Q, a = 0n) {
  if (!P) return Q;
  if (!Q) return P;
  if (P.x === Q.x && P.y !== Q.y) return null; // O

  let lambda;
  if (P.x === Q.x && P.y === Q.y) {
    if (P.y === 0n) return null;
    lambda = F.mul(F.add(F.mul(3n, F.mul(P.x, P.x)), a), F.inv(F.mul(2n, P.y)));
  } else {
    lambda = F.mul(F.sub(Q.y, P.y), F.inv(F.sub(Q.x, P.x)));
  }
  const x3 = F.sub(F.sub(F.mul(lambda, lambda), P.x), Q.x);
  const y3 = F.sub(F.mul(lambda, F.sub(P.x, x3)), P.y);
  return { x: x3, y: y3 };
}

function ecMul(k, P, a = 0n) {
  let R = null, B = P, e = k;
  while (e > 0n) {
    if (e & 1n) R = ecAdd(R, B, a);
    B = ecAdd(B, B, a);
    e >>= 1n;
  }
  return R;
}

// ── Geometric challenge hash ──
// Binds the signature to the 3D PLANE NORMAL + coordinates + message.
// The plane normal n = (P₂−P₁)×(P₃−P₁) is hashed into the Fiat–Shamir challenge,
// so a signature is invalid in any cube whose 3-point plane differs — this is what
// makes signatures spatially non-transferable (see verify/replay tests below).
function challengeHash(R, pk, message, cubeContext) {
  const h = createHash('sha256');
  h.update(DOMAIN_SIG);
  h.update(R.x.toString(16).padStart(64, '0'));
  h.update(R.y.toString(16).padStart(64, '0'));
  h.update(pk.x.toString(16).padStart(64, '0'));
  h.update(pk.y.toString(16).padStart(64, '0'));
  if (typeof message === 'string') h.update(message);
  else h.update(message);

  // Bind to the cubic geometry — the PLANE NORMAL of the first 3 coordinates,
  // computed over F_p, then the raw coordinates and the cube address. Hashing the
  // normal (not just the points) is what ties the challenge to the plane itself.
  const coords = cubeContext.coordinates || [];
  if (coords.length >= 3) {
    const n = planeNormal(cubeContext);
    h.update('n=');
    h.update(n.nx.toString(16).padStart(64, '0'));
    h.update(n.ny.toString(16).padStart(64, '0'));
    h.update(n.nz.toString(16).padStart(64, '0'));
  }
  for (const c of coords) {
    h.update(`${c.x},${c.y},${c.z}`);
    if (c.magnitude !== undefined) h.update(`,m=${c.magnitude}`);
  }
  if (cubeContext.cubeAddress !== undefined) {
    h.update(String(cubeContext.cubeAddress));
  }
  return Fn.mod(BigInt('0x' + h.digest('hex')));
}

// ── Public API ──

/**
 * Generate a Cubic-SIG keypair.
 * @returns {{sk: bigint, pk: {x: bigint, y: bigint}}}
 */
export function keyGen() {
  const sk = Fn.mod(BigInt('0x' + randomBytes(32).toString('hex')));
  const pk = ecMul(sk, G);
  return { sk, pk };
}

/**
 * Sign a message, binding the signature to the 3-point cubic plane.
 *
 * @param {string|Uint8Array} message  — the message to sign
 * @param {bigint} sk                  — signer's secret key
 * @param {{x:bigint,y:bigint}} pk     — signer's public key
 * @param {CurveRequest} cubeContext   — { cubeAddress, coordinates[≥3] }
 * @returns {{R:{x:bigint,y:bigint}, s:bigint, e:bigint}}
 */
export function sign(message, sk, pk, cubeContext) {
  if (!cubeContext?.coordinates || cubeContext.coordinates.length < 3) {
    throw new Error('cubic-sig: cubeContext must contain ≥ 3 coordinates');
  }
  // Spatial binding is only meaningful with a real plane. Collinear coordinates give a
  // zero normal — the challenge would bind to (0,0,0) and the "non-transferable outside
  // its plane" property would be vacuous. Reject at signing, matching CubicCurveSource.
  const nsign = planeNormal(cubeContext);
  if (nsign.nx === 0n && nsign.ny === 0n && nsign.nz === 0n) {
    throw new Error('cubic-sig: the 3 coordinates are collinear (plane normal = 0); a spatially-bound signature needs a real plane');
  }
  const k = Fn.mod(BigInt('0x' + randomBytes(32).toString('hex')));
  const R = ecMul(k, G);
  const e = challengeHash(R, pk, message, cubeContext);
  const s = Fn.add(k, Fn.mul(e, sk));
  return { R, s, e };
}

/**
 * Verify a Cubic-SIG signature.
 *
 * Checks: [s]G == R + [e]pk
 *
 * @param {string|Uint8Array} message
 * @param {{R:{x:bigint,y:bigint}, s:bigint}} sig
 * @param {{x:bigint,y:bigint}} pk
 * @param {CurveRequest} cubeContext
 * @returns {boolean}
 */
export function verify(message, sig, pk, cubeContext) {
  if (!sig?.R || sig.s === undefined) return false;
  if (!cubeContext?.coordinates || cubeContext.coordinates.length < 3) return false;

  const e = challengeHash(sig.R, pk, message, cubeContext);
  const sG = ecMul(sig.s, G);
  const ePk = ecMul(e, pk);
  const Repk = ecAdd(sig.R, ePk);

  if (!sG || !Repk) return sG === Repk; // both null = O
  return sG.x === Repk.x && sG.y === Repk.y;
}

/**
 * Verify WITH the intermediate work exposed: the recomputed challenge e and BOTH
 * sides of the Schnorr equation [s]G  ==  R + [e]pk. Lets a proof card show the two
 * points that must coincide (and, on a negative test, the e that differs), instead
 * of only a boolean.
 * @param {string|Uint8Array} message
 * @param {{R:{x:bigint,y:bigint}, s:bigint}} sig
 * @param {{x:bigint,y:bigint}} pk
 * @param {CurveRequest} cubeContext
 * @returns {{ok:boolean, e:bigint, lhs:{x:bigint,y:bigint}|null, rhs:{x:bigint,y:bigint}|null}}
 */
export function verifyDetail(message, sig, pk, cubeContext) {
  const e = challengeHash(sig.R, pk, message, cubeContext);
  const lhs = ecMul(sig.s, G);            // [s]G
  const rhs = ecAdd(sig.R, ecMul(e, pk)); // R + [e]pk
  const ok = (!lhs || !rhs) ? (lhs === rhs) : (lhs.x === rhs.x && lhs.y === rhs.y);
  return { ok, e, lhs, rhs };
}

/**
 * Derive the 3-point plane normal from a CurveRequest's first 3 coordinates.
 * Useful for introspection / display.
 * @param {CurveRequest} cubeContext
 * @returns {{nx:bigint, ny:bigint, nz:bigint}}
 */
export function planeNormal(cubeContext) {
  const [c0, c1, c2] = cubeContext.coordinates;
  const dx12 = [F.mod(BigInt(c1.x - c0.x)), F.mod(BigInt(c1.y - c0.y)), F.mod(BigInt(c1.z - c0.z))];
  const dx13 = [F.mod(BigInt(c2.x - c0.x)), F.mod(BigInt(c2.y - c0.y)), F.mod(BigInt(c2.z - c0.z))];
  return {
    nx: F.sub(F.mul(dx12[1], dx13[2]), F.mul(dx12[2], dx13[1])),
    ny: F.sub(F.mul(dx12[2], dx13[0]), F.mul(dx12[0], dx13[2])),
    nz: F.sub(F.mul(dx12[0], dx13[1]), F.mul(dx12[1], dx13[0])),
  };
}

// ── Serialization helpers (Base64 envelopes for wire and signer seam) ──

export function serializeSignature(sig) {
  return Buffer.from(JSON.stringify({
    Rx: sig.R.x.toString(16),
    Ry: sig.R.y.toString(16),
    s: sig.s.toString(16),
    e: sig.e?.toString(16) || '',
  })).toString('base64');
}

export function deserializeSignature(str) {
  const obj = JSON.parse(Buffer.from(str, 'base64').toString('utf8'));
  return {
    R: { x: BigInt('0x' + obj.Rx), y: BigInt('0x' + obj.Ry) },
    s: BigInt('0x' + obj.s),
    e: obj.e ? BigInt('0x' + obj.e) : 0n,
  };
}

export function serializePublicKey(pk) {
  return Buffer.from(JSON.stringify({
    x: pk.x.toString(16),
    y: pk.y.toString(16),
  })).toString('base64');
}

export function deserializePublicKey(str) {
  const obj = JSON.parse(Buffer.from(str, 'base64').toString('utf8'));
  return {
    x: BigInt('0x' + obj.x),
    y: BigInt('0x' + obj.y),
  };
}

export function serializePrivateKey(sk) {
  return Buffer.from(sk.toString(16).padStart(64, '0'), 'hex').toString('base64');
}

export function deserializePrivateKey(str) {
  return BigInt('0x' + Buffer.from(str, 'base64').toString('hex'));
}

// ── Self-test ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const ok = (b) => (b ? 'PASS' : 'FAIL');
  // Non-collinear: normal = (P₂−P₁)×(P₃−P₁) ≠ 0, so the planar section is defined.
  const ctx = {
    cubeAddress: 'cube-0001',
    coordinates: [
      { x: 1, y: 2, z: 3 },
      { x: 4, y: 0, z: -1 },
      { x: -2, y: 5, z: 2 },
    ],
  };

  const { sk, pk } = keyGen();
  const msg = 'XMBL-TRANSFER-42-XYM';
  const sig1 = sign(msg, sk, pk, ctx);
  console.log(`cubic-sig honest verify:          ${ok(verify(msg, sig1, pk, ctx))}  (want PASS)`);
  console.log(`cubic-sig tampered msg rejected:   ${ok(!verify(msg + '-x', sig1, pk, ctx))}  (want PASS)`);

  // Replay in a different cube context must fail
  const ctx2 = { cubeAddress: 'cube-9999', coordinates: [
    { x: 2, y: 2, z: 2 }, { x: 3, y: 3, z: 3 }, { x: 4, y: 4, z: 4 },
  ]};
  console.log(`cubic-sig cross-cube replay rejected: ${ok(!verify(msg, sig1, pk, ctx2))}  (want PASS)`);

  // Wrong key must fail
  const { pk: pk2 } = keyGen();
  console.log(`cubic-sig wrong-key rejected:      ${ok(!verify(msg, sig1, pk2, ctx))}  (want PASS)`);
}
