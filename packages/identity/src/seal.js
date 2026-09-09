// seal — hybrid post-quantum envelope encryption to an XMBL identity.
//
// Seals an arbitrary secret (a key, a secret share, a pre-signed transaction — anything) so
// that ONLY the holder of a named XMBL identity's PQ-Cubic-LWE secret key can open it. This is
// the cryptographic core of "settled on XMBL": a value transfer that clears on another rail
// (e.g. a USDC ERC-20 transfer whose authorizing EVM private key is the sealed secret) is bound
// to an XMBL identity — the receiver, named on the XMBL record, is the only party who can
// decrypt the authorizing secret, and the network's job is to validate the receiver's claim and
// release the sealed material to them, not to custody the ERC-20 itself.
//
// Construction (hybrid KEM-DEM, the standard shape):
//   • KEM: PQ-Cubic-LWE encapsulate(pk) → a 32-byte shared secret + its lattice ciphertext.
//   • KDF: HKDF-SHA256 over the shared secret, domain-separated + bound to the receiver address
//     and an AAD, so the AES key cannot be reused across receivers or contexts.
//   • DEM: AES-256-GCM over the plaintext, with the claim metadata as additional authenticated
//     data — so the ciphertext is cryptographically tied to WHO it is for and WHAT it settles;
//     tampering with either fails the GCM tag, not silently decrypts to a different meaning.
//
// The LWE parameters are carried in the envelope so open() uses the exact ring the seal used.
// Determinism note: sealing is randomized (KEM + IV); opening is deterministic. A sealed
// envelope is safe to publish — it reveals nothing without the receiver's LWE secret key.

import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { encapsulate, decapsulate, keyGen as cubicLweKeyGen, MAINNET_N } from './cubic-lwe.js';

const ALG = 'xmbl-seal-v1'; // Cubic-LWE KEM + HKDF-SHA256 + AES-256-GCM

// A value-bearing seal must ride the mainnet lattice. N=27 is a toy ring with no quantum margin;
// sealing an EVM key or secret share to it would make "post-quantum settlement" a false claim.
// sealSecret REFUSES any receiver pk below this unless a caller explicitly opts into a weak ring
// for a non-value demonstration (allowWeak). sealKeyPair mints at MAINNET_N by default.
const MIN_SEAL_N = MAINNET_N;

// ---- HKDF-SHA256 (extract + expand), enough to derive one 32-byte AES key + 12-byte IV salt ----
function hkdf(ikm, salt, info, len) {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const out = [];
  let t = Buffer.alloc(0), i = 0;
  while (Buffer.concat(out).length < len) {
    i += 1;
    t = createHmac('sha256', prk).update(Buffer.concat([t, Buffer.from(info), Buffer.from([i])])).digest();
    out.push(t);
  }
  return Buffer.concat(out).subarray(0, len);
}

// Canonical AAD bytes: the metadata the ciphertext is bound to (order-stable).
function aadBytes(receiver, meta) {
  const canon = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  };
  return Buffer.from(`${ALG}|${receiver}|${canon(meta || {})}`, 'utf8');
}

/**
 * Seal `secret` to a receiver's PQ-Cubic-LWE public key. The returned envelope is safe to
 * publish/anchor: without the receiver's LWE secret key it reveals nothing.
 *
 * @param {{A:bigint[][], b:bigint[], n:number, q:bigint}} receiverPk receiver's Cubic-LWE pk
 * @param {Uint8Array|Buffer|string} secret the material to protect (e.g. an EVM private key)
 * @param {object} [opts]
 * @param {string} [opts.receiver] the receiver's XMBL address, bound into the KDF + AAD
 * @param {object} [opts.meta] metadata bound as AAD (asset, amount, evm tx hash, …)
 * @returns {{alg:string, receiver:string, meta:object, kem:object, n:number, q:string, iv:string, ct:string, tag:string}}
 */
