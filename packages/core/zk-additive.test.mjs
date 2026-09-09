// ZK stays ADDITIVE and never consensus-load-bearing (MAINNET-GATES §@xmbl/zero-knowledge).
// XZK is experimental + UNAUDITED. The invariant that must not regress: with XZK_COMMIT unset
// the commitment path does not exist at all (no listener, no state), and when opted in it is a
// side buffer only — a ZK failure is swallowed (never breaks a sealed face) and ZK output lands
// solely in the read-only getZkCommitments() query, never feeding the ledger/consensus/seal.
// We construct a node with a stubbed network (as boot-gate.test.mjs does) and drive the ledger's
// face:complete event directly. Run: node zk-additive.test.mjs
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMBLCore } from './index.js';

let pass = 0, fail = 0;
const check = async (n, f) => {
  try { await f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; }
};

function makeNode() {
  const dir = mkdtempSync(join(tmpdir(), 'xmbl-zkadd-'));
  const node = new XMBLCore({
    ledger: { dbPath: join(dir, 'xclt') },
    stateMachine: { dbPath: join(dir, 'xvsm') },
    consensus: { dbPath: join(dir, 'xpc') },
  });
  node.xn = { started: false, start: async () => {}, on() {}, subscribe: async () => {}, publish: async () => {} };
  return node;
}

const savedEnv = { ...process.env };
delete process.env.XZK_COMMIT;

const EV = 'face:complete';
// A face whose block.hash getter throws — the handler must catch it (non-blocking), never rethrow.
const throwingFace = { faceIndex: 1, cubeId: 1, face: { blocks: { values: () => [
  { get hash() { throw new Error('boom'); }, id: 'x' },
  { get hash() { throw new Error('boom'); }, id: 'y' },
] } } };
// A well-formed face → the handler commits one record into the side buffer.
const goodFace = { faceIndex: 2, cubeId: 2, face: { blocks: { values: () => [
  { hash: 'aa'.repeat(16), id: 'b1' }, { hash: 'bb'.repeat(16), id: 'b2' }, { hash: 'cc'.repeat(16), id: 'b3' },
] } } };

await check('default OFF: no listener, no state, query reports disabled (strictly additive)', async () => {
  delete process.env.XZK_COMMIT;
  const node = makeNode();
  const before = node.xclt.listenerCount(EV);
  await node._setupZkCommit();
  assert.strictEqual(node.zkCommitments, undefined, 'no commitment buffer when opted out');
  assert.strictEqual(node.xclt.listenerCount(EV), before, 'no face:complete listener attached when opted out');
  assert.strictEqual(node.getZkCommitments().enabled, false, 'query must report disabled');
  // A sealed face still fires with ZK off and must not throw or be affected by ZK.
  assert.doesNotThrow(() => node.xclt.emit(EV, goodFace), 'sealing a face is independent of ZK when off');
});

await check('opt-in attaches exactly one side listener and a read-only buffer', async () => {
  process.env.XZK_COMMIT = '1';
  const node = makeNode();
  const before = node.xclt.listenerCount(EV);
  await node._setupZkCommit();
  assert.strictEqual(node.xclt.listenerCount(EV), before + 1, 'opt-in attaches one listener');
  assert.ok(Array.isArray(node.zkCommitments), 'opt-in creates the side buffer');
  assert.strictEqual(node.getZkCommitments().enabled, true, 'query reports enabled');
});

await check('non-blocking: a ZK failure inside the handler never breaks the sealed face', async () => {
  process.env.XZK_COMMIT = '1';
  const node = makeNode();
  await node._setupZkCommit();
  // Emitting the face that makes ZK throw must not propagate out of the seal path...
  assert.doesNotThrow(() => node.xclt.emit(EV, throwingFace), 'a ZK error must be swallowed, not rethrown');
  // ...and nothing is committed from the failed attempt.
  assert.strictEqual(node.zkCommitments.length, 0, 'a failed commit adds no record');
});

await check('side-buffer only: a valid face commits ONE record, visible only via the query surface', async () => {
  process.env.XZK_COMMIT = '1';
  const node = makeNode();
  await node._setupZkCommit();
  node.xclt.emit(EV, goodFace);
  assert.strictEqual(node.zkCommitments.length, 1, 'exactly one record committed');
  const rec = node.zkCommitments[0];
  assert.strictEqual(typeof rec.verified, 'boolean', 'record carries a verified flag');
  assert.strictEqual(rec.faceIndex, goodFace.faceIndex, 'record indexes the face');
  const q = node.getZkCommitments();
  assert.strictEqual(q.count, 1, 'query reflects the buffer');
  assert.ok(q.recent.some((r) => r.faceIndex === goodFace.faceIndex), 'commitment is reachable only through the read-only query');
});

Object.assign(process.env, savedEnv);
console.log(`\nzk additive guard: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
