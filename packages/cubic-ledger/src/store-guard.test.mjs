// THE LEDGER STORE'S OWN LIMITS (v0.1.31): a write fault is reported once, a full disk refuses admissions at the
// door with nothing changed, and a store that is mostly dead versions is compacted at boot. See store-guard.js
// for the measurement behind each rule. Asserted by what is on disk and in memory after the fact.
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Level } from 'level';
import { Ledger, micromineTx, STORE_FAULT_EXIT_CODE, isStoreFault } from '../index.js';
import { dirBytes } from './store-guard.js';

const digest = (label) => createHash('sha256').update(label).digest('hex');
const anchorTx = (label) => micromineTx({ type: 'anchor', event: 'task.created', hash: digest(label), ts: '2026-07-08T22:54:11.727Z' });
const tmp = (tag) => mkdtempSync(join(tmpdir(), `xclt-sg-${tag}-`));
const blockRows = async (db) => { let n = 0; for await (const _ of db.iterator({ gte: 'block:', lt: 'block;' })) n++; return n; };
const GiB = 1024 ** 3;
// the boot measurement, or a clear failure when the ledger never reports one (0.1.30 has no such event)
const measuredOf = (led, ms = 20_000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no store:measured within ${ms} ms`)), ms);
  led.once('store:measured', (out) => { clearTimeout(t); resolve(out); });
});

test('the exit code is EX_IOERR (74), not the OTA restart code (75)', () => {
  assert.strictEqual(STORE_FAULT_EXIT_CODE, 74);
});

test('the fault classifier: IO and corruption are faults; a closed handle and a refusal are not', () => {
  const err = (code, message = 'x') => Object.assign(new Error(message), { code });
  assert.strictEqual(isStoreFault(err('LEVEL_IO_ERROR', 'IO error: /x/000123.log: No space left on device')), true);
  assert.strictEqual(isStoreFault(err('LEVEL_CORRUPTION')), true);
  assert.strictEqual(isStoreFault(err(undefined, 'IO error: No space left on device')), true);
  assert.strictEqual(isStoreFault(Object.assign(new Error('wrapped'), { cause: err('LEVEL_IO_ERROR') })), true);
  assert.strictEqual(isStoreFault(err('LEVEL_DATABASE_NOT_OPEN', 'Database is not open')), false);
  assert.strictEqual(isStoreFault(err('LEDGER_DISK_LOW')), false);
  assert.strictEqual(isStoreFault(null), false);
});

test('a write fault is emitted once as store:fault, though the call site swallows it', async () => {
  const dir = tmp('fault');
  try {
    const led = new Ledger({ dbPath: dir, consensusV2: true, bootCompact: false });
    // the store starts refusing batches the way LevelDB does on a full disk; installed before open, so the
    // ledger's own guard wraps it like the real one
    led.db.batch = async () => { throw Object.assign(new Error('IO error: 000042.log: No space left on device'), { code: 'LEVEL_IO_ERROR' }); };
    const faults = [];
    led.on('store:fault', (f) => faults.push(f));
    await led.ready();
    await led.addTransaction(anchorTx('f1'));   // block put succeeds, pool batch faults, the call returns
    await led.addTransaction(anchorTx('f2'));
    assert.strictEqual(faults.length, 1, `store:fault emitted ${faults.length} time(s)`);
    assert.strictEqual(faults[0].code, 'LEVEL_IO_ERROR');
    assert.ok(led.storeHealth().faulted, 'storeHealth reports the fault');
    await led.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the daemon exits on store:fault with the store-fault code', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../core/bin/xmbl-node.js', import.meta.url), 'utf8');
  assert.match(src, /core\.xclt\?\.on\?\.\('store:fault'[\s\S]{0,400}shutdown\('store-fault', \{ exitCode: STORE_FAULT_EXIT_CODE \}\)/);
});

test('free disk under the floor refuses admissions at the door: nothing in memory, nothing on disk', async () => {
  const dir = tmp('disk');
  try {
    let free = 0.5 * GiB;
    const led = new Ledger({ dbPath: dir, diskFreeBytes: () => free, bootCompact: false });
    const low = [];
    led.on('store:disk-low', (d) => low.push(d));
    await led.ready();
    const rowsBefore = await blockRows(led.db);
    await assert.rejects(led.addTransaction(anchorTx('d1')), (e) => e.code === 'LEDGER_DISK_LOW');
    await assert.rejects(led.addSealedBatch([anchorTx('d2')]), (e) => e.code === 'LEDGER_DISK_LOW');
    await assert.rejects(led.rebuildFromAnchors([]), (e) => e.code === 'LEDGER_DISK_LOW');
    assert.strictEqual(led._membershipPool.length, 0, 'nothing pooled');
    assert.strictEqual(led._anchorKeys.size, 0, 'no anchor key claimed by a refused admission');
    assert.strictEqual(await blockRows(led.db), rowsBefore, 'no row written');
    assert.strictEqual(low.length, 1, 'disk-low said once');
    // room again (past the 10 s reading cache): admitted
    free = 50 * GiB;
    led._diskCheck = null;
    const r = await led.addTransaction(anchorTx('d1'));
    assert.ok(r.id, 'admitted once there is room');
    assert.strictEqual(await blockRows(led.db), rowsBefore + 1);
    await led.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the floor is max(1 GiB, 2 x live ledger bytes)', async () => {
  const dir = tmp('floor');
  try {
    const led = new Ledger({ dbPath: dir, diskFreeBytes: () => 1.5 * GiB, bootCompact: false });
    await led.ready();
    led._liveBytes = 0.25 * GiB; led._diskCheck = null;
    assert.strictEqual(led._diskRoom().need, GiB, 'small ledger: the 1 GiB floor');
    assert.strictEqual(led._diskRoom().ok, true);
    led._liveBytes = 1 * GiB; led._diskCheck = null;
    assert.strictEqual(led._diskRoom().need, 2 * GiB, 'large ledger: twice its live bytes');
    assert.strictEqual(led._diskRoom().ok, false);
    await led.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('boot compaction: a store that is mostly dead versions is compacted once at boot', async () => {
  const dir = tmp('compact');
  try {
    // 0.1.30's failure in miniature: one key rewritten many times. A real ledger holds 30 anchors; then one of
    // its block rows is overwritten 400 times with 64 KiB of random bytes (LevelDB compresses each block, so a
    // repetitive value would hide the dead bytes) and finally put back. 25 MiB written, the live rows unchanged.
    const seed = new Ledger({ dbPath: dir, bootCompact: false });
    await seed.ready();
    for (let i = 0; i < 30; i++) await seed.addTransaction(anchorTx(`c${i}`));
    await seed.close();
    const raw = new Level(dir, { valueEncoding: 'utf8' });
    await raw.open();
    let rowKey = null, rowValue = null;
    for await (const [k, v] of raw.iterator({ gte: 'block:', lt: 'block;', limit: 1 })) { rowKey = k; rowValue = v; }
    assert.ok(rowKey, 'the seed ledger wrote block rows');
    for (let i = 0; i < 400; i++) await raw.put(rowKey, randomBytes(48 * 1024).toString('base64'));
    await raw.put(rowKey, rowValue);
    const rowsSeeded = await blockRows(raw);
    await raw.close();
    const before = dirBytes(dir);
    const MIN = 4 * 1024 * 1024;
    assert.ok(before > MIN, `seeded store is ${before} B`);

    const led = new Ledger({ dbPath: dir, bootCompactMinBytes: MIN });
    const measured = measuredOf(led);
    await led.ready();
    const out = await measured;
    assert.strictEqual(out.compacted, true, `compacted: du ${out.du_before} B, live ${out.live} B`);
    assert.ok(out.du_after < out.du_before / 2, `du ${out.du_before} -> ${out.du_after} B`);
    assert.ok(led.storeHealth().live_bytes > 0, 'the live size is kept for the disk floor');
    assert.strictEqual(await blockRows(led.db), rowsSeeded, 'every live row survives the compaction');
    assert.strictEqual(led._anchorKeys.size, 30);
    await led.close();
    const after = dirBytes(dir);

    const again = new Ledger({ dbPath: dir, bootCompactMinBytes: MIN });
    const m2 = measuredOf(again);
    await again.ready();
    const out2 = await m2;
    assert.strictEqual(out2.compacted, false, `the second boot does not compact again (du ${after} B)`);
    await again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('boot compaction leaves a small store alone', async () => {
  const dir = tmp('small');
  try {
    const led = new Ledger({ dbPath: dir });
    const measured = measuredOf(led);
    await led.ready();
    await led.addTransaction(anchorTx('s1'));
    const out = await measured;
    assert.strictEqual(out.compacted, false);
    await led.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
