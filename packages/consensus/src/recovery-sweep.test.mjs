// THE 1 MS SWEEP. startStrandedRecoverySweep read its interval as `opts.intervalMs ?? Number(env) ?? 15000`.
// With the env var unset that is Number(undefined) = NaN, `??` keeps NaN, and setInterval(fn, NaN) fires every
// 1 ms — so every node without XPC_RECOVERY_SWEEP_MS set swept its pool about a thousand times a second, and
// with the pass cap also NaN the sweep only stopped when a pass found nothing at all. Each tick also fired a
// drain it did not await, so slow drains (a whole-pool signature walk) stacked one copy per tick.
//
// Pinned here: the defaults hold when the env is unset or junk, an env value is honoured, the pass cap stops
// the sweep, and no two passes (and so no two drains) ever run at once.
import { ConsensusWorkflow } from './workflow.js';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stop = (w) => { if (w._recoverySweep) clearInterval(w._recoverySweep); w._recoverySweep = null; };
const DB = mkdtempSync(join(tmpdir(), 'xpc-sweep-'));
let dbs = 0;
// Async: the constructor runs one recovery pass of its own once the mempool is ready, and that pass is not
// the sweep's, so the stubs go on after it.
const mk = async ({ drainMs = 0, recovered = 0, promoted = 0 } = {}) => {
  const w = new ConsensusWorkflow({ dbPath: join(DB, String(dbs++)) });
  await w.ready;
  const seen = { drains: 0, inDrain: 0, maxInDrain: 0, passes: 0 };
  w.getLiveLeaders = () => [];
  w.drainInvalidMempool = async () => {
    seen.drains++; seen.inDrain++; seen.maxInDrain = Math.max(seen.maxInDrain, seen.inDrain);
    if (drainMs) await wait(drainMs);
    seen.inDrain--;
    return { scanned: 0, evicted: 0 };
  };
  w.recoverStrandedRawTxs = () => { seen.passes++; return recovered; };
  w.promoteSatisfiedRawTxs = async () => promoted;
  return { w, seen };
};
const withEnv = async (vars, f) => {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await f(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
};
const quiet = (f) => async () => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };

console.log('\n1. the interval is 15 s unless something real says otherwise');
await check('env unset -> 15000 ms, not 1 ms', () => withEnv({ XPC_RECOVERY_SWEEP_MS: undefined }, async () => {
  const { w } = await mk(); const t = w.startStrandedRecoverySweep();
  try { assert.strictEqual(t._idleTimeout, 15000); } finally { stop(w); }
}));
await check('env junk ("abc", "", "0", "-5") -> 15000 ms', () => withEnv({}, async () => {
  for (const v of ['abc', '', '0', '-5']) {
    await withEnv({ XPC_RECOVERY_SWEEP_MS: v }, async () => {
      const { w } = await mk(); const t = w.startStrandedRecoverySweep();
      try { assert.strictEqual(t._idleTimeout, 15000, `env ${JSON.stringify(v)}`); } finally { stop(w); }
    });
  }
}));
await check('env "2500" -> 2500 ms', () => withEnv({ XPC_RECOVERY_SWEEP_MS: '2500' }, async () => {
  const { w } = await mk(); const t = w.startStrandedRecoverySweep();
  try { assert.strictEqual(t._idleTimeout, 2500); } finally { stop(w); }
}));
await check('opts.intervalMs wins over env', () => withEnv({ XPC_RECOVERY_SWEEP_MS: '2500' }, async () => {
  const { w } = await mk(); const t = w.startStrandedRecoverySweep({ intervalMs: 700 });
  try { assert.strictEqual(t._idleTimeout, 700); } finally { stop(w); }
}));

console.log('\n2. the pass cap stops a sweep that keeps finding work');
await check('env cap unset, junk cap -> stops at the default 40, not never', quiet(() => withEnv({ XPC_RECOVERY_MAX_PASSES: 'abc' }, async () => {
  const { w, seen } = await mk({ recovered: 1 });
  w.startStrandedRecoverySweep({ intervalMs: 1 });
  for (let i = 0; i < 400 && w._recoverySweep; i++) await wait(5);
  const stopped = !w._recoverySweep; stop(w);
  assert.ok(stopped, `sweep still running after ${seen.passes} passes`);
  assert.strictEqual(seen.passes, 40);
})));
await check('env cap "3" -> 3 passes', quiet(() => withEnv({ XPC_RECOVERY_MAX_PASSES: '3' }, async () => {
  const { w, seen } = await mk({ recovered: 1 });
  w.startStrandedRecoverySweep({ intervalMs: 1 });
  for (let i = 0; i < 200 && w._recoverySweep; i++) await wait(5);
  const stopped = !w._recoverySweep; stop(w);
  assert.ok(stopped); assert.strictEqual(seen.passes, 3);
})));

console.log('\n3. one pass at a time');
await check('a 60 ms drain under a 2 ms interval never runs twice at once', async () => {
  const { w, seen } = await mk({ drainMs: 60, recovered: 1 });
  w.startStrandedRecoverySweep({ intervalMs: 2, maxPasses: 1000 });
  await wait(300); stop(w); await wait(80);
  assert.strictEqual(seen.maxInDrain, 1, `${seen.maxInDrain} drains ran at once`);
  assert.ok(seen.drains <= 6, `${seen.drains} drains started in 300 ms`);
});
await check('recovery runs after the drain finishes, not beside it', async () => {
  const { w, seen } = await mk({ drainMs: 30, recovered: 1 });
  let inDrainAtRecover = -1;
  const rec = w.recoverStrandedRawTxs;
  w.recoverStrandedRawTxs = () => { if (inDrainAtRecover < 0) inDrainAtRecover = seen.inDrain; return rec(); };
  w.startStrandedRecoverySweep({ intervalMs: 5, maxPasses: 1000 });
  await wait(100); stop(w); await wait(40);
  assert.strictEqual(inDrainAtRecover, 0);
});
await check('a pass that finds nothing stops the sweep', quiet(async () => {
  const { w, seen } = await mk();
  w.startStrandedRecoverySweep({ intervalMs: 2 });
  for (let i = 0; i < 100 && w._recoverySweep; i++) await wait(5);
  const stopped = !w._recoverySweep; stop(w);
  assert.ok(stopped); assert.strictEqual(seen.passes, 1);
}));

rmSync(DB, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
