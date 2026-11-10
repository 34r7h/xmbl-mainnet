// APPENDING A JOURNAL DELTA LANDS ON THE SAME LEDGER AND THE SAME STATE ROOT AS A FULL REBUILD — and anything the
// node cannot prove extends its own set is refused with nothing touched.
//
// MEASURED 2026-11-10 on the operator's MacBook (0.1.29): every ~90 s convergence tick pulled 21.9 MB, wiped and
// rewrote 229,715 block rows (72,078 anchors + 157,636 preserved non-anchor blocks), resealed 25,524 faces, spent
// ~60 s in rebuildFromAnchors plus ~11.5 s in the verkle rebuild, and held the node at ~1.25 cores continuously.
// append_canonical takes only the rows after the node's cursor. Every claim below is read from the stores after
// the call (the anchor key set, the tree root, the durable rows), never from the op's own reply.
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { XMBLCore } from './index.js';
import { createControlServer } from './control-socket.js';
import { CANON_D0, canonRoot, canonStep, verifyCanonRun } from './canon-digest.js';
import { micromineTx, micromine, type6TxBody } from '@xmbl/cubic-ledger';
import { VerkleStateTree } from '@xmbl/state-machine';
import { startCanonicalSelfFeed, feedState } from './canonical-feed.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n + (extra !== undefined ? ` — ${JSON.stringify(extra)}` : '')); } };
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

// ---- 1. the digest, pinned by the broker's golden vectors (handoff tests/xmbl-canon-journal.test.ts) ----
{
  const X1 = '07' + '11'.repeat(31), X2 = '07' + '22'.repeat(31);
  const V = [
    { event: 'value.transfer', hash: 'aa'.repeat(32), ts: '2026-11-10T00:00:00.000Z', xid: X1, nonce: 3, prior: '' },
    { event: 'task.created', hash: 'bb'.repeat(32), ts: '2026-11-10T00:00:01.000Z', xid: X2, nonce: 12, prior: X1 },
    { event: 'soc.posted', hash: 'cc'.repeat(32), ts: '2026-11-10T00:00:02.000Z' },
  ];
  ok('D0 = sha256("xmbl-canon-v1")', CANON_D0 === '384340f07a70ae494f1d852ac530ad97fe60859fdd072b685c6bb2c9dfe0e484');
  const d1 = canonStep(CANON_D0, 1, V[0]), d2 = canonStep(d1, 2, V[1]), d3 = canonStep(d2, 3, V[2]);
  ok('golden d1', d1 === '886b07b9073a219ddaa8e67bd3121e0fb297fe693a9f8d785b42e04b97dda050');
  ok('golden d2', d2 === '7f26edf7bb0a6919b33b7c8991793bc0dc32b4dc5462e43204d24015d6a0c301');
  ok('golden d3', d3 === 'ed9c0c18012105537720658fb3b416a5f4a5ffcdc837959d7babc7e898028e96');
  ok('canonRoot over the three = d3', canonRoot(V) === d3);
  ok('a run from d1 numbered 2.. reaches d3', verifyCanonRun(V.slice(1).map((a, i) => ({ ...a, seq: i + 2 })), d1, 1).root === d3);
  ok('a gap in seq is refused', verifyCanonRun([{ ...V[1], seq: 3 }], d1, 1).ok === false);
}

// ---- fixture: one numbered canonical journal, and a node's own value txs ----
const N = 61, CUT = 40;
const journal = Array.from({ length: N }, (_, i) => {
  const t = micromineTx({ type: 'anchor', event: i % 3 ? 'task.created' : 'value.transfer', hash: sha(`canon-${i}`), ts: new Date(Date.UTC(2026, 10, 10, 0, 0, i)).toISOString() });
  return { seq: i + 1, event: t.event, hash: t.hash, ts: t.ts, xid: t.xid, nonce: t.nonce, prior: t.prior ?? '' };
});
const GEN = 'aaaabbbbccccdddd';
const rootAt = (n) => canonRoot(journal.slice(0, n));
const valueTxs = Array.from({ length: 7 }, (_, i) => {
  const t = { chain: 'xmbl', from: ['xmbA'], to: ['xmbB'], asset: 'XMBL', amount: 1 + i, seq: i, prev: '', unspent: '' };
  const { xid, nonce } = micromine(type6TxBody(t), 6);
  return { type: 'tx', xid, nonce, ...t };
});

