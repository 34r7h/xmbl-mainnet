// STAGE 2 IS INDEXED AND IT EMPTIES. Each leader's tasks were one array that every assign, completion, persist
// and lookup walked (0.45 s of 10.9 s per node, 4 real nodes, 2007 node-signed datums), and nothing cleared a
// tx's tasks when it reached processing: every tx a node ever processed kept its tasks in memory and a
// validationTasks row on disk, and every boot reloaded them all.
// Pinned here: assign is idempotent, a completion persists only that tx's slice, the per-tx lookups answer what
// a scan answers, a clear removes memory and disk rows, a processed tx leaves no task behind (in memory and
// after a restart over the same LevelDB), and a boot drops the rows of txs that are no longer in the raw pool.
// Run: node validation-tasks.test.mjs
import { ConsensusWorkflow } from './workflow.js';
import { ValidationTaskManager } from './validation-tasks.js';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DB = mkdtempSync(join(tmpdir(), 'xpc-tasks-'));

// A store that records what the manager asks of it.
const recorder = () => {
  const calls = [];
  return {
    calls,
    setValidationTasksFor: (l, r, list) => calls.push(['set', l, r, list.map((t) => `${t.task}=${t.complete}`)]),
    clearValidationTasksFor: (l, r) => calls.push(['clearFor', l, r]),
    clearValidationTasks: (l) => calls.push(['clear', l]),
  };
};

await check('assigning the same tasks twice holds them once', () => {
  const m = new ValidationTaskManager();
  m.assignTasks('r1', m.createTasks('r1', ['A', 'B']));
  m.assignTasks('r1', m.createTasks('r1', ['A', 'B']));
  assert.deepStrictEqual(m.size(), { tasks: 2, txs: 1 });
  assert.strictEqual(m.tasksOf('A', 'r1').length, 1);
});

await check('a completion persists that tx\'s slice and nothing else', () => {
  const store = recorder();
  const m = new ValidationTaskManager({ store });
  for (let j = 0; j < 50; j++) m.assignTasks(`r${j}`, m.createTasks(`r${j}`, ['A']));
  store.calls.length = 0;
  m.completeTask('A', 'r7:A:validate');
  m.completeTask('A', 'r7:A:validate');
  assert.deepStrictEqual(store.calls, [['set', 'A', 'r7', ['r7:A:validate=true']]]);
  assert.strictEqual(m.getTask('A', 'r7:A:validate').complete, true);
});

await check('tasksOf, leadersHolding and getTasksForLeader answer what a scan answers', () => {
  const m = new ValidationTaskManager();
  m.assignTasks('r1', m.createTasks('r1', ['A', 'B']));
  m.assignTasks('r2', m.createTasks('r2', ['B', 'C']));
  m.assignTasks('r3', m.createTasks('r3', ['A']));
  const scan = (l) => m.getTasksForLeader(l);
  for (const l of ['A', 'B', 'C', 'D']) for (const r of ['r1', 'r2', 'r3', 'r4']) {
    assert.deepStrictEqual(m.tasksOf(l, r), scan(l).filter((t) => t.task.startsWith(`${r}:`)), `${l} ${r}`);
  }
  for (const r of ['r1', 'r2', 'r3', 'r4']) {
    assert.deepStrictEqual(m.leadersHolding(r).sort(), ['A', 'B', 'C', 'D'].filter((l) => scan(l).some((t) => t.task.startsWith(`${r}:`))), r);
  }
  assert.deepStrictEqual(scan('B').map((t) => t.task), ['r1:B:validate', 'r2:B:validate'], 'not in assignment order');
  scan('B').pop();
  assert.strictEqual(scan('B').length, 2, 'getTasksForLeader handed out its own list');
});

await check('clearing a tx removes its tasks in memory and its rows on disk, and an emptied leader', () => {
  const store = recorder();
  const m = new ValidationTaskManager({ store });
  m.assignTasks('r1', m.createTasks('r1', ['A', 'B']));
  m.assignTasks('r2', m.createTasks('r2', ['B']));
  store.calls.length = 0;
  m.clearTasksForRawTx('r1');
  assert.deepStrictEqual(m.size(), { tasks: 1, txs: 1 });
  assert.deepStrictEqual(m.getKnownLeaderIds(), ['B']);
  assert.deepStrictEqual(m.leadersHolding('r1'), []);
  assert.deepStrictEqual(store.calls, [['clearFor', 'A', 'r1'], ['clear', 'A'], ['clearFor', 'B', 'r1']]);
  m.clearTasksForRawTx('r1');
  assert.strictEqual(store.calls.length, 3, 'a second clear touched the store');
});

await check('hydrate keeps the tasks of txs still pooled and drops the rest, on disk too', () => {
  const store = recorder();
  const boot = new Map([
    ['A', [{ task: 'live:A:validate', complete: true, leaderId: 'A' }, { task: 'gone:A:validate', complete: false, leaderId: 'A' }]],
    ['B', [{ task: 'gone:B:validate', complete: false, leaderId: 'B' }, { task: 'live:B:validate', complete: false, leaderId: 'B' }, { task: 'live:B:validate', complete: false, leaderId: 'B' }]],
  ]);
  store.getAllValidationTasks = () => boot;
  const m = new ValidationTaskManager({ store });
  assert.strictEqual(m.hydrate((r) => r === 'live'), 2);
  assert.deepStrictEqual(m.size(), { tasks: 2, txs: 1 });
  assert.strictEqual(m.getTask('A', 'live:A:validate').complete, true);
  assert.deepStrictEqual(store.calls.filter((c) => c[0] === 'clearFor').sort(), [['clearFor', 'A', 'gone'], ['clearFor', 'B', 'gone']]);
  assert.strictEqual(boot.size, 0, 'the store kept its boot-time copy');
});

