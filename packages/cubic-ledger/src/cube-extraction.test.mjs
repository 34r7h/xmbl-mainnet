// THE BYTES THE CUBE CURVE IS HASHED FROM WERE 47% COVERED.
//
// cube-extraction turns a completed cube into the ORDERED coordinate/vector set its downstream consumer
// hashes. The file's own header states the load-bearing claim: "BYTE-STABLE across nodes for the same
// ledger state". Everything in it exists to keep one promise — that two independent node processes,
// given the same transactions, emit the same bytes. Order is the whole content: `serializeExtraction`
// prefixes each coordinate with its index precisely so that reordering identical values changes the
// digest.
//
// What had never been exercised is every way that promise can quietly break. Traversal order must be
// CONTENT-derived, so §3 feeds the same cube with its faces in a different Map insertion order and its
// blocks inserted backwards, and requires identical bytes. Index resolution must sort by hash-derived
// id and never by timestamp, so §5 builds a ledger whose id order and insertion order DISAGREE and
// checks which one the extractor follows — insertion order is process-relative, so following it would
// hand two nodes different cubes for the same index while both reported success.
//
// The error paths matter for the same reason: an incomplete cube must THROW, because the alternative is
// a short coordinate list that hashes to something plausible.
import { createHash } from 'crypto';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractCube, extractFromLedger, serializeExtraction } from './cube-extraction.js';
import { Ledger } from './ledger.js';
import { micromineTx } from './transaction-validator.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const threw = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const sha = (s) => createHash('sha256').update(s).digest('hex');

// ── a structural fixture ───────────────────────────────────────────────────────────────────────────
// extractInto reads `cube.faces` (a Map of face objects carrying `.index` and a `blocks`/`cubes` Map).
// Built by hand so a face's insertion order and its `.index` can be made to DISAGREE — which is the
// only way to tell whether traversal follows content or follows whatever order the Map happens to hold.
const leafFace = (index, tag, { reverse = false } = {}) => {
  const blocks = new Map();
  const positions = reverse ? [8, 7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7, 8];
  for (const p of positions) blocks.set(p, { hash: sha(`${tag}-f${index}-p${p}`) });
  return { index, blocks, hash: sha(`face-${tag}-${index}`) };
};
const atomicCube = (tag, { faceOrder = [0, 1, 2], reverseBlocks = false } = {}) => {
  const faces = new Map();
  for (const i of faceOrder) faces.set(i, leafFace(i, tag, { reverse: reverseBlocks }));
  return { id: `cube-${tag}`, faces, level: null, isComplete: () => faces.size === 3 };
};
const superCube = (tag, level, children) => {
  const faces = new Map();
  let k = 0;
  for (let i = 0; i < 3; i++) {
    const cubes = new Map();
    for (let p = 0; p < 9; p++) cubes.set(p, children[k++]);
    faces.set(i, { index: i, cubes, hash: sha(`sface-${tag}-${i}`) });
  }
  return { id: `super-${tag}`, faces, level, isComplete: () => faces.size === 3 };
};

// ── 1. A LEVEL-1 CUBE YIELDS ITS 27 LEAVES, IN ORDER, WITH MAGNITUDES ─────────────────────────────
{
  const e = extractCube(atomicCube('a'));
  ok('the extraction reports the cube address', e.cubeAddress === 'cube-a');
  ok('A LEVEL-1 CUBE YIELDS EXACTLY 27 COORDINATES', e.coordinates.length === 27);
  ok('every coordinate carries x, y, z and a magnitude',
     e.coordinates.every((c) => ['x', 'y', 'z', 'magnitude'].every((k) => typeof c[k] === 'number')));
  ok('every component is finite', e.coordinates.every((c) => Object.values(c).every(Number.isFinite)));
  ok('LEAF COMPONENTS LIE IN {-1,0,1} — the atomic unit grid',
     e.coordinates.every((c) => [c.x, c.y, c.z].every((v) => v === -1 || v === 0 || v === 1)));
  ok('all 27 positions are distinct — no two leaves share a coordinate',
     new Set(e.coordinates.map((c) => `${c.x},${c.y},${c.z}`)).size === 27);
  ok('the magnitude is the vector length of its own coordinate',
     e.coordinates.every((c) => Math.abs(c.magnitude - Math.sqrt(c.x ** 2 + c.y ** 2 + c.z ** 2)) < 1e-12));
  ok('the origin leaf is present (0,0,0 has magnitude 0)',
     e.coordinates.some((c) => c.x === 0 && c.y === 0 && c.z === 0 && c.magnitude === 0));
}

