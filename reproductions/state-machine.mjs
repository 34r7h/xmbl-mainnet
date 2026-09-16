// REPRODUCTION — THE STATE ROOT IS A PURE FUNCTION OF THE APPLIED SET, AND IT SURVIVES A RESTART
// (packages/state-machine).
//
// CLAIM: two nodes that apply the same canonical set hold the same verkle state root, whatever order the set
// arrives in and whatever either held before; and a node that restarts comes back with the SAME root rather
// than an empty one. The first half is what lets the nodes compare roots at all. The second half is what makes
// that comparison mean anything after a reboot.
//
// WHY BOTH HALVES ARE MEASURED HERE — each was measured failing:
//   • The trie was not rebuilt on load: every restart came back with a root of 64 zeros, so a node that had
//     applied thousands of anchors published the empty root and any comparison against it was meaningless.
//   • rebuildFromCanonical cleared `this.diffs` in memory while leaving 92,505 `diff:` rows on disk, so the
//     "authoritative" rebuild lasted exactly until the next boot read them back.
//   • It also wrote into the tree without recording a diff, and applied_tx_count is derived from the diff log —
//     so running the convergence primitive reset the one number the nodes read as "is this node applying
//     anything" to 0 and left it there. MEASURED 2026-09-15: 42 of 46 reporting nodes published 0, and a design
//     ruling was written on the premise that they had applied nothing. They had applied thousands.
//
// Exits non-zero if any claim fails, so it is also a hard-gate test (reproductions.test.mjs).
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateMachine } from '@xmbl/state-machine';

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const selfDigest = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
console.log('XMBL reproduction — the state root is a pure function of the applied set, and survives a restart');
console.log(`source sha256: ${selfDigest}\n`);

let failures = 0;
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`); if (!cond) failures++; };
const dirs = [];
const newSM = async () => {
  const d = mkdtempSync(join(tmpdir(), 'xmbl-repro-vsm-')); dirs.push(d);
  const sm = new StateMachine({ dbPath: d, totalShards: 4 });
  await sm.ready();
  return { sm, dir: d };
};
const EMPTY_ROOT = '0'.repeat(64);

// The canonical set as the broker's feed serves it.
const N = 40;
const canonical = Array.from({ length: N }, (_, i) => ({ event: i % 2 ? 'task.created' : 'value.transfer', hash: sha('a' + i), ts: 1789500000000 + i }));

// ── 1. SAME SET, ANY ORDER → SAME ROOT ──
const { sm: A } = await newSM();
const { sm: B } = await newSM();
const ra = await A.rebuildFromCanonical(canonical);
const rb = await B.rebuildFromCanonical(canonical.slice().reverse());
ok('both applied every row', ra.applied === N && rb.applied === N, `${ra.applied} / ${rb.applied} of ${N}`);
ok('neither skipped anything', ra.skipped === 0 && rb.skipped === 0);
ok('the root is not the empty root', ra.state_root !== EMPTY_ROOT && /^[0-9a-f]{64}$/.test(ra.state_root), ra.state_root.slice(0, 24) + '…');
ok('THE ROOTS ARE IDENTICAL although the set arrived in opposite orders', ra.state_root === rb.state_root);

// ── 2. THE APPLIED COUNT IS REAL, NOT RESET BY THE REBUILD ──
const stats = A.getStatistics();
ok('applied_tx_count reflects what was applied, not 0', stats.totalTransactions >= N, `totalTransactions=${stats.totalTransactions}`);

// ── 3. A NODE THAT ALREADY HELD JUNK CONVERGES ON THE SAME ROOT ──
const { sm: C } = await newSM();
await C.rebuildFromCanonical([{ event: 'divergent', hash: sha('junk1'), ts: 1 }, { event: 'divergent', hash: sha('junk2'), ts: 2 }]);
const junkRoot = C.getStateRoot();
ok('the junk node starts from a DIFFERENT root', junkRoot !== ra.state_root, junkRoot.slice(0, 24) + '…');
const rc = await C.rebuildFromCanonical(canonical);
ok('after adopting the canonical set it lands on the SAME root as the others', rc.state_root === ra.state_root);
ok('nothing of the junk survived (the rebuild is authoritative, not additive)', C.getStateRoot() === ra.state_root);

// ── 4. THE ROOT SURVIVES A RESTART ──
const d = mkdtempSync(join(tmpdir(), 'xmbl-repro-vsm-restart-')); dirs.push(d);
let rootBefore = null, appliedBefore = 0;
{
  const sm = new StateMachine({ dbPath: d, totalShards: 4 });
  await sm.ready();
  const r = await sm.rebuildFromCanonical(canonical);
  rootBefore = r.state_root;
  appliedBefore = sm.getStatistics().totalTransactions;
  ok('the first boot applied the set and holds a real root', r.applied === N && rootBefore !== EMPTY_ROOT);
  await sm.db?.close?.();
}
{
  const sm = new StateMachine({ dbPath: d, totalShards: 4 });
  await sm.ready();
  const rootAfter = sm.getStateRoot();
  ok('THE SECOND BOOT COMES BACK WITH THE SAME ROOT — not 64 zeros', rootAfter === rootBefore, `${String(rootBefore).slice(0, 16)}… → ${String(rootAfter).slice(0, 16)}…`);
  ok('and the applied count came back with it', sm.getStatistics().totalTransactions === appliedBefore, `${appliedBefore} → ${sm.getStatistics().totalTransactions}`);
  await sm.db?.close?.();
}

// ── 5. AN EMPTY ROW IS SKIPPED, NOT APPLIED AS NOTHING ──
const { sm: D } = await newSM();
const withJunk = [...canonical, { event: null, hash: null }, {}, null];
const rd = await D.rebuildFromCanonical(withJunk);
ok('rows with no event or hash are SKIPPED and counted', rd.applied === N && rd.skipped === 3, `applied=${rd.applied} skipped=${rd.skipped}`);
ok('and the root is unchanged by the junk', rd.state_root === ra.state_root);

for (const sm of [A, B, C, D]) { try { await sm.db?.close?.(); } catch { /* */ } }
for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
console.log(failures === 0
  ? '\nREPRODUCED — same set, same root, any order; a divergent node converges; the root and the applied count survive a restart.'
  : `\nNOT REPRODUCED — ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
