// THE COMPRESSED TRIE. The state tree used to hold one object per trie level per key — 32 levels, so 14,134
// anchors were 436,927 nodes and about 200 MB of heap, on boxes with under 1 GiB of RAM that were OOMing during
// the coordinator's full rebuild every 90 s. A lone key's single-child chain is now one Leaf that hashes the
// chain on demand. The commitment must not move by one bit: every node in the network has to reach the same
// state_root, and a proof built here has to verify where the old code built it.
//
// Pinned here:
//   1. golden vectors from the uncompressed tree (main 227035c): roots, proofs, keyPaths and shapes over keys
//      that share 0, 1 and 2 leading hash bytes, after inserts, deletes, a replace and a full drain;
//   2. a reference root computed from scratch with nothing from verkle-tree.js, after random inserts, updates
//      and deletes, read at random points so lazy hashing is caught mid-way;
//   3. the heap held per key (the old tree held 12,936 bytes per key at 20,000 keys, this one 434).
// Run: node verkle-compression.test.mjs
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import { VerkleStateTree } from './verkle-tree.js';

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const sha = (b) => createHash('sha256').update(b).digest();
const H = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex');
// `n` keys whose sha256 starts with the same `bytes` bytes, so they share trie nodes that deep.
const sharing = (n, bytes, tag) => {
  const t = sha('anchor-' + tag), out = [];
  for (let i = 0; out.length < n; i++) { const k = `${tag}-${i}`; if (sha(k).subarray(0, bytes).equals(t.subarray(0, bytes))) out.push(k); }
  return out;
};

// ---- reference root, sharing no code with the tree ----
// node at depth 32 = sha256(value); node above = sha256(256 slots x 32 bytes, empty slot zeros); empty = zeros.
const refHashValue = (v) => sha(typeof v === 'string' ? v : JSON.stringify(v));
function refRoot(entries, depth = 0) {
  if (entries.length === 0) return Buffer.alloc(32);
  if (depth === 32) return entries[0][1];
  const groups = new Map();
  for (const e of entries) { const nib = e[0][depth]; if (!groups.has(nib)) groups.set(nib, []); groups.get(nib).push(e); }
  const row = Buffer.alloc(256 * 32);
  for (const [nib, g] of groups) refRoot(g, depth + 1).copy(row, nib * 32);
  return sha(row);
}
const refOf = (state) => refRoot([...state].map(([k, v]) => [sha(k), refHashValue(v)])).toString('hex');

console.log('\n1. golden vectors from the uncompressed tree (main 227035c)');
const GOLDEN = {
  empty: '0000000000000000000000000000000000000000000000000000000000000000',
  all: 'e8068d948d6d5b21417f57eeffb72fb4f568aeb0427f3dab417aaa6010d9dc43',
  proofs: 'e932e62ecd4cbdf00f1bc098ade4da0f1f7bf00f4701a17b6235d04112fe23c7',
  paths: 'fe7697932fd3293e941b752ceffc3718d6bfed5a0df82b0cc2edd450fd08c194',
  shape: '58644a68740e5a532d638ed684ee630b8e382ce56ad9dd90b31748e1f7ccd218',
  odd: '4beab6337cb57c6562e82ee38e1e26f4784b917e8b66caa63193667931e2b0aa',
  oddProofs: '29c3f8bbc63a35c188a075cf6909ac4513f28e9c83b64e304a896208b8ca6fbc',
  replaced: '66013a247584ea58f9f0766274a17502e2f8f053551f1f01cf3ec1582f18624d',
};
const keys = [...Array.from({ length: 200 }, (_, i) => `k${i}`), ...sharing(5, 1, 'one'), ...sharing(4, 2, 'two')];
const t = new VerkleStateTree();
await check('empty root is 32 zero bytes', () => assert.strictEqual(t.getRoot(), GOLDEN.empty));
for (let i = 0; i < keys.length; i++) await t.insert(keys[i], { i });
await check('root over 209 keys', () => assert.strictEqual(t.getRoot(), GOLDEN.all));
await check('every proof, byte for byte', () => assert.strictEqual(H(keys.map((k) => t.generateProof(k))), GOLDEN.proofs));
await check('every keyPath, byte for byte', () => assert.strictEqual(H(keys.map((k) => t.keyPath(k))), GOLDEN.paths));
await check('tree shape, full and depth 3', () => assert.strictEqual(H([t.getTreeShape({ maxDepth: 40, maxNodes: 50000 }), t.getTreeShape({ maxDepth: 3 })]), GOLDEN.shape));
for (let i = 0; i < keys.length; i += 2) await t.delete(keys[i]);
await check('root after deleting every other key', () => assert.strictEqual(t.getRoot(), GOLDEN.odd));
await check('proofs after the deletes (collapsed chains)', () => assert.strictEqual(H(keys.filter((_, i) => i % 2).map((k) => t.generateProof(k))), GOLDEN.oddProofs));
await t.insert(keys[1], 'replaced');
await check('root after replacing a value', () => assert.strictEqual(t.getRoot(), GOLDEN.replaced));
for (const k of keys) await t.delete(k);
await check('root after deleting everything is empty again', () => assert.strictEqual(t.getRoot(), GOLDEN.empty));

console.log('\n2. random inserts, updates and deletes against a from-scratch root');
await check('1500 ops over 40 keys sharing 0-2 leading bytes, root read at random points', async () => {
  const pool = [...Array.from({ length: 26 }, (_, i) => `r${i}`), ...sharing(8, 1, 'r1'), ...sharing(6, 2, 'r2')];
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const tree = new VerkleStateTree();
  let compared = 0;
  for (let step = 0; step < 1500; step++) {
    const k = pool[Math.floor(rnd() * pool.length)];
    if (rnd() < 0.55) await tree.insert(k, { v: Math.floor(rnd() * 3) }); else await tree.delete(k);
    if (rnd() < 0.1) { assert.strictEqual(tree.getRoot(), refOf(tree.state), `root differs at op ${step}`); compared++; }
  }
  assert.strictEqual(tree.getRoot(), refOf(tree.state));
  assert.ok(compared > 100, `only ${compared} comparisons`);
});
await check('insertion order does not change the root', async () => {
  const pool = [...sharing(6, 1, 'o1'), ...sharing(4, 2, 'o2'), 'a', 'b', 'c'];
  const a = new VerkleStateTree(), b = new VerkleStateTree();
  for (const k of pool) await a.insert(k, k);
  for (const k of [...pool].reverse()) await b.insert(k, k);
  assert.strictEqual(a.getRoot(), b.getRoot());
  assert.strictEqual(a.getRoot(), refOf(a.state));
});
await check('deleting a key that is not there leaves the root alone', async () => {
  const tree = new VerkleStateTree();
  for (const k of sharing(3, 2, 'd2')) await tree.insert(k, 1);
  const before = tree.getRoot();
  await tree.delete('never-inserted');
  assert.strictEqual(tree.getRoot(), before);
});

console.log('\n3. memory');
await check('20,000 keys hold under 2,000 bytes of heap each (the uncompressed tree held 12,936)', async () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  const big = new VerkleStateTree();
  for (let i = 0; i < 20000; i++) await big.insert(`m${i}`, { ts: i });
  big.getRoot();
  gc(); gc();
  const perKey = Math.round((process.memoryUsage().heapUsed - before) / 20000);
  assert.strictEqual(big.state.size, 20000);
  assert.ok(perKey < 2000, `${perKey} bytes per key`);
  console.log(`       ${perKey} bytes per key`);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
