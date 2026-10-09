// ONE WIPE AT A TIME — two rebuild_ledger calls on one node must not both wipe the chain.
//
// The coordinator's convergence tick fires every 90s with no in-flight guard and gives rebuild_ledger 180s. A
// call that outlasts that is never pinned, and the next tick starts a SECOND wipe-and-reseal while the first is
// still running. MEASURED on 356a2a7a18 (v0.1.21, 2-CPU, load ~4, 2026-10-09): blocks_persisted 12268 against
// ~8.2k canonical anchors, and height/applied jumping 12268/4688 → 5584/8126 → 10435/5971 → 3126/4286 →
// 8427/7891 between beacons — the node never held one chain long enough to agree with anyone. That those were
// overlapping rebuilds is inferred from the readings; the box's single-rebuild time was not measured (an 11-CPU
// Mac at load ~7.5 wipes and reseals the 7848-anchor set in 14.0s). MEASURED here before the fix, 600 anchors: two
// overlapping rebuilds of one set left 52 cubes where one rebuild seals 26, and the second call failed with
// "placement refused — face 0 is not 9 blocks"; a rebuild overlapping one of a grown set (+40) left a state root
// that matches NEITHER set.
//
// The node now runs one ledger mutation at a time: a repeat of the in-flight call joins it, anything else is
// told `busy` at once (no queue — queued rebuilds pile up when each outlasts the tick), and a repeat of the set
// it last rebuilt, with nothing changed since, returns that result instead of wiping again. Every outcome is
// compared against a second node that rebuilt the same set alone.
import assert from 'node:assert';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { XMBLCore } from './index.js';
import { createControlServer } from './control-socket.js';
import { micromineTx } from '@xmbl/cubic-ledger';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const digest = (s) => createHash('sha256').update(String(s)).digest('hex');

const dirs = [];
async function node(tag) {
  const dir = mkdtempSync(join(tmpdir(), `xmbl-oplock-${tag}-`));
  dirs.push(dir);
  const core = new XMBLCore({ ledger: { dbPath: join(dir, 'l') }, stateMachine: { dbPath: join(dir, 'v') }, storage: { dbPath: join(dir, 's') } });
  await core.start();
  const sockPath = join(dir, 'n.sock');
  const server = await createControlServer({ core, config: {}, sockPath, statusSnapshot: () => ({ pid: process.pid }) });
  const call = (req) => new Promise((res, rej) => { const s = net.connect(sockPath); let b = ''; s.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) { s.end(); res(JSON.parse(b.slice(0, i))); } }); s.on('error', rej); s.on('connect', () => s.write(JSON.stringify(req) + '\n')); });
  // The persisted chain, read from LevelDB — what a restart would come back with.
  const rows = async () => { let n = 0; for await (const _ of core.xclt.db.iterator({ gte: 'block:', lt: 'block;' })) n++; return n; };
  // The whole chain as a comparable fingerprint: persisted rows, in-memory blocks, sealed cubes, state root.
  const shape = async () => ({ rows: await rows(), blocks: core.xclt.blocks.size, cubes: core.xclt.cubes.size, root: core.xvsm.getStateRoot() });
  return { core, server, call, shape };
}
// Resolves once the node is INSIDE rebuildFromAnchors — two sockets connecting at once arrive in either order,
// so a call meant to land during a rebuild waits for this instead of a tick.
const entered = (x) => new Promise((res) => { const orig = x.core.xclt.rebuildFromAnchors; x.core.xclt.rebuildFromAnchors = function (...args) { x.core.xclt.rebuildFromAnchors = orig; res(); return orig.apply(this, args); }; });
const same = (x, y) => x.rows === y.rows && x.blocks === y.blocks && x.cubes === y.cubes && x.root === y.root;
const fmt = (s) => `${s.rows} rows / ${s.blocks} blocks / ${s.cubes} cubes / root ${String(s.root).slice(0, 12)}`;

const row = (t) => ({ event: t.event, hash: t.hash, ts: t.ts, xid: t.xid, nonce: t.nonce, prior: t.prior });
const mk = (event, seed) => micromineTx({ type: 'anchor', event, hash: digest(seed), ts: 3000 });
const N = 600;
const set = Array.from({ length: N }, (_, i) => row(mk('task.created', `lock-${i}`)));
const grown = [...set, ...Array.from({ length: 40 }, (_, i) => row(mk('task.verified', `lock-more-${i}`)))];   // the next tick's feed

// ---- reference: a node that rebuilds each set alone, one call at a time ----
const ref = await node('ref');
await ref.call({ op: 'rebuild_ledger', anchors: set });
const refSet = await ref.shape();
await ref.call({ op: 'rebuild_ledger', anchors: grown });
const refGrown = await ref.shape();
ok(`reference: ${N} anchors alone → ${fmt(refSet)}`, refSet.rows > 0 && refSet.cubes > 0);
ok(`reference: ${grown.length} anchors alone → ${fmt(refGrown)}`, refGrown.rows > refSet.rows);

