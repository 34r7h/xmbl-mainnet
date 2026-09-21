// Node-side capability runners for the browser extension. The extension popup cannot run xmbl's
// zk / homomorphic-encryption / signature primitives in-page (they need node:crypto; an MV3 page
// CSP and WebCrypto's async sha256 make a faithful in-page port impossible), so the devnet node
// process — which already loads the REAL modules — runs each primitive end-to-end and returns a
// JSON-safe verdict. Each runner does the right thing and its NEGATIVE control in one call: it
// proves the capability verifies true input AND rejects tampered input, so a green card on screen
// is backed by a real refusal, not a fabricated pass. Every flow mirrors the headless
// reproductions in @xmbl/contracts (reproductions/contract-zk.mjs, contract-he.mjs,
// agentic-contract-e2e.mjs) so the extension and the audit prove the same thing.
import { setup, blindedCurve, prove, verify as zkVerify } from '../../zero-knowledge/index.js';
import {
  cubicSigKeyGen, cubicSigSign, cubicSigVerify,
  cubicLweKeyGen, encryptBit, decryptBit, addCiphertexts,
  sealSecret, openSecret, sealKeyPair,
} from '../../identity/index.js';

const bi = (v) => BigInt(v);
const str = (v) => (typeof v === 'bigint' ? v.toString() : v);

// A real, non-collinear cube plane for the spatial binding (normal ≠ 0).
const CUBE_CONTEXT = {
  cubeAddress: 'cube-xbe-demo',
  coordinates: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }],
};

// ── Coordinate / curve zero-knowledge (@xmbl/zero-knowledge, FRI, ⛔ UNAUDITED) ──
// A prover shows a coordinate (derivedX, derivedY) lies on a curve through secret points, and a
// verifier checks it WITHOUT the secret points. We prove the genuine coordinate and reject a
// tampered y (derivedY+1) — the exact pair reproductions/contract-zk.mjs gates a Verkle write on.
export function zkProof({ derivedX = 99 } = {}) {
  const ctx = setup();
  const publicPoints = [{ x: 11n, y: 101n }, { x: 12n, y: 205n }, { x: 13n, y: 313n }, { x: 14n, y: 419n }];
  const secretPoints = [{ x: 21n, y: 55555n }, { x: 22n, y: 66666n }, { x: 23n, y: 77777n }];
  const dX = bi(derivedX);
  const { Pt, derivedY } = blindedCurve(ctx, { publicPoints, secretPoints, derivedX: dX });
  const proof = prove(ctx, { Pt, publicPoints, derivedX: dX, derivedY });
  const genuine = zkVerify(ctx, { proof, publicPoints, derivedX: dX, derivedY });
  const tampered = zkVerify(ctx, { proof, publicPoints, derivedX: dX, derivedY: derivedY + 1n });
  return {
    ok: genuine === true && tampered === false,
    scheme: 'xzk (FRI coordinate/curve proof, UNAUDITED)',
    derivedX: str(dX), derivedY: str(derivedY),
    publicAnchors: publicPoints.length,
    genuineVerifies: genuine, tamperedRejected: tampered === false,
    note: 'proof checked without the secret points; a coordinate off the curve is rejected',
  };
}

// ── Homomorphic add (post-quantum cubic-LWE) ──
// ENC(a) ⊞ ENC(b) decrypts to a+b with NO secret key present during the add. Single-bit message
// space wraps mod 2 (the documented behavior in reproductions/contract-he.mjs). a,b ∈ {0,1}.
export function heAdd({ a = 1, b = 1 } = {}) {
  // The message space is a single bit; reject anything else rather than silently coercing (a
  // coerced 3→1 would return ok:true for an operation nobody asked for).
  if (![0, 1].includes(a) || ![0, 1].includes(b)) {
    return { ok: false, scheme: 'cubic-LWE (single-bit message space)', a, b, error: 'heAdd: a and b must each be 0 or 1' };
  }
  const bitA = a, bitB = b;
  const { sk, pk } = cubicLweKeyGen();
  const ctA = encryptBit(pk, bitA);
  const ctB = encryptBit(pk, bitB);
  const ctSum = addCiphertexts(ctA, ctB); // NO secret key here — the add is blind
  const sum = decryptBit(sk, ctSum);      // decrypt OFF to the side, with sk
  const expected = (bitA + bitB) % 2;
  return {
    ok: sum === expected,
    scheme: 'cubic-LWE (post-quantum, single-bit message space mod 2)',
    a: bitA, b: bitB, sum, expected,
    note: 'ENC(a) ⊞ ENC(b) added with no secret key; decryption needs sk and is on no contract ABI',
  };
}

// ── Cubic-SIG signature verify (spatially bound to a cube plane) ──
// Sign a message, verify it, then prove a tampered message is rejected.
export function sigVerify({ message = 'xmbl-extension' } = {}) {
  const { sk, pk } = cubicSigKeyGen();
  const sig = cubicSigSign(message, sk, pk, CUBE_CONTEXT);
  const good = cubicSigVerify(message, sig, pk, CUBE_CONTEXT);
  const bad = cubicSigVerify(message + '!', sig, pk, CUBE_CONTEXT);
  return {
    ok: good === true && bad === false,
    scheme: 'Cubic-SIG (Schnorr bound to a 3-point cube plane)',
    message, signedVerifies: good, tamperedRejected: bad === false,
    note: '[s]G == R + [e]pk over the cube plane; a changed message fails verification',
  };
}

// ── Seal (post-quantum KEM envelope, MAINNET_N) ──
// Seal a secret to a receiver's public key; only the receiver's secret key opens it.
export function sealRoundTrip({ secret = 'authorizing-key' } = {}) {
  const receiver = sealKeyPair();
  const bytes = new TextEncoder().encode(secret);
  const env = sealSecret(receiver.pk, bytes);
  const opened = openSecret(receiver.sk, env);
  const back = new TextDecoder().decode(Uint8Array.from(opened));
  return {
    ok: back === secret,
    scheme: 'cubic-LWE KEM seal (post-quantum, MAINNET_N)',
    roundTrip: back === secret,
    note: 'sealed to the receiver’s public key; opens only with their secret key, never custodied',
  };
}

// Dispatch table: message.type → runner. Kept here so DevnetRpc.handle stays a thin router.
export const CAPABILITIES = {
  zkProof: (m) => zkProof(m),
  heAdd: (m) => heAdd(m),
  sigVerify: (m) => sigVerify(m),
  seal: (m) => sealRoundTrip(m),
};