// ── 2. A LEVEL-L CUBE YIELDS 27^L LEAVES, SPACED THREE TIMES WIDER PER LEVEL ──────────────────────
{
  const children = Array.from({ length: 27 }, (_, i) => atomicCube(`c${i}`));
  const s = extractCube(superCube('s', 2, children));
  ok('A LEVEL-2 CUBE YIELDS 27x27 = 729 COORDINATES', s.coordinates.length === 729);
  ok('it reports the super-cube’s own address', s.cubeAddress === 'super-s');
  ok('every one of the 729 is distinct — nesting does not collide children',
     new Set(s.coordinates.map((c) => `${c.x},${c.y},${c.z}`)).size === 729);
  ok('THE SPAN WIDENS WITH LEVEL — a level-2 extent exceeds the level-1 extent',
     Math.max(...s.coordinates.map((c) => Math.abs(c.x))) > 1);
  // MEASURED: a level-2 component is (slot in {0,±3,±6}) x scale 3, plus the leaf's own {-1,0,1} —
  // so exactly {0,±1,±8,±9,±10,±17,±18,±19}. Asserted as the literal set rather than a
  // bound, because a bound would still pass if the nesting scale silently changed.
  ok('EVERY LEVEL-2 COMPONENT IS A SLOT OFFSET PLUS A LEAF OFFSET, and nothing else', (() => {
     const allowed = new Set([0, 1, 8, 9, 10, 17, 18, 19]);
     return s.coordinates.every((c) => [c.x, c.y, c.z]
       .every((v) => Number.isInteger(v) && allowed.has(Math.abs(v))));
   })());

  // The first 27 leaves are the first child's, offset by that child's slot.
  const first = extractCube(children[0]).coordinates;
  const head = s.coordinates.slice(0, 27);
  const dx = head[0].x - first[0].x, dy = head[0].y - first[0].y, dz = head[0].z - first[0].z;
  ok('THE FIRST CHILD’S 27 LEAVES APPEAR FIRST, RIGIDLY TRANSLATED BY ITS SLOT',
     head.every((c, i) => c.x - first[i].x === dx && c.y - first[i].y === dy && c.z - first[i].z === dz));
}

// ── 3. TRAVERSAL IS CONTENT-DERIVED, NOT MAP-ORDER-DERIVED ───────────────────────────────────────
// This is the determinism claim. Two node processes build their Maps in whatever order transactions
// arrived; if traversal followed that, the same ledger state would serialize to different bytes.
{
  const canonical = serializeExtraction(extractCube(atomicCube('z')));

  const shuffledFaces = serializeExtraction(extractCube(atomicCube('z', { faceOrder: [2, 0, 1] })));
  ok('INSERTING THE FACES IN A DIFFERENT ORDER PRODUCES IDENTICAL BYTES', canonical.equals(shuffledFaces));

  const reversedBlocks = serializeExtraction(extractCube(atomicCube('z', { reverseBlocks: true })));
  ok('INSERTING THE BLOCKS BACKWARDS PRODUCES IDENTICAL BYTES', canonical.equals(reversedBlocks));

  const both = serializeExtraction(extractCube(atomicCube('z', { faceOrder: [1, 2, 0], reverseBlocks: true })));
  ok('...and so does doing both at once', canonical.equals(both));

  // Control: the comparison could go red. A genuinely different cube must differ.
  ok('a DIFFERENT cube serializes differently (the control could fail)',
     !canonical.equals(serializeExtraction(extractCube(atomicCube('different')))));
}

// ── 4. AN INCOMPLETE CUBE THROWS RATHER THAN RETURNING A SHORT LIST ──────────────────────────────
// A short coordinate list hashes to something perfectly plausible. Every structural defect must be loud.
{
  ok('a cube with two faces is refused',
     threw(() => extractCube(atomicCube('t', { faceOrder: [0, 1] })), /expected 3 faces|not complete/));
  // A FOURTH face is caught by isComplete() first, one stage before facesInOrder's count — so the message
  // is "not complete", not "expected 3 faces". Pinned as the actual behaviour.
  ok('a cube with four faces is refused (by the completeness check, which runs first)',
     threw(() => extractCube(atomicCube('t', { faceOrder: [0, 1, 2, 3] })), /not complete/));
  ok('...and a four-face cube whose isComplete lies is still caught by the face count', (() => {
     const c = atomicCube('t', { faceOrder: [0, 1, 2, 3] });
     c.isComplete = () => true;
     return threw(() => extractCube(c), /expected 3 faces, got 4/);
   })());
  ok('isComplete() === false is refused before the faces are even walked', (() => {
    const c = atomicCube('t'); c.isComplete = () => false;
    return threw(() => extractCube(c), /not complete/);
  })());

  ok('A MISSING LEAF BLOCK IS NAMED, with its face and position', (() => {
    const c = atomicCube('t'); c.faces.get(1).blocks.delete(4);
    return threw(() => extractCube(c), /missing leaf block at face 1 position 4/);
  })());
  ok('a level-1 face with no blocks map at all is refused', (() => {
    const c = atomicCube('t'); delete c.faces.get(0).blocks;
    return threw(() => extractCube(c), /has no blocks/);
  })());
  ok('an internal face with no child cubes is refused', (() => {
    const children = Array.from({ length: 27 }, (_, i) => atomicCube(`c${i}`));
    const s = superCube('s', 2, children); delete s.faces.get(0).cubes;
    return threw(() => extractCube(s), /no child cubes/);
  })());
  ok('A MISSING CHILD CUBE IS NAMED', (() => {
    const children = Array.from({ length: 27 }, (_, i) => atomicCube(`c${i}`));
    const s = superCube('s', 2, children); s.faces.get(2).cubes.delete(3);
    return threw(() => extractCube(s), /missing child cube at face 2 position 3/);
  })());

  for (const bad of [null, undefined, 42, 'cube', [], {}, { faces: null }]) {
    ok(`a non-cube argument is refused (${JSON.stringify(bad)})`,
       threw(() => extractCube(bad), /requires a cube object with faces/));
  }
}

