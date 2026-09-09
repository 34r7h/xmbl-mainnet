// Verkle proof soundness under an INDEPENDENT verifier (MAINNET-GATES §@xmbl/state-machine, T8.1).
//
// The existing suite only checks that generateProof() RETURNS something. A proof is worth nothing
// unless a verifier that does NOT share the prover's code can recompute the committed root from it.
// This suite re-implements the check from first principles — only node:crypto, nothing imported from
// verkle-tree.js — so a bug shared by the tree's prover AND its own verifyProof() cannot pass both.
//
// The tree's commitment scheme, restated independently here:
//   leaf hash            = sha256(value canonicalised)            (value node at depth 32)
//   internal node hash   = sha256( concat of 256 child slots, each 32 bytes; empty slot = 32 zeros )
//   a key's nibble at depth d = sha256(key)[d]
// A proof carries, per level, the sibling hashes at that node; the honest verifier fills the key's own
// slot with the hash carried up from below and every other slot from the siblings (or zeros), hashes,
// and repeats to the root. The proof is SOUND iff the reconstructed root equals the tree's real root —
// which the verifier learns independently (tree.getRoot()), never from the attacker-supplied proof.root.
// Run: node verkle-independent-verify.test.mjs
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { VerkleStateTree } from './verkle-tree.js';

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };

// ---- INDEPENDENT verifier — a second implementation, sharing no code with the tree ----------------
const sha256 = (buf) => createHash('sha256').update(buf).digest();
const indepHashKey = (key) => sha256(key);
const indepHashValue = (value) => sha256(typeof value === 'string' ? value : JSON.stringify(value));

// Reconstruct the root committed by (key, value, proof.path) from scratch. Returns hex.
function indepReconstructRoot(key, value, proof) {
  const keyHash = indepHashKey(key);
  let acc = indepHashValue(value);                          // the leaf: hash of the value
  // Fold levels deepest-first, using each level's OWN declared depth to pick the key's nibble.
  const levels = [...proof.path].sort((a, b) => b.depth - a.depth);
  for (const level of levels) {
    const nibble = keyHash[level.depth];
    const slots = [];
    for (let j = 0; j < 256; j++) {
      if (j === nibble) { slots.push(acc); continue; }
      const sib = (level.siblings || []).find((s) => s.nibble === j);
      slots.push(sib ? Buffer.from(sib.hash, 'hex') : Buffer.alloc(32));
    }
    acc = sha256(Buffer.concat(slots));
  }
  return acc.toString('hex');
}

// SOUND check: the proof must reconstruct the KNOWN-GOOD root, learned independently of the proof.
const indepVerify = (key, value, proof, trustedRoot) => indepReconstructRoot(key, value, proof) === trustedRoot;

// ---- fixtures --------------------------------------------------------------------------------------
async function treeWith(entries) {
  const t = new VerkleStateTree();                          // in-memory, no db
  for (const [k, v] of entries) await t.insert(k, v);
  return t;
}
const ENTRIES = [
  ['account:xmbA', { balance: 100, nonce: 1 }],
  ['account:xmbB', { balance: 42, nonce: 7 }],
  ['contract:c1', { code: 'deadbeef', slots: 3 }],
  ['anchor:task.created:zzz', 'sealed'],
];

// ---- 0. completeness — a valid proof reconstructs the real root under the independent verifier ------
await check('single-key tree: a valid proof independently reconstructs the real root', async () => {
  const t = await treeWith([['solo:key', { v: 1 }]]);
  const proof = t.generateProof('solo:key');
  const realRoot = t.getRoot();
  // independent path
  assert.strictEqual(indepReconstructRoot('solo:key', { v: 1 }, proof), realRoot, 'independent reconstruction != real root');
  assert.strictEqual(indepVerify('solo:key', { v: 1 }, proof, realRoot), true, 'independent verify rejected a valid proof');
  // and the tree agrees (cross-check, not the source of truth)
  assert.strictEqual(VerkleStateTree.verifyProof('solo:key', { v: 1 }, proof), true, 'built-in verify rejected a valid proof');
});

