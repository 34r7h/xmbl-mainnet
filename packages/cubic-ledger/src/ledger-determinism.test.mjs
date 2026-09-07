// Two independent ledgers fed the SAME transactions in DIFFERENT orders must produce the SAME cubes.
// Test 0 is the control: shuffling must actually change arrival order, or the test proves nothing.
import { createHash } from 'crypto';
import assert from 'assert';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Ledger } from './ledger.js';

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };

const mkTxs = (n) => Array.from({ length: n }, (_, i) => ({
  type: 'anchor', event: 'task.created', hash: createHash('sha256').update('p' + i).digest('hex'),
  ts: '2026-08-03T00:00:00Z', from: 'xmbA', sig: 'S', id: 'tx' + i,
  validationTimestamp: String(1784758606627666688n + BigInt(i)),
}));
const shuffle = (a, seed) => { a = [...a]; let s = seed;
  for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) & 0x7fffffff; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

async function run(txs, tag) {
  const dir = join(tmpdir(), `led-${tag}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  const l = new Ledger({ dbPath: dir });
  await new Promise(r => setTimeout(r, 300));
  // Feed the whole AGREED SET at once. Streaming one-at-a-time cannot be arrival-independent: the pool is
  // sealed in chunks of 9 as it fills, so WHICH nine are present when the ninth lands is timing-dependent.
  // Freezing the set before partitioning is exactly what consensus-v2 seal agreement provides cross-node.
  await l.addSealedBatch(txs);
  await new Promise(r => setTimeout(r, 300));
  const cubes = [...l.cubes.values()].filter(c => c.isComplete && c.isComplete())
    .map(c => ({ id: c.id, root: c.getMerkleRoot() }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  try { await l.db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
  return cubes;
}
const digest = (cubes) => createHash('sha256').update(cubes.map(c => `${c.id}:${c.root}`).join('|')).digest('hex');

const TXS = mkTxs(81);

console.log('\n0. control');
await check('shuffling actually reorders the input', () => {
  assert.notDeepStrictEqual(shuffle(TXS, 1).map(t => t.id), TXS.map(t => t.id));
});

console.log('\n1. same set, different arrival order -> SAME cubes');
const base = await run(TXS, 'base');
await check(`${base.length} complete cubes formed from 81 txs`, () => { assert.ok(base.length > 0, 'no cubes formed'); });
for (const seed of [1, 2, 3]) {
  await check(`shuffle ${seed} produces an identical cube set`, async () => {
    const got = await run(shuffle(TXS, seed), 's' + seed);
    assert.strictEqual(got.length, base.length, `cube COUNT differs: ${got.length} vs ${base.length}`);
    assert.strictEqual(digest(got), digest(base), 'cube set digest differs — placement is arrival-dependent');
  });
}
await check('reversed input produces an identical cube set', async () => {
  const got = await run([...TXS].reverse(), 'rev');
  assert.strictEqual(digest(got), digest(base));
});

// 2. REBUILD-FROM-CANONICAL must be idempotent across REPEATED rebuilds. The convergence timer calls
// rebuild_ledger every ~90s, so the same anchor set is rebuilt hundreds of times over a node's life. The
// rebuild MUST land on the identical sealed chain every time — a pure function of the set. Regression guard for
// the cube-formation accumulators (_slotFaces et al.) leaking across rebuilds: left unreset they drifted the
// per-slot cube ordinals apart until no cube could collect 3 faces, and cubes_persisted collapsed from 31 → 0
// after ~8 rebuilds (measured on prod as cubes_persisted:0 / faces_sealed_since_boot:437, "none finalized").
console.log('\n2. repeated rebuildFromAnchors -> STABLE persisted cubes (not 0)');
const mkAnchors = (n) => Array.from({ length: n }, (_, i) => ({
  event: 'task.created', hash: createHash('sha256').update('a' + i).digest('hex'), ts: 1784758606627 + i,
}));
await check('cubes_persisted is identical and > 0 across 12 rebuilds', async () => {
  const dir = join(tmpdir(), `led-rebuild-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  const l = new Ledger({ dbPath: dir });
  await new Promise(r => setTimeout(r, 300));
  const anchors = mkAnchors(900);
  const persistedCubes = async () => { let c = 0; for await (const k of l.db.keys({ gte: 'cube:', lt: 'cube;' })) { void k; c++; } return c; };
  const counts = [];
  for (let m = 0; m < 12; m++) { await l.rebuildFromAnchors(anchors); counts.push(await persistedCubes()); }
  try { await l.db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
  assert.ok(counts[0] > 0, `first rebuild persisted 0 cubes: ${counts.join(',')}`);
  assert.ok(counts.every((c) => c === counts[0]), `cube count drifted across rebuilds: ${counts.join(',')}`);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
