// Determinism contract for deterministic-placement.js.
// Test 0 is a NEGATIVE CONTROL reproducing the OLD arrival-order rule; it must FAIL shuffle-invariance, or
// "all shuffles agree" would prove nothing about the new rule.
import { createHash } from 'crypto';
import assert from 'assert';
import {
  place, placeFaces, placeCubes, placeLevel, orderMembers, memberKey, isPlaceable, slotOf,
  faceRootOf, cubeIdOf, cubeRootOf, FACE_SIZE, CUBE_SLOTS, CUBE_SIZE,
} from './deterministic-placement.js';
import { Face } from './face.js';
import { Cube } from './cube.js';
import { calculateAbsoluteCoords } from './geometry.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };

function makeBlocks(n, salt = '') {
  const out = [];
  for (let i = 0; i < n; i++) {
    const tx = { type: 'anchor', id: `tx${salt}${i}`, validationTimestamp: String(1784758606627666688n + BigInt(i)) };
    const hash = createHash('sha256').update(JSON.stringify(tx)).digest('hex');
    out.push({ id: hash.slice(0, 16), hash, tx, timestamp: 9_000_000n - BigInt(i) }); // arrival REVERSED
  }
  return out;
}
const shuffle = (arr, seed) => { const a = [...arr]; let s = seed;
  for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) & 0x7fffffff; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const dig = (r) => JSON.stringify(r.cubes.map(c => ({ id: c.id, root: c.merkleRoot,
  p: c.placements.map(p => `${memberKey(p.member)}:${p.location.faceIndex}:${p.location.position}`).sort() })));

const B = makeBlocks(500);

console.log('\n0. negative control');
check('OLD arrival-order rule is NOT shuffle-invariant (proves the test can go red)', () => {
  const ids = (bs) => { const o = []; for (let i = 0; i + CUBE_SIZE <= bs.length; i += CUBE_SIZE) {
      const m = bs.slice(i, i + CUBE_SIZE);
      o.push(cubeIdOf([0,1,2].map(f => faceRootOf(m.slice(f*9, f*9+9).map(b => b.hash))))); } return o.join(','); };
  assert.notStrictEqual(ids(shuffle(B, 1)), ids(shuffle(B, 2)));
});

console.log('\n1. determinism');
check('25 shuffles produce byte-identical placement', () => {
  const base = dig(place(B));
  for (let s = 1; s <= 25; s++) assert.strictEqual(dig(place(shuffle(B, s))), base, `shuffle ${s}`);
});
check('reversed input identical', () => assert.strictEqual(dig(place([...B].reverse())), dig(place(B))));
check('arrival timestamp has zero effect', () => {
  const m = B.map(b => ({ ...b, timestamp: BigInt(Math.random() * 1e9 | 0) }));
  assert.strictEqual(dig(place(m)), dig(place(B)));
});

console.log('\n2. randomness chain');
check('one ns of validator disagreement reshuffles block.hash', () => {
  const h = (vt) => createHash('sha256').update(JSON.stringify({ ...B[0].tx, validationTimestamp: vt })).digest('hex');
  assert.notStrictEqual(h('1784758606627666688'), h('1784758606627666689'));
});
check('changing one member changes its face root AND its cube id', () => {
  const a = place(B), b = place([...B.slice(0, 499), ...makeBlocks(1, 'X')]);
  assert.notStrictEqual(dig(a), dig(b));
});
check('cube.id is the ordering key one level up', () => {
  const cubes = place(makeBlocks(6000)).cubes;
  assert.deepStrictEqual(orderMembers(cubes).map(c => c.id), [...cubes.map(c => c.id)].sort());
});

console.log('\n3. blocks -> faces: HASH SORT, chunks of 9 (not digital root, not mod 9)');
check('faces are consecutive chunks of the hash-sorted order', () => {
  const { faces } = placeFaces(B);
  const ordered = orderMembers(B.filter(isPlaceable));
  faces.forEach((f, i) => {
    assert.deepStrictEqual(f.members.map(m => memberKey(m.member)),
      ordered.slice(i * FACE_SIZE, (i + 1) * FACE_SIZE).map(memberKey), `face ${i}`);
  });
});
check('position = rank within the chunk, 0..8', () => {
  for (const f of placeFaces(B).faces) assert.deepStrictEqual(f.members.map(m => m.position), [0,1,2,3,4,5,6,7,8]);
});
check('no block waits on a residue — 9 blocks make 1 face', () => {
  assert.strictEqual(placeFaces(makeBlocks(9)).faces.length, 1);
});

