// CHAIN-AGNOSTIC SETTLEMENT — Solana, EVM, Sui and Bitcoin, each proven the way that chain would check it.
//
// The operator's ruling: value stays under the control of KEYS and XMBL enforces who the key releases to.
// The claim that buys is "one mechanism settles anywhere", and a claim like that is worth exactly as much
// as the weakest chain it was actually run against. So every chain here is exercised end to end — mint,
// seal, refuse the wrong opener, release, sign, verify — and the address derivations are checked against
// KNOWN-ANSWER VECTORS from the real chains rather than against this module's own output, because a
// derivation that only agrees with itself will happily send a payout into the void.
import assert from 'node:assert';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  sealChainKey, releaseAndSign, verifyRelease, chainAddress,
  CHAINS, SUPPORTED_CHAINS, base58, bech32, sealKeyPair,
} from '../index.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const check = (n, f) => { try { f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log(`FAIL ${n}\n       ${e.message}`); } };

// A payout the XMBL charter authorized. One shape, four chains — that IS the chain-agnostic claim.
const AUTHZ = { contract: 'c0ffee1234567890', method: 'payout', payout_id: 'p-0007', amount: '250000', asset: 'USDC' };
const payloadFor = (chain) => JSON.stringify({ chain, to: 'PAYEE', amount: '250000', nonce: 7, memo: AUTHZ.payout_id });

// ── 0. KNOWN-ANSWER VECTORS — the encodings, checked against the chains themselves ─────────────────
//
// base58, bech32 and the four address derivations are the only places a silent bug sends money nowhere.
// Each of these values comes from the chain's own spec or a published test vector, not from this code.

check('base58 matches published vectors, leading zero bytes included', () => {
  assert.strictEqual(base58(Buffer.from('', 'hex')), '1');
  assert.strictEqual(base58(Buffer.from('61', 'hex')), '2g');
  assert.strictEqual(base58(Buffer.from('626262', 'hex')), 'a3gV');
  assert.strictEqual(base58(Buffer.from('516b6fcd0f', 'hex')), 'ABnLTmg');
  // A leading zero byte MUST render as '1', or a key beginning 0x00 silently shortens by a character and
  // the payout address is a different account. This is the canonical base58check payload+checksum vector.
  assert.strictEqual(base58(Buffer.from('00010966776006953D5567439E5E39F86A0D273BEED61967F6', 'hex')), '16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM');
  // TWO leading zero bytes render as TWO '1's — the rule is per byte, not "one prefix".
  assert.strictEqual(base58(Buffer.from('0000010966776006953D5567439E5E39F86A0D273BEED61967F6', 'hex')), '116UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM');
});

