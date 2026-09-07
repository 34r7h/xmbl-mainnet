// THE CHURN FIX. One stale coordinator (xmbc3d2a9792ed66d53c8db961f884484ef7a4441de) accumulated 13,737 raw
// txs on one box and 15,955 on another. Its txs ARE signed — they simply do not verify. The mechanism was:
// completeValidation returned false and left the tx pooled, so validation-retry re-chewed it every sweep,
// forever. Failure with no eviction path is the churn.
//
// Three properties are tested, with the fork-safety asymmetry pinned explicitly: the predicate must be false
// whenever it CANNOT prove invalidity, because rejecting a tx the rest of the mesh seals costs a cube forever.
import { ConsensusWorkflow } from './workflow.js';
import assert from 'node:assert';

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const mk = () => new ConsensusWorkflow({});
const SIGNED = { type: 'anchor', event: 'e', hash: 'h', from: 'xmbStale', sig: 'SIG' };

console.log('\n1. predicate is fork-safe — false whenever invalidity cannot be PROVEN');
await check('unsigned tx -> false (presence guard handles it, not this)', async () => {
  const w = mk(); assert.strictEqual(await w._isPositivelyInvalid({ type: 'anchor', from: 'a' }), false);
});
await check('no key resolver -> false', async () => {
  const w = mk(); assert.strictEqual(await w._isPositivelyInvalid(SIGNED), false);
});
await check('key does NOT resolve -> false (older SPKI-DER identities must not be blackholed)', async () => {
  const w = mk(); w.getPublicKeyByAddress = () => null;
  assert.strictEqual(await w._isPositivelyInvalid(SIGNED), false);
});
await check('resolver throws -> false', async () => {
  const w = mk(); w.getPublicKeyByAddress = () => { throw new Error('boom'); };
  assert.strictEqual(await w._isPositivelyInvalid(SIGNED), false);
});

console.log('\n2. eviction removes from BOTH tiers and drops its tasks');
await check('_evictRawTx clears map, LevelDB and stage-2 tasks', async () => {
  const w = mk();
  const rawTxId = 'raw1';
  w.rawTxToId.set(rawTxId, 'leaderX');
  w.mempool.rawTx.set('leaderX', new Map([[rawTxId, { txData: SIGNED }]]));
  let deleted = null;
  w.mempool._deleteRawTx = async (l, r) => { deleted = `${l}:${r}`; };
  w.taskManager.assignTasks(rawTxId, w.taskManager.createTasks(rawTxId, ['leaderX']));
  assert.strictEqual(w.taskManager.getTasksForLeader('leaderX').length, 1);
  await w._evictRawTx(rawTxId);
  assert.strictEqual(w.mempool.rawTx.get('leaderX').has(rawTxId), false, 'still in memory');
  assert.strictEqual(deleted, `leaderX:${rawTxId}`, 'not deleted from LevelDB');
  assert.strictEqual(w.rawTxToId.has(rawTxId), false, 'submitter mapping left behind');
  assert.strictEqual(w.taskManager.getTasksForLeader('leaderX').length, 0, 'stage-2 tasks left behind');
});

console.log('\n3. drain clears the pre-guard backlog, and ONLY the provably-invalid part');
await check('drain evicts invalid, keeps unprovable, keeps valid', async () => {
  const w = mk();
  const bad = { ...SIGNED, hash: 'bad' };                 // resolves + verify=false -> evict
  const unprovable = { ...SIGNED, from: 'xmbUnknown' };   // key unresolved       -> keep
  const good = { ...SIGNED, hash: 'good', from: 'xmbGood' };
  w.mempool.rawTx.set('L', new Map([['b', { txData: bad }], ['u', { txData: unprovable }], ['g', { txData: good }]]));
  w.rawTxToId.set('b', 'L'); w.rawTxToId.set('u', 'L'); w.rawTxToId.set('g', 'L');
  w.mempool._deleteRawTx = async () => {};
  w.getPublicKeyByAddress = (a) => (a === 'xmbUnknown' ? null : 'PK');
  w._isPositivelyInvalid = async (tx) => tx.from !== 'xmbUnknown' && tx.hash === 'bad';
  const { scanned, evicted } = await w.drainInvalidMempool();
  assert.strictEqual(scanned, 3);
  assert.strictEqual(evicted, 1, 'expected exactly the provably-invalid one');
  const left = [...w.mempool.rawTx.get('L').keys()].sort();
  assert.deepStrictEqual(left, ['g', 'u'], 'wrong survivors');
});
await check('drain on an empty pool is a clean no-op', async () => {
  const w = mk();
  const r = await w.drainInvalidMempool();
  assert.deepStrictEqual(r, { scanned: 0, evicted: 0 });
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