console.log('\n4. faces -> cubes: MOD 3, parallel construction');
check('faceIndex == faceRoot mod 3', () => {
  for (const c of place(B).cubes) for (const f of c.faces) assert.strictEqual(f.faceIndex, slotOf(f.merkleRoot, CUBE_SLOTS));
});
check('faces sharing a slot land in DIFFERENT cubes (parallel, not colliding)', () => {
  const bySlot = {};
  for (const c of place(B).cubes) for (const f of c.faces) (bySlot[f.faceIndex] ??= []).push(c.id);
  for (const [slot, ids] of Object.entries(bySlot)) assert.strictEqual(new Set(ids).size, ids.length, `slot ${slot} reused a cube`);
});
check('every cube holds exactly one face per slot, 27 members', () => {
  for (const c of place(B).cubes) {
    assert.deepStrictEqual(c.faces.map(f => f.faceIndex).sort(), [0, 1, 2]);
    assert.strictEqual(c.placements.length, CUBE_SIZE);
  }
});
check('cube k = the k-th face of each slot, by root order', () => {
  const { faces } = placeFaces(B);
  const bySlot = [[], [], []];
  for (const f of orderMembers(faces)) bySlot[slotOf(f.merkleRoot, CUBE_SLOTS)].push(f);
  place(B).cubes.forEach((c, k) => {
    assert.deepStrictEqual(c.faceRoots.slice().sort(), [0,1,2].map(s => bySlot[s][k].merkleRoot).sort(), `cube ${k}`);
  });
});

console.log('\n5. agreement with Face/Cube');
check('faceRootOf matches Face.getMerkleRoot', () => {
  const f = placeFaces(B).faces[0];
  const F = new Face(0, 1n); f.members.forEach(m => F.addBlock(m.member));
  assert.strictEqual(f.merkleRoot, F.getMerkleRoot());
});
check('cubeIdOf / cubeRootOf match Cube when faceIndex = root rank', () => {
  const c = place(B).cubes[0];
  const faces = c.faces.map(f => { const F = new Face(0, BigInt(f.faceIndex + 1)); f.members.forEach(m => F.addBlock(m.member)); return F; });
  const rank = new Map(faces.map(f => f.getMerkleRoot()).sort().map((r, i) => [r, i]));
  faces.forEach(f => { f.index = rank.get(f.getMerkleRoot()); });
  const real = new Cube(1n); faces.forEach(f => real.addFace(f));
  assert.strictEqual(c.id, real.id);
  assert.strictEqual(c.merkleRoot, real.getMerkleRoot());
});

console.log('\n6. consensus gating (stage 4 -> 5 output is the admission ticket)');
check('block with no validationTimestamp is never placed', () => {
  const bad = { ...B[0], tx: { ...B[0].tx } }; delete bad.tx.validationTimestamp;
  const r = place([...B.slice(1), bad]);
  assert.strictEqual(r.unplaceable.length, 1);
  assert.ok(!r.cubes.some(c => c.placements.some(p => memberKey(p.member) === bad.hash)));
});
check('isPlaceable rejects missing/malformed quorum timestamp', () => {
  assert.strictEqual(isPlaceable({ hash: 'a'.repeat(64), tx: {} }), false);
  assert.strictEqual(isPlaceable({ hash: 'a'.repeat(64), tx: { validationTimestamp: 'abc' } }), false);
  assert.strictEqual(isPlaceable({ hash: 'a'.repeat(64), tx: { validationTimestamp: '1' } }), true);
});
check('19- and 25-digit timestamps both accepted', () => {
  assert.ok(isPlaceable({ hash: 'a'.repeat(64), tx: { validationTimestamp: '1784758606627666688' } }));
  assert.ok(isPlaceable({ hash: 'b'.repeat(64), tx: { validationTimestamp: '1785000000000000000000000' } }));
});

console.log('\n7. recursion');
check('cubes place into a level-2 cube by the same two rules', () => {
  const l1 = place(makeBlocks(20000)).cubes;
  const l2 = placeLevel(l1);
  assert.ok(l2.cubes.length >= 1, `expected >=1 level-2 cube, got ${l2.cubes.length}`);
  assert.strictEqual(l2.cubes[0].level, 2);
  assert.deepStrictEqual(l2.cubes[0].faces.map(f => f.faceIndex).sort(), [0, 1, 2]);
});
check('level-2 placement is shuffle-invariant and timestamp-free', () => {
  const l1 = place(makeBlocks(20000)).cubes;
  assert.strictEqual(dig(placeLevel(shuffle(l1, 9))), dig(placeLevel(l1)));
  assert.strictEqual(dig(placeLevel(l1.map(c => ({ ...c, timestamp: 0n })))), dig(placeLevel(l1)));
});

console.log('\n8. coordinates');
check('coordinates deterministic across shuffles', () => {
  const co = (bs) => place(bs).cubes.flatMap(c => c.placements.map(p => `${memberKey(p.member)}:${JSON.stringify(calculateAbsoluteCoords(p.location))}`)).sort().join('|');
  assert.strictEqual(co(shuffle(B, 7)), co(B));
});
check('one distinct coordinate per placed block (old bug: 396 blocks -> 9 coords)', () => {
  const r = place(B), set = new Set();
  for (const c of r.cubes) for (const p of c.placements) set.add(JSON.stringify(calculateAbsoluteCoords(p.location)));
  assert.strictEqual(set.size, r.cubes.length * CUBE_SIZE, `expected ${r.cubes.length * CUBE_SIZE} distinct, got ${set.size}`);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