const dirs = [];
async function bootNode(tag) {
  const dir = mkdtempSync(join(tmpdir(), `xmbl-append-${tag}-`));
  dirs.push(dir);
  const core = new XMBLCore({ ledger: { dbPath: join(dir, 'l') }, stateMachine: { dbPath: join(dir, 'v') }, storage: { dbPath: join(dir, 's') } });
  await core.start();
  const sockPath = join(dir, 'n.sock');
  const server = await createControlServer({ core, config: {}, sockPath, statusSnapshot: () => ({ pid: process.pid }) });
  const call = (req) => new Promise((res, rej) => { const s = net.connect(sockPath); const parts = []; s.setEncoding('utf8'); s.on('data', (d) => { parts.push(d); const b = parts.join(''); const i = b.indexOf('\n'); if (i >= 0) { s.end(); res(JSON.parse(b.slice(0, i))); } }); s.on('error', rej); s.on('connect', () => s.write(JSON.stringify(req) + '\n')); });
  for (const tx of valueTxs) await core.xclt.addTransaction(tx);
  return { core, server, call };
}
const settle = () => new Promise((r) => setTimeout(r, 50));
const durableRows = async (core) => { let n = 0; for await (const k of core.xclt.db.keys({ gte: 'block:', lt: 'block;' })) { void k; n++; } return n; };
const anchorKeys = (core) => [...core.xclt._anchorKeys].sort().join('\n');
const held = (core) => core.xclt.blocks.size;
const delta = (since, to) => ({ op: 'append_canonical', gen: GEN, since, prev_root: rootAt(since), to_seq: to, to_root: rootAt(to), anchors: journal.slice(since, to) });

const A = await bootNode('a');
const B = await bootNode('b');

// ---- 2. a full rebuild that names the numbering sets the cursor ----
const r0 = await A.call({ op: 'rebuild_ledger', anchors: journal.slice(0, CUT), gen: GEN, root: rootAt(CUT) });
ok('rebuild_ledger with gen and root sets the cursor at the set it verified', r0.ok && r0.canon_cursor && r0.canon_cursor.seq === CUT && r0.canon_cursor.root === rootAt(CUT), r0.canon_cursor);
const caps0 = await A.call({ op: 'ledger_capabilities' });
ok('ledger_capabilities advertises appends_canonical, canon_digest v1 and the cursor',
  caps0.capabilities.appends_canonical === true && caps0.capabilities.canon_digest === 'v1' && caps0.canon_cursor && caps0.canon_cursor.seq === CUT);
const badRoot = await B.call({ op: 'rebuild_ledger', anchors: journal.slice(0, CUT), gen: GEN, root: 'ff'.repeat(32) });
ok('a rebuild whose rows do not chain to the named root sets no cursor', badRoot.ok && badRoot.canon_cursor === null);
await A.call({ op: 'chain' });   // the chain count's baseline, taken before the append moves it
await settle();

// ---- 3. refusals touch nothing ----
const before = { keys: anchorKeys(A.core), held: held(A.core), root: A.core.xvsm.getStateRoot(), rows: await durableRows(A.core) };
const unchangedNow = async () => anchorKeys(A.core) === before.keys && held(A.core) === before.held && A.core.xvsm.getStateRoot() === before.root && (await durableRows(A.core)) === before.rows;
const tampered = delta(CUT, N); tampered.anchors = tampered.anchors.map((a, i) => (i === 3 ? { ...a, ts: '2026-11-10T09:09:09.000Z' } : a));
const cases = [
  ['a different gen', { ...delta(CUT, N), gen: 'eeeeffff00001111' }],
  ['a since past the cursor', delta(CUT + 1, N)],
  ['a prev_root that is not the held root', { ...delta(CUT, N), prev_root: 'ab'.repeat(32) }],
  ['a row edited in transit', tampered],
  ['a dropped row', { ...delta(CUT, N), anchors: journal.slice(CUT, N).filter((_, i) => i !== 5) }],
  ['a to_root the rows do not reach', { ...delta(CUT, N), to_root: rootAt(N - 1) }],
];
for (const [name, req] of cases) {
  const r = await A.call(req);
  ok(`refused with reset:true — ${name}`, r.ok === false && r.reset === true, r);
  ok(`and nothing moved — ${name}`, await unchangedNow());
}
ok('the cursor survives every refusal', (await A.call({ op: 'ledger_capabilities' })).canon_cursor.seq === CUT);

