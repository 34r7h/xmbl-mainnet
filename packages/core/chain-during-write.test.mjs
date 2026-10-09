// A NODE SIGNS ONLY A CHAIN IT HOLDS — never a reading taken while a rebuild is tearing it down and resealing it.
//
// MEASURED 2026-10-09 15:16–15:18Z by the broker (handoff-claude, /xmbl/status every 10s): ONE node, 4293b3c6's
// xmbc35a1e0…, one coordinator, beacons ~31s apart, SIGNED these heights in turn: 19746, 9882, 17442, 19791, 9909.
// The broker keeps a high-water mark per address and refused every low one as a replay ('height_regression').
//
// The cause, from the code: `chain` counts block rows once and then bumps the count on every 'block:added'. A
// rebuild_ledger wipes every block row and reseals the whole set, and every block it reseals fires 'block:added'
// on the counter it never reset — so mid-rebuild the count climbs from the real height toward TWICE it, and is
// only rescanned after the op returns. The coordinator calls rebuild_ledger every ~90s with a set that grows by a
// few anchors each tick, so a slow box spends much of every minute inside one, and every beacon taken there
// signs a number that is no chain at all — along with a state root from a tree that is still being rebuilt.
//
// Now a `chain` read while a ledger write runs answers with the last reading taken with no write in flight,
// signature and all (its own ts, so the broker's freshness window still bounds it), marked `during_write`. A
// node that has no such reading yet answers UNSIGNED. A reading a write started under is not signed either.
import assert from 'node:assert';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { XMBLCore } from './index.js';
import { createControlServer } from './control-socket.js';
import { micromineTx } from '@xmbl/cubic-ledger';
import { verify } from '@xmbl/identity';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const digest = (s) => createHash('sha256').update(String(s)).digest('hex');

const dir = mkdtempSync(join(tmpdir(), 'xmbl-chainwrite-'));
const core = new XMBLCore({ ledger: { dbPath: join(dir, 'l') }, stateMachine: { dbPath: join(dir, 'v') }, storage: { dbPath: join(dir, 's') } });
await core.start();
const sockPath = join(dir, 'n.sock');
const server = await createControlServer({ core, config: {}, sockPath, statusSnapshot: () => ({ pid: process.pid }) });
const call = (req) => new Promise((res, rej) => { const s = net.connect(sockPath); let b = ''; s.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) { s.end(); res(JSON.parse(b.slice(0, i))); } }); s.on('error', rej); s.on('connect', () => s.write(JSON.stringify(req) + '\n')); });
const rows = async () => { let n = 0; for await (const _ of core.xclt.db.keys({ gte: 'block:', lt: 'block;' })) n++; return n; };
// What the broker does with a reading: verify the signature, then read the height out of the signed statement.
const signed = async (r) => {
  if (!r || !r.stmt || !r.sig || !r.pk) return null;
  if (!(await verify(r.stmt, r.sig, r.pk))) return null;
  return JSON.parse(r.stmt);
};
// Pause a write at a named point, read `chain` there, then let the write go on.
const readInside = (obj, fn) => new Promise((res) => {
  const orig = obj[fn];
  obj[fn] = async function (...args) { obj[fn] = orig; res(await call({ op: 'chain' })); return orig.apply(this, args); };
});

const row = (t) => ({ event: t.event, hash: t.hash, ts: t.ts, xid: t.xid, nonce: t.nonce, prior: t.prior });
const mk = (event, seed) => micromineTx({ type: 'anchor', event, hash: digest(seed), ts: 3000 });
const N = 270;
const set = Array.from({ length: N }, (_, i) => row(mk('task.created', `cw-${i}`)));
const grown = [...set, ...Array.from({ length: 27 }, (_, i) => row(mk('task.verified', `cw-more-${i}`)))];   // the next tick's feed

