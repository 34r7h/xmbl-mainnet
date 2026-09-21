// A LEDGER WHOSE STORE FAILED TO OPEN MUST SAY SO — never report itself durable and drop every write on the floor.
//
// _initDb used to set _dbOpen = true on the FAILURE branch as well ("might already be open"), so a LevelDB whose
// LOCK another process held produced a ledger that answered every add with an id while persisting nothing. A
// second process then found no row. Pinned here by holding the lock ourselves and opening a second Ledger on it.
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, micromineTx } from '../index.js';

const anchor = (label) => micromineTx({ type: 'anchor', event: 'task.created', hash: createHash('sha256').update(label).digest('hex'), ts: 1_700_000_000_000 });

test('a second ledger on a LOCKED store reports the store unavailable, and the first one keeps its rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xclt-lock-'));
  try {
    const first = new Ledger({ dbPath: dir });
    await first.ready();
    assert.strictEqual(first._dbOpen, true, 'the first open succeeds');

    const second = new Ledger({ dbPath: dir });
    const unavailable = new Promise((r) => second.once('store:unavailable', r));
    await second.ready();
    assert.strictEqual(second._dbOpen, false, 'a failed open is reported as NOT open');
    assert.ok(second._dbError, 'the reason is kept');
    const evt = await unavailable;
    assert.ok(evt && evt.error, 'store:unavailable carries the error');

    // the genuine ledger still works in memory and still answers with an id — it just never claims durability
    const r = await second.addTransaction(anchor('x'));
    assert.ok(r.id, 'in-memory add still yields the block id');
    let onDisk = 0;
    for await (const [k] of first.db.iterator({ gte: 'block:', lt: 'block;' })) { void k; onDisk++; }
    assert.strictEqual(onDisk, 0, 'nothing from the unopened ledger reached the store');

    // and the ledger that DOES hold the store persists
    const ok = await first.addTransaction(anchor('y'));
    let rows = 0;
    for await (const [k] of first.db.iterator({ gte: 'block:', lt: 'block;' })) { void k; rows++; }
    assert.strictEqual(rows, 1, 'the open ledger wrote its row');
    assert.strictEqual(ok.id, (await first.getBlock(ok.id)).id, 'and can read it back by the id it returned');
    await first.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
