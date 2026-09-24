// A STORAGE NODE MUST NEVER PASS FOR DURABLE WHEN IT IS NOT (MAINNET-GATES §@xmbl/storage-compute).
//
// _init() used to answer a failed LevelDB open with a bare `this.db = new Map()` — no throw, no flag, no
// log. The node then behaved exactly like a healthy one and every byte died at the next restart with
// nothing having said so. It is reached by an ordinary accident: LevelDB takes an EXCLUSIVE LOCK on its
// directory, so a second node on the same dbPath (two processes from one working directory, or a deploy
// whose restart overlaps the outgoing process) degrades one of them to RAM.
//
// The gate these tests hold: (1) a non-durable node SAYS SO, (2) it REFUSES to store rather than
// accepting bytes it cannot keep, (3) the check a caller would naively reach for — write, then read it
// back — CANNOT distinguish the two states, which is why (1) has to exist, and (4) an in-memory node is
// still available to anyone who ASKS for one. Run: node durability.test.mjs
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageNode } from './storage-node.js';

let pass = 0, fail = 0;
const check = async (n, f) => {
  try { await f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; }
};

const BYTES = Buffer.from('bytes a node must not claim to have stored', 'utf8');
const dbPath = await mkdtemp(join(tmpdir(), 'xmbl-durability-'));

// The holder of the lock — a healthy, durable node.
const healthy = new StorageNode({ capacity: 1 << 20, dbPath });
await healthy.ready();
// THE ACCIDENT, reproduced exactly: a second node aimed at the same directory.
const locked = new StorageNode({ capacity: 1 << 20, dbPath });
await locked.ready();
// The same accident, but declared.
const volatileNode = new StorageNode({ capacity: 1 << 20, dbPath, volatile: true });
await volatileNode.ready();

await check('a healthy node reports durable, stores, and reads back', async () => {
  const r = await healthy.ready();
  assert.equal(r.durable, true, 'healthy node should be durable');
  assert.equal(r.error, null);
  const id = await healthy.storeShard({ index: 0, data: BYTES });
  const got = await healthy.getShard(id);
  assert.equal(Buffer.compare(Buffer.from(got.data), BYTES), 0);
});

await check('a node that lost the race SAYS it is not durable, and names why', async () => {
  const r = await locked.ready();
  assert.equal(r.durable, false, 'a node whose open failed must not report durable');
  assert.ok(r.error, 'it must carry the reason, not just a boolean');
});

await check('⛔ it REFUSES to store rather than accepting bytes it cannot keep', async () => {
  await assert.rejects(
    () => locked.storeShard({ index: 0, data: BYTES }),
    /not durable/i,
    'an undeclared non-durable node must refuse storeShard',
  );
});

// THE REASON THE FLAG HAS TO EXIST. This asserts the WEAKNESS of the obvious health check, so nobody
// replaces ready() with a canary and believes they have covered this.
await check('a write-then-read canary CANNOT tell the two apart — so it is not a durability check', async () => {
  const canary = async (node) => {
    const id = await node.storeShard({ index: 0, data: BYTES });
    const got = await node.getShard(id);
    return Buffer.compare(Buffer.from(got.data), BYTES) === 0;
  };
  assert.equal(await canary(healthy), true);
  assert.equal(await canary(volatileNode), true, 'the in-memory node serves the read it just took');
  assert.notEqual((await healthy.ready()).durable, (await volatileNode.ready()).durable,
    'ready() distinguishes exactly what the canary cannot');
});

await check('durability is UNKNOWN until init settles — it never reads healthy early', async () => {
  const fresh = new StorageNode({ capacity: 1 << 20, dbPath });   // will lose the lock too
  assert.equal(fresh.durable, null, 'before init, durable must be null — not true, not false');
  assert.equal((await fresh.ready()).durable, false);
});

await check('an in-memory node is still available to a caller that ASKS for one', async () => {
  const r = await volatileNode.ready();
  assert.equal(r.volatile, true);
  assert.equal(r.durable, false, 'volatile is honest about not being durable');
  const id = await volatileNode.storeShard({ index: 0, data: BYTES });
  assert.ok(id, 'a declared volatile node stores');
});

console.log(`\nstorage durability: ${pass} passed, ${fail} failed`);
await rm(dbPath, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