// ── 5. LEDGER INDEXING SORTS BY HASH-DERIVED id, NEVER BY INSERTION ORDER ────────────────────────
// Insertion order is process-relative. If index 0 followed it, two nodes would extract different cubes
// for the same (level, index) and BOTH would report success — the failure mode this sort exists to stop.
{
  const mk = (id) => ({ ...atomicCube(id), id });
  // ids chosen so that insertion order is the exact REVERSE of id order.
  const ledger = { cubes: new Map([['zzz', mk('zzz')], ['mmm', mk('mmm')], ['aaa', mk('aaa')]]) };

  ok('the fixture’s insertion order really is not id order (the control)',
     [...ledger.cubes.keys()].join() === 'zzz,mmm,aaa');
  ok('INDEX 0 IS THE LOWEST id, NOT THE FIRST INSERTED',
     extractFromLedger(ledger, 1, 0).cubeAddress === 'aaa');
  ok('index 1 is the middle id', extractFromLedger(ledger, 1, 1).cubeAddress === 'mmm');
  ok('index 2 is the highest id', extractFromLedger(ledger, 1, 2).cubeAddress === 'zzz');
  ok('...and every index yields the full 27 coordinates',
     [0, 1, 2].every((i) => extractFromLedger(ledger, 1, i).coordinates.length === 27));

  ok('AN INDEX PAST THE END SAYS HOW MANY THERE ACTUALLY ARE',
     threw(() => extractFromLedger(ledger, 1, 3), /no completed cube at level 1 index 3 \(have 3\)/));

  // Incomplete cubes are excluded from the index, not counted and then failed on.
  const withPartial = { cubes: new Map([...ledger.cubes, ['bbb', { id: 'bbb', faces: new Map(), isComplete: () => false }]]) };
  ok('AN INCOMPLETE CUBE IS NOT INDEXABLE — it is filtered out, not counted',
     extractFromLedger(withPartial, 1, 0).cubeAddress === 'aaa'
     && threw(() => extractFromLedger(withPartial, 1, 3), /\(have 3\)/));

  // Super-cube levels come from a different map.
  const children = Array.from({ length: 27 }, (_, i) => atomicCube(`c${i}`));
  const l2 = { cubes: new Map(), superCubes: new Map([[2, new Map([['s1', superCube('s1', 2, children)]])]]) };
  ok('a level-2 cube is resolved from superCubes, not cubes',
     extractFromLedger(l2, 2, 0).coordinates.length === 729);
  ok('a level with no super-cubes reports an empty set rather than crashing',
     threw(() => extractFromLedger(l2, 3, 0), /\(have 0\)/));
  ok('a ledger with no superCubes map at all is handled',
     threw(() => extractFromLedger({ cubes: new Map() }, 2, 0), /\(have 0\)/));

  // Argument validation.
  ok('a missing ledger is refused', threw(() => extractFromLedger(null, 1, 0), /ledger is required/));
  for (const lvl of [0, -1, 1.5, '1', null, NaN]) {
    ok(`level ${JSON.stringify(lvl)} is refused`,
       threw(() => extractFromLedger(ledger, lvl, 0), /level must be an integer >= 1/));
  }
  for (const idx of [-1, 1.5, '0', null, NaN]) {
    ok(`index ${JSON.stringify(idx)} is refused`,
       threw(() => extractFromLedger(ledger, 1, idx), /index must be a non-negative integer/));
  }
}