// ---- the node under test, already converged on `set` the way a running node is ----
const n = await node('n');
let t0 = Date.now();
const single = await n.call({ op: 'rebuild_ledger', anchors: set });
const singleMs = Date.now() - t0;
ok(`setup: one rebuild_ledger of ${N} typed anchors (${singleMs}ms) matches the reference`, single.ok === true && same(await n.shape(), refSet));

// ---- 1. two overlapping rebuilds of the same set ----
const [a, b] = await Promise.all([n.call({ op: 'rebuild_ledger', anchors: set }), n.call({ op: 'rebuild_ledger', anchors: set })]);
const s1 = await n.shape();
ok(`OUTCOME: after two overlapping rebuilds of one set the chain is one rebuild's chain (${fmt(s1)})`, same(s1, refSet));
ok('both callers get the same ok answer — the second joined the first', a.ok === true && b.ok === true && a.state_root === b.state_root && a.state_root === refSet.root);

// ---- 2. the next tick's grown set arrives while the old set is still rebuilding ----
const in2 = entered(n);
const first = n.call({ op: 'rebuild_ledger', anchors: grown });
await in2;
t0 = Date.now();
const second = await n.call({ op: 'rebuild_ledger', anchors: set });
const busyMs = Date.now() - t0;
const firstRes = await first;
const s2 = await n.shape();
ok(`a different set during a rebuild comes back busy at once (${busyMs}ms)`, second.ok === false && second.busy === true);
ok('the busy answer cannot trip the coordinator\'s apply_canonical fallback (/unknown op|predates/)', !/unknown op|predates/.test(String(second.error)));
ok('the busy answer carries no untyped/rejected counts', second.untyped === undefined && second.rejected === undefined);
ok('the in-flight rebuild completed normally', firstRes.ok === true && firstRes.anchors === grown.length);
ok(`OUTCOME: the chain is the grown set's chain and nothing of the refused call (${fmt(s2)})`, same(s2, refGrown));

// ---- 3. other write ops during a rebuild are refused; reads are not ----
const in3 = entered(n);
const r3 = n.call({ op: 'rebuild_ledger', anchors: set });
await in3;
const bf = await n.call({ op: 'apply_backfill' });
const ap = await n.call({ op: 'apply_canonical', anchors: grown });
const ev = await n.call({ op: 'evict', keys: [`${set[1].event}:${set[1].hash}`] });
const st = await n.call({ op: 'status' });
const r3res = await r3;
ok('apply_backfill during a rebuild is busy', bf.ok === false && bf.busy === true);
ok('apply_canonical during a rebuild is busy', ap.ok === false && ap.busy === true);
ok('evict during a rebuild is busy', ev.ok === false && ev.busy === true);
ok('status still answers during a rebuild', st.ok === true);
ok('OUTCOME: the busy evict removed nothing, and the rebuild landed on the reference chain', r3res.ok === true && n.core.xclt._anchorKeys.has(`${set[1].event}:${set[1].hash}`) && same(await n.shape(), refSet));

// ---- 4. the same set again, nothing changed: no second wipe ----
const before4 = await n.shape();
t0 = Date.now();
const again = await n.call({ op: 'rebuild_ledger', anchors: set });
const againMs = Date.now() - t0;
ok(`a repeat of the last set with nothing changed returns unchanged (${againMs}ms vs ${singleMs}ms)`, again.ok === true && again.unchanged === true && again.state_root === before4.root);
ok('the unchanged answer carries the counts the coordinator pins on', again.anchors === N && again.untyped === 0 && again.rejected === 0);
ok('OUTCOME: the repeat did not wipe — the chain is as before', same(await n.shape(), before4));

// ---- 5. ...but once the chain changes, the same set is really rebuilt ----
const ev2 = await n.call({ op: 'evict', keys: [`${set[2].event}:${set[2].hash}`] });
ok('setup: evict ran', ev2.ok === true && ev2.evicted === 1);
const real = await n.call({ op: 'rebuild_ledger', anchors: set });
ok('after an evict the same set is rebuilt for real, not answered from memory', real.ok === true && real.unchanged !== true && real.anchors === N - 1);
const s5 = await n.shape();
ok(`OUTCOME: the chain reflects the evict (${fmt(s5)})`, s5.blocks === N - 1 && s5.rows === real.blocks - real.pooled && !n.core.xclt._anchorKeys.has(`${set[2].event}:${set[2].hash}`));

for (const x of [ref, n]) { x.server.close(); await x.core.stop?.(); }
for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
process.exit(0);