// The workflow over a real LevelDB. Txs go in through submitTransaction with the user-as-validator task set, and
// out through moveToProcessing, the path every sealed tx takes.
const mkWorkflow = async (path) => {
  const w = new ConsensusWorkflow({ dbPath: path });
  await w.ready;
  if (w._recoverySweep) clearInterval(w._recoverySweep);
  w._recoverySweep = null;
  return w;
};
const close = async (w) => { await wait(50); await w.mempool.db.close(); };
const taskRows = async (w) => { const keys = []; for await (const [k] of w.mempool.db.iterator({ gt: 'validationTasks:', lt: 'validationTasks:\xFF' })) keys.push(k.toString()); return keys; };
const put = async (w, j) => {
  const rawTxId = `raw${j}`;
  w.rawTxToId.set(rawTxId, 'L');
  if (!w.mempool.rawTx.has('L')) w.mempool.rawTx.set('L', new Map());
  const entry = { txData: { type: 'anchor', j, sig: 's' }, validationTimestamps: [1, 2, 3], validationTasks: [], txTimestamp: Date.now() };
  w.mempool.rawTx.get('L').set(rawTxId, entry);
  await w.mempool._saveRawTx('L', rawTxId, entry);
  w.taskManager.assignTasks(rawTxId, w.taskManager.createTasks(rawTxId, ['L', 'M', 'N']));
  return rawTxId;
};

await check('a tx that reaches processing leaves no task in memory, on disk, or after a restart', async () => {
  const path = join(DB, 'processed');
  const w = await mkWorkflow(path);
  const ids = [];
  for (let j = 0; j < 20; j++) ids.push(await put(w, j));
  assert.deepStrictEqual(w.taskManager.size(), { tasks: 60, txs: 20 });
  for (const id of ids.slice(0, 15)) await w.moveToProcessing(id);
  assert.deepStrictEqual(w.taskManager.size(), { tasks: 15, txs: 5 });
  await wait(50);
  assert.strictEqual((await taskRows(w)).length, 15, 'validationTasks rows for processed txs');
  await close(w);
  const again = await mkWorkflow(path);
  assert.deepStrictEqual(again.taskManager.size(), { tasks: 15, txs: 5 });
  assert.deepStrictEqual(again.taskManager.leadersHolding('raw0'), []);
  assert.deepStrictEqual(again.taskManager.leadersHolding('raw19').sort(), ['L', 'M', 'N']);
  await close(again);
});

await check('a boot drops the task rows of a tx no longer in the raw pool', async () => {
  const path = join(DB, 'stale');
  const w = await mkWorkflow(path);
  await put(w, 1);
  // A row left behind by a build that never cleared stage 2: its tx is gone from the raw pool.
  await w.mempool.db.put('validationTasks:L:ghost', JSON.stringify([{ task: 'ghost:L:validate', complete: true, leaderId: 'L' }]));
  await w.mempool.db.put('validationTasks:Q:ghost', JSON.stringify([{ task: 'ghost:Q:validate', complete: false, leaderId: 'Q' }]));
  await close(w);
  const again = await mkWorkflow(path);
  assert.deepStrictEqual(again.taskManager.size(), { tasks: 3, txs: 1 });
  assert.deepStrictEqual(again.taskManager.getKnownLeaderIds().sort(), ['L', 'M', 'N']);
  await wait(50);
  assert.deepStrictEqual((await taskRows(again)).sort(), ['validationTasks:L:raw1', 'validationTasks:M:raw1', 'validationTasks:N:raw1']);
  await close(again);
});

await check('the age reaper and a direct pool delete drop the tasks and submitter mapping of what they remove', async () => {
  const path = join(DB, 'reaped');
  const w = await mkWorkflow(path);
  for (let j = 0; j < 6; j++) await put(w, j);
  for (const j of [0, 1, 2]) w.mempool.rawTx.get('L').get(`raw${j}`).txTimestamp = Date.now() - 60000;
  assert.strictEqual(await w.reapAbandonedRawTxs(30000), 3);
  assert.deepStrictEqual(w.taskManager.size(), { tasks: 9, txs: 3 });
  assert.deepStrictEqual([...w.rawTxToId.keys()].sort(), ['raw3', 'raw4', 'raw5']);
  // The cap sweep and core's forced eviction take this route: Map delete, then _deleteRawTx.
  w.mempool.rawTx.get('L').delete('raw3');
  await w.mempool._deleteRawTx('L', 'raw3');
  assert.deepStrictEqual(w.taskManager.size(), { tasks: 6, txs: 2 });
  assert.strictEqual(w.rawTxToId.has('raw3'), false);
  // A delete under a leader the tx is not mapped to leaves it alone.
  await w.mempool._deleteRawTx('Z', 'raw4');
  assert.deepStrictEqual(w.taskManager.size(), { tasks: 6, txs: 2 });
  assert.strictEqual(w.rawTxToId.get('raw4'), 'L');
  await wait(50);
  assert.strictEqual((await taskRows(w)).length, 6);
  await close(w);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
