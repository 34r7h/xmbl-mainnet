// Cube sync must ACCEPT a truthful cube and REJECT every way a peer can lie. Test 0 is the control: if the
// happy path did not pass, every rejection below would be vacuous.
import { createHash } from 'crypto';
import assert from 'assert';
import { verifyCube, planAdoption, diffWanted, faceRootOf, cubeIdOf, cubeRootOf, setDigest } from './cube-sync.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const txHash = (tx) => createHash('sha256').update(JSON.stringify(tx, (_k, v) => typeof v === 'bigint' ? v.toString() : v)).digest('hex');

function makeCube(salt = '') {
  const faces = [];
  for (let f = 0; f < 3; f++) {
    const blocks = [];
    for (let i = 0; i < 9; i++) {
      const tx = { type: 'anchor', event: 'task.created', hash: `h${salt}${f}${i}`, from: 'xmbA', sig: 'S', validationTimestamp: '1784758606627666688' };
      blocks.push({ hash: txHash(tx), tx });
    }
    faces.push({ merkleRoot: faceRootOf(blocks.map(b => b.hash)), blocks });
  }
  const roots = faces.map(f => f.merkleRoot);
  return { payload: { faces, merkleRoot: cubeRootOf(roots) }, id: cubeIdOf(roots) };
}
const clone = (o) => JSON.parse(JSON.stringify(o));

console.log('\n0. control — a truthful cube must VERIFY');
check('honest cube verifies and recomputes its own id', () => {
  const { payload, id } = makeCube();
  const r = verifyCube(payload, id);
  assert.ok(r.ok, r.reason);
  assert.strictEqual(r.id, id);
});

console.log('\n1. every way a peer can lie is rejected');
const cases = {
  'tampered block hash': (p) => { p.faces[0].blocks[0].hash = 'a'.repeat(64); },
  'tampered tx body (hash no longer matches)': (p) => { p.faces[0].blocks[0].tx.event = 'evil'; },
  'face with 8 blocks': (p) => { p.faces[0].blocks.pop(); },
  'face with 10 blocks': (p) => { p.faces[0].blocks.push(p.faces[0].blocks[0]); },
  'only 2 faces': (p) => { p.faces.pop(); },
  '4 faces': (p) => { p.faces.push(p.faces[0]); },
  'lying face merkleRoot': (p) => { p.faces[0].merkleRoot = 'b'.repeat(64); },
  'lying cube merkleRoot': (p) => { p.merkleRoot = 'c'.repeat(64); },
  'block with no tx': (p) => { delete p.faces[0].blocks[0].tx; },
  'malformed hash': (p) => { p.faces[0].blocks[0].hash = 'nothex'; },
};
for (const [name, mutate] of Object.entries(cases)) {
  check(`REJECT ${name}`, () => {
    const { payload, id } = makeCube();
    const p = clone(payload); mutate(p);
    const r = verifyCube(p, id);
    assert.strictEqual(r.ok, false, 'accepted a tampered cube');
  });
}
check('REJECT a VALID cube served under the wrong id', () => {
  const { payload } = makeCube('x');
  const other = makeCube('y');
  assert.strictEqual(verifyCube(payload, other.id).ok, false);
});
check('REJECT empty / garbage payloads without throwing', () => {
  for (const bad of [null, undefined, {}, { faces: null }, { faces: [] }, 42, 'str']) {
    assert.strictEqual(verifyCube(bad, 'abc').ok, false);
  }
});

console.log('\n2. remote input fails CLOSED on signature (unlike the local path)');
check('member tx failing verification rejects the whole cube', () => {
  const { payload, id } = makeCube();
  assert.strictEqual(verifyCube(payload, id, { verifyTx: () => false }).ok, false);
});
check('verifyTx passing keeps it accepted', () => {
  const { payload, id } = makeCube();
  assert.ok(verifyCube(payload, id, { verifyTx: () => true }).ok);
});
check('a throwing validateTransaction rejects, does not crash', () => {
  const { payload, id } = makeCube();
  const r = verifyCube(payload, id, { validateTransaction: () => { throw new Error('unknown type'); } });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /invalid tx/);
});

console.log('\n3. adoption hazards');
check('⛔ adopted cubes never count toward L2 recursion', () => {
  const { payload, id } = makeCube();
  const plan = planAdoption(verifyCube(payload, id), payload, {});
  assert.strictEqual(plan.countTowardRecursion, false);
});
check('⛔ adopted blocks are never admitted to the mempool', () => {
  const { payload, id } = makeCube();
  const plan = planAdoption(verifyCube(payload, id), payload, {});
  assert.strictEqual(plan.admitToMempool, false);
});
check('members sitting in the L1 pool are evicted (else the tx seals twice)', () => {
  const { payload, id } = makeCube();
  const victim = payload.faces[1].blocks[3].hash;
  const plan = planAdoption(verifyCube(payload, id), payload, { membershipPool: [{ hash: victim }, { hash: 'z'.repeat(64) }] });
  assert.deepStrictEqual(plan.evictFromPool, [victim]);
});
check('never-seen blocks are flagged, previously-known ones are not', () => {
  const { payload, id } = makeCube();
  const known = new Set([payload.faces[0].blocks[0].hash]);
  const plan = planAdoption(verifyCube(payload, id), payload, { knownBlockHashes: known });
  assert.strictEqual(plan.blocks.filter(b => !b.neverSeen).length, 1);
  assert.strictEqual(plan.blocks.filter(b => b.neverSeen).length, 26);
});
check('27 members placed, faceIndex 0-2 x9, position 0-8 x3, cubeIndex = content id', () => {
  const { payload, id } = makeCube();
  const plan = planAdoption(verifyCube(payload, id), payload, {});
  assert.strictEqual(plan.blocks.length, 27);
  for (const fi of [0, 1, 2]) assert.strictEqual(plan.blocks.filter(b => b.location.faceIndex === fi).length, 9);
  for (const p of [0, 4, 8]) assert.strictEqual(plan.blocks.filter(b => b.location.position === p).length, 3);
  assert.ok(plan.blocks.every(b => b.location.cubeIndex === id));
});
check('a cube already held is skipped, not re-adopted', () => {
  const { payload, id } = makeCube();
  const plan = planAdoption(verifyCube(payload, id), payload, { haveCubeIds: new Set([id]) });
  assert.strictEqual(plan.skip, true);
});

console.log('\n4. diff + digest');
check('diffWanted asks only for what is missing, bounded', () => {
  const peer = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
  assert.deepStrictEqual(diffWanted(new Set(['a', 'b']), peer, 2), ['c', 'd']);
  assert.deepStrictEqual(diffWanted(new Set(['a', 'b', 'c', 'd', 'e']), peer, 4), []);
});
check('setDigest is order-independent and content-sensitive', () => {
  const a = [{ id: '1', merkleRoot: 'x' }, { id: '2', merkleRoot: 'y' }];
  assert.strictEqual(setDigest(a), setDigest([...a].reverse()));
  assert.notStrictEqual(setDigest(a), setDigest([{ id: '1', merkleRoot: 'x' }, { id: '2', merkleRoot: 'z' }]));
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