// ---- 4. the append ----
const app = await A.call(delta(CUT, N));
ok('append_canonical appends exactly the delta', app.ok === true && app.appended === N - CUT && app.held === 0, app);
ok('the cursor advances to the delta\'s end', app.canon_cursor.seq === N && app.canon_cursor.root === rootAt(N));
const replay = await A.call(delta(CUT, N));
ok('a replay of the applied delta answers unchanged', replay.ok === true && replay.unchanged === true && replay.canon_cursor.seq === N);
const stale = await A.call(delta(CUT, N - 3));
ok('an older delta answers stale, not reset', stale.ok === false && stale.stale === true && !stale.reset);

// ---- 5. the same set rebuilt from scratch on another node ----
const r1 = await B.call({ op: 'rebuild_ledger', anchors: journal, gen: GEN, root: rootAt(N) });
await settle();
ok('OUTCOME: the same anchor key set as a full rebuild of the extended set', anchorKeys(A.core) === anchorKeys(B.core));
ok('OUTCOME: the same number of blocks held', held(A.core) === held(B.core), [held(A.core), held(B.core)]);
// The root a tree holding exactly the canonical anchor keys commits to, computed from nothing but the set.
const pureRoot = async (rows) => { const t = new VerkleStateTree(); for (const a of rows) await t.insert(`anchor:${a.event}:${a.hash}`, { ts: a.ts }); return t.getRoot(); };
const canonicalStateRoot = await pureRoot(journal);
ok('OUTCOME: the full rebuild\'s root is the root of the canonical set alone (no stray leaf)', B.core.xvsm.getStateRoot() === canonicalStateRoot, [B.core.xvsm.getStateRoot(), canonicalStateRoot]);
ok('OUTCOME: the same verkle state root as a full rebuild', A.core.xvsm.getStateRoot() === B.core.xvsm.getStateRoot() && A.core.xvsm.getStateRoot() === r1.state_root, [A.core.xvsm.getStateRoot(), r1.state_root]);
ok('OUTCOME: the same applied count', A.core.xvsm.getStatistics().totalTransactions === B.core.xvsm.getStatistics().totalTransactions);
const total = N + valueTxs.length;
const sealedA = held(A.core) - A.core.xclt._membershipPool.length, sealedB = held(B.core) - B.core.xclt._membershipPool.length;
ok('OUTCOME: the same number of sealed blocks (floor(n/9) faces either way)', sealedA === sealedB && sealedA === Math.floor(total / 9) * 9, [sealedA, sealedB]);
const chainA = await A.call({ op: 'chain' });
ok('OUTCOME: the signed height equals the durable rows on disk', chainA.cube_curve.blocks_persisted === (await durableRows(A.core)), [chainA.cube_curve.blocks_persisted, await durableRows(A.core)]);
const stmt = JSON.parse(chainA.stmt);
ok('the signed statement carries the canon cursor', stmt.canon && stmt.canon.gen === GEN && stmt.canon.seq === N && stmt.canon.root === rootAt(N), stmt.canon);

// ---- 6. a key a sealed face applied between ticks is swept by the next (empty) append ----
await A.core.xvsm.stateTree.insert('tx:between-ticks', { amount: 1 });
ok('setup: a stray key moves the root off the canonical one', A.core.xvsm.getStateRoot() !== r1.state_root);
const empty = await A.call(delta(N, N));
ok('an empty delta is accepted and sweeps the stray', empty.ok === true && empty.appended === 0 && empty.forgot === 1, empty);
ok('OUTCOME: the root is back on the full rebuild\'s', A.core.xvsm.getStateRoot() === r1.state_root);

