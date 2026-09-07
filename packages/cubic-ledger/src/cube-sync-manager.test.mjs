// SyncManager wiring: two in-process nodes on a fake mesh must converge. Test 0 is the control — if they were
// already identical, "converged" would prove nothing.
import { createHash } from 'crypto';
import assert from 'assert';
import { CubeSyncManager } from './cube-sync-manager.js';
import { faceRootOf, cubeIdOf, cubeRootOf, setDigest } from './cube-sync.js';
import { EventEmitter } from 'events';

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const txHash = (tx) => createHash('sha256').update(JSON.stringify(tx)).digest('hex');

// A fake floodsub: publish delivers to every OTHER node subscribed to the topic.
class Bus {
  constructor() { this.nodes = []; }
  attach(n) { this.nodes.push(n); }
}
class FakeXn extends EventEmitter {
  constructor(bus) { super(); this.bus = bus; this.started = true; this.topics = new Set(); bus.attach(this); }
  async subscribe(t) { this.topics.add(t); }
  async publish(t, msg) {
    for (const n of this.bus.nodes) if (n !== this && n.topics.has(t)) {
      setImmediate(() => n.emit(`message:${t}`, JSON.parse(JSON.stringify(msg))));
    }
  }
}
// Minimal ledger backed by a Map, exposing the same iterator shape the manager uses.
class FakeLedger {
  constructor() { this.store = new Map(); this._membershipPool = []; this.db = {
    iterator: ({ gte, lt }) => ({ [Symbol.asyncIterator]: async function* () {
      for (const [k, v] of [...this.store.entries()].sort()) if (k >= gte && k < lt) yield [k, v];
    }.bind(this) }),
    put: async (k, v) => { this.store.set(k, v); },
  }; }
  getMembershipPool() { return this._membershipPool; }
}
function seedCube(ledger, salt) {
  const faces = [];
  for (let f = 0; f < 3; f++) {
    const blocks = [];
    for (let i = 0; i < 9; i++) {
      const tx = { type: 'anchor', event: 'e', hash: `h${salt}${f}${i}`, from: 'xmbA', sig: 'S' };
      blocks.push({ hash: txHash(tx), tx });
    }
    faces.push({ root: faceRootOf(blocks.map(b => b.hash)), blocks });
  }
  const roots = faces.map(f => f.root);
  const id = cubeIdOf(roots);
  const rank = new Map([...roots].sort().map((r, i) => [r, i]));
  ledger.store.set(`cube:${id}`, JSON.stringify({ id, merkleRoot: cubeRootOf(roots), faces: [0, 1, 2], level: 1 }));
  for (const f of faces) {
    const fi = rank.get(f.root);
    [...f.blocks].sort((a, b) => a.hash < b.hash ? -1 : 1).forEach((b, position) => {
      ledger.store.set(`block:${b.hash.slice(0, 16)}`, JSON.stringify({
        id: b.hash.slice(0, 16), hash: b.hash, tx: b.tx,
        location: { faceIndex: fi, position, cubeIndex: id, cubeSequentialIndex: 0, level: 1 },
      }));
    });
  }
  return id;
}
const settle = (ms = 700) => new Promise(r => setTimeout(r, ms));

console.log('\n0. control — the two nodes must START divergent');
const bus = new Bus();
const lA = new FakeLedger(), lB = new FakeLedger();
const idA = seedCube(lA, 'A'), idB = seedCube(lB, 'B');
const A = new CubeSyncManager({ xn: new FakeXn(bus), ledger: lA, nodeId: 'A' });
const B = new CubeSyncManager({ xn: new FakeXn(bus), ledger: lB, nodeId: 'B' });
await check('A and B hold different, non-overlapping cubes', async () => {
  const a = await A.localCubes(), b = await B.localCubes();
  assert.strictEqual(a.length, 1); assert.strictEqual(b.length, 1);
  assert.notStrictEqual(setDigest(a), setDigest(b), 'control invalid: already identical');
  assert.strictEqual(a[0].id === b[0].id, false);
});

console.log('\n1. a node can serve a cube it holds');
await check('buildPayload reconstructs 3 faces of 9 from persisted membership', async () => {
  const p = await A.buildPayload(idA);
  assert.ok(p, 'could not rebuild payload');
  assert.strictEqual(p.faces.length, 3);
  for (const f of p.faces) assert.strictEqual(f.blocks.length, 9);
});
await check('a cube with no membership on disk is NOT served', async () => {
  const l = new FakeLedger();
  l.store.set('cube:deadbeefdeadbeef', JSON.stringify({ id: 'deadbeefdeadbeef', merkleRoot: 'x' }));
  const m = new CubeSyncManager({ xn: new FakeXn(new Bus()), ledger: l, nodeId: 'C' });
  assert.strictEqual(await m.buildPayload('deadbeefdeadbeef'), null);
});

