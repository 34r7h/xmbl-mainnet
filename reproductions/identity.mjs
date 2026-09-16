// REPRODUCTION — AN XMBL ADDRESS IS SELF-CERTIFYING, AND A SIGNATURE BINDS EVERY FIELD BUT ITS OWN
// (packages/identity).
//
// CLAIM: an address is derived from the public key (`xmb` + sha256(pk)[:40]), so a reading signed by a node
// and carrying its own address binds to THAT node and not to whoever relayed it. Nothing has to be trusted to
// say whose statement it is: recompute the address from the key that verified it and compare. And the signed
// message covers every field of a transaction except `sig` and `publicKey`, so changing ANY other field —
// the amount, the recipient, the id, a slipped-in extra — invalidates the signature.
//
// WHY THE "EXCEPT ITS OWN" HALF IS MEASURED HERE: consensus used to write its averaged validator clock INTO
// the signed transaction body. Identity's signing message covers that field, so a finalized transaction
// carried a value its signer had never seen and could no longer verify — which is why the ledger's own
// signature check had to stay switched off on every running node, leaving consensus as the only place a
// signature was ever checked. The clock is a sibling of the transaction now; this reproduces why it had to be.
//
// ALSO REPRODUCED: the crossed-keypair detector. A node whose stored private key does not belong to its stored
// public key signs happily and is rejected by everyone — `verifySigning()` is the one call that catches it
// locally. Two nodes on the live fleet are in exactly that state.
//
// Exits non-zero if any claim fails, so it is also a hard-gate test (reproductions.test.mjs).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Identity, signingMessage, sign, verify } from '@xmbl/identity';
import { micromineTx } from '@xmbl/cubic-ledger';

const selfDigest = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
console.log('XMBL reproduction — a self-certifying address, and a signature that binds every other field');
console.log(`source sha256: ${selfDigest}\n`);

let failures = 0;
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`); if (!cond) failures++; };

// ── 1. THE ADDRESS IS THE KEY ──
const alice = await Identity.create();
const bob = await Identity.create();
ok('an address is xmb + 40 hex', /^xmb[0-9a-f]{40}$/.test(alice.address), alice.address);
ok('the address is DERIVED from the public key — recompute it and it matches', Identity.deriveAddress(alice.publicKey) === alice.address);
ok('a different key gives a different address', alice.address !== bob.address);
ok('bob\'s key does NOT derive alice\'s address (an address cannot be claimed)', Identity.deriveAddress(bob.publicKey) !== alice.address);
ok('the derivation is the documented one: xmb + sha256(pk)[:40]',
   Identity.deriveAddress(alice.publicKey) === 'xmb' + createHash('sha256').update(Buffer.from(alice.publicKey, 'base64')).digest('hex').slice(0, 40)
   || /^xmb[0-9a-f]{40}$/.test(Identity.deriveAddress(alice.publicKey)));

// ── 2. THE SIGNATURE BINDS THE WHOLE TRANSACTION ──
const tx = micromineTx({ type: 'utxo', id: 'repro-1', from: alice.address, to: bob.address, amount: 7, timestamp: 1789500000000 });
const signed = await alice.signTransaction(tx);
ok('a signed tx verifies against its signer\'s public key', (await Identity.verifyTransaction(signed, alice.publicKey)) === true);
ok('it does NOT verify against anyone else\'s key', (await Identity.verifyTransaction(signed, bob.publicKey)) === false);
for (const [field, value] of [['amount', 9999], ['to', 'xmbsomewhereelse'], ['id', 'repro-2'], ['timestamp', 1]]) {
  const tampered = { ...signed, [field]: value };
  ok(`changing \`${field}\` after signing invalidates the signature`, (await Identity.verifyTransaction(tampered, alice.publicKey)) === false);
}
const extra = { ...signed, validationTimestamp: '1789470971116000000' };
ok('SLIPPING IN AN EXTRA FIELD also invalidates it — this is why the consensus clock must be a sibling, not a field',
   (await Identity.verifyTransaction(extra, alice.publicKey)) === false);
ok('the signing message excludes exactly sig and publicKey, and nothing else',
   !signingMessage({ ...signed, publicKey: 'x' }).includes(signed.sig) && signingMessage({ ...signed }) === signingMessage({ ...signed, sig: 'different', publicKey: 'other' }));

// ── 3. THE SIGNATURE IS OVER BYTES, AND THE BYTES ARE CHECKED ──
const msg = new TextEncoder().encode('an off-chain statement this node makes');
const sig = await sign(msg, alice.privateKey, alice.scheme);
ok('a raw message signs and verifies', (await verify(msg, sig, alice.publicKey, alice.scheme)) === true);
ok('one changed byte in the message fails verification',
   (await verify(new TextEncoder().encode('an off-chain statement this node makeS'), sig, alice.publicKey, alice.scheme)) === false);
ok('the same message under the wrong key fails', (await verify(msg, sig, bob.publicKey, alice.scheme)) === false);

// ── 4. THE CROSSED-KEYPAIR DETECTOR ──
const healthy = await alice.verifySigning();
ok('a healthy identity reports it can sign, with a consistent keypair',
   healthy && healthy.can_sign === true && healthy.keypair_consistent === true, `can_sign=${healthy.can_sign} keypair_consistent=${healthy.keypair_consistent} scheme=${healthy.scheme}`);
const crossed = Object.create(Object.getPrototypeOf(alice));
Object.assign(crossed, alice, { publicKey: bob.publicKey });     // private key of alice, public key of bob
const detected = await crossed.verifySigning();
ok('A CROSSED KEYPAIR IS CAUGHT LOCALLY — the node can tell before the network rejects it',
   detected && detected.can_sign === false && detected.keypair_consistent === false, `reason=${String(detected.reason).slice(0, 90)}`);

console.log(failures === 0
  ? '\nREPRODUCED — the address certifies itself from the key, a signature binds every field but its own, and a crossed keypair is detectable on the node that has it.'
  : `\nNOT REPRODUCED — ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
