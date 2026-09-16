// THE BACKFILL REWRITES EVERY BLOCK'S COORDINATES, AND NO SUITE HAD EVER LOADED IT.
//
// membership-backfill reconstructs which blocks belong to which cube for a ledger whose persisted records
// cannot say — `faces` holds face INDICES, never ids, and every block reads cubeIndex 0. It then emits a
// `writes` list that rewrites each block's location, coordinates, vector and fractal address. A wrong
// partition here does not fail loudly: it relabels 27 blocks per cube with coordinates that no other node
// agrees with, which is precisely the state the file exists to repair.
//
// What makes that safe is ONE property — the reconstruction is self-verifying: a candidate partition is
// accepted only if it reproduces the persisted cube id AND the persisted merkleRoot. Sections 3 and 4 are
// the ones that matter: they hand it records it must REFUSE, and check that refusal is reported as
// `unmatched` rather than absorbed. A backfill that silently matches nothing and a backfill that silently
// matches wrongly look identical from the outside unless something checks.
import { createHash } from 'crypto';
import { reconstruct, RULES } from './membership-backfill.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };

// ── the derivation, restated independently ─────────────────────────────────────────────────────────
// Deliberately a SECOND implementation rather than an import: a test that builds its fixtures with the
// function under test proves only that the function agrees with itself.
const sha = (s) => createHash('sha256').update(s).digest('hex');
const merkle = (hs) => {
  if (!hs.length) throw new Error('merkle of empty set');
  if (hs.length === 1) return hs[0];
  const nx = [];
  for (let i = 0; i < hs.length; i += 2) nx.push(sha(hs[i] + (hs[i + 1] ?? hs[i])));
  return merkle(nx);
};
const faceRootOf = (hashes) => merkle([...hashes].sort());
const idOf = (roots) => sha([...roots].sort().join('')).slice(0, 16);
const rootOf = (roots) => merkle([...roots].sort());

