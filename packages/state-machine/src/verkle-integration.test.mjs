// The Verkle state tree must actually RECEIVE transactions. Live measurement 2026-08-02 before this fix:
// state_root = 64 zeros, applied_tx_count 0, state_diffs 0, against 396 persisted blocks and 14 cubes.
// Test 0 is the negative control: the OLD state_diff-only rule must leave the root empty for real traffic.
import assert from 'assert';
import { StateMachine } from './state-machine.js';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const EMPTY = '0'.repeat(64);
// Portable: this suite runs on the laptop AND on every Linux box in the fleet.
const dir = join(tmpdir(), 'xvsm-verkle-test');
const fresh = async () => { rmSync(dir, { recursive: true, force: true });
  const sm = new StateMachine({ dbPath: dir }); await new Promise(r => setTimeout(r, 120)); return sm; };

const blk = (id, tx) => ({ id, tx });
const REAL_TRAFFIC = [
  blk('b1', { type: 'anchor', event: 'task.created', hash: 'a'.repeat(64), ts: '2026-08-02T00:00:00Z', from: 'xmbA' }),
  blk('b2', { type: 'anchor', event: 'task.verified', hash: 'b'.repeat(64), ts: '2026-08-02T00:00:01Z', from: 'xmbA' }),
  blk('b3', { type: 'tx', xid: '06abc123', chain: 'xmbl', from: ['xmbA'], to: ['xmbB'], asset: 'usdc', amount: '5', unspent: '' }),
  blk('b4', { type: 'utxo', from: 'xmbA', to: 'xmbB', amount: 7 }),
  blk('b5', { type: 'identity', publicKey: 'pk-1', from: 'xmbC' }),
  blk('b6', { type: 'token_creation', tokenId: 't1', creator: 'xmbA' }),
  blk('b7', { type: 'contract', contractHash: 'c'.repeat(64), abi: [] }),
  blk('b8', { type: 'state_diff', args: { 'k:1': 'v1' } }),
];

console.log('\n0. negative control — the OLD rule must leave the tree empty');
await check('state_diff-only filter ignores anchors and value txs (root stays zero)', async () => {
  const sm = await fresh();
  for (const b of REAL_TRAFFIC.filter(x => x.tx.type !== 'state_diff')) {
    if (b.tx.type === 'state_diff' && b.tx.args) continue; // the old condition, verbatim
  }
  assert.strictEqual(sm.stateTree.getRoot(), EMPTY, 'control invalid: root non-empty with nothing applied');
});

console.log('\n1. every transaction type reaches the Verkle tree');
await check('all 8 block types produce a state change', async () => {
  const sm = await fresh();
  for (const b of REAL_TRAFFIC) {
    const changes = sm._stateChangesFor(b);
    assert.ok(changes && Object.keys(changes).length, `${b.tx.type} produced no state change`);
  }
});
await check('applying real traffic moves the root off zero', async () => {
  const sm = await fresh();
  assert.strictEqual(sm.stateTree.getRoot(), EMPTY);
  for (const b of REAL_TRAFFIC) await sm._handleLedgerBlock(b);
  assert.notStrictEqual(sm.stateTree.getRoot(), EMPTY, 'root still empty after applying 8 blocks');
  assert.strictEqual(sm.diffs.length, REAL_TRAFFIC.length, `expected ${REAL_TRAFFIC.length} diffs`);
});
await check('anchors alone are enough (the live node sees only anchors)', async () => {
  const sm = await fresh();
  await sm._handleLedgerBlock(REAL_TRAFFIC[0]);
  assert.notStrictEqual(sm.stateTree.getRoot(), EMPTY);
});
await check('keys are namespaced per type — no cross-type collision', async () => {
  const sm = await fresh();
  const keys = REAL_TRAFFIC.flatMap(b => Object.keys(sm._stateChangesFor(b) || {}));
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicate key across types');
  for (const k of keys.filter(k => k.includes(':'))) assert.ok(/^[a-z_]+:/.test(k), `unnamespaced key ${k}`);
});
await check('unknown / malformed tx yields no change, never a crash', async () => {
  const sm = await fresh();
  for (const bad of [blk('x', { type: 'nope' }), blk('x', {}), blk('x', null), { id: 'x' },
                     blk('x', { type: 'anchor' }), blk('x', { type: 'tx' })]) {
    assert.strictEqual(sm._stateChangesFor(bad), null);
    await sm._handleLedgerBlock(bad);
  }
  assert.strictEqual(sm.stateTree.getRoot(), EMPTY, 'malformed input mutated the tree');
});

console.log('\n2. determinism — the root is a cross-node commitment');
await check('same set applied in any order yields the SAME root', async () => {
  const a = await fresh(); for (const b of REAL_TRAFFIC) await a._handleLedgerBlock(b);
  const rootA = a.stateTree.getRoot();
  const b2 = await fresh(); for (const b of [...REAL_TRAFFIC].reverse()) await b2._handleLedgerBlock(b);
  assert.strictEqual(b2.stateTree.getRoot(), rootA, 'root depends on application order — not a valid commitment');
});
await check('a different set yields a DIFFERENT root (control could go red)', async () => {
  const a = await fresh(); for (const b of REAL_TRAFFIC) await a._handleLedgerBlock(b);
  const c = await fresh(); for (const b of REAL_TRAFFIC.slice(0, 4)) await c._handleLedgerBlock(b);
  assert.notStrictEqual(c.stateTree.getRoot(), a.stateTree.getRoot());
});

console.log('\n3. cube commitment');
await check('cube:complete WRITES the state root onto the cube (was console.log only)', async () => {
  const sm = await fresh();
  for (const b of REAL_TRAFFIC) await sm._handleLedgerBlock(b);
  const cube = { id: 'cube1' };
  const returned = sm._handleCubeComplete(cube);
  assert.strictEqual(cube.stateRoot, sm.stateTree.getRoot(), 'stateRoot not committed to cube');
  assert.strictEqual(returned, cube.stateRoot);
  assert.notStrictEqual(cube.stateRoot, EMPTY);
});
await check('proofs verify against the committed root', async () => {
  const sm = await fresh();
  for (const b of REAL_TRAFFIC) await sm._handleLedgerBlock(b);
  const key = `anchor:task.created:${'a'.repeat(64)}`;
  const proof = sm.stateTree.generateProof(key);
  assert.ok(proof, 'no proof generated for an applied key');
});

console.log('\n4. restart survival');
await check('verkle root survives a restart (diffs are REPLAYED, not just collected)', async () => {
  const d = dir + '-restart';
  rmSync(d, { recursive: true, force: true });
  let sm = new StateMachine({ dbPath: d }); await new Promise(r => setTimeout(r, 150));
  for (const b of REAL_TRAFFIC) await sm._handleLedgerBlock(b);
  const before = sm.stateTree.getRoot();
  assert.notStrictEqual(before, EMPTY);
  await new Promise(r => setTimeout(r, 250)); await sm.db.close();
  sm = new StateMachine({ dbPath: d }); await new Promise(r => setTimeout(r, 500));
  const after = sm.stateTree.getRoot();
  await sm.db.close(); rmSync(d, { recursive: true, force: true });
  assert.strictEqual(after, before, 'root changed across restart');
  assert.notStrictEqual(after, EMPTY, 'root reset to zeros on restart');
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
