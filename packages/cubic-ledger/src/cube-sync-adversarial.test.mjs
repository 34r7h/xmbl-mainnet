// Cube sync END-TO-END adversarial rejection (MAINNET-GATES §@xmbl/cubic-ledger, T9.1).
// cube-sync.test.mjs already proves the PURE verifyCube() rejects a lie. This suite closes the
// remaining clause of the gate: when an inconsistent/contradictory block set is fed through the
// live ingestion path (CubeSyncManager._onCube → adopt, the code that actually WRITES to the
// ledger), the peer's lie must be REJECTED and LOCAL STATE MUST BE UNCHANGED — no cube record,
// no member block, no partial adoption slips into the db. Honest sync still converges (control).
// Run: node cube-sync-adversarial.test.mjs
import { createHash } from 'crypto';
import assert from 'assert';
import { CubeSyncManager } from './cube-sync-manager.js';
import { faceRootOf, cubeIdOf, cubeRootOf } from './cube-sync.js';

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const txHash = (tx) => createHash('sha256').update(JSON.stringify(tx, (_k, v) => typeof v === 'bigint' ? v.toString() : v)).digest('hex');

// Minimal ledger backed by a Map, matching the iterator/put shape CubeSyncManager uses.
class FakeLedger {
  constructor() {
    this.store = new Map();
    this._membershipPool = [];
    this.db = {
      iterator: ({ gte, lt }) => ({ [Symbol.asyncIterator]: async function* () {
        for (const [k, v] of [...this.store.entries()].sort()) if (k >= gte && k < lt) yield [k, v];
      }.bind(this) }),
      put: async (k, v) => { this.store.set(k, v); },
    };
  }
  getMembershipPool() { return this._membershipPool; }
}

// Build a well-formed cube PAYLOAD (the { id, faces } shape a peer sends on TOPIC_CUBE).
function makePayload(salt = '') {
  const faces = [];
  for (let f = 0; f < 3; f++) {
    const blocks = [];
    for (let i = 0; i < 9; i++) {
      const tx = { type: 'anchor', event: 'e', hash: `h${salt}${f}${i}`, from: 'xmbA', sig: 'S' };
      blocks.push({ hash: txHash(tx), tx });
    }
    faces.push({ merkleRoot: faceRootOf(blocks.map(b => b.hash)), blocks });
  }
  const roots = faces.map(f => f.merkleRoot);
  return { id: cubeIdOf(roots), faces, merkleRoot: cubeRootOf(roots) };
}
const clone = (o) => JSON.parse(JSON.stringify(o));
// A stable, comparable snapshot of everything persisted.
const snapshot = (ledger) => JSON.stringify([...ledger.store.entries()].sort());

// Feed a payload straight into the ingestion handler as if it arrived from a peer named 'P'.
async function feed(mgr, payload) {
  await mgr._onCube({ id: payload.id, faces: payload.faces, merkleRoot: payload.merkleRoot });
}
const newMgr = (ledger) => new CubeSyncManager({ xn: null, ledger, nodeId: 'self' });

// ---- 0. control: the honest path MUST adopt, or every rejection below is vacuous --------------
await check('control — an HONEST cube fed to the ingestion path is adopted (state grows)', async () => {
  const l = new FakeLedger();
  const m = newMgr(l);
  const honest = makePayload('ok');
  await feed(m, honest);
  assert.strictEqual(m.stats.adopted, 1, 'honest cube was not adopted');
  assert.strictEqual(m.stats.rejected, 0, 'honest cube was wrongly rejected');
  assert.ok(l.store.has(`cube:${honest.id}`), 'cube record not written');
  assert.strictEqual([...l.store.keys()].filter(k => k.startsWith('block:')).length, 27, 'expected 27 member blocks');
});

// ---- 1. every inconsistent set is REJECTED and leaves local state byte-for-byte unchanged ------
const adversaries = {
  'a member tx tampered so its hash no longer matches (inconsistent block)':
    (p) => { p.faces[0].blocks[0].tx.event = 'evil'; },
  'a block hash swapped for a fabricated one':
    (p) => { p.faces[1].blocks[2].hash = 'a'.repeat(64); },
  'a face carrying only 8 blocks (truncated set)':
    (p) => { p.faces[2].blocks.pop(); },
  'a face carrying 10 blocks (padded set)':
    (p) => { p.faces[0].blocks.push(clone(p.faces[0].blocks[0])); },
  'only 2 faces delivered':
    (p) => { p.faces.pop(); },
  'a lying face merkleRoot':
    (p) => { p.faces[1].merkleRoot = 'b'.repeat(64); },
  'a lying cube merkleRoot':
    (p) => { p.merkleRoot = 'c'.repeat(64); },
  'a valid cube served under the WRONG id (id substitution)':
    (p) => { p.id = makePayload('other').id; },
};
for (const [name, mutate] of Object.entries(adversaries)) {
  await check(`REJECT + state unchanged — ${name}`, async () => {
    const l = new FakeLedger();
    const m = newMgr(l);
    const before = snapshot(l);            // empty, but assert it stays empty
    const bad = makePayload('adv'); mutate(bad);
    await feed(m, bad);
    assert.strictEqual(m.stats.adopted, 0, 'an inconsistent set was adopted');
    assert.strictEqual(m.stats.rejected, 1, 'the inconsistent set was not counted as rejected');
    assert.strictEqual(snapshot(l), before, 'local state changed on a rejected set — partial merge leaked in');
    assert.strictEqual([...l.store.keys()].filter(k => k.startsWith('block:')).length, 0, 'a member block was written for a rejected cube');
  });
}

// ---- 2. no partial adoption: ONE bad face rejects the WHOLE cube, zero blocks written ----------
await check('partial adoption is impossible — a single corrupt face writes NONE of the 27 blocks', async () => {
  const l = new FakeLedger();
  const m = newMgr(l);
  const bad = makePayload('partial');
  bad.faces[2].blocks[5].hash = 'd'.repeat(64);   // faces 0 and 1 are still internally valid
  await feed(m, bad);
  assert.strictEqual(m.stats.adopted, 0);
  assert.strictEqual([...l.store.keys()].filter(k => k.startsWith('block:')).length, 0, 'blocks from the valid faces were persisted anyway');
});

// ---- 3. a contradictory SET cannot corrupt already-adopted honest state ------------------------
await check('a fork attempt (same id, different bytes) does NOT overwrite the honest cube', async () => {
  const l = new FakeLedger();
  const m = newMgr(l);
  const honest = makePayload('fork-honest');
  await feed(m, honest);
  const afterHonest = snapshot(l);
  assert.strictEqual(m.stats.adopted, 1);

  // Attacker replays the honest id but with different member bytes — the recomputed id will not
  // match honest.id, so it is rejected; the honest cube's records must be untouched.
  const forged = makePayload('fork-evil');
  forged.id = honest.id;                          // claim the honest id
  await feed(m, forged);
  assert.strictEqual(m.stats.rejected, 1, 'the fork payload was not rejected');
  assert.strictEqual(snapshot(l), afterHonest, 'the honest cube state was mutated by the fork attempt');
});

// ---- 4. garbage input is rejected without throwing (the loop survives one bad peer) ------------
await check('malformed payloads are ignored without crashing the handler', async () => {
  const l = new FakeLedger();
  const m = newMgr(l);
  for (const bad of [null, undefined, {}, { id: 'x' }, { faces: [] }, { id: 'x', faces: 'nope' }]) {
    await m._onCube(bad);
  }
  assert.strictEqual(l.store.size, 0, 'garbage input mutated local state');
  assert.strictEqual(m.stats.adopted, 0);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