const r0 = await call({ op: 'rebuild_ledger', anchors: set });
ok('setup: the first rebuild sealed the set', r0.ok === true && r0.anchors === N);
const idle = await call({ op: 'chain' });
const s0 = await signed(idle);
const h0 = await rows();
ok(`an idle reading is signed and its height is the block rows on disk (${s0?.height} = ${h0})`, !!s0 && s0.height === h0 && h0 > 0);

// ---- the next tick: rebuild the grown set, and read `chain` at the two places a beacon lands inside it ----
const midSeal = readInside(core.xclt, '_sealReadyFaces');               // rows wiped, the reseal under way
const midState = readInside(core.xvsm, 'rebuildFromCanonical');         // every block resealed, the tree not yet
const r1 = await call({ op: 'rebuild_ledger', anchors: grown });
const [a, b] = await Promise.all([midSeal, midState]);
const sa = await signed(a), sb = await signed(b);
ok('setup: the grown set rebuilt', r1.ok === true && r1.anchors === grown.length);
const h1 = await rows();
ok(`setup: the grown chain is taller (${h0} → ${h1} rows)`, h1 > h0);
for (const [where, r, s] of [['while the ledger reseals', a, sa], ['while the state tree rebuilds', b, sb]]) {
  ok(`OUTCOME: a reading ${where} signs no height above the chain that exists (signed ${s ? s.height : 'nothing'}, chain ${h0} → ${h1})`, !s || s.height <= h1);
  ok(`OUTCOME: ...and none below the chain it held before the write (signed ${s ? s.height : 'nothing'} ≥ ${h0})`, !s || s.height >= h0);
  ok(`a reading ${where} says a write is running`, r?.during_write?.op === 'rebuild_ledger');
  ok(`a reading ${where} is the last settled one, its signature unchanged`, r?.stmt === idle.stmt && r?.sig === idle.sig && s?.state_root === s0.state_root);
}

const after = await call({ op: 'chain' });
const s2 = await signed(after);
ok(`after the write the reading is fresh, signed, and the grown chain (${s2?.height} = ${h1})`, !!s2 && s2.height === h1 && s2.ts > s0.ts && !after.during_write);
ok('OUTCOME: the signed heights in beacon order never go down — the broker refuses none of them',
  [s0, sa, sb, s2].filter(Boolean).every((s, i, xs) => i === 0 || s.height >= xs[i - 1].height));

// ---- a node with no settled reading yet signs nothing during a write ----
{
  const dir2 = mkdtempSync(join(tmpdir(), 'xmbl-chainwrite-cold-'));
  const c2 = new XMBLCore({ ledger: { dbPath: join(dir2, 'l') }, stateMachine: { dbPath: join(dir2, 'v') }, storage: { dbPath: join(dir2, 's') } });
  await c2.start();
  const sock2 = join(dir2, 'n.sock');
  const srv2 = await createControlServer({ core: c2, config: {}, sockPath: sock2, statusSnapshot: () => ({ pid: process.pid }) });
  const call2 = (req) => new Promise((res, rej) => { const s = net.connect(sock2); let buf = ''; s.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { s.end(); res(JSON.parse(buf.slice(0, i))); } }); s.on('error', rej); s.on('connect', () => s.write(JSON.stringify(req) + '\n')); });
  const orig = c2.xvsm.rebuildFromCanonical;
  const cold = new Promise((res) => { c2.xvsm.rebuildFromCanonical = async function (...args) { c2.xvsm.rebuildFromCanonical = orig; res(await call2({ op: 'chain' })); return orig.apply(this, args); }; });
  const w = await call2({ op: 'rebuild_ledger', anchors: set });
  const r = await cold;
  ok('setup: the cold node rebuilt', w.ok === true);
  ok(`OUTCOME: with no settled reading, a reading during a write is unsigned (${r?.stmt ? 'SIGNED' : 'unsigned'})`, r?.ok === true && !r.stmt && !r.sig && r.during_write?.op === 'rebuild_ledger');
  srv2.close(); await c2.stop?.();
  rmSync(dir2, { recursive: true, force: true });
}

server.close(); await core.stop?.();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
process.exit(0);
