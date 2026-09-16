// A STORE WRITTEN BEFORE CONTENT IDS CONVERGES ON ITS NEXT BOOT — BY ITSELF.
//
// Rows written before block ids addressed consensus content (block.js consensusBody) are keyed by a hash of the
// WHOLE tx, envelope included: the same anchor sits on disk under one id per node that relayed it and per time it
// was resubmitted. The compaction that collapses them used to be a method nobody called; a fleet node converged
// only if an operator remembered to. Now the ledger's own boot scan notices an envelope-keyed row and runs the
// compaction once, so the second boot finds nothing to do — asserted here by COUNT, on disk, after the fact.
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Level } from 'level';
import { Ledger, Block, contentKey, micromineTx } from '../index.js';

const digest = (label) => createHash('sha256').update(label).digest('hex');
// typed, as every tx is (2026-09-16): the xid is the type-7 pointer identity the broker mines
const ANCHOR_A = micromineTx({ type: 'anchor', event: 'task.created', hash: digest('a'), ts: '2026-07-08T22:54:11.727Z' });
const ANCHOR_B = micromineTx({ type: 'anchor', event: 'task.verified', hash: digest('b'), ts: '2026-07-09T10:00:00.000Z' });
// what a relaying node used to bake into the id
const wrap = (tx, i) => ({ ...tx, from: `xmb${i}`, sig: `SIG${i}`, validationTimestamp: `17894709711160000${i}`, id: `submitter-${i}` });
// the PRE-content-id derivation: sha256 of the whole serialized tx, first 16 hex
const legacyId = (tx) => createHash('sha256').update(JSON.stringify(tx)).digest('hex').slice(0, 16);
const legacyRow = (tx) => JSON.stringify({ id: legacyId(tx), tx, hash: createHash('sha256').update(JSON.stringify(tx)).digest('hex'), digitalRoot: 0, timestamp: { __bigint__: '0' }, location: null });

