import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anchorTimestampNanos, Ledger } from '../index.js';

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
    const anchors = [
      { event: 'task.created',        hash: 'a'.repeat(64), ts: '2026-07-08T22:54:11.727Z' },
      { event: 'value.transfer',      hash: 'b'.repeat(64), ts: '2026-08-01T00:00:00.000Z' },
      { event: 'settlement.executed', hash: 'c'.repeat(64), ts: '2026-09-16T03:10:32.424Z' }
    ];
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
