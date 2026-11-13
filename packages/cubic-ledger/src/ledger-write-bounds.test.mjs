// WHAT THE LEDGER WRITES, BY BYTE COUNT (v0.1.31).
//
// MEASURED 2026-11-13 on the operator's MacBook, node 0.1.30: the ledger directory was 11 GB for about 230 MB of
// live rows. The pool was stored as ONE key holding the whole member list (`pool:membership`), rewritten on every
// pooled block: 3.04 MB per write at 160k members, 207 versions in one boot, 37.3 GB of LevelDB compaction.
// A canonical rebuild made it worse: every tx finalized while the rebuild re-admitted its rescued rows rewrote
// the whole in-flight pool, and the ~90 s self-feed tick rewrote the list even with 0 fresh anchors.
//
// Each test counts the bytes the ledger hands LevelDB (key + value of every put, key of every del, one op per
// clear) through a wrapper on its own db handle, so the assertion is on what reached the store, not on which
// code path ran. Run against the 0.1.30 ledger.js, the idle, pooling and rebuild tests fail: that is the
// negative control. XMBL_GATE_POOL_N sets the pooling size (default 10,000).
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Level } from 'level';
import { Ledger, micromineTx } from '../index.js';

const digest = (label) => createHash('sha256').update(label).digest('hex');
const TS = '2026-07-08T22:54:11.727Z';
const anchorTx = (label) => micromineTx({ type: 'anchor', event: 'task.created', hash: digest(label), ts: TS });
// the row shape the canonical feed hands rebuild_ledger / append_canonical
const rowOf = (tx) => {
  const r = { event: tx.event, hash: tx.hash, ts: tx.ts, xid: tx.xid, nonce: tx.nonce };
  if (typeof tx.prior === 'string') r.prior = tx.prior;
  return r;
};
const rows = (prefix, n) => Array.from({ length: n }, (_, i) => rowOf(anchorTx(`${prefix}-${i}`)));
const identityTx = (i) => micromineTx({ type: 'identity', publicKey: `pk-${i}`, signature: `sg-${i}`, timestamp: 1_000 + i });

const len = (x) => (x == null ? 0 : Buffer.byteLength(typeof x === 'string' ? x : String(x)));
function meter(db) {
  const m = { ops: 0, bytes: 0, pool: 0, poolOps: 0, on: true };
  const note = (type, key, value) => {
    if (!m.on) return;
    const k = String(key);
    const b = len(k) + (type === 'put' ? len(value) : 0);
    m.ops++; m.bytes += b;
    if (k.startsWith('pool:')) { m.pool += b; m.poolOps++; }
  };
  const put = db.put.bind(db), del = db.del.bind(db), batch = db.batch.bind(db), clear = db.clear.bind(db);
  db.put = (k, v, o) => { note('put', k, v); return put(k, v, o); };
  db.del = (k, o) => { note('del', k); return del(k, o); };
  db.clear = (o) => { if (m.on) m.ops++; return clear(o); };
  db.batch = (ops, o) => {
    if (!Array.isArray(ops)) throw new Error('meter: chained batch is not counted — extend the meter before using it');
    for (const op of ops) note(op.type, op.key, op.value);
    return batch(ops, o);
  };
  m.reset = () => { m.ops = 0; m.bytes = 0; m.pool = 0; m.poolOps = 0; };
  return m;
}

const boot = async (dir, opts = {}) => { const led = new Ledger({ dbPath: dir, ...opts }); await led.ready(); return led; };
const tmp = (tag) => mkdtempSync(join(tmpdir(), `xclt-wb-${tag}-`));
const poolKeysOnDisk = async (db) => {
  const ids = new Set();
  for await (const [k] of db.iterator({ gte: 'pool:m:', lt: 'pool:m;' })) ids.add(k.toString().slice('pool:m:'.length));
  return ids;
};
const legacyListOnDisk = async (db) => { try { const v = await db.get('pool:membership'); return v === undefined || v === null ? null : v; } catch { return null; } };
const poolIds = (led) => new Set(led._membershipPool.map((b) => b.id));

