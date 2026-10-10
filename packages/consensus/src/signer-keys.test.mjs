// A CARRIED KEY IS KEPT ONLY WHEN IT DERIVES TO ITS ADDRESS. A raw tx travels with its signer's key so a node can
// check the signature before the signer's presence arrives; whoever relayed it could have put any key there, so
// the key is kept only if it hashes to the address it is offered for. Pinned here with real MAYO identities: the
// signer's own key is kept, another identity's key is refused, a key that is not even base64 is refused without a
// throw, a known key costs no second hash, and the map keeps at most `max` signers.
// Run: node signer-keys.test.mjs
import assert from 'node:assert';
import { Identity } from '@xmbl/identity';
import { SignerKeys } from './signer-keys.js';

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const alice = await Identity.create(), mallory = await Identity.create(), carol = await Identity.create();
let derives = 0;
const mk = (max) => new SignerKeys({ derive: (pk) => { derives++; return Identity.deriveAddress(pk); }, ...(max ? { max } : {}) });

await check('the signer\'s own key is kept, and a tx signed under it verifies with what was kept', async () => {
  const k = mk();
  assert.strictEqual(k.learn(alice.address, alice.publicKey), true);
  assert.strictEqual(k.get(alice.address), alice.publicKey);
  const tx = await alice.signTransaction({ type: 'anchor', to: 'xmb' + '0'.repeat(40), amount: 1, ts: 7 });
  assert.strictEqual(await Identity.verifyTransaction(tx, k.get(tx.from)), true);
});

await check('another identity\'s key offered for the address is refused, and the kept key stays', () => {
  const k = mk();
  k.learn(alice.address, alice.publicKey);
  assert.strictEqual(k.learn(alice.address, mallory.publicKey), false);
  assert.strictEqual(k.get(alice.address), alice.publicKey);
  assert.strictEqual(k.refused, 1);
  assert.strictEqual(mk().learn(alice.address, mallory.publicKey), false);
});

await check('a key that is not base64, or no key, is refused without a throw', () => {
  const k = mk();
  assert.strictEqual(k.learn(alice.address, '%%%not base64%%%'), false);
  assert.strictEqual(k.learn(alice.address, ''), false);
  assert.strictEqual(k.learn(alice.address, null), false);
  assert.strictEqual(k.learn(['xmbPayer'], alice.publicKey), false);
  assert.strictEqual(k.size, 0);
  assert.strictEqual(k.get(alice.address), null);
});

await check('a key already kept for its address costs no second hash', () => {
  const k = mk();
  k.learn(alice.address, alice.publicKey);
  const before = derives;
  for (let i = 0; i < 100; i++) k.learn(alice.address, alice.publicKey);
  assert.strictEqual(derives - before, 0);
});

await check('at most max signers are kept, the oldest out first', () => {
  const k = mk(2);
  k.learn(alice.address, alice.publicKey);
  k.learn(mallory.address, mallory.publicKey);
  k.learn(carol.address, carol.publicKey);
  assert.strictEqual(k.size, 2);
  assert.strictEqual(k.get(alice.address), null);
  assert.strictEqual(k.get(carol.address), carol.publicKey);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