export function sealSecret(receiverPk, secret, opts = {}) {
  const receiver = opts.receiver || '';
  const meta = opts.meta || {};
  // Fail closed: a seal that protects real value must use the mainnet lattice. Only an explicit
  // opts.allowWeak (a non-value demonstration) may seal to a sub-mainnet ring, and it is stamped
  // so nothing downstream can mistake it for a post-quantum-secure envelope.
  if (!receiverPk || typeof receiverPk.n !== 'number') throw new Error('seal: receiver pk missing lattice dimension n');
  if (receiverPk.n < MIN_SEAL_N && !opts.allowWeak)
    throw new Error(`seal: receiver lattice N=${receiverPk.n} is below mainnet N=${MIN_SEAL_N} — refusing to seal value to a toy ring (pass allowWeak for a non-value demo)`);
  const plaintext = typeof secret === 'string' ? Buffer.from(secret, 'utf8')
    : Buffer.from(secret instanceof Uint8Array ? secret : Buffer.from(secret));

  const { ciphertext: kem, sharedSecret } = encapsulate(receiverPk, { secretBits: 256 });
  const salt = createHash('sha256').update(`${ALG}|salt|${receiver}`).digest();
  const key = hkdf(sharedSecret, salt, `${ALG}|aes-key|${receiver}`, 32);
  const iv = randomBytes(12);
  const aad = aadBytes(receiver, meta);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Serialize the KEM ciphertext COMPACTLY. Every u/v entry is a residue mod q (< 2^16), so pack
  // them as little-endian uint16 and base64 rather than 256·(n+1) decimal strings. At the mainnet
  // dimension N=729 this is ~500 KB instead of ~1.2 MB per envelope — the difference between what
  // gets stored per settlement, returned in an HTTP body, and re-hashed on every claim validation.
  // Crypto is unchanged (same KEM/KDF/AAD, same `alg`); only the wire encoding of `kem` changes.
  const count = kem.length, n = receiverPk.n;
  const uBuf = Buffer.allocUnsafe(count * n * 2), vBuf = Buffer.allocUnsafe(count * 2);
  for (let i = 0; i < count; i++) {
    const c = kem[i], base = i * n * 2;
    for (let j = 0; j < n; j++) uBuf.writeUInt16LE(Number(c.u[j]), base + j * 2);
    vBuf.writeUInt16LE(Number(c.v), i * 2);
  }
  return {
    alg: ALG, enc: 'u16le', receiver, meta,
    kemU: uBuf.toString('base64'), kemV: vBuf.toString('base64'), count, n: receiverPk.n, q: receiverPk.q.toString(),
    iv: iv.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64'),
    ...(receiverPk.n < MIN_SEAL_N ? { weak: true } : {}),
  };
}

/**
 * Open a sealed envelope with the receiver's PQ-Cubic-LWE secret key. Throws if the envelope
 * was not sealed for this key or was tampered with (the GCM tag fails) — never returns wrong
 * plaintext.
 * @param {{s:bigint[], n:number, q:bigint}} receiverSk
 * @param {object} env envelope from {@link sealSecret}
 * @returns {Buffer} the recovered secret bytes
 */
export function openSecret(receiverSk, env) {
  if (!env || env.alg !== ALG) throw new Error(`seal: unknown envelope alg '${env && env.alg}'`);
  // PIN the ring to the RECEIVER'S OWN key, never the (attacker-supplied) envelope. A tampered
  // envelope that shrinks n or swaps q must not steer decapsulation into a weaker/other ring — the
  // receiver decapsulates under exactly the parameters of the key they hold, or the open fails.
  const skN = receiverSk.n ?? (receiverSk.s ? receiverSk.s.length : undefined);
  if (skN !== undefined && env.n !== skN) throw new Error(`seal: envelope n=${env.n} does not match the receiver key n=${skN}`);
  if (receiverSk.q !== undefined && BigInt(env.q) !== BigInt(receiverSk.q)) throw new Error(`seal: envelope q=${env.q} does not match the receiver key q=${receiverSk.q}`);
  const q = receiverSk.q !== undefined ? BigInt(receiverSk.q) : BigInt(env.q);
  let kem;
  if (env.enc === 'u16le' && env.kemU) {
    // Compact form: little-endian uint16 blobs (see sealSecret). Unpack back to per-ciphertext vectors.
    const uBuf = Buffer.from(env.kemU, 'base64'), vBuf = Buffer.from(env.kemV, 'base64');
    const n = env.n, count = env.count;
    kem = new Array(count);
    for (let i = 0; i < count; i++) {
      const u = new Array(n), base = i * n * 2;
      for (let j = 0; j < n; j++) u[j] = BigInt(uBuf.readUInt16LE(base + j * 2));
      kem[i] = { u, v: BigInt(vBuf.readUInt16LE(i * 2)) };
    }
  } else {
    // Legacy decimal-string form.
    kem = env.kem.map((c) => ({ u: c.u.map((x) => BigInt(x)), v: BigInt(c.v) }));
  }
  const sharedSecret = decapsulate({ s: receiverSk.s, n: env.n, q }, kem);
  const salt = createHash('sha256').update(`${ALG}|salt|${env.receiver || ''}`).digest();
  const key = hkdf(sharedSecret, salt, `${ALG}|aes-key|${env.receiver || ''}`, 32);
  const aad = aadBytes(env.receiver || '', env.meta || {});

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
}

/** Convenience: a fresh receiver identity for sealing. Mints at the MAINNET lattice (N=729) by
 *  default so a sealed value envelope is post-quantum from the start; pass { n } to override. */
export function sealKeyPair(opts = {}) { return cubicLweKeyGen({ n: MAINNET_N, ...opts }); }
