// THE APPLY STEP MUST ACTUALLY RUN. Measured on prod 2026-08-17 before this test existed: state_root 64
// zeros, applied_tx_count 0, state_diffs 0 — against 711 txs held and 5,594 block rows persisted. The cause
// was not a hard bug in any function; every function worked. The `block:added` event that connects the ledger
// to the state machine was documented (ledger.js @emits) and subscribed to (state-machine.js) and NEVER
// EMITTED, so a fully implemented consumer sat unreachable for weeks while every dashboard read green.
//
// These checks are written against the OUTCOME — the state root and the applied counts after the fact — not
// against the mechanism. A test that asserted "emit was called" would have passed on a build where the tree
// still ended up empty.
//
//   node vendor/xmbl-node/state-machine/src/apply-path.test.mjs
import { StateMachine } from './state-machine.js';
import { Ledger } from '../../cubic-ledger/src/ledger.js';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ZERO = '0'.repeat(64);
let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`); };

// Nine anchor txs seal exactly one face under the hash-sorted partition (9 blocks per face).
const anchors = (n, tag) => Array.from({ length: n }, (_, i) => ({
  type: 'anchor', event: 'task.created', hash: `${tag}-${i}`.padEnd(64, '0'), ts: 1_700_000_000_000 + i,
}));

const fresh = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xvsm-apply-'));
  const xclt = new Ledger({ dbPath: join(dir, '@xmbl/cubic-ledger') });
  await xclt.db.open().catch(() => {});
  xclt._dbOpen = true;
  const xvsm = new StateMachine({ dbPath: join(dir, '@xmbl/state-machine'), xclt });
  await new Promise((r) => setTimeout(r, 120));   // let both LevelDBs finish opening
  return { dir, xclt, xvsm };
};
const close = async ({ dir, xclt, xvsm }) => {
  await xclt.db.close().catch(() => {});
  await xvsm.db.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
};

console.log('\n1. a SEALED face reaches the state tree (the missing block:added doorbell)');
{
  const env = await fresh();
  await check('the tree starts empty — the honest baseline, not an assumption', async () => {
    eq(env.xvsm.getStateRoot(), ZERO, 'initial root');
  });
  await check('sealing 9 txs moves state_root off zero and applies 9 diffs', async () => {
    for (const tx of anchors(9, 'seal')) await env.xclt.addTransaction(tx);
    await new Promise((r) => setTimeout(r, 250));   // the xvsm handler is async
    const root = env.xvsm.getStateRoot();
    if (root === ZERO) throw new Error('state_root is still 64 zeros — block:added never reached xvsm');
    eq(env.xvsm.diffs.length, 9, 'diffs applied');
  });
  await check('each applied key is the namespaced key the mapping defines', async () => {
    const keys = env.xvsm.diffs.flatMap((d) => Object.keys(d.changes || {}));
    const bad = keys.filter((k) => !k.startsWith('anchor:task.created:'));
    if (bad.length) throw new Error(`unexpected keys: ${bad.slice(0, 3).join(', ')}`);
  });
  await close(env);
}

console.log('\n2. POOLED-but-unsealed blocks must NOT be applied');
{
  const env = await fresh();
  await check('8 txs (one short of a face) leave the root at zero', async () => {
    for (const tx of anchors(8, 'pool')) await env.xclt.addTransaction(tx);
    await new Promise((r) => setTimeout(r, 250));
    eq(env.xvsm.getStateRoot(), ZERO, 'root after 8 pooled');
    eq(env.xvsm.diffs.length, 0, 'diffs after 8 pooled');
  });
  await check('the 9th seals the face and only THEN does the root move', async () => {
    await env.xclt.addTransaction(anchors(9, 'pool')[8]);
    await new Promise((r) => setTimeout(r, 250));
    if (env.xvsm.getStateRoot() === ZERO) throw new Error('root still zero after the sealing tx');
    eq(env.xvsm.diffs.length, 9, 'diffs after the face sealed');
  });
  await close(env);
}

console.log('\n3. BACKFILL applies what is already on disk — no doorbell, no quorum');
{
  const env = await fresh();
  await check('a tree that missed every event recovers from the ledger rows alone', async () => {
    // Simulate the prod condition exactly: blocks persisted by the ledger, a state machine that never heard
    // about any of them. Detaching the listener is what makes this the real scenario rather than a mock.
    env.xclt.removeAllListeners('block:added');
    for (const tx of anchors(9, 'back')) await env.xclt.addTransaction(tx);
    await new Promise((r) => setTimeout(r, 250));
    eq(env.xvsm.getStateRoot(), ZERO, 'root before backfill (proves the listener really was detached)');

    const r = await env.xvsm.backfillFromLedger();
    if (r.applied !== 9) throw new Error(`applied ${r.applied} of 9 (scanned ${r.scanned}, failed ${r.failed})`);
    if (r.state_root === ZERO) throw new Error('backfill reported success but the root is still zero');
  });
  await check('running it a second time is idempotent — same root, no divergence', async () => {
    const first = env.xvsm.getStateRoot();
    const r = await env.xvsm.backfillFromLedger();
    eq(env.xvsm.getStateRoot(), first, 'root after a repeat backfill');
    if (r.applied !== 9) throw new Error(`repeat applied ${r.applied}, expected the same 9`);
  });
  await close(env);
}

console.log('\n4. the state COMMITMENT is observable (state:committed was a silent no-op)');
{
  const env = await fresh();
  await check('StateMachine is an EventEmitter, so a listener can be attached at all', async () => {
    if (typeof env.xvsm.on !== 'function' || typeof env.xvsm.emit !== 'function') {
      throw new Error('StateMachine still has no emit/on — this.emit?.() would swallow itself again');
    }
  });
  await check('completing a cube emits state:committed carrying the root it committed', async () => {
    const seen = [];
    let cubes = 0;
    env.xvsm.on('state:committed', (e) => seen.push(e));
    env.xclt.on('cube:complete', () => cubes++);
    // Drive the LEDGER until it says a cube completed, rather than assuming 27 txs make exactly one: the
    // legacy path assigns each sealed face to the first cube with room, so a single 27-tx call can spread
    // three faces across two cubes. Asserting an internal packing rule would test the wrong thing.
    for (let batch = 0; batch < 12 && !cubes; batch++) {
      for (const tx of anchors(9, `commit${batch}`)) await env.xclt.addTransaction(tx);
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!cubes) throw new Error('the ledger never completed a cube — nothing to commit (test setup, not the fix)');
    if (!seen.length) throw new Error('a cube completed but no state:committed reached a listener');
    const root = env.xvsm.getStateRoot();
    const last = seen[seen.length - 1];
    if (root === ZERO) throw new Error('a commitment was announced over an empty tree');
    if (!last.cubeId) throw new Error('the event names no cube');
    if (typeof last.stateRoot !== 'string' || last.stateRoot.length !== 64) {
      throw new Error(`event carried no usable root: ${last.stateRoot}`);
    }
  });
  await check('the ENVELOPE shape is pinned: the inner cube is what gets stamped, not the wrapper', async () => {
    // Drive cube:complete through the EMITTER with the exact payload ledger.js sends. The handler accepts
    // both shapes, so a direct call with a raw Cube (which is what verkle-integration.test.mjs does) passes
    // either way and cannot detect a regression to envelope-only handling — the precise blind spot that let
    // "no cube ever carried a state commitment" survive a green suite. This asserts the INNER cube.
    const cube = { id: 'cube-envelope-probe', faces: new Map() };
    env.xclt.emit('cube:complete', { cube, cubeId: 'timestamp-key', validatorAverageTimestamp: 1, level: 1 });
    await new Promise((r) => setTimeout(r, 60));
    if (!cube.stateRoot) throw new Error('the inner cube carries no stateRoot — the wrapper was stamped instead');
    eq(cube.stateRoot, env.xvsm.getStateRoot(), 'the root stamped on the cube');
  });
  await close(env);
}

console.log('\n5. the same SET in a different order yields the SAME root (why replay is safe)');
{
  const a = await fresh(), b = await fresh();
  await check('forward and reverse insertion agree', async () => {
    const txs = anchors(9, 'order');
    for (const tx of txs) await a.xclt.addTransaction(tx);
    for (const tx of [...txs].reverse()) await b.xclt.addTransaction(tx);
    await new Promise((r) => setTimeout(r, 300));
    eq(a.xvsm.getStateRoot(), b.xvsm.getStateRoot(), 'roots across insertion orders');
    if (a.xvsm.getStateRoot() === ZERO) throw new Error('both roots are zero — nothing was applied at all');
  });
  await close(a); await close(b);
}

console.log(`\n${fail ? 'FAILED' : 'PASSED'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
