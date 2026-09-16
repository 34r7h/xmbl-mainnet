import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, Block, consensusBody, contentKey } from '../index.js';

const ANCHOR = { type: 'anchor', event: 'task.created', hash: 'a'.repeat(64), ts: '2026-07-08T22:54:11.727Z' };
// what a node adds on the way past: relayer, signature, its own validator's clock, its submitter's id
const ENVELOPED = { ...ANCHOR, from: 'xmbA', sig: 'SIG', validationTimestamp: '1789470971116000000',
                    id: 'whatever', agent: 'someagent', agent_xmbl_address: 'xmbZ' };

test('the same anchor has ONE id however it was wrapped, ordered or timed', () => {
  const bare = Block.fromTransaction(ANCHOR).id;
  assert.strictEqual(Block.fromTransaction(ENVELOPED).id, bare);
  // key order and a numeric ts for the same instant must not change it either
  const reordered = { hash: ANCHOR.hash, type: 'anchor', ts: Date.parse(ANCHOR.ts), event: ANCHOR.event };
  assert.strictEqual(Block.fromTransaction(reordered).id, bare);
});

test('block.hash is still the whole-tx hash — peers verify adopted cubes with it', () => {
  const txHash = (tx) => createHash('sha256')
    .update(JSON.stringify(tx, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).digest('hex');
  for (const tx of [ANCHOR, ENVELOPED]) {
    assert.strictEqual(Block.fromTransaction(tx).hash, txHash(tx));
  }
  // and the envelope still changes the hash, which is exactly why it must not reach the id
  assert.notStrictEqual(Block.fromTransaction(ANCHOR).hash, Block.fromTransaction(ENVELOPED).hash);
});

test('a type-6 value tx is addressed by its mined xid, not by its envelope', () => {
  const base = { type: 'tx', chain: 'xmbl', from: ['a'], to: ['b'], asset: 'USDC', amount: '0.3',
                 seq: 3, prev: '0'.repeat(64), unspent: '', xid: '06' + 'c'.repeat(62), nonce: 117 };
  assert.strictEqual(consensusBody(base), 'xid:' + base.xid);
  assert.strictEqual(contentKey(base), 'xid:' + base.xid);
  // MEASURED on this node's ledger: two rows carried this shape for one transfer, differing only in
  // validationTimestamp and the submitter's id — one payment, counted twice.
  const a = { ...base, validationTimestamp: '1789458010595500032', id: 'x'.repeat(64) };
  const b = { ...base, validationTimestamp: '1789471333962999936', id: 'y'.repeat(64) };
  assert.strictEqual(consensusBody(a), consensusBody(b));
});

test('a tx with no defined content address keeps the old whole-tx derivation', () => {
  assert.strictEqual(consensusBody({ type: 'identity', publicKey: 'k' }), null);
  assert.strictEqual(contentKey({ type: 'identity', publicKey: 'k' }), null);
});

test('an evicted tx is refused, and stays refused after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xclt-evict-'));
  try {
    const led = new Ledger({ dbPath: dir });
    if (typeof led.ready === 'function') await led.ready();
    await led.addTransaction(ANCHOR);
    const key = contentKey(ANCHOR);
    // addTransaction persists and pools; it does not populate led.blocks, so count rows on disk
    const rowsFor = async (k) => {
      let n = 0;
      for await (const [, v] of led.db.iterator({ gte: 'block:', lt: 'block;' })) {
        try { if (contentKey(JSON.parse(v).tx) === k) n++; } catch { /* unreadable */ }
      }
      return n;
    };
    assert.strictEqual(await rowsFor(key), 1);

    const r = await led.evict(key, 'test');
    assert.strictEqual(r.evicted, true);
    assert.strictEqual(r.rows_deleted, 1);
    assert.strictEqual(await rowsFor(key), 0);

    // never seen again — on this instance
    assert.strictEqual((await led.addTransaction(ANCHOR)).evicted, true);
    assert.strictEqual(await rowsFor(key), 0);
    // ...and on the sealed-batch path, which must not be a way around it
    await led.addSealedBatch([ANCHOR]);
    assert.strictEqual(await rowsFor(key), 0);
    await led.db.close();

    // ...and after a restart, which is the half an in-memory set cannot do
    const again = new Ledger({ dbPath: dir });
    if (typeof again.ready === 'function') await again.ready();
    await new Promise(r => setTimeout(r, 300));
    assert.ok(again._evicted.has(key), 'eviction did not survive the restart');
    assert.strictEqual((await again.addTransaction(ANCHOR)).evicted, true);
    await again.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compaction keeps one row per content key and re-keys it, without a rebuild', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xclt-compact-'));
  try {
    const led = new Ledger({ dbPath: dir });
    if (typeof led.ready === 'function') await led.ready();
    // three rows for ONE anchor, keyed the old way: whole-tx hash, so three different ids
    const variants = [ANCHOR, ENVELOPED, { ...ANCHOR, from: 'xmbB', sig: 'OTHER' }];
    for (const tx of variants) {
      const legacyId = createHash('sha256').update(JSON.stringify(tx)).digest('hex').slice(0, 16);
      await led.db.put(`block:${legacyId}`, JSON.stringify(
        { id: legacyId, tx, hash: createHash('sha256').update(JSON.stringify(tx)).digest('hex'),
          digitalRoot: 0, location: null }));
    }
    const count = async () => {
      let n = 0;
      for await (const [] of led.db.iterator({ gte: 'block:', lt: 'block;' })) n++;
      return n;
    };
    assert.strictEqual(await count(), 3);

    const r = await led.compactToContentIds();
    assert.strictEqual(r.scanned, 3);
    assert.strictEqual(r.kept, 1);
    assert.strictEqual(r.removed, 2);
    assert.strictEqual(r.balanced, true);
    assert.strictEqual(await count(), 1);

    // the survivor sits under its content id, and it is the bare-shape row
    const wantId = Block.fromTransaction(ANCHOR).id;
    const row = JSON.parse(await led.db.get(`block:${wantId}`));
    assert.strictEqual(row.id, wantId);
    assert.ok(!('sig' in row.tx), 'kept an enveloped row over the bare one');
    await led.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
