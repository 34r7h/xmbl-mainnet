// THE THREE DEFECTS THAT KEPT NODES OFF A SHARED ROOT, each asserted by the symptom the nodes showed,
// not by the mechanism. All three were measured live on 2026-09-15 before being fixed here.
import { test } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { StateMachine } from './state-machine.js';

const ZERO = '0'.repeat(64);
const anchors = (n) => Array.from({ length: n }, (_, i) => ({
  event: 'task.created', hash: `h${String(i).padStart(4, '0')}`.padEnd(12, '0'), ts: 1000 + i,
}));
const blockFor = (a, tag) => ({ id: `blk-${tag}-${Math.random().toString(16).slice(2)}`,
  tx: { type: 'anchor', event: a.event, hash: a.hash, ts: a.ts } });
const countDiffRows = async (sm) => { let n = 0; for await (const [] of sm.db.iterator({ gt: 'diff:', lt: 'diff:\xFF' })) n++; return n; };

async function open(dir) { const sm = new StateMachine({ dbPath: dir }); await sm.ready(); return sm; }

test('a restarted node publishes a REAL root, not 64 zeros, from the state: keyspace alone', async () => {
  const dir = `/tmp/xvsm-rehydrate-${process.pid}-a`;
  rmSync(dir, { recursive: true, force: true });
  let sm = await open(dir);
  for (const a of anchors(30)) await sm._handleLedgerBlock(blockFor(a, 'x'));
  const before = sm.stateTree.getRoot();
  assert.notStrictEqual(before, ZERO);
  await sm.db.close();

  // Reopen. The diff replay is NOT the thing under test — delete every diff row first, so the only
  // surviving source for the trie is `state:`. 39 of 44 reporting nodes published ZERO here.
  sm = await open(dir);
  await sm.db.clear({ gte: 'diff:', lt: 'diff:\xFF' });
  await sm.db.close();
  sm = await open(dir);
  assert.strictEqual(sm.stateTree.state.size, 30, 'keys must come back');
  assert.notStrictEqual(sm.stateTree.getRoot(), ZERO, 'a tree holding 30 keys must not commit to zeros');
  assert.strictEqual(sm.stateTree.getRoot(), before, 'and it must be the SAME root it had before the restart');
  await sm.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('re-submitting the same anchor under fresh tx ids writes ONE durable row, not one per submission', async () => {
  const dir = `/tmp/xvsm-rehydrate-${process.pid}-b`;
  rmSync(dir, { recursive: true, force: true });
  const sm = await open(dir);
  const set = anchors(50);
  for (let pass = 0; pass < 4; pass++) for (const a of set) await sm._handleLedgerBlock(blockFor(a, pass));
  assert.strictEqual(await countDiffRows(sm), 50, '200 submissions of 50 anchors is 50 state changes');
  assert.strictEqual(sm.getStatistics().totalTransactions, 50, 'and the published count must agree with disk');
  await sm.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the canonical set a node adopts SURVIVES a restart', async () => {
  const dir = `/tmp/xvsm-rehydrate-${process.pid}-c`;
  rmSync(dir, { recursive: true, force: true });
  let sm = await open(dir);
  const local = anchors(50);
  for (const a of local) await sm._handleLedgerBlock(blockFor(a, 'local'));
  const canonical = local.slice(0, 10);
  const reb = await sm.rebuildFromCanonical(canonical);
  assert.strictEqual(reb.applied, 10);
  const canonicalRoot = reb.state_root;
  await sm.db.close();

  sm = await open(dir);
  assert.strictEqual(sm.stateTree.state.size, 10, 'the 40 non-canonical keys must not come back');
  assert.strictEqual(sm.stateTree.getRoot(), canonicalRoot, 'the node must still be on the canonical root');
  assert.strictEqual(sm.getStatistics().totalTransactions, 10);
  await sm.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('legacy rows keyed by block id are re-keyed to content identity on the next boot', async () => {
  const dir = `/tmp/xvsm-rehydrate-${process.pid}-d`;
  rmSync(dir, { recursive: true, force: true });
  let sm = await open(dir);
  // Write rows the way every node on the nodes already has them: one per submission, keyed by block id.
  const set = anchors(40);
  let written = 0;
  for (let pass = 0; pass < 3; pass++) for (const a of set) {
    const key = `anchor:${a.event}:${a.hash}`;
    await sm.db.put(`diff:blk-${pass}-${a.hash}`, JSON.stringify({
      txId: `blk-${pass}-${a.hash}`, timestamp: 1000 + pass, changes: { [key]: { ts: a.ts } },
    }));
    written++;
  }
  assert.strictEqual(await countDiffRows(sm), written);
  await sm.db.close();

  sm = await open(dir);
  assert.strictEqual(await countDiffRows(sm), 40, `${written} legacy rows collapse to 40 distinct changes`);
  assert.strictEqual(sm.getStatistics().totalTransactions, 40);
  await sm.db.close();
  rmSync(dir, { recursive: true, force: true });
});
