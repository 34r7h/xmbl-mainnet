import { createHash } from 'node:crypto';
// A CANONICAL REBUILD MAY DISCARD A DIVERGENT CHAIN. IT MAY NOT DISCARD STATE THE CANONICAL SET DOES NOT
// DESCRIBE. The broker's canonical set is anchors and nothing else, so every type-6 value tx, utxo, identity
// and contract a node holds is outside it by construction — and rebuildFromAnchors cleared the whole `block:`
// keyspace before rebuilding only the anchors. The convergence timer calls it every ~90 seconds.
//
// MEASURED on this node's own ledger 2026-09-15, same store both runs:
//   @xmbl/cubic-ledger@0.1.3  before {anchor 14642, tx 249} -> after {anchor 3492}        249 destroyed
//   fixed                     before {anchor 14642, tx 249} -> after {anchor 3495, tx 249}  249 survive
import { test } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { Ledger } from './ledger.js';
import { micromine, type6TxBody } from './micromine.js';
import { micromineTx } from './transaction-validator.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const countByType = async (db) => {
  const t = {};
  for await (const [, v] of db.iterator({ gte: 'block:', lt: 'block;' })) {
    let b; try { b = JSON.parse(v.toString()); } catch { continue; }
    const k = (b.tx && b.tx.type) || '(none)'; t[k] = (t[k] || 0) + 1;
  }
  return t;
};

test('a canonical rebuild keeps every block the anchor set cannot re-derive', async () => {
  const dir = `/tmp/xclt-preserve-${process.pid}`;
  rmSync(dir, { recursive: true, force: true });
  const led = new Ledger({ dbPath: dir });
  for (let i = 0; i < 100 && !led._dbOpen; i++) await sleep(50);

  // typed anchors, as the broker mines them: the canonical set hands {xid, nonce, prior} over with each row
  const anchors = Array.from({ length: 30 }, (_, i) => {
    const t = micromineTx({ type: 'anchor', event: 'task.created', hash: createHash('sha256').update(`anchor-${i}`).digest('hex'), ts: 1000 + i });
    return { event: t.event, hash: t.hash, ts: t.ts, xid: t.xid, nonce: t.nonce, prior: t.prior };
  });
  for (const a of anchors) await led.addTransaction({ type: 'anchor', ...a });
  for (let i = 0; i < 12; i++) {
    const t = { chain: 'xmbl', from: ['xmbA'], to: ['xmbB'], asset: 'XMBL', amount: 1 + i, seq: i, prev: '', unspent: '' };
    const { xid, nonce } = micromine(type6TxBody(t), 6);
    await led.addTransaction({ type: 'tx', xid, nonce, ...t });
  }
  const before = await countByType(led.db);
  assert.strictEqual(before.tx, 12, 'fixture must hold 12 value txs');

  // Rebuild against a canonical set that is a SUBSET of the anchors and contains no value tx at all —
  // which is what the broker serves.
  const r = await led.rebuildFromAnchors(anchors.slice(0, 10));
  const after = await countByType(led.db);

  assert.strictEqual(r.preserved, 12, 'the rebuild must report what it rescued');
  assert.strictEqual(after.tx, 12, 'every value transaction must survive the rebuild');
  assert.ok((after.anchor ?? 0) <= 10, 'non-canonical anchors are still discarded — that is the point of it');

  // And it must be idempotent: a second rebuild over the same set must not lose them either.
  await led.rebuildFromAnchors(anchors.slice(0, 10));
  const twice = await countByType(led.db);
  assert.strictEqual(twice.tx, 12, 'a repeated rebuild must not erode the preserved set');

  await led.db.close();
  rmSync(dir, { recursive: true, force: true });
});
