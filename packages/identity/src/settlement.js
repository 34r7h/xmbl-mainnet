// settlement — CHAIN-AGNOSTIC value release, enforced by XMBL and by nobody else.
//
// The operator's ruling (2026-09-24): value stays under the control of KEYS, and XMBL enforces who the
// key releases to. That is deliberately NOT an escrow on the settling chain, and the difference is worth
// stating plainly because it decides what "settled on XMBL" may be claimed to mean:
//
//   • An ESCROW would lock the value in a contract on the settling chain, released only when that chain
//     itself verifies a proof of the XMBL decision. No chain can do that for XMBL today — Ethereum's
//     ecrecover accepts only ECDSA, Cubic-SIG is a different construction over the same field, and there
//     is no MAYO precompile anywhere. It would also mean a per-chain contract: not chain-agnostic.
//   • KEY RELEASE puts the value in an ordinary account on ANY chain and makes the AUTHORIZING KEY the
//     thing XMBL controls. The XMBL contract decides who may open the envelope; the settling chain sees
//     an ordinary, valid transaction and needs to know nothing about XMBL. That is what makes one
//     mechanism work for Solana, EVM, Sui and Bitcoin without a line of chain-specific consensus code.
//
// ⛔ THE RESIDUAL TRUST IS THE SEALER, AND IT DOES NOT GO AWAY. Whoever generated the account key could
// have kept a copy. The protocol guarantee is "only the named payee can OPEN this envelope", never "only
// the payee can move the funds". Mint a FRESH key per payout, fund it with exactly the payout amount, and
// discard the plaintext — then a retained copy is worth one payout, not an account. `sealChainKey`
// enforces the freshness it can: it generates the key itself and returns the ADDRESS, never the secret.
//
// What is chain-specific lives in CHAINS below and is exactly three functions — how an address is derived
// from a public key, which digest the chain signs, and how a signature is encoded. Everything else (the
// seal, the authorization binding, the release check) is identical for every chain, which is the point.

import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sealSecret, openSecret } from './seal.js';

const u8 = (b) => (b instanceof Uint8Array ? b : Uint8Array.from(b));
const hex = (b) => Buffer.from(b).toString('hex');
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

// ---- base58 (Bitcoin alphabet), used for Solana addresses. Short, fully specified, no dependency. ----
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes) {
  const b = u8(bytes);
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const x of b) { if (x !== 0) break; out = '1' + out; }   // leading zero bytes are '1'
  return out || '1';
}

