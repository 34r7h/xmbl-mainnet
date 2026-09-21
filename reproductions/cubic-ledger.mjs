// REPRODUCTION — THE CHAIN IS A PURE FUNCTION OF THE SET IT WAS GIVEN (packages/cubic-ledger).
//
// CLAIM: two ledgers handed the same canonical anchor set rebuild to the SAME chain — the same blocks, the
// same faces, the same cubes, the same cube `set_digest` — regardless of the order the anchors arrive in or
// what either node held before. That is the property every node's convergence rests on, and the number
// the coordinated rebuild compares.
//
// AND THE THREE THINGS A REBUILD MUST NOT DO, each measured here because each was measured FAILING:
//   • It must not destroy state the canonical set does not describe. The set contains anchors and nothing
//     else, so every value tx, utxo, identity and contract a node holds is outside it by construction.
//     Measured on a live node 2026-09-15: 14,890 block rows of which 249 were type-6 value txs, none in the
//     canonical set, deleted every 90 seconds by the convergence timer.
//   • It must not accept a set that would empty the chain. The broker's default feed still serves 4008 rows of
//     which 3991 predate typing and can never be back-mined; fed to a typed-only node it rebuilds to nothing.
//     A wipe is not a rebuild, so the ledger refuses it and touches nothing.
//   • It must not let a forgery evict what it impersonates. Found by reproductions/three-nodes.mjs: a datum
//     whose claimed xid is not its content address was evicted BY that xid — i.e. by somebody else's identity.
//
// Exits non-zero if any claim fails, so it is also a hard-gate test (reproductions.test.mjs).
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger, micromineTx } from '@xmbl/cubic-ledger';

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const selfDigest = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
console.log('XMBL reproduction — a rebuilt chain is a pure function of the anchor set');
console.log(`source sha256: ${selfDigest}\n`);

