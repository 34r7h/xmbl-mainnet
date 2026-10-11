// THE PROCESSING TIER ON A NODE THAT DOES NOT FINALIZE. finalizeTransaction is the only thing that takes a row out
// of processing and only the lead role calls it, so on a lead:false node every validated tx, body and all, stayed
// in the processing map until the process died. Measured 2026-10-11 on the two lead:false seeds: 831cfb42
// processing 66 -> 115, 4293b3c6 41 -> 65 within minutes, while both lead nodes sat at 0.
//
// Pinned here, over a real LevelDB: a lead still finalizes exactly as before; a non-lead holds no processing row,
// in memory or on disk, and releases the UTXO lock; a non-lead booting on rows an older build did write to disk
// drops every one of them before anything reads them.
import { ConsensusWorkflow } from './workflow.js';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DB = mkdtempSync(join(tmpdir(), 'xpc-processing-'));

const mk = async (path, opts = {}) => {
  const w = new ConsensusWorkflow({ dbPath: path, ...opts });
  const boot = await w.ready;
  if (w._recoverySweep) clearInterval(w._recoverySweep);
  w._recoverySweep = null;
  return { w, boot };
};
const close = async (w) => { await wait(50); await w.mempool.db.close(); };
const rows = async (w, prefix) => { let n = 0; for await (const _ of w.mempool.db.iterator({ gt: prefix, lt: `${prefix}\xFF` })) n++; return n; };
// A validated raw tx (three timestamps in), locked under its sender the way submitTransaction locks it.
const put = async (w, j) => {
  const rawTxId = `raw${j}`;
  const txData = { type: 'anchor', j, from: `xmbsender${j}`, sig: 's' };
  w.rawTxToId.set(rawTxId, 'L');
  if (!w.mempool.rawTx.has('L')) w.mempool.rawTx.set('L', new Map());
  const entry = { txData, validationTimestamps: [1, 2, 3], validationTasks: [], txTimestamp: Date.now() };
  w.mempool.rawTx.get('L').set(rawTxId, entry);
  await w.mempool._saveRawTx('L', rawTxId, entry);
  await w.mempool.lockUtxos([txData.from]);
  return rawTxId;
};

console.log('\n1. a lead (the default) holds processing and finalizes it, unchanged');
await check('default finalizes: moveToProcessing holds the row; finalizeTransaction moves it to tx and emits tx:finalized', async () => {
  const { w } = await mk(join(DB, 'lead'));
  assert.strictEqual(w.finalizes, true);
  const seen = [], finalized = [];
  w.on('tx:processing', (d) => seen.push(d.txId));
  w.on('tx:finalized', (d) => finalized.push(d.txId));
  for (let j = 0; j < 5; j++) await w.moveToProcessing(await put(w, j));
  assert.strictEqual(seen.length, 5);
  assert.strictEqual(w.mempool.processingTx.size, 5);
  for (const id of seen) assert.strictEqual(await w.finalizeTransaction(id), true);
  assert.strictEqual(w.mempool.processingTx.size, 0);
  assert.strictEqual(await rows(w, 'processingTx:'), 0);
  assert.strictEqual(finalized.length, 5);
  assert.strictEqual(w.mempool.tx.size, 5);
  assert.strictEqual(w.mempool.lockedUtxo.size, 0);
  await close(w);
});

console.log('\n2. a non-lead keeps no processing tier');
await check('finalizes:false: 10 txs through moveToProcessing leave 0 rows in memory and 0 on disk, and 0 locks', async () => {
  const { w } = await mk(join(DB, 'nonlead'), { finalizes: false });
  const seen = [];
  w.on('tx:processing', (d) => seen.push(d.txId));
  for (let j = 0; j < 10; j++) await w.moveToProcessing(await put(w, j));
  assert.strictEqual(seen.length, 10, 'tx:processing still fires for observers');
  assert.strictEqual(w.mempool.processingTx.size, 0);
  assert.strictEqual(await rows(w, 'processingTx:'), 0);
  assert.strictEqual(w.mempool.rawTx.get('L').size, 0, 'the raw pool empties as before');
  assert.strictEqual(w.mempool.lockedUtxo.size, 0);
  assert.strictEqual(await w.finalizeTransaction(seen[0]), false, 'nothing here to finalize');
  assert.strictEqual(w.mempool.tx.size, 0);
  assert.strictEqual(w._processedRawTxIds.has('raw0'), true, 'a re-gossip of the same tx is still a no-op');
  await close(w);
});

console.log('\n3. a non-lead booting on rows an older version left behind');
// A processing row as an older build wrote it to disk (moveToProcessing's own write never lands: the BigInt clock
// makes JSON.stringify throw), with its sender locked.
const legacyRow = async (w, j) => {
  const txData = { type: 'anchor', j, from: `xmbsender${j}`, sig: 's' };
  await w.mempool.db.put(`processingTx:legacy${j}`, JSON.stringify({ rawTxId: `raw${j}`, timestamp: '1', validationTimestamp: '1', txData }));
  await w.mempool.lockUtxos([txData.from]);
};

await check('12 rows on disk from an older build: boot as non-lead leaves 0 in memory, 0 on disk, 0 locks', async () => {
  const path = join(DB, 'upgrade');
  const { w: old } = await mk(path);
  for (let j = 0; j < 12; j++) await legacyRow(old, j);
  assert.strictEqual(await rows(old, 'processingTx:'), 12);
  assert.strictEqual(old.mempool.lockedUtxo.size, 12);
  await close(old);
  const { w, boot } = await mk(path, { finalizes: false });
  assert.strictEqual(boot.dropped, 12);
  assert.strictEqual(w.mempool.processingTx.size, 0);
  assert.strictEqual(await rows(w, 'processingTx:'), 0);
  assert.strictEqual(w.mempool.lockedUtxo.size, 0);
  await close(w);
  const { w: again, boot: boot2 } = await mk(path, { finalizes: false });
  assert.strictEqual(boot2.dropped, 0, 'nothing comes back on the next boot');
  assert.strictEqual(again.mempool.processingTx.size, 0);
  assert.strictEqual(await rows(again, 'processingTx:'), 0);
  await close(again);
});

await check('the same rows booted as a lead are kept for it', async () => {
  const path = join(DB, 'lead-boot');
  const { w: old } = await mk(path);
  for (let j = 0; j < 3; j++) await legacyRow(old, j);
  await close(old);
  const { w, boot } = await mk(path);
  assert.strictEqual(boot.dropped, 0);
  assert.strictEqual(w.mempool.processingTx.size, 3);
  assert.strictEqual(await rows(w, 'processingTx:'), 3);
  await close(w);
});

rmSync(DB, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
