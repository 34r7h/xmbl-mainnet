#!/usr/bin/env node
// END-TO-END THROUGHPUT, COUNTED ON REAL NODES. Boots a fleet (scripts/fleet.mjs), submits K transactions spread
// over every live node's control socket, and times how long until EVERY node holds every one of them as a block
// in its ledger. The figure printed is that count over that wall time — not a submit rate, not one node's view.
//
// Run: node scripts/fleet-load.mjs [--nodes 4] [--txs 2000] [--class datum] [--batch 500] [--kill 1@3]
//                                  [--env XPC_CONSENSUS_V2=1] [--stall 30] [--keep]
//   --class datum   node-authored state_diff carrying one type-0 datum: the node micromines and signs it
//   --kill i@s      SIGKILL node i s seconds after the first submit (repeatable); its share is resubmitted elsewhere
import { startFleet } from './fleet.mjs';
import { datumWrite } from '@xmbl/cubic-ledger';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const all = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
const N = Number(opt('nodes', 4));
const K = Number(opt('txs', 2000));
const CLASS = opt('class', 'datum');
const BATCH = Math.min(500, Number(opt('batch', 500)));
const STALL_S = Number(opt('stall', 30));
const env = Object.fromEntries(all('env').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
const kills = all('kill').map((s) => { const [i, t] = s.split('@'); return { i: Number(i), at: Number(t) * 1000 }; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = Date.now().toString(36);

function makeTx(j) {
  if (CLASS === 'datum') return { type: 'state_diff', function: 'put', args: datumWrite({ fleet: run, j }, 0) };
  throw new Error(`unknown --class ${CLASS}`);
}

const f = await startFleet({ n: N, env, keep: argv.includes('--keep'), log: (m) => console.log(m) });
const stop = async (code) => { await f.stop(); process.exit(code); };
process.on('SIGINT', () => stop(130));
await f.waitMesh();

const snap = async (i) => {
  const c = await f.call(i, { op: 'chain' }, 10000);
  const cc = c?.cube_curve || {};
  return { node: i, blocks: cc.blocks_persisted ?? null, pooled: cc.pooled_blocks ?? null, cubes: cc.cubes_persisted ?? null,
           applied: c?.applied_tx_count ?? null, mempool: c?.mempool ?? null, root: c?.state_root ? String(c.state_root).slice(0, 12) : null };
};
const baseline = await Promise.all(f.alive().map(snap));
// A tx is in a node's ledger once it is a block there, sealed into a face or pooled in the face still filling
// (a face takes 9 blocks, so the last few of a run wait for the next traffic). Both are counted; the sealed
// figure is printed beside it.
const held = (s) => (s.blocks ?? 0) + (s.pooled ?? 0);
const base = Object.fromEntries(baseline.map((s) => [s.node, held(s)]));
const baseSealed = Object.fromEntries(baseline.map((s) => [s.node, s.blocks ?? 0]));

console.log(`preparing ${K} ${CLASS} txs`);
const txs = Array.from({ length: K }, (_, j) => makeTx(j));

const t0 = Date.now();
for (const k of kills) setTimeout(() => { f.kill(k.i).then(() => console.log(`killed node ${k.i} at +${Date.now() - t0} ms`)); }, k.at);
let accepted = 0, rejected = 0, lost = 0;
const errors = new Map();
const batches = [];
for (let j = 0; j < K; j += BATCH) batches.push(txs.slice(j, j + BATCH));
let next = 0;
// One in-flight batch per live node; a batch whose node died is resubmitted to another.
await Promise.all(Array.from({ length: N }, async (_, lane) => {
  while (next < batches.length) {
    const b = batches[next++];
    for (let tries = 0; tries < N; tries++) {
      const live = f.alive();
      if (!live.length) { lost += b.length; break; }
      const i = live[(lane + tries) % live.length];
      const r = await f.call(i, { op: 'submit_batch', params: { txs: b } }, 120000);
      if (!r || !Array.isArray(r.results)) continue;
      accepted += r.accepted; rejected += r.failed;
      for (const x of r.results) if (!x.ok) errors.set(x.error, (errors.get(x.error) || 0) + 1);
      break;
    }
  }
}));
const tSubmitted = Date.now();
console.log(`submitted: ${accepted} accepted, ${rejected} rejected, ${lost} lost in ${tSubmitted - t0} ms (${Math.round(accepted / ((tSubmitted - t0) / 1000))} tx/s at the door)`);
for (const [e, c] of errors) console.log(`  rejected x${c}: ${String(e).slice(0, 160)}`);

// Wait until every live node holds `accepted` new txs, or nothing moves for STALL_S seconds.
let last = null, lastMove = Date.now(), tDone = null;
while (true) {
  const rows = await Promise.all(f.alive().map(snap));
  const got = rows.map((r) => held(r) - (base[r.node] ?? 0));
  const key = JSON.stringify(got);
  if (key !== last) { last = key; lastMove = Date.now(); console.log(`+${Date.now() - t0} ms  new txs per live node ${key}  of them pooled ${JSON.stringify(rows.map((r) => r.pooled))}`); }
  if (got.length && got.every((g) => g >= accepted)) { tDone = Date.now(); break; }
  if (Date.now() - lastMove > STALL_S * 1000) break;
  await sleep(1000);
}
const rows = await Promise.all(f.alive().map(snap));
for (const r of rows) console.log(JSON.stringify(r));
const roots = new Set(rows.map((r) => r.root));
const minHeld = Math.min(...rows.map((r) => held(r) - (base[r.node] ?? 0)));
const minSealed = Math.min(...rows.map((r) => (r.blocks ?? 0) - (baseSealed[r.node] ?? 0)));
const wall = ((tDone ?? lastMove) - t0) / 1000;
console.log(`\nRESULT nodes=${N} live=${rows.length} class=${CLASS} accepted=${accepted} on_every_node=${minHeld} (sealed ${minSealed}) ` +
  `wall=${wall.toFixed(1)}s e2e=${Math.round(minHeld / wall)} tx/s state_roots=${roots.size}${tDone ? '' : ' (STALLED)'}`);
await stop(tDone ? 0 : 1);