// 27 blocks = 3 faces of 9 = one cube. Timestamps ascend so the `arrival` rule's ordering is the array order.
const mkBlocks = (n, { base = 1_789_500_000_000_000_000n, tag = 'b' } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${tag}${i}`,
    hash: sha(`${tag}-block-${i}`),
    timestamp: base + BigInt(i),
  }));

// Build the cube records the ledger would have persisted for an ordering, without using the module.
const recordsFor = (ordered) => {
  const faces = [];
  for (let i = 0; i + 9 <= ordered.length; i += 9) {
    faces.push(faceRootOf(ordered.slice(i, i + 9).map((b) => b.hash)));
  }
  const out = [];
  for (let f = 0; f + 3 <= faces.length; f += 3) {
    const roots = faces.slice(f, f + 3);
    out.push({ id: idOf(roots), merkleRoot: rootOf(roots) });
  }
  return out;
};

// ── 1. THE ROUND TRIP: A CUBE SEALED IN ARRIVAL ORDER IS RECOVERED ─────────────────────────────────
{
  const blocks = mkBlocks(27);
  const records = recordsFor(blocks);
  ok('the fixture produces exactly one cube record', records.length === 1);

  const r = reconstruct(blocks, records);
  ok('THE PERSISTED CUBE IS MATCHED', r.matched.length === 1 && r.matched[0] === records[0].id);
  ok('nothing is left unmatched', r.unmatched.length === 0);
  ok('the arrival rule is the one that matched it', r.ruleUsed.arrival === 1);
  ok('WRITES COVER EVERY BLOCK IN THE CUBE — 3 faces x 9', r.writes.length === 27);
  ok('every write names the cube it belongs to, not index 0',
     r.writes.every((w) => w.location.cubeIndex === records[0].id));
  ok('every write carries coordinates, a vector and a fractal address',
     r.writes.every((w) => w.coordinates && w.vector && typeof w.fractalAddress !== 'undefined'));

  // Shuffling the input must not change the answer: `arrival` sorts by timestamp itself.
  const shuffled = [...blocks].reverse();
  const r2 = reconstruct(shuffled, records);
  ok('THE INPUT ORDER IS IRRELEVANT — the rule sorts, so a reversed array recovers the same cube',
     r2.matched.length === 1 && r2.matched[0] === records[0].id);
  ok('...and produces the same 27 writes', r2.writes.length === 27);
}

// ── 2. faceIndex AGREES WITH THE ID DERIVATION, WHICH IS THE WHOLE POINT ───────────────────────────
// cube.id is sha(sorted roots joined), so a face's index must be its root's RANK among the sorted roots.
// If those two disagree, every node that recomputes an id from the backfilled faces gets a different cube.
{
  const blocks = mkBlocks(27);
  const records = recordsFor(blocks);
  const r = reconstruct(blocks, records);

  const byFace = new Map();
  for (const w of r.writes) {
    if (!byFace.has(w.location.faceIndex)) byFace.set(w.location.faceIndex, []);
    byFace.get(w.location.faceIndex).push(w);
  }
  ok('exactly three face indices are used', byFace.size === 3);
  ok('THEY ARE 0, 1, 2 — not arbitrary labels', [0, 1, 2].every((i) => byFace.has(i)));
  ok('each face holds exactly nine blocks', [...byFace.values()].every((v) => v.length === 9));

  // Recompute each face's root from its members and check the rank matches the recorded index.
  const rootsByIndex = new Map();
  for (const [idx, ws] of byFace) rootsByIndex.set(idx, faceRootOf(ws.map((w) => w.block.hash)));
  const sortedRoots = [...rootsByIndex.values()].sort();
  ok('EVERY faceIndex IS THE RANK OF THAT FACE’S ROOT AMONG THE SORTED ROOTS',
     [...rootsByIndex.entries()].every(([idx, root]) => sortedRoots.indexOf(root) === idx));
  ok('...and those three roots reproduce the persisted cube id',
     idOf(sortedRoots) === records[0].id);
  ok('...and the persisted merkle root', rootOf(sortedRoots) === records[0].merkleRoot);

  // Position within a face is by hash, so every node lands on the same slot for the same block.
  ok('POSITIONS ARE 0..8 AND ORDERED BY BLOCK HASH — placement cannot depend on arrival order',
     [...byFace.values()].every((ws) => {
       const byPos = [...ws].sort((a, b) => a.location.position - b.location.position);
       if (byPos.map((w) => w.location.position).join() !== '0,1,2,3,4,5,6,7,8') return false;
       const hashes = byPos.map((w) => w.block.hash);
       return hashes.join() === [...hashes].sort().join();
     }));
}

// ── 3. THE SELF-VERIFICATION REFUSES A RECORD IT CANNOT REPRODUCE ──────────────────────────────────
// This is the guard that makes a wrong rule impossible to apply silently. A record whose merkleRoot does
// not match must be left ALONE and REPORTED, never matched on the id alone.
{
  const blocks = mkBlocks(27);
  const records = recordsFor(blocks);

  const tampered = [{ id: records[0].id, merkleRoot: sha('not the real root') }];
  const r = reconstruct(blocks, tampered);
  ok('A RECORD WHOSE merkleRoot DOES NOT MATCH IS NOT MATCHED ON ITS ID ALONE', r.matched.length === 0);
  ok('...it is reported as unmatched', r.unmatched.length === 1 && r.unmatched[0] === records[0].id);
  ok('...AND NO WRITES ARE EMITTED — a cube it cannot verify is left untouched', r.writes.length === 0);
  ok('...and no rule claims credit', Object.keys(r.ruleUsed).length === 0);

  // A record with NO merkleRoot at all is matched on the id, which is the documented fallback for legacy
  // records — pinned here so removing the `want.get(id).merkleRoot &&` guard shows up as a change.
  const noRoot = reconstruct(blocks, [{ id: records[0].id }]);
  ok('a legacy record carrying no merkleRoot still matches on the id (documented fallback)',
     noRoot.matched.length === 1 && noRoot.writes.length === 27);
}

// ── 4. A CUBE ID NOTHING CAN PRODUCE IS REPORTED, NOT INVENTED ─────────────────────────────────────
{
  const blocks = mkBlocks(27);
  const records = recordsFor(blocks);
  const ghost = { id: 'deadbeefdeadbeef', merkleRoot: sha('ghost') };

  const r = reconstruct(blocks, [...records, ghost]);
  ok('the real cube is still matched alongside the ghost', r.matched.includes(records[0].id));
  ok('THE GHOST IS REPORTED UNMATCHED', r.unmatched.length === 1 && r.unmatched[0] === ghost.id);
  ok('the ghost contributes no writes', r.writes.length === 27);

  const only = reconstruct(blocks, [ghost]);
  ok('a record set of nothing but ghosts matches nothing', only.matched.length === 0);
  ok('...and emits nothing', only.writes.length === 0);
  ok('an EMPTY record set is not an error — nothing wanted, nothing written',
     (() => { const e = reconstruct(blocks, []); return e.matched.length === 0 && e.writes.length === 0; })());
}

// ── 5. THE SECOND RULE EXISTS BECAUSE ONE ERA SEALED DIFFERENTLY ───────────────────────────────────
// `hash` orders the pool globally by block hash (addSealedBatch); `arrival` by timestamp. A cube sealed
// under one must not be recoverable by accident under the other, or "which rule matched" means nothing.
{
  ok('both rules are exported and are functions',
     typeof RULES.arrival === 'function' && typeof RULES.hash === 'function');

  const blocks = mkBlocks(27, { tag: 'h' });
  const hashOrdered = RULES.hash(blocks);
  ok('the hash rule sorts by block hash',
     hashOrdered.map((b) => b.hash).join() === [...blocks.map((b) => b.hash)].sort().join());
  ok('the arrival rule sorts by timestamp',
     RULES.arrival([...blocks].reverse()).map((b) => b.id).join() === blocks.map((b) => b.id).join());
  ok('the rules genuinely disagree on this fixture (otherwise the next check proves nothing)',
     hashOrdered.map((b) => b.id).join() !== blocks.map((b) => b.id).join());

  const hashRecords = recordsFor(hashOrdered);
  const r = reconstruct(blocks, hashRecords);
  ok('A CUBE SEALED UNDER THE HASH RULE IS RECOVERED', r.matched.length === 1);
  ok('...AND THE REPORT NAMES THE HASH RULE, not arrival',
     r.ruleUsed.hash === 1 && r.ruleUsed.arrival === undefined);
  ok('...with a full set of writes', r.writes.length === 27);

  // Both eras at once: two disjoint block sets, one sealed each way.
  const era1 = mkBlocks(27, { tag: 'x' });
  const era2 = mkBlocks(27, { tag: 'y', base: 1_789_600_000_000_000_000n });
  const mixed = reconstruct([...era1, ...era2],
                            [...recordsFor(RULES.arrival([...era1, ...era2]))]);
  ok('54 blocks in arrival order seal two cubes, and both are matched', mixed.matched.length === 2);
  ok('...covering all 54 blocks', mixed.writes.length === 54);
  ok('...and their sequential indices are distinct',
     new Set(mixed.writes.map((w) => w.location.cubeSequentialIndex)).size === 2);
}

// ── 6. A SHORT LEDGER SEALS NOTHING, AND SAYS SO ───────────────────────────────────────────────────
// 26 blocks is not a cube. The chunking is `i + 9 <= len` and `f + 3 <= faces`, so a partial face and a
// partial cube are both dropped — the failure mode to avoid is inventing a cube from 18 blocks.
{
  for (const n of [0, 1, 8, 9, 17, 26]) {
    const blocks = mkBlocks(n, { tag: `s${n}` });
    const r = reconstruct(blocks, [{ id: 'anything', merkleRoot: sha('x') }]);
    ok(`${n} blocks produce no cube`, r.matched.length === 0 && r.writes.length === 0);
  }
  const exact = mkBlocks(27, { tag: 'e' });
  ok('27 blocks — the first count that CAN seal — produce exactly one',
     reconstruct(exact, recordsFor(exact)).matched.length === 1);
  ok('53 blocks still produce only one cube (the 54th is what completes the second)',
     (() => { const b = mkBlocks(53, { tag: 'q' }); return reconstruct(b, recordsFor(b)).matched.length === 1; })());
}

// ── 7. TIMESTAMP SHAPES THE LEDGER ACTUALLY PERSISTS ───────────────────────────────────────────────
// Nanosecond timestamps survive JSON as `{ __bigint__: "…" }`. A block whose timestamp is that envelope,
// a plain number, a string, or missing entirely must all order without throwing — `tsOf` falls back to 0n.
{
  const wrap = (v) => ({ __bigint__: String(v) });
  const blocks = mkBlocks(27, { tag: 'w' }).map((b, i) => ({
    ...b,
    timestamp: i % 4 === 0 ? wrap(b.timestamp)
             : i % 4 === 1 ? Number(b.timestamp / 1_000_000n)
             : i % 4 === 2 ? String(b.timestamp)
             : b.timestamp,
  }));
  let threw = null;
  try { RULES.arrival(blocks); } catch (e) { threw = e; }
  ok('MIXED TIMESTAMP SHAPES DO NOT THROW — the wrapped-bigint envelope is understood', threw === null);

  const junk = [{ id: 'j0', hash: sha('j0') },                           // no timestamp at all
                { id: 'j1', hash: sha('j1'), timestamp: null },
                { id: 'j2', hash: sha('j2'), timestamp: 'not a number' },
                { id: 'j3', hash: sha('j3'), timestamp: { __bigint__: 'garbage' } }];
  let junkThrew = null;
  try { RULES.arrival(junk); } catch (e) { junkThrew = e; }
  ok('AN UNPARSEABLE TIMESTAMP FALLS BACK TO ZERO RATHER THAN THROWING', junkThrew === null);
  ok('...and the ordering still returns every block', RULES.arrival(junk).length === 4);

  // The wrapped form must order IDENTICALLY to the raw bigint, or a JSON round trip silently repartitions
  // the ledger — the same blocks, a different cube id, and a backfill that "matched nothing".
  const raw = mkBlocks(27, { tag: 'r' });
  const wrapped = raw.map((b) => ({ ...b, timestamp: wrap(b.timestamp) }));
  ok('A JSON ROUND TRIP OF THE TIMESTAMP DOES NOT REPARTITION THE LEDGER',
     RULES.arrival(wrapped).map((b) => b.id).join() === RULES.arrival(raw).map((b) => b.id).join());
  ok('...so the cube built from the wrapped blocks has the SAME id',
     recordsFor(RULES.arrival(wrapped))[0].id === recordsFor(RULES.arrival(raw))[0].id);
}

// ── 8. THE INPUT IS NOT MUTATED ────────────────────────────────────────────────────────────────────
// The rules sort copies. A backfill that reordered the caller's array in place would corrupt whatever the
// caller reads next — and it reads the same blocks to write them back.
{
  const blocks = mkBlocks(27, { tag: 'm' });
  const before = blocks.map((b) => b.id).join();
  reconstruct(blocks, recordsFor(blocks));
  ok('reconstruct DOES NOT REORDER THE CALLER’S ARRAY', blocks.map((b) => b.id).join() === before);
  RULES.hash(blocks); RULES.arrival(blocks);
  ok('...and neither rule does either', blocks.map((b) => b.id).join() === before);
  ok('a write points at the caller’s own block object, not a copy',
     reconstruct(blocks, recordsFor(blocks)).writes.every((w) => blocks.includes(w.block)));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