// ---- 7. a rebuild without a numbering clears the cursor; a repeat that names one sets it without rebuilding ----
const r2 = await A.call({ op: 'rebuild_ledger', anchors: journal });
ok('rebuild_ledger without gen rebuilds and leaves no cursor', r2.ok === true && !r2.unchanged && r2.canon_cursor === null, r2);
ok('ledger_capabilities then shows no cursor', (await A.call({ op: 'ledger_capabilities' })).canon_cursor === null);
const afterPlain = await A.call(delta(N, N));
ok('and an append is refused with reset', afterPlain.ok === false && afterPlain.reset === true, afterPlain);
await A.call({ op: 'rebuild_ledger', anchors: journal });   // the refused append cleared the write lock's memory of the last set
const rowsBeforeRepeat = await durableRows(A.core), rootBeforeRepeat = A.core.xvsm.getStateRoot();
const r3 = await A.call({ op: 'rebuild_ledger', anchors: journal, gen: GEN, root: rootAt(N) });
ok('a repeat of the held set that names its numbering answers unchanged and sets the cursor', r3.ok === true && r3.unchanged === true && r3.canon_cursor && r3.canon_cursor.seq === N && r3.canon_cursor.root === rootAt(N), r3);
ok('OUTCOME: and touched nothing to do it', (await durableRows(A.core)) === rowsBeforeRepeat && A.core.xvsm.getStateRoot() === rootBeforeRepeat);
const afterRepeat = await A.call(delta(N, N));
ok('and the next append is accepted from that cursor', afterRepeat.ok === true && afterRepeat.appended === 0, afterRepeat);

// ---- 8. the self-feed appends from the cursor instead of pulling the whole set ----
{
  const urls = [];
  const C = await bootNode('c');
  const head = { n: CUT, gen: GEN };
  const fetchImpl = async (u) => {
    urls.push(u);
    const q = new URL(u).searchParams;
    const json = (o) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => o });
    if (q.get('since') != null) {
      const since = Number(q.get('since'));
      if (q.get('gen') !== head.gen) return json({ success: true, reset: true, reason: 'gen', gen: head.gen, head_seq: head.n, root: rootAt(head.n) });
      return json({ success: true, reset: false, gen: head.gen, since, prev_root: rootAt(since), head_seq: head.n, root: rootAt(head.n), anchors: journal.slice(since, head.n), more: false, to_seq: head.n, to_root: rootAt(head.n) });
    }
    return json({ success: true, gen: head.gen, head_seq: head.n, root: rootAt(head.n), anchors: journal.slice(0, head.n) });
  };
  const logs = [];
  let t = 1_000_000;
  const feed = startCanonicalSelfFeed({ core: C.core, callOp: C.server.localOp, env: { XMBL_SELF_FEED_MS: '1000', XMBL_SELF_FEED_STALE_MS: '1' }, fetchImpl, log: (l) => logs.push(l), now: () => (t += 5000) });
  const first = await feed.tick();
  ok('self-feed: with no cursor the first tick takes the full set and names its numbering', first === 'applied' && C.core.canonCursor && C.core.canonCursor.seq === CUT, [first, logs.at(-1)]);
  head.n = N;
  const fullPulls = urls.filter((u) => !u.includes('since=')).length;
  const second = await feed.tick();
  ok('self-feed: the next tick appends from the cursor', second === 'appended' && C.core.canonCursor.seq === N, [second, logs.at(-1)]);
  ok('self-feed: and pulled no full set to do it', urls.filter((u) => !u.includes('since=')).length === fullPulls && urls.at(-1).includes(`since=${CUT}`) && urls.at(-1).includes(`gen=${GEN}`));
  ok('self-feed: the appended node holds what a full rebuild holds', anchorKeys(C.core) === anchorKeys(B.core) && C.core.xvsm.getStateRoot() === r1.state_root);
  const third = await feed.tick();
  ok('self-feed: a tick with nothing new appends nothing and pulls no full set', third === 'appended' && C.core.canonCursor.seq === N && urls.filter((u) => !u.includes('since=')).length === fullPulls);
  head.gen = '1111222233334444';   // the broker renumbered its journal
  const rowsBefore = urls.length;
  const fourth = await feed.tick();
  const pulled = urls.slice(rowsBefore);
  ok('self-feed: a broker renumbering falls to the full set and takes the new numbering', fourth === 'applied' && C.core.canonCursor.gen === head.gen && C.core.canonCursor.seq === N && C.core.canonCursor.root === rootAt(N), [fourth, C.core.canonCursor, logs.at(-1)]);
  ok('self-feed: one delta asked, one full set pulled', pulled.length === 2 && pulled[0].includes('since=') && pulled[1].includes('from_epoch=1'), pulled);
  ok('self-feed: and the applied line names why', /full set because broker: gen/.test(logs.at(-1)), logs.at(-1));
  ok('OUTCOME: the renumbered node still holds the full rebuild\'s root', C.core.xvsm.getStateRoot() === r1.state_root);
  feed.stop();
  feedState(C.core);
  await C.core.stop?.();
  C.server.close();
}

A.server.close(); B.server.close();
await A.core.stop?.(); await B.core.stop?.();
for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