test('an idle node writes 0 bytes: append ticks with nothing fresh touch no key', async (t) => {
  const dir = tmp('idle');
  try {
    const led = await boot(dir);
    const set = rows('idle', 30);                     // 3 faces sealed, 3 left pooled
    await led.rebuildFromAnchors(set);
    assert.ok(led._membershipPool.length > 0 && led._membershipPool.length < 9, `pool after rebuild: ${led._membershipPool.length}`);
    const m = meter(led.db);
    for (let i = 0; i < 10; i++) {
      const r1 = await led.appendFromAnchors([]);                 // the self-feed's empty journal delta
      assert.strictEqual(r1.appended, 0);
      const r2 = await led.appendFromAnchors(set);                // a re-delivery of the set already held
      assert.strictEqual(r2.appended, 0);
      assert.strictEqual(r2.held, set.length);
    }
    t.diagnostic(`20 idle ticks: ${m.ops} op(s), ${m.bytes} B, pool ${m.pool} B`);
    assert.strictEqual(m.ops, 0, `20 idle ticks issued ${m.ops} store op(s), ${m.bytes} B (pool ${m.pool} B)`);
    assert.strictEqual(m.bytes, 0);
    // the meter is live: one fresh anchor is a write
    const r = await led.appendFromAnchors([...set, rowOf(anchorTx('idle-fresh'))]);
    assert.strictEqual(r.appended, 1);
    assert.ok(m.ops > 0 && m.pool > 0, `a fresh anchor wrote ${m.ops} op(s), ${m.pool} pool B`);
    await led.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pooling N blocks writes O(N) pool bytes, not O(N^2)', async (t) => {
  const N = Number(process.env.XMBL_GATE_POOL_N) > 0 ? Number(process.env.XMBL_GATE_POOL_N) : 10_000;
  const dir = tmp('pool');
  try {
    const led = await boot(dir, { consensusV2: true });   // the candidate pool grows until a seal round agrees it
    const m = meter(led.db);
    for (let i = 0; i < N; i++) await led.addTransaction(anchorTx(`pool-${i}`));
    assert.strictEqual(led._membershipPool.length, N);
    const perMember = m.pool / N;
    t.diagnostic(`pooling ${N}: ${m.pool} pool B in ${m.poolOps} op(s), ${perMember.toFixed(1)} B per block; all writes ${m.bytes} B`);
    assert.ok(perMember <= 64, `pool bytes per pooled block: ${perMember.toFixed(1)} (total ${m.pool} B for ${N})`);
    if (N >= 10_000) assert.ok(m.pool < 1_048_576, `pooling ${N} blocks wrote ${m.pool} pool B, ceiling 1 MiB`);
    const onDisk = await poolKeysOnDisk(led.db);
    assert.deepStrictEqual(onDisk, poolIds(led), 'one pool key per member, no more, no fewer');
    await led.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a restart restores the same pool and writes no pool byte doing it', async () => {
  const dir = tmp('restart');
  try {
    let led = await boot(dir, { consensusV2: true });
    for (let i = 0; i < 500; i++) await led.addTransaction(anchorTx(`restart-${i}`));
    const before = poolIds(led);
    await led.close();
    // count the reboot's own writes on a raw handle the ledger will reuse
    led = new Ledger({ dbPath: dir, consensusV2: true });
    const m = meter(led.db);
    await led.ready();
    assert.deepStrictEqual(poolIds(led), before, 'the pool after a restart is the pool before it');
    assert.strictEqual(m.pool, 0, `the reboot wrote ${m.pool} pool B`);
    await led.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a 0.1.30 store migrates: the whole-list key becomes member keys and is deleted, once', async () => {
  const dir = tmp('migrate');
  try {
    let led = await boot(dir, { consensusV2: true });
    for (let i = 0; i < 200; i++) await led.addTransaction(anchorTx(`mig-${i}`));
    const want = poolIds(led);
    await led.close();
    // rewrite the pool the way 0.1.30 left it: no member keys, one JSON list
    const raw = new Level(dir, { valueEncoding: 'utf8' });
    await raw.open();
    for await (const [k] of raw.iterator({ gte: 'pool:m:', lt: 'pool:m;' })) await raw.del(k);
    await raw.put('pool:membership', JSON.stringify([...want]));
    assert.strictEqual((await poolKeysOnDisk(raw)).size, 0);
    await raw.close();

    led = await boot(dir, { consensusV2: true });
    assert.deepStrictEqual(poolIds(led), want, 'the legacy list is read');
    assert.deepStrictEqual(await poolKeysOnDisk(led.db), want, 'every member now has its key');
    assert.strictEqual(await legacyListOnDisk(led.db), null, 'the legacy list is deleted');
    await led.close();

    led = new Ledger({ dbPath: dir, consensusV2: true });
    const m = meter(led.db);
    await led.ready();
    assert.deepStrictEqual(poolIds(led), want, 'the second boot reads the member keys');
    assert.strictEqual(m.pool, 0, `the second boot wrote ${m.pool} pool B: the migration ran twice`);
    await led.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a rebuild persists the pool once: blocks admitted while it runs do not rewrite the in-flight pool', async (t) => {
  const K = 90, P = 900, M = 30;
  const dir = tmp('rebuild');
  try {
    const led = await boot(dir);
    for (let i = 0; i < P; i++) await led.addTransaction(identityTx(i));   // the non-anchor rows a rebuild rescues
    const set = rows('rb', K);
    const m = meter(led.db);
    // Live traffic during the rebuild: the first store op issued while the in-flight pool holds more than the
    // anchor set (the rescued rows are being re-admitted, or sealed) admits M new blocks without awaiting them.
    const adds = [];
    let fired = false;
    const fire = () => {
      if (fired || led._membershipPool.length <= K) return;
      fired = true;   // before the loop: an admission's own first put re-enters here
      for (let j = 0; j < M; j++) adds.push(led.addTransaction(identityTx(P + j)));
    };
    for (const name of ['put', 'batch', 'del']) {
      const inner = led.db[name];
      led.db[name] = (...a) => { fire(); return inner(...a); };
    }
    m.reset();
    const out = await led.rebuildFromAnchors(set);
    await Promise.all(adds);
    assert.strictEqual(adds.length, M, 'the traffic landed inside the rebuild');
    assert.strictEqual(out.anchors, K);
    const ceiling = 64 * (9 + M);
    t.diagnostic(`rebuild of ${K} anchors + ${P} rescued rows with ${M} concurrent admissions: ${m.pool} pool B in ${m.poolOps} op(s); all writes ${m.bytes} B in ${m.ops} op(s)`);
    assert.ok(m.pool <= ceiling, `the rebuild and its ${M} concurrent admissions wrote ${m.pool} pool B in ${m.poolOps} op(s), ceiling ${ceiling}`);
    assert.deepStrictEqual(await poolKeysOnDisk(led.db), poolIds(led), 'the pool on disk is the pool in memory');
    const inMemory = poolIds(led);
    await led.close();
    const again = await boot(dir);
    assert.deepStrictEqual(poolIds(again), inMemory, 'and a restart reads it back');
    await again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a rebuild that throws does not leave pool persistence switched off', async () => {
  const dir = tmp('throw');
  try {
    const led = await boot(dir, { consensusV2: true });
    const seal = led._sealReadyFaces;
    led._sealReadyFaces = async () => { throw new Error('seal failed (test)'); };
    await assert.rejects(led.rebuildFromAnchors(rows('th', 20)), /seal failed/);
    led._sealReadyFaces = seal;
    const tx = anchorTx('after-throw');
    const r = await led.addTransaction(tx);
    assert.ok(r.id);
    assert.ok((await poolKeysOnDisk(led.db)).has(r.id), 'a block pooled after the failed rebuild is persisted');
    await led.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
