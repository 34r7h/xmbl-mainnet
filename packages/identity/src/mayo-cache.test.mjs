// ONE MAYO MODULE PER SCHEME, ONE VERIFY PER SIGNATURE. Every sign and every verify used to instantiate a fresh
// Emscripten module, and a node verified the same signed tx at the door, at validation, at finalize and at the
// ledger. Measured on a 2-node fleet (scripts/fleet-load.mjs, 500 node-signed datums): 0.56 s in load, 1.96 s
// in verify, 0.95 s in sign, plus the garbage. Pinned here: the module is instantiated once however many
// signatures go through it, the answers are the ones a fresh module gives, and a repeated verify is a lookup
// that returns the same answer — for a refusal as well as an acceptance.
// Run: node mayo-cache.test.mjs
import assert from 'node:assert';
process.env.XMBL_VERIFY_MEMO_MAX = '8';
const { MAYOWasm } = await import('./wasm-wrapper.js');
const { sign, verify, verifyStats } = await import('./signer.js');
const { Identity } = await import('./identity.js');

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const enc = (s) => new TextEncoder().encode(s);

const a = await Identity.create();
const b = await Identity.create();

await check('two keygens on the one module give two different keypairs', () => {
  assert.notStrictEqual(a.publicKey, b.publicKey);
  assert.notStrictEqual(a.privateKey, b.privateKey);
});

await check('load returns the same instance every time', async () => {
  const [x, y] = await Promise.all([MAYOWasm.load(), MAYOWasm.load()]);
  assert.strictEqual(x, y);
  assert.strictEqual(await MAYOWasm.load('mayo'), x);
});

await check('40 signs and 80 verifies instantiate one module', async () => {
  for (let i = 0; i < 40; i++) {
    const m = enc(`msg-${i}`);
    const s = await sign(m, a.privateKey);
    assert.strictEqual(await verify(m, s, a.publicKey), true);
    assert.strictEqual(await verify(enc(`other-${i}`), s, a.publicKey), false);
  }
  assert.strictEqual(MAYOWasm.instantiations, 1);
});

await check('an unknown scheme rejects, is not cached, and leaves the mayo module alone', async () => {
  await assert.rejects(() => MAYOWasm.load('no-such-scheme'));
  await assert.rejects(() => MAYOWasm.load('no-such-scheme'));
  assert.strictEqual(MAYOWasm.instantiations, 1);
});

const m = enc('pay 5 to bob');
const sigA = await sign(m, a.privateKey);
const sigB = await sign(m, b.privateKey);
const tampered = Buffer.from(sigA, 'base64'); tampered[7] ^= 1;
const sigT = tampered.toString('base64');
const cases = [
  ['the signer\'s own key', m, sigA, a.publicKey, true],
  ['the wrong key', m, sigA, b.publicKey, false],
  ['the other signer\'s signature', m, sigB, a.publicKey, false],
  ['a flipped signature byte', m, sigT, a.publicKey, false],
  ['another message', enc('pay 6 to bob'), sigA, a.publicKey, false],
];

await check('the memo answers what a fresh verify answers, first time and repeat', async () => {
  for (const [name, msg, sig, pk, want] of cases) {
    const fresh = (await MAYOWasm._instantiate('mayo')).verifySync(msg, sig, pk);
    assert.strictEqual(fresh, want, `${name}: a fresh module says ${fresh}`);
    const before = verifyStats();
    assert.strictEqual(await verify(msg, sig, pk), want, `${name}: first`);
    const mid = verifyStats();
    assert.strictEqual(await verify(msg, sig, pk), want, `${name}: repeat`);
    const after = verifyStats();
    assert.strictEqual(after.hits - mid.hits, 1, `${name}: the repeat was not a lookup`);
    assert.ok(mid.misses - before.misses <= 1);
  }
});

await check('the memo keeps at most XMBL_VERIFY_MEMO_MAX entries', async () => {
  for (let i = 0; i < 20; i++) await verify(enc(`fill-${i}`), sigA, a.publicKey);
  assert.strictEqual(verifyStats().size, 8);
  // The oldest went first: the earliest case is a miss again, and still the same answer.
  const before = verifyStats().misses;
  assert.strictEqual(await verify(m, sigA, a.publicKey), true);
  assert.strictEqual(verifyStats().misses - before, 1);
});

await check('a signed tx verifies through Identity.verifyTransaction, and a re-addressed copy does not', async () => {
  const tx = await a.signTransaction({ to: 'xmb' + '0'.repeat(40), amount: 1, ts: 1 });
  assert.strictEqual(await Identity.verifyTransaction(tx, a.publicKey), true);
  assert.strictEqual(await Identity.verifyTransaction(tx, a.publicKey), true);
  assert.strictEqual(await Identity.verifyTransaction({ ...tx, amount: 2 }, a.publicKey), false);
  assert.strictEqual(await Identity.verifyTransaction(tx, b.publicKey), false);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