check('bech32 P2WPKH matches the BIP-173 test vector', () => {
  // BIP-173: witness v0 keyhash 751e76e8199196d454941c45d1b3a323f1433bd6 → bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4
  assert.strictEqual(
    bech32('bc', 0, Buffer.from('751e76e8199196d454941c45d1b3a323f1433bd6', 'hex')),
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
});

check('EVM address derivation matches the canonical keypair vector', () => {
  // The secp256k1 key 0x4646…4646 is Vitalik's EIP-155 example key; its address is published with it.
  const sk = Buffer.from('4646464646464646464646464646464646464646464646464646464646464646', 'hex');
  const pub = secp256k1.getPublicKey(new Uint8Array(sk), false);   // uncompressed, as EVM derives from
  assert.strictEqual(chainAddress('evm', Buffer.from(pub)), '0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f');
});

check('Bitcoin P2WPKH address derivation matches the BIP-84 vector', () => {
  // BIP-84 account 0, first receiving key — pubkey and address are both published in the BIP.
  const pub = Buffer.from('0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c', 'hex');
  assert.strictEqual(chainAddress('bitcoin', pub), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
});

check('Solana address IS the base58 of the ed25519 public key', () => {
  // The all-ones 32-byte key is the documented System Program-adjacent vector; base58 of it is fixed.
  const pub = Buffer.alloc(32, 1);
  assert.strictEqual(chainAddress('solana', pub), base58(pub));
  assert.strictEqual(chainAddress('solana', pub), '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi');
});

check('Sui address is blake2b-256 over the 0x00 scheme flag || pubkey', () => {
  const pub = Buffer.alloc(32, 0);
  const a = chainAddress('sui', pub);
  assert.match(a, /^0x[0-9a-f]{64}$/, 'a Sui address is a 32-byte hex id');
  // It must NOT be the bare key hash — the scheme flag is what stops two schemes colliding on one address.
  assert.notStrictEqual(a, '0x' + Buffer.from(blake2b(new Uint8Array(pub), { dkLen: 32 })).toString('hex'));
  assert.strictEqual(a, '0x' + Buffer.from(blake2b(Uint8Array.from([0, ...pub]), { dkLen: 32 })).toString('hex'));
});

// ── 1. EVERY CHAIN, END TO END ─────────────────────────────────────────────────────────────────────
ok('all four chains the operator named are supported',
  ['solana', 'evm', 'sui', 'bitcoin'].every((c) => SUPPORTED_CHAINS.includes(c)) && SUPPORTED_CHAINS.length === 4);

for (const chain of ['solana', 'evm', 'sui', 'bitcoin']) {
  const payee = sealKeyPair();
  const stranger = sealKeyPair();
  const payload = payloadFor(chain);

  const minted = sealChainKey(chain, payee.pk, 'xmbPAYEE', AUTHZ);
  ok(`${chain}: sealChainKey returns an address to fund and an envelope, and NO secret`,
    typeof minted.address === 'string' && minted.address.length > 0 && !!minted.envelope
    && !('privateKey' in minted) && !('secret' in minted) && !('sk' in minted));
  ok(`${chain}: the address is derived from the minted public key, not invented`,
    minted.address === chainAddress(chain, minted.publicKey));

  // ENFORCEMENT: only the named payee can open it. This is the whole guarantee.
  let strangerOpened = true;
  try { releaseAndSign(chain, stranger.sk, minted.envelope, payload); } catch { strangerOpened = false; }
  ok(`${chain}: a stranger CANNOT open the envelope — the release is the enforcement`, strangerOpened === false);

  const released = releaseAndSign(chain, payee.sk, minted.envelope, payload);
  ok(`${chain}: the payee releases the key and it settles to the SAME address that was funded`,
    released.address === minted.address);
  ok(`${chain}: the signature verifies the way ${chain} would check it`,
    verifyRelease(chain, payload, released.signature, released.publicKey) === true);

  // A signature over a DIFFERENT payload must not verify — otherwise "authorized this payout" is vacuous.
  ok(`${chain}: the signature does NOT verify against a tampered payload`,
    verifyRelease(chain, payload.replace('250000', '999999'), released.signature, released.publicKey) === false);

  // The envelope's AAD binds the authorization: a tampered claim fails the GCM tag rather than
  // decrypting to a different meaning.
  const forged = { ...minted.envelope, meta: { ...minted.envelope.meta, amount: '999999' } };
  let forgedOpened = true;
  try { releaseAndSign(chain, payee.sk, forged, payload); } catch { forgedOpened = false; }
  ok(`${chain}: re-presenting the envelope as a DIFFERENT payout fails the AAD`, forgedOpened === false);
}

// ── 2. THE CHAIN-SPECIFIC BITS ARE REALLY CHAIN-SPECIFIC ───────────────────────────────────────────
check('each chain signs a DIFFERENT digest of the same bytes — the encoding is not cosmetic', () => {
  const msg = Buffer.from('settle me');
  const digests = new Set(['solana', 'evm', 'sui', 'bitcoin'].map((c) => Buffer.from(CHAINS[c].digest(msg)).toString('hex')));
  assert.strictEqual(digests.size, 4, 'four chains, four digests');
  // EVM signs keccak256, not sha256 — the single most common way to produce a signature no node accepts.
  assert.strictEqual(Buffer.from(CHAINS.evm.digest(msg)).toString('hex'), Buffer.from(keccak_256(new Uint8Array(msg))).toString('hex'));
  // Bitcoin signs the DOUBLE sha256.
  const d1 = createHash('sha256').update(msg).digest();
  assert.strictEqual(Buffer.from(CHAINS.bitcoin.digest(msg)).toString('hex'), createHash('sha256').update(d1).digest('hex'));
  // Solana signs the message itself.
  assert.strictEqual(Buffer.from(CHAINS.solana.digest(msg)).toString('hex'), msg.toString('hex'));
});

check('the signature ENCODINGS are the ones each chain accepts', () => {
  const msg = Buffer.from(payloadFor('x'));
  const skK = secp256k1.utils.randomSecretKey();
  const evm = CHAINS.evm.sign(msg, skK);
  assert.match(evm.r, /^[0-9a-f]{64}$/); assert.match(evm.s, /^[0-9a-f]{64}$/);
  assert.ok(evm.v === 27 || evm.v === 28, 'ecrecover takes v of 27 or 28');
  const btc = CHAINS.bitcoin.sign(msg, skK);
  assert.strictEqual(Buffer.from(btc.der, 'hex')[0], 0x30, 'a Bitcoin signature is DER, which starts 0x30');
  const seed = new Uint8Array(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' })).slice(-32);
  assert.strictEqual(Buffer.from(CHAINS.solana.sign(msg, seed).sig, 'hex').length, 64, 'an ed25519 signature is 64 bytes');
  const sui = CHAINS.sui.sign(msg, seed);
  const ser = Buffer.from(sui.serialized, 'hex');
  assert.strictEqual(ser.length, 1 + 64 + 32, 'a Sui signature serializes as flag || sig || pubkey');
  assert.strictEqual(ser[0], 0x00, 'flag 0x00 is ed25519');
  assert.ok(ed25519.verify(ser.subarray(1, 65), CHAINS.sui.digest(msg), ser.subarray(65)), 'and the serialized parts agree');
});

// ── 3. FAIL CLOSED ─────────────────────────────────────────────────────────────────────────────────
check('an UNBOUND seal is refused — a key release no XMBL decision gates is the one thing this prevents', () => {
  const payee = sealKeyPair();
  assert.throws(() => sealChainKey('evm', payee.pk, 'xmbPAYEE', {}), /authorization\.contract is required/);
  assert.throws(() => sealChainKey('evm', payee.pk, 'xmbPAYEE'), /authorization\.contract is required/);
});
check('a seal with no receiver is refused — the receiver is bound into the AAD', () => {
  const payee = sealKeyPair();
  assert.throws(() => sealChainKey('evm', payee.pk, '', AUTHZ), /receiver/);
});
check('an unsupported chain is refused by NAME, listing what is supported', () => {
  const payee = sealKeyPair();
  assert.throws(() => sealChainKey('dogecoin', payee.pk, 'xmbPAYEE', AUTHZ), /unsupported chain dogecoin/);
  assert.throws(() => chainAddress('dogecoin', Buffer.alloc(32)), /unsupported chain dogecoin/);
});

// ── 4. ⛔ THE RESIDUAL TRUST, STATED AS A TEST SO IT CANNOT BE FORGOTTEN ────────────────────────────
check('⛔ the guarantee is "only the payee can OPEN", never "only the payee can MOVE"', () => {
  // sealChainKey mints the key itself and returns no secret, which is the strongest freshness this
  // module can enforce — but nothing here, and nothing on any settling chain, can prove the funding
  // party did not retain a copy of a key it supplied instead. So the mitigation is procedural and must
  // be stated: mint per payout via THIS function, fund with exactly the payout amount.
  const payee = sealKeyPair();
  const minted = sealChainKey('evm', payee.pk, 'xmbPAYEE', AUTHZ);
  assert.deepStrictEqual(Object.keys(minted).sort(), ['address', 'authorization', 'chain', 'envelope', 'publicKey']);
  // Two mints for the SAME payout must not collide on one account — a reused address is a reused key.
  const again = sealChainKey('evm', payee.pk, 'xmbPAYEE', AUTHZ);
  assert.notStrictEqual(minted.address, again.address, 'every mint is a fresh account');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