let failures = 0;
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`); if (!cond) failures++; };
const dirs = [];
const newLedger = async () => { const d = mkdtempSync(join(tmpdir(), 'xmbl-repro-cl-')); dirs.push(d); const l = new Ledger({ dbPath: d }); await l.ready(); return l; };
const setDigest = (l) => {
  const cubes = [...l.cubes.values()].map((c) => ({ id: c.id, merkleRoot: c.merkleRoot ?? null }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return createHash('sha256').update(cubes.map((c) => `${c.id}:${c.merkleRoot}`).join('|')).digest('hex');
};

// The canonical set, exactly as the broker's epoch-scoped feed serves it: event, hash, ts, xid, nonce, prior.
const N = 30;
const feed = Array.from({ length: N }, (_, i) => {
  const t = micromineTx({ type: 'anchor', event: i % 2 ? 'task.created' : 'value.transfer', hash: sha('anchor' + i), ts: 1789500000000 + i });
  return { event: t.event, hash: t.hash, ts: t.ts, xid: t.xid, nonce: t.nonce, prior: t.prior };
});

// ── 1. SAME SET, ANY ORDER → SAME CHAIN ──
const a = await newLedger(), b = await newLedger();
const ra = await a.rebuildFromAnchors(feed);
const rb = await b.rebuildFromAnchors(feed.slice().reverse());
ok('both ledgers rebuilt every typed row', ra.anchors === N && rb.anchors === N, `${ra.anchors} / ${rb.anchors} of ${N}`);
ok('neither reported an untyped or rejected row', ra.untyped === 0 && ra.rejected === 0 && rb.untyped === 0 && rb.rejected === 0);
ok('both sealed the same number of faces and cubes', ra.faces_sealed === rb.faces_sealed && a.cubes.size === b.cubes.size, `faces=${ra.faces_sealed} cubes=${a.cubes.size}`);
ok('the CUBE SET DIGEST is identical although the anchors arrived in opposite orders', setDigest(a) === setDigest(b), setDigest(a).slice(0, 24) + '…');

// ── 2. A REBUILD PRESERVES WHAT THE ANCHOR SET DOES NOT DESCRIBE ──
const valueTx = micromineTx({ type: 'utxo', from: 'xmbPAYER', to: 'xmbPAYEE', amount: '42', timestamp: 7 });
await a.addTransaction({ ...valueTx, sig: 'SIGNATURE' });
const beforeValue = [...a._membershipPool, ...a.blocks.values()].filter((bl) => bl.tx && bl.tx.type === 'utxo').length;
ok('the node holds a value tx that is NOT in the canonical set', beforeValue === 1);
const again = await a.rebuildFromAnchors(feed);
const afterValue = [...a._membershipPool, ...a.blocks.values()].filter((bl) => bl.tx && bl.tx.type === 'utxo').length;
ok('the rebuild PRESERVED it (rescued, not destroyed)', afterValue === beforeValue, `before=${beforeValue} after=${afterValue}`);
ok('and the rebuild says how many rows it wiped', typeof again.wiped === 'number' && again.wiped > 0, `wiped=${again.wiped}`);

// ── 3. A REBUILD THAT WOULD EMPTY THE CHAIN IS REFUSED ──
const legacyFeed = Array.from({ length: 50 }, (_, i) => ({ event: 'legacy', hash: sha('legacy' + i), ts: 1 }));
const heldBefore = a.blocks.size;
const refused = await a.rebuildFromAnchors(legacyFeed);
ok('an all-untyped feed is REFUSED', refused.refused === 'would-empty-the-chain');
ok('the refusal counts what it saw', refused.requested === 50 && refused.untyped === 50 && refused.would_rebuild === 0);
ok('NOTHING was deleted — the chain is exactly as it was', a.blocks.size === heldBefore, `${heldBefore} → ${a.blocks.size}`);

// ── 4. A FORGERY CANNOT EVICT WHAT IT IMPERSONATES ──
const c = await newLedger();
const genuine = micromineTx({ type: 'anchor', event: 'task.created', hash: sha('genuine'), ts: 99 });
const forgery = { ...genuine, hash: sha('forged') };          // same xid + nonce, different body
let threw = null;
try { await c.addTransaction(forgery); } catch (e) { threw = e; }
ok('the forgery is refused, and says why', threw !== null && threw.code === 'XID_MISMATCH');
ok('the impersonated xid was NOT evicted', !c._evicted.has(`xid:${genuine.xid}`));
ok('the forgery WAS evicted, under a digest of its own bytes', [...c._evicted].some((k) => k.startsWith('forged:')));
const admitted = await c.addTransaction(genuine);
ok('the genuine anchor still gets in afterwards', !!admitted && admitted.evicted !== true && c._membershipPool.length === 1);

// ── 5. AN INVALID DATUM IS EVICTED FOR GOOD — across a restart ──
const d = mkdtempSync(join(tmpdir(), 'xmbl-repro-cl-evict-')); dirs.push(d);
{
  const l1 = new Ledger({ dbPath: d }); await l1.ready();
  const label = { type: 'anchor', event: 'proof.mined', hash: 'proofofmined-1789450900844', ts: 1 };
  try { await l1.addTransaction(label); } catch { /* expected */ }
  ok('a label where a digest belongs is refused and recorded', l1._evicted.size >= 1);
  await l1.close?.();
  const l2 = new Ledger({ dbPath: d }); await l2.ready();
  ok('the eviction SURVIVED the restart — it is never examined again', l2._evicted.size >= 1, `evicted=${l2._evicted.size}`);
  await l2.close?.();
}

for (const l of [a, b, c]) { try { await l.close?.(); } catch { /* */ } }
for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
console.log(failures === 0
  ? '\nREPRODUCED — same set, same chain, in any order; nothing outside the set is destroyed; a wipe is refused; a forgery cannot evict its victim.'
  : `\nNOT REPRODUCED — ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