// ---- bech32 (BIP-173), used for Bitcoin P2WPKH addresses. ----
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function bech32Expand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [], maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}
export function bech32(hrp, witnessVersion, program) {
  const data = [witnessVersion, ...convertBits(u8(program), 8, 5, true)];
  const chk = bech32Polymod([...bech32Expand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const sum = [];
  for (let i = 0; i < 6; i++) sum.push((chk >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...sum].map((d) => BECH32[d]).join('')}`;
}

// ---- The only chain-specific code in the settlement path ----
//
// Each entry answers three questions and nothing else: what KEY does this chain use, what does it
// actually SIGN, and how is a key rendered as an ADDRESS. `verify` is here so a caller can check a
// release the same way the settling chain would, rather than trusting that it signed something.
export const CHAINS = Object.freeze({
  // secp256k1 over keccak256(payload); address = last 20 bytes of keccak256(uncompressed pubkey).
  evm: Object.freeze({
    curve: 'secp256k1',
    digest: (msg) => keccak_256(u8(msg)),
    address(pub) { return '0x' + hex(keccak_256(u8(pub).slice(1)).slice(-20)); },
    sign(msg, sk) {
      // `recovered` is 65 bytes — the recovery id FIRST, then r||s. ecrecover needs that id, so the
      // recoverable form is taken here rather than reconstructing it from a 64-byte signature.
      const rec = secp256k1.sign(this.digest(msg), u8(sk), { prehash: false, format: 'recovered' });
      return { r: hex(rec.slice(1, 33)), s: hex(rec.slice(33, 65)), v: 27 + rec[0], encoding: 'eip155-rsv' };
    },
    verify(msg, sig, pub) {
      const raw = Buffer.concat([Buffer.from(sig.r, 'hex'), Buffer.from(sig.s, 'hex')]);
      return secp256k1.verify(new Uint8Array(raw), this.digest(msg), u8(pub), { prehash: false });
    },
  }),
  // secp256k1 over sha256(sha256(payload)); address = bech32 P2WPKH of ripemd160(sha256(compressed pk)).
  bitcoin: Object.freeze({
    curve: 'secp256k1',
    compressed: true,
    digest: (msg) => sha256(sha256(u8(msg))),
    address(pub) { return bech32('bc', 0, ripemd160(sha256(u8(pub)))); },
    sign(msg, sk) {
      return { der: hex(secp256k1.sign(this.digest(msg), u8(sk), { prehash: false, format: 'der' })), encoding: 'der', sighash: 'SIGHASH_ALL' };
    },
    verify(msg, sig, pub) {
      return secp256k1.verify(Buffer.from(sig.der, 'hex'), this.digest(msg), u8(pub), { prehash: false, format: 'der' });
    },
  }),
  // ed25519 over the RAW message (Solana signs the serialized transaction itself); address = base58(pk).
  solana: Object.freeze({
    curve: 'ed25519',
    digest: (msg) => u8(msg),
    address(pub) { return base58(u8(pub)); },
    sign(msg, sk) { return { sig: hex(ed25519.sign(this.digest(msg), u8(sk))), encoding: 'ed25519-raw' }; },
    verify(msg, sig, pub) { return ed25519.verify(Buffer.from(sig.sig, 'hex'), this.digest(msg), u8(pub)); },
  }),
  // ed25519 over blake2b-256 of the intent message; address = blake2b-256(0x00 flag || pk).
  sui: Object.freeze({
    curve: 'ed25519',
    digest: (msg) => blake2b(u8(msg), { dkLen: 32 }),
    address(pub) { return '0x' + hex(blake2b(Uint8Array.from([0x00, ...u8(pub)]), { dkLen: 32 })); },
    sign(msg, sk) {
      // Sui's serialized signature is flag || sig || pubkey — the flag is what makes a scheme-agnostic
      // verifier able to pick the right one, so it belongs in the encoding, not in a comment.
      const raw = ed25519.sign(this.digest(msg), u8(sk));
      const pub = ed25519.getPublicKey(u8(sk));
      return { sig: hex(raw), serialized: hex(Uint8Array.from([0x00, ...raw, ...pub])), encoding: 'sui-flag-sig-pk' };
    },
    verify(msg, sig, pub) { return ed25519.verify(Buffer.from(sig.sig, 'hex'), this.digest(msg), u8(pub)); },
  }),
});

export const SUPPORTED_CHAINS = Object.freeze(Object.keys(CHAINS));

function newKey(chain) {
  const spec = CHAINS[chain];
  if (spec.curve === 'ed25519') {
    const kp = generateKeyPairSync('ed25519');
    // The 32-byte seed is what ed25519.sign takes; node wraps it in PKCS8, whose last 32 bytes are it.
    const sk = new Uint8Array(kp.privateKey.export({ type: 'pkcs8', format: 'der' })).slice(-32);
    return { sk, pub: ed25519.getPublicKey(sk) };
  }
  const sk = secp256k1.utils.randomSecretKey();
  return { sk, pub: secp256k1.getPublicKey(sk, CHAINS[chain].compressed !== false) };
}

/**
 * MINT a fresh account key for `chain` and SEAL it to an XMBL identity. The secret never leaves this
 * function — the caller gets the ADDRESS to fund and the ENVELOPE to publish, and nothing else, so there
 * is no plaintext for a caller to mislay. The envelope's AAD binds the ciphertext to the receiver AND to
 * the authorization that justifies it, so an envelope cannot be re-presented as settling a different
 * payout: tampering with either fails the GCM tag rather than decrypting to a different meaning.
 *
 * @param {string} chain one of SUPPORTED_CHAINS
 * @param {object} receiverPk the payee's XMBL Cubic-LWE public key (identity `sealKeyPair`)
 * @param {string} receiver the payee's XMBL address, bound into the AAD
 * @param {{contract:string, method?:string, payout_id?:string, amount?:string, asset?:string}} authorization
 * @returns {{chain:string, address:string, publicKey:string, envelope:object, authorization:object}}
 */
export function sealChainKey(chain, receiverPk, receiver, authorization = {}) {
  const spec = CHAINS[chain];
  if (!spec) throw new Error(`settlement: unsupported chain ${chain} (have ${SUPPORTED_CHAINS.join(', ')})`);
  if (!receiver) throw new Error('settlement: a receiver XMBL address is required — it is bound into the AAD');
  if (!authorization || !authorization.contract) {
    // ⛔ FAIL CLOSED ON AN UNBOUND SEAL. An envelope with no authorization in its AAD is a key release
    // that no XMBL decision gates, which is the one thing this module exists to prevent.
    throw new Error('settlement: authorization.contract is required — an envelope not bound to an authorizing contract is an ungated key release');
  }
  const { sk, pub } = newKey(chain);
  const meta = { ...authorization, chain, address: spec.address(pub) };
  const envelope = sealSecret(receiverPk, Buffer.from(sk), { receiver, meta });
  return { chain, address: meta.address, publicKey: hex(pub), envelope, authorization: meta };
}

/**
 * OPEN a sealed account key and SIGN a payload the settling chain will accept. Only the holder of the
 * payee's XMBL secret key can do this — that is the enforcement, and it is cryptographic rather than
 * procedural, which is why it needs no cooperation from the settling chain.
 *
 * Returns the signature in the chain's own encoding PLUS the address it signs for, so a caller can check
 * the release landed on the account it funded instead of assuming it.
 */
export function releaseAndSign(chain, receiverSk, envelope, payload) {
  const spec = CHAINS[chain];
  if (!spec) throw new Error(`settlement: unsupported chain ${chain} (have ${SUPPORTED_CHAINS.join(', ')})`);
  const sk = u8(openSecret(receiverSk, envelope));
  const pub = spec.curve === 'ed25519' ? ed25519.getPublicKey(sk) : secp256k1.getPublicKey(sk, spec.compressed !== false);
  const msg = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : u8(payload);
  return { chain, address: spec.address(pub), publicKey: hex(pub), signature: spec.sign(msg, sk), digest: hex(spec.digest(msg)) };
}

/** Verify a release the way the settling chain would. Separate from the signing so a checker never needs the secret. */
export function verifyRelease(chain, payload, signature, publicKey) {
  const spec = CHAINS[chain];
  if (!spec) throw new Error(`settlement: unsupported chain ${chain}`);
  const msg = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : u8(payload);
  return spec.verify(msg, signature, Buffer.from(publicKey, 'hex'));
}

/** The address a public key settles to on a given chain — derivation only, no key material involved. */
export function chainAddress(chain, publicKey) {
  const spec = CHAINS[chain];
  if (!spec) throw new Error(`settlement: unsupported chain ${chain}`);
  return spec.address(typeof publicKey === 'string' ? Buffer.from(publicKey, 'hex') : u8(publicKey));
}