await check('multi-key tree: every present key verifies independently against the real root', async () => {
  const t = await treeWith(ENTRIES);
  const realRoot = t.getRoot();
  for (const [k, v] of ENTRIES) {
    const proof = t.generateProof(k);
    assert.strictEqual(indepVerify(k, v, proof, realRoot), true, `independent verify failed for ${k}`);
    assert.strictEqual(VerkleStateTree.verifyProof(k, v, proof), true, `built-in verify failed for ${k}`);
    assert.strictEqual(proof.root, realRoot, `proof.root != real root for ${k}`);
  }
});

// ---- 1. soundness — the independent verifier REJECTS every tamper ----------------------------------
await check('tampered VALUE: the same proof does not verify for a different value', async () => {
  const t = await treeWith(ENTRIES);
  const proof = t.generateProof('account:xmbA');
  assert.strictEqual(indepVerify('account:xmbA', { balance: 999, nonce: 1 }, proof, t.getRoot()), false,
    'a proof verified for a value it does not commit to');
});

await check('tampered KEY: a proof for one key does not verify for another', async () => {
  const t = await treeWith(ENTRIES);
  const proof = t.generateProof('account:xmbA');
  // Verify the SAME proof/value but under a different key — the nibble path changes.
  assert.strictEqual(indepVerify('account:xmbB', { balance: 100, nonce: 1 }, proof, t.getRoot()), false,
    'a proof verified under the wrong key');
});

await check('tampered ROOT binding: a valid proof does not verify against the WRONG root', async () => {
  const t = await treeWith(ENTRIES);
  const other = await treeWith([['unrelated', 'x']]);
  const proof = t.generateProof('contract:c1');
  // Correct value + correct proof, but checked against a root the proof was not built for.
  assert.strictEqual(indepVerify('contract:c1', { code: 'deadbeef', slots: 3 }, proof, other.getRoot()), false,
    'a proof verified against an unrelated root');
  // And a proof that lies about its own root cannot move the independent verdict — we bind to the real root.
  const forged = { ...proof, root: '0'.repeat(64) };
  assert.strictEqual(indepVerify('contract:c1', { code: 'deadbeef', slots: 3 }, forged, t.getRoot()), true,
    'forging proof.root should not matter: the independent verifier ignores it and binds to the real root');
});

await check('tampered SIBLING: corrupting a carried sibling hash breaks reconstruction', async () => {
  const t = await treeWith(ENTRIES);
  const proof = t.generateProof('account:xmbA');
  // find a level that actually carries a sibling (depth 0 does, since keys diverge on the first byte)
  const lvl = proof.path.find((p) => (p.siblings || []).length > 0);
  assert.ok(lvl, 'expected at least one sibling in a multi-key proof');
  const tampered = JSON.parse(JSON.stringify(proof));
  const tl = tampered.path.find((p) => p.depth === lvl.depth);
  tl.siblings[0].hash = 'f'.repeat(64);                     // flip a sibling hash
  assert.strictEqual(indepVerify('account:xmbA', { balance: 100, nonce: 1 }, tampered, t.getRoot()), false,
    'a corrupted sibling still verified');
  assert.strictEqual(VerkleStateTree.verifyProof('account:xmbA', { balance: 100, nonce: 1 }, tampered), false,
    'built-in also should reject a corrupted sibling');
});

await check('spliced proof: keyA proof cannot certify keyB (key/value/proof must agree)', async () => {
  const t = await treeWith(ENTRIES);
  const proofA = t.generateProof('account:xmbA');
  assert.strictEqual(indepVerify('contract:c1', { code: 'deadbeef', slots: 3 }, proofA, t.getRoot()), false,
    'keyA proof certified keyB');
});

// ---- 2. the independent verifier tracks the real tree as it changes --------------------------------
await check('after a mutation, an OLD proof no longer verifies against the NEW root', async () => {
  const t = await treeWith(ENTRIES);
  const proof = t.generateProof('account:xmbB');
  assert.strictEqual(indepVerify('account:xmbB', { balance: 42, nonce: 7 }, proof, t.getRoot()), true);
  await t.insert('account:xmbC', { balance: 1, nonce: 0 });  // root moves
  assert.strictEqual(indepVerify('account:xmbB', { balance: 42, nonce: 7 }, proof, t.getRoot()), false,
    'a stale proof verified against a changed root');
  // a fresh proof against the new root verifies again
  const fresh = t.generateProof('account:xmbB');
  assert.strictEqual(indepVerify('account:xmbB', { balance: 42, nonce: 7 }, fresh, t.getRoot()), true);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