// ── 6. SERIALIZATION IS ORDER-SENSITIVE AND CANONICAL ───────────────────────────────────────────
// The downstream curve hashes these bytes, so "same values, different order" MUST be different bytes.
{
  const e = extractCube(atomicCube('ser'));
  const bytes = serializeExtraction(e);
  ok('it returns a Buffer, ready to hash', Buffer.isBuffer(bytes));
  ok('the same extraction serializes identically every time',
     bytes.equals(serializeExtraction(e)));
  ok('the address is in the bytes', bytes.toString('utf8').includes('cube-ser'));

  const swapped = { cubeAddress: e.cubeAddress, coordinates: [e.coordinates[1], e.coordinates[0], ...e.coordinates.slice(2)] };
  ok('SWAPPING TWO COORDINATES CHANGES THE BYTES — order is content, not presentation',
     !bytes.equals(serializeExtraction(swapped)));
  ok('a different address changes the bytes',
     !bytes.equals(serializeExtraction({ ...e, cubeAddress: 'other' })));
  ok('dropping a coordinate changes the bytes',
     !bytes.equals(serializeExtraction({ ...e, coordinates: e.coordinates.slice(0, 26) })));

  // -0 normalizes to 0, or two processes that computed the same point differently would disagree.
  const negZero = { cubeAddress: 'x', coordinates: [{ x: -0, y: 0, z: 0, magnitude: 0 }] };
  const posZero = { cubeAddress: 'x', coordinates: [{ x: 0, y: 0, z: 0, magnitude: 0 }] };
  ok('NEGATIVE ZERO NORMALIZES TO ZERO — the same point cannot serialize two ways',
     serializeExtraction(negZero).equals(serializeExtraction(posZero)));

  for (const v of [NaN, Infinity, -Infinity]) {
    ok(`a non-finite coordinate (${v}) is refused rather than serialized`,
       threw(() => serializeExtraction({ cubeAddress: 'x', coordinates: [{ x: v, y: 0, z: 0, magnitude: 0 }] }),
             /non-finite coordinate/));
  }
  ok('a non-numeric coordinate is refused',
     threw(() => serializeExtraction({ cubeAddress: 'x', coordinates: [{ x: '1', y: 0, z: 0, magnitude: 0 }] }),
           /non-finite coordinate/));
  ok('an empty coordinate list is serializable (a zero-count extraction is still canonical)',
     Buffer.isBuffer(serializeExtraction({ cubeAddress: 'x', coordinates: [] })));

  ok('a missing extraction is refused', threw(() => serializeExtraction(null), /requires an extraction object/));
  ok('a missing address is refused', threw(() => serializeExtraction({ coordinates: [] }), /cubeAddress is required/));
  ok('a null address is refused', threw(() => serializeExtraction({ cubeAddress: null, coordinates: [] }), /cubeAddress is required/));
  ok('non-array coordinates are refused',
     threw(() => serializeExtraction({ cubeAddress: 'x', coordinates: 'nope' }), /must be an array/));
}

// ── 7. AGAINST A REAL LEDGER: THE SAME TRANSACTIONS EXTRACT TO THE SAME BYTES ────────────────────
// The structural fixtures above prove the traversal rules. This proves the rules survive contact with
// the real Cube/Face objects the Ledger builds — two independent ledgers, the same transaction set fed
// in DIFFERENT orders, and a byte-for-byte comparison of every extraction.
{
  const txs = Array.from({ length: 81 }, (_, i) => ({
    ...micromineTx({ type: 'anchor', event: 'task.created', hash: sha('cx' + i), ts: '2026-08-03T00:00:00Z' }),
    from: 'xmbA', sig: 'S', id: 'cx' + i,
    validationTimestamp: String(1784758606627666688n + BigInt(i)),
  }));
  const shuffled = (() => { const a = [...txs]; let s = 7;
    for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) & 0x7fffffff; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a; })();

  const build = async (batch, tag) => {
    const dir = join(tmpdir(), `cx-extract-${tag}-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    const l = new Ledger({ dbPath: dir });
    if (typeof l.ready === 'function') await l.ready();
    await l.addSealedBatch(batch);
    const complete = [...l.cubes.values()].filter((c) => c.isComplete && c.isComplete());
    const digests = complete
      .map((_, i) => serializeExtraction(extractFromLedger(l, 1, i)).toString('hex'))
      .join('|');
    const count = complete.length;
    try { await l.db.close(); } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
    return { count, digests };
  };

  const a = await build(txs, 'a');
  const b = await build(shuffled, 'b');

  ok('the control holds: the two orderings really are different',
     txs.map((t) => t.id).join() !== shuffled.map((t) => t.id).join());
  ok('both ledgers sealed at least one cube (otherwise the comparison is vacuous)', a.count >= 1);
  ok('...and the same number of them', a.count === b.count);
  ok('EXTRACTION IS BYTE-IDENTICAL ACROSS TWO LEDGERS FED IN DIFFERENT ORDERS', a.digests === b.digests);
  ok('the extracted bytes are non-trivial', a.digests.length > 100);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
