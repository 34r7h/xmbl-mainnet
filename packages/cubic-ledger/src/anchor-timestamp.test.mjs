import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anchorTimestampNanos, blockTimestampNanos, Ledger, micromineTx } from '../index.js';

// The broker's canonical feed sends `ts` as an ISO string. Number("2026-07-08T22:54:11.727Z") is NaN,
// and the old line `BigInt(Math.max(0, Math.floor(Number(a.ts) || 0)))` turned that into 0n — measured
// on a live ledger as 3,967 of 3,967 rebuilt rows pinned to the epoch.
test('an ISO string is parsed, not coerced to zero', () => {
  const ns = anchorTimestampNanos('2026-07-08T22:54:11.727Z');
  assert.strictEqual(typeof ns, 'bigint');
  assert.notStrictEqual(ns, 0n);
  assert.strictEqual(ns, BigInt(Date.parse('2026-07-08T22:54:11.727Z')) * 1000000n);
});

test('epoch-ms is scaled to nanoseconds, the unit the rest of the ledger measures in', () => {
  assert.strictEqual(anchorTimestampNanos(1783551251727), 1783551251727000000n);
  assert.strictEqual(anchorTimestampNanos('1783551251727'), 1783551251727000000n);
});

test('a BigInt is already nanoseconds and passes through untouched', () => {
  assert.strictEqual(anchorTimestampNanos(1783551251727000000n), 1783551251727000000n);
});

test('an anchor that recorded no time stays 0n rather than borrowing the local clock', () => {
  for (const bad of [undefined, null, '', 0, -5, 'not a date', NaN, {}, []]) {
    assert.strictEqual(anchorTimestampNanos(bad), 0n, `expected 0n for ${JSON.stringify(bad)}`);
  }
});

test('rebuildFromAnchors pins every rebuilt block to the anchor time, not to 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xclt-ts-'));
  try {
    const led = new Ledger({ dbPath: dir });
    if (typeof led.ready === 'function') await led.ready();
    // typed canonical rows, as the feed must carry them: {xid, nonce, prior} mined per anchor
    const anchors = [
      { event: 'task.created',        hash: 'a'.repeat(64), ts: '2026-07-08T22:54:11.727Z' },
      { event: 'value.transfer',      hash: 'b'.repeat(64), ts: '2026-08-01T00:00:00.000Z' },
      { event: 'settlement.executed', hash: 'c'.repeat(64), ts: '2026-09-16T03:10:32.424Z' }
    ].map((a) => { const t = micromineTx({ type: 'anchor', ...a }); return { ...a, xid: t.xid, nonce: t.nonce, prior: t.prior }; });
    await led.rebuildFromAnchors(anchors);
    const got = [...led.blocks.values()].filter(b => b.tx?.type === 'anchor');
    assert.strictEqual(got.length, 3);
    for (const b of got) {
      assert.strictEqual(typeof b.timestamp, 'bigint');
      assert.notStrictEqual(b.timestamp, 0n, `block ${b.id} rebuilt at the epoch`);
      const ms = Number(b.timestamp / 1000000n);
      assert.strictEqual(new Date(ms).toISOString(), b.tx.ts);
    }
    // distinct times, so face/cube placement keys cannot all collide on "0"
    assert.strictEqual(new Set(got.map(b => b.timestamp.toString())).size, 3);
    try { await led.db.close(); } catch { /* already closed */ }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The rescue pass that re-admits non-anchor blocks was re-stamping them with Date.now(), because rows
// written before Block.serialize() carried `timestamp` have no timestamp field and the constructor
// defaults an absent one to the local clock. MEASURED on a rebuild of a real ledger: all 276 value-tx
// blocks came back inside a 58ms window at the instant the rebuild ran.
test('a preserved block keeps its own validation time, not the clock of whoever rebuilt', () => {
  const ns = blockTimestampNanos({ timestamp: undefined, tx: { type: 'tx', validationTimestamp: '1789470971116000000' } });
  assert.strictEqual(ns, 1789470971116000000n);
});

test('a preserved block that knows no time gets 0n, never the local clock', () => {
  const ns = blockTimestampNanos({ tx: { type: 'tx' } });
  assert.strictEqual(ns, 0n);
});

test('a rebuild does not re-time the blocks it rescues', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xclt-preserve-'));
  try {
    const led = new Ledger({ dbPath: dir });
    if (typeof led.ready === 'function') await led.ready();
    // Write a value-tx row in the legacy on-disk shape: no `timestamp` field at all.
    const tx = { type: 'tx', chain: 'xmbl', from: ['a'], to: ['b'], asset: 'USDC', amount: '1',
                 seq: 1, prev: '0'.repeat(64), unspent: '', xid: '06' + 'a'.repeat(62), nonce: 7,
                 validationTimestamp: '1789470971116000000', id: 'f'.repeat(64) };
    await led.db.put('block:deadbeefdeadbeef', JSON.stringify(
      { id: 'deadbeefdeadbeef', tx, hash: 'd'.repeat(64), digitalRoot: 0, location: null }));

    const before = Date.now();
    const one = micromineTx({ type: 'anchor', event: 'task.created', hash: 'a'.repeat(64), ts: '2026-07-08T22:54:11.727Z' });
    await led.rebuildFromAnchors([{ event: one.event, hash: one.hash, ts: one.ts, xid: one.xid, nonce: one.nonce, prior: one.prior }]);
    const b = led.blocks.get('deadbeefdeadbeef');
    assert.ok(b, 'the value tx was not preserved');
    assert.strictEqual(b.timestamp, 1789470971116000000n);
    // the failing shape was a millisecond value from the rebuild instant
    assert.ok(!(typeof b.timestamp === 'number' && b.timestamp >= before), 'block re-stamped with the local clock');
    try { await led.db.close(); } catch { /* already closed */ }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
