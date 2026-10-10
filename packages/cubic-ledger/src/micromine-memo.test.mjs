// THE NONCE SEARCH IS DONE ONCE PER CONTENT PER PROCESS. Pinned here: a repeated micromine is a lookup, its answer
// is the one a fresh search gives (golden vectors, every type 0-9, and an unmemoised reference), a change of one
// byte of data or of the type is a new search, a caller that mutates what it got back cannot poison the next
// answer, and the memo is bounded.
// Run: node micromine-memo.test.mjs
import assert from 'node:assert';
import { createHash } from 'node:crypto';
process.env.XMBL_MICROMINE_MEMO_MAX = '16';
const { micromine, micromineStats, oidOf, type6TxBody } = await import('./micromine.js');
const { datumWrite, stateDiffWrites } = await import('./transaction-validator.js');

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const sha = (s) => createHash('sha256').update(s).digest('hex');
// The search with nothing kept, sharing no code with micromine.js beyond the oid rule.
const reference = (data, type) => {
  const oid = sha(JSON.stringify({ data })), prefix = '0' + type;
  for (let n = 0; ; n++) { const xid = sha(oid + n); if (xid.startsWith(prefix)) return { oid, nonce: n, xid, key: `${xid}_${n}` }; }
};
const delta = (f) => { const b = { ...micromineStats }; f(); return { hits: micromineStats.hits - b.hits, searches: micromineStats.searches - b.searches }; };

await check('golden v1 twice: the second is a lookup with the same answer', () => {
  const body = type6TxBody({ chain: 'xmbl', from: [], to: [], asset: 'XMBL', amount: '1', seq: 0, prev: '', unspent: '1' });
  let a, b;
  assert.deepStrictEqual(delta(() => { a = micromine(body, 6); }), { hits: 0, searches: 1 });
  assert.deepStrictEqual(delta(() => { b = micromine(body, 6); }), { hits: 1, searches: 0 });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(b.nonce, 91);
  assert.strictEqual(b.xid, '0687f086db1d8e1c57277494f24fb87d8baedee05bcb522abc85b23e561279ee');
});

await check('every type 0-9, first and repeat, equals the unmemoised search', () => {
  for (let t = 0; t <= 9; t++) {
    const data = { probe: 'memo', t };
    const want = reference(data, t);
    assert.deepStrictEqual(micromine(data, t), want, `type ${t} first`);
    assert.deepStrictEqual(micromine(data, t), want, `type ${t} repeat`);
  }
});

await check('the same data as another type is another search and another answer', () => {
  const data = { same: 'content' };
  const a = micromine(data, 0);
  let b;
  assert.strictEqual(delta(() => { b = micromine(data, 5); }).searches, 1);
  assert.strictEqual(a.oid, b.oid);
  assert.ok(b.xid.startsWith('05') && a.xid.startsWith('00'));
  assert.deepStrictEqual(b, reference(data, 5));
});

await check('one byte of difference in the data is a new search', () => {
  micromine({ text: 'hello' }, 0);
  let r;
  assert.strictEqual(delta(() => { r = micromine({ text: 'hellp' }, 0); }).searches, 1);
  assert.deepStrictEqual(r, reference({ text: 'hellp' }, 0));
});

await check('mutating a returned answer does not change the next one', () => {
  const data = { mutate: 1 };
  const a = micromine(data, 0);
  a.nonce = 999; a.xid = '00ff'; a.key = 'x';
  assert.deepStrictEqual(micromine(data, 0), reference(data, 0));
});

await check('stateDiffWrites admits a datum and refuses a forged key the same way on a memo hit', () => {
  const w = datumWrite({ fleet: 'memo', j: 1 }, 0);
  const [key] = Object.keys(w);
  assert.strictEqual(stateDiffWrites({ args: w }).ok, true);
  const again = delta(() => assert.strictEqual(stateDiffWrites({ args: w }).ok, true));
  assert.deepStrictEqual(again, { hits: 1, searches: 0 });
  // The same value under another datum's key, and another value under this key: both refused, both on hits.
  const other = datumWrite({ fleet: 'memo', j: 2 }, 0);
  const [otherKey] = Object.keys(other);
  assert.strictEqual(stateDiffWrites({ args: { [otherKey]: w[key] } }).ok, false);
  assert.strictEqual(stateDiffWrites({ args: { [key]: other[otherKey] } }).ok, false);
  assert.strictEqual(stateDiffWrites({ args: { [key]: { ...w[key], nonce: w[key].nonce + 1 } } }).ok, false);
});

await check('the memo keeps at most XMBL_MICROMINE_MEMO_MAX answers, oldest out first', () => {
  for (let i = 0; i < 40; i++) micromine({ fill: i }, 1);
  assert.strictEqual(delta(() => micromine({ fill: 39 }, 1)).hits, 1);
  assert.strictEqual(delta(() => micromine({ fill: 0 }, 1)).searches, 1);
  assert.deepStrictEqual(micromine({ fill: 0 }, 1), reference({ fill: 0 }, 1));
  assert.strictEqual(oidOf({ fill: 0 }), reference({ fill: 0 }, 1).oid);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