console.log('\n2. CONVERGENCE over the mesh');
await check('after sync rounds both nodes hold BOTH cubes with equal digests', async () => {
  await A.start(); await B.start();
  for (let i = 0; i < 4; i++) { await A.advertise(); await B.advertise(); await settle(); }
  const a = await A.localCubes(), b = await B.localCubes();
  assert.strictEqual(a.length, 2, `A has ${a.length} cubes, expected 2`);
  assert.strictEqual(b.length, 2, `B has ${b.length} cubes, expected 2`);
  assert.strictEqual(setDigest(a), setDigest(b), 'digests still differ after sync');
  assert.ok(a.some(c => c.id === idB), 'A did not adopt B\'s cube');
  assert.ok(b.some(c => c.id === idA), 'B did not adopt A\'s cube');
  A.stop(); B.stop();
});
await check('adopted blocks landed with the content cube id as cubeIndex', async () => {
  const adopted = [...lA.store.entries()].filter(([k]) => k.startsWith('block:')).map(([, v]) => JSON.parse(v))
    .filter(b => b.location.cubeIndex === idB);
  assert.strictEqual(adopted.length, 27, `expected 27 adopted blocks, got ${adopted.length}`);
});
await check('adopt counters moved and nothing was rejected', async () => {
  assert.ok(A.stats.adopted >= 1 && B.stats.adopted >= 1, JSON.stringify({ A: A.stats, B: B.stats }));
  assert.strictEqual(A.stats.rejected + B.stats.rejected, 0);
});

console.log('\n3. idempotence + safety');
await check('a second sync round adopts nothing new', async () => {
  const before = A.stats.adopted;
  await A.advertise(); await B.advertise(); await settle();
  assert.strictEqual((await A.localCubes()).length, 2);
  assert.strictEqual(A.stats.adopted, before, 're-adopted an already-held cube');
});
await check('XCS_SYNC=0 disables it cleanly', async () => {
  process.env.XCS_SYNC = '0';
  const m = new CubeSyncManager({ xn: new FakeXn(new Bus()), ledger: new FakeLedger(), nodeId: 'D' });
  assert.strictEqual(await m.start(), false);
  delete process.env.XCS_SYNC;
});

console.log('\n4. unservable cubes must NOT wedge the loop (the live stall)');
await check('in-flight slots are freed by TTL when a request is never answered', async () => {
  const l = new FakeLedger();
  const m = new CubeSyncManager({ xn: new FakeXn(new Bus()), ledger: l, nodeId: 'E' });
  m.pendingTtlMs = 10;
  const peer = { nodeId: 'P', cubes: Array.from({ length: 8 }, (_, i) => ({ id: `id${i}`, merkleRoot: 'r' })) };
  await m._onList(peer);
  assert.strictEqual(m._pending.size, m.maxInFlight, 'did not fill the in-flight window');
  await new Promise(r => setTimeout(r, 30));
  m._expirePending();
  assert.strictEqual(m._pending.size, 0, 'stale requests still holding slots');
  assert.strictEqual(m._unservable.size, m.maxInFlight, 'unanswered ids not recorded');
});
await check('the next round asks for DIFFERENT ids, not the same lowest 4 forever', async () => {
  const l = new FakeLedger();
  const m = new CubeSyncManager({ xn: new FakeXn(new Bus()), ledger: l, nodeId: 'F' });
  m.pendingTtlMs = 10;
  const peer = { nodeId: 'P', cubes: Array.from({ length: 8 }, (_, i) => ({ id: `id${i}`, merkleRoot: 'r' })) };
  await m._onList(peer);
  const first = [...m._pending.keys()].sort();
  await new Promise(r => setTimeout(r, 30));
  await m._onList(peer);
  const second = [...m._pending.keys()].sort();
  assert.notDeepStrictEqual(second, first, 'requested the identical set again — this is the live stall');
});
await check('an id past maxAttempts is dropped entirely', async () => {
  const l = new FakeLedger();
  const m = new CubeSyncManager({ xn: new FakeXn(new Bus()), ledger: l, nodeId: 'G' });
  m.pendingTtlMs = 5; m.maxAttempts = 2;
  const peer = { nodeId: 'P', cubes: [{ id: 'only', merkleRoot: 'r' }] };
  for (let i = 0; i < 4; i++) { await m._onList(peer); await new Promise(r => setTimeout(r, 15)); m._expirePending(); }
  await m._onList(peer);
  assert.strictEqual(m._pending.has('only'), false, 'kept requesting a permanently unservable cube');
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
