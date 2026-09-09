// seal conformance — hybrid PQ envelope encryption to an XMBL identity.
// The property is CONFIDENTIALITY + BINDING: only the named receiver's LWE key opens it, a
// wrong key fails, and tampering with the ciphertext, the receiver, or the bound metadata
// fails the GCM tag rather than decrypting to something else.
// Run: node seal.test.mjs
import assert from 'node:assert';
import { keyGen as cubicLweKeyGen, MAINNET_N } from './cubic-lwe.js';
import { sealSecret, openSecret, sealKeyPair } from './seal.js';

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ok  ', n); pass++; };
const throws = (n, f) => { let t = false; try { f(); } catch { t = true; } ok(n, t); };

// A realistic secret: a 32-byte EVM private key that controls a funded USDC account.
const EVM_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

// A value-bearing seal MUST ride the mainnet lattice (N=729) — sealKeyPair mints there by default.
// (0) a seal to the TOY ring (N=27) is REFUSED, so "post-quantum settlement" can't be a false claim.
{
  const toy = cubicLweKeyGen(); // default N=27 — no quantum margin
  ok('sealKeyPair mints at the mainnet lattice', sealKeyPair().pk.n === MAINNET_N);
  throws('sealing value to a toy N=27 ring is refused', () => sealSecret(toy.pk, EVM_KEY, { receiver: 'xmbR' }));
  const weakEnv = sealSecret(toy.pk, EVM_KEY, { receiver: 'xmbR', allowWeak: true });
  ok('an explicit allowWeak demo seal is stamped weak:true', weakEnv.weak === true);
  ok('a mainnet seal carries no weak stamp', sealSecret(sealKeyPair().pk, EVM_KEY, { receiver: 'xmbR' }).weak === undefined);
}

// (1) round-trip: the named receiver recovers the exact secret
{
  const receiver = sealKeyPair();
  const env = sealSecret(receiver.pk, EVM_KEY, { receiver: 'xmbRECEIVER', meta: { asset: 'USDC', amount: '2.50', evm_from: '0xabc' } });
  ok('envelope is JSON-safe (no bigints leak)', JSON.parse(JSON.stringify(env)).ct === env.ct);
  ok('envelope carries no plaintext', !JSON.stringify(env).includes(EVM_KEY.slice(2)));
  const opened = openSecret(receiver.sk, env);
  ok('receiver recovers the exact EVM key', opened.toString('utf8') === EVM_KEY);
}

// (2) a DIFFERENT identity cannot open it
{
  const receiver = sealKeyPair();
  const attacker = sealKeyPair();
  const env = sealSecret(receiver.pk, EVM_KEY, { receiver: 'xmbRECEIVER' });
  // Wrong LWE key either fails the tag or yields garbage ≠ the secret; assert it never returns the secret.
  let leaked = false;
  try { leaked = openSecret(attacker.sk, env).toString('utf8') === EVM_KEY; } catch { leaked = false; }
  ok('a non-receiver key does NOT recover the secret', leaked === false);
}

// (3) tampering is detected (GCM tag), never silently mis-decrypted
{
  const receiver = sealKeyPair();
  const env = sealSecret(receiver.pk, EVM_KEY, { receiver: 'xmbRECEIVER', meta: { amount: '2.50' } });

  const flipCt = { ...env, ct: Buffer.from((() => { const b = Buffer.from(env.ct, 'base64'); b[0] ^= 0xff; return b; })()).toString('base64') };
  throws('a flipped ciphertext byte fails the tag', () => openSecret(receiver.sk, flipCt));

  const reboundMeta = { ...env, meta: { amount: '9999.99' } }; // AAD no longer matches
  throws('rebinding the amount (AAD) fails the tag', () => openSecret(receiver.sk, reboundMeta));

  const reboundReceiver = { ...env, receiver: 'xmbSOMEONEELSE' };
  throws('rebinding the receiver fails the tag', () => openSecret(receiver.sk, reboundReceiver));
}

// (3b) the ring is pinned to the RECEIVER'S key: an envelope whose n/q was altered is rejected,
// never decapsulated under attacker-chosen parameters.
{
  const receiver = sealKeyPair();
  const env = sealSecret(receiver.pk, EVM_KEY, { receiver: 'xmbR' });
  throws('an envelope with a shrunk n is rejected (ring pinned to the key)', () => openSecret(receiver.sk, { ...env, n: 27 }));
  throws('an envelope with a swapped q is rejected', () => openSecret(receiver.sk, { ...env, q: '12289' }));
}

// (4) binary secret (a raw 32-byte key, not a hex string) round-trips byte-exact
{
  const receiver = sealKeyPair();
  const raw = Buffer.from('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', 'hex');
  const env = sealSecret(receiver.pk, raw, { receiver: 'xmbR' });
  ok('raw 32-byte secret round-trips byte-exact', Buffer.compare(openSecret(receiver.sk, env), raw) === 0);
}

console.log(`\nPASS — ${pass} checks\n`);