const rowsOf = async (db) => {
  const rows = [];
  for await (const [k, v] of db.iterator({ gte: 'block:', lt: 'block;' })) rows.push({ key: k.toString().slice('block:'.length), row: JSON.parse(v.toString()) });
  return rows;
};
const boot = async (dir) => { const led = new Ledger({ dbPath: dir }); await led.ready(); return led; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('envelope-keyed rows are re-keyed to content ids on the next boot, once — and untyped rows are deleted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xclt-rekey-'));
  try {
    // Seed a store the way a pre-content-id node left it: anchor A under THREE envelope ids, anchor B under one,
    // a TYPED identity tx under an envelope id (re-keyed like any other content), and one UNTYPED anchor row —
    // what every row written before the type rule looks like — which must be deleted, not evicted.
    const seed = new Level(dir, { valueEncoding: 'utf8' });
    await seed.open();
    const legacy = [wrap(ANCHOR_A, 1), wrap(ANCHOR_A, 2), wrap(ANCHOR_A, 3), wrap(ANCHOR_B, 1)];
    for (const tx of legacy) await seed.put(`block:${legacyId(tx)}`, legacyRow(tx));
    const identityTx = micromineTx({ type: 'identity', publicKey: 'pk', signature: 'sg', timestamp: 1 });
    await seed.put(`block:${legacyId(identityTx)}`, legacyRow(identityTx));
    const untypedAnchor = { type: 'anchor', event: 'task.created', hash: digest('u'), ts: '2026-07-01T00:00:00.000Z', from: 'xmb9', sig: 'SIG9' };
    await seed.put(`block:${legacyId(untypedAnchor)}`, legacyRow(untypedAnchor));
    await seed.put('pool:membership', JSON.stringify([...legacy, identityTx, untypedAnchor].map(legacyId)));
    assert.strictEqual((await rowsOf(seed)).length, 6, 'seeded rows');
    await seed.close();

    // FIRST BOOT: converges, and says what it deleted.
    let led = new Ledger({ dbPath: dir });
    let rehydrated = new Promise((r) => led.once('pools:rehydrated', r));
    await led.ready();
    let info = await rehydrated;
    assert.strictEqual(info.untyped, 1, 'the untyped row is counted');
    let rows = await rowsOf(led.db);
    assert.strictEqual(rows.length, 3, `expected 3 rows after boot (A, B, identity), got ${rows.length}`);
    assert.ok(rows.every((r) => contentKey(r.row.tx) !== null), 'every surviving row is content-addressed');
    for (const r of rows) {
      assert.strictEqual(r.key, Block.fromTransaction(r.row.tx).id, `row ${r.key} is keyed by its content id`);
      assert.strictEqual(r.row.id, r.key, 'the stored block carries its content id');
    }
    assert.deepStrictEqual(rows.map((r) => contentKey(r.row.tx)).sort(), [contentKey(ANCHOR_A), contentKey(ANCHOR_B), contentKey(identityTx)].sort());
    assert.ok(!rows.some((r) => r.row.tx.hash === untypedAnchor.hash), 'the untyped anchor row is gone');
    assert.ok(!led._evicted.has(contentKey(untypedAnchor)), 'deleted, NOT evicted — its typed successor is welcome');
    // the pool re-derived from the survivors, not the stale envelope ids
    assert.strictEqual(led._membershipPool.length, 3, 'pool holds the three survivors');
    assert.ok(led._membershipPool.every((b) => b.id === Block.fromTransaction(b.tx).id), 'pool ids are content ids');
    assert.ok(led._anchorKeys.has(contentKey(ANCHOR_A)) && led._anchorKeys.has(contentKey(ANCHOR_B)), 'dedup set rebuilt');
    // a re-submission of the collapsed anchor is a duplicate, not a fourth row
    const dup = await led.addTransaction(wrap(ANCHOR_A, 9));
    assert.strictEqual(dup.duplicate, true);
    // the untyped anchor's TYPED successor is admitted (same event:hash, now with its identity)
    const typedSuccessor = micromineTx({ type: 'anchor', event: untypedAnchor.event, hash: untypedAnchor.hash, ts: untypedAnchor.ts });
    const adm = await led.addTransaction(typedSuccessor);
    assert.ok(adm.id && !adm.evicted && !adm.duplicate, 'typed successor of a deleted untyped row is admitted');
    assert.strictEqual((await rowsOf(led.db)).length, 4, '3 survivors + the typed successor');
    await led.db.close();

    // SECOND BOOT: nothing to do, and it says so.
    led = new Ledger({ dbPath: dir });
    rehydrated = new Promise((r) => led.once('pools:rehydrated', r));
    await led.ready();
    info = await rehydrated;
    assert.strictEqual(info.legacyKeyed, 0, 'no envelope-keyed rows remain');
    assert.strictEqual(info.untyped, 0, 'no untyped rows remain');
    assert.strictEqual(info.rekey, null, 'compaction did not run');
    assert.strictEqual((await rowsOf(led.db)).length, 4);
    await led.db.close();
  } finally {
    await sleep(20);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy row the current rule refuses is evicted during convergence, never re-keyed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xclt-rekey-bad-'));
  try {
    const seed = new Level(dir, { valueEncoding: 'utf8' });
    await seed.open();
    // the fabricated anchor from the 2026-09-16 audit: a label where a digest belongs, signed and sealed anyway
    // (typed — micromining does not judge the hash; the SHAPE rule does, and it is what evicts a label-for-a-digest)
    const bad = wrap(micromineTx({ type: 'anchor', event: 'proof.mined', hash: 'proofofmined-1789450900844', ts: '2026-09-15T00:00:00.000Z' }), 1);
    const good = wrap(ANCHOR_A, 1);
    await seed.put(`block:${legacyId(bad)}`, legacyRow(bad));
    await seed.put(`block:${legacyId(good)}`, legacyRow(good));
    await seed.close();

    const led = await boot(dir);
    const rows = await rowsOf(led.db);
    assert.strictEqual(rows.length, 1, 'the fabricated anchor is gone, the real one survives');
    assert.strictEqual(contentKey(rows[0].row.tx), contentKey(ANCHOR_A));
    assert.ok(led._evicted.has(contentKey(bad)), 'the fabricated anchor is on the eviction list');
    const again = await led.addTransaction(bad);
    assert.strictEqual(again.evicted, true, 'resubmitting it is refused as evicted');
    await led.db.close();
  } finally {
    await sleep(20);
    rmSync(dir, { recursive: true, force: true });
  }
});
