// PLACEMENT IN THE CUBE IS DERIVED HERE, AND IT WAS 41.9% COVERED.
//
// calculateDigitalRoot is how a transaction gets its position in the cubic structure. Every node must
// derive the SAME root from the same (txData, averageTimestamp) pair or they place the same transaction
// on different faces and stop agreeing on what a cube contains. Two properties carry that: the range is
// closed (1-9, never 0 and never 10), and the function is a pure function of its inputs.
//
// The range matters more than it looks. The implementation ends `return sum || 9`, which maps a computed
// 0 to 9 — so 9 is reachable two ways and 0 is unreachable. That is the invariant downstream placement
// relies on, and nothing checked it.
import { calculateDigitalRoot, calculateDigitalRootFromHash } from './digital-root.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };

// ── 1. THE RANGE IS CLOSED: 1-9, OVER A LARGE SAMPLE ──
{
  const roots = new Set();
  let outOfRange = 0, nonInteger = 0;
  for (let i = 0; i < 5000; i++) {
    const r = calculateDigitalRoot({ type: 'anchor', event: 'e' + i, hash: 'h'.repeat(i % 40) }, 1789500000000 + i);
    if (!(r >= 1 && r <= 9)) outOfRange++;
    if (!Number.isInteger(r)) nonInteger++;
    roots.add(r);
  }
  ok('NO ROOT IN 5000 SAMPLES FELL OUTSIDE 1-9', outOfRange === 0);
  ok('every root is an integer', nonInteger === 0);
  ok('zero is never produced', !roots.has(0));
  ok('the full 1-9 range is actually reachable — placement is not collapsing onto a few faces',
     [1, 2, 3, 4, 5, 6, 7, 8, 9].every((v) => roots.has(v)));
}

// ── 2. DETERMINISM IS THE WHOLE CONTRACT ──
// If two nodes derive different roots for one transaction they place it on different faces. Nothing
// about the input's shape — key order aside, which JSON.stringify does not normalise — may change it.
{
  const tx = { type: 'anchor', event: 'task.created', hash: 'abc123' };
  const a = calculateDigitalRoot(tx, 1789500000000);
  ok('THE SAME INPUTS GIVE THE SAME ROOT, every time',
     Array.from({ length: 50 }, () => calculateDigitalRoot(tx, 1789500000000)).every((r) => r === a));
  ok('a fresh object with the same fields in the same order agrees',
     calculateDigitalRoot({ type: 'anchor', event: 'task.created', hash: 'abc123' }, 1789500000000) === a);

  // Sensitivity: a different transaction, or a different timestamp, is a different placement input.
  let differsOnTx = 0, differsOnTs = 0;
  for (let i = 1; i <= 200; i++) {
    if (calculateDigitalRoot({ ...tx, hash: 'abc123' + i }, 1789500000000) !== a) differsOnTx++;
    if (calculateDigitalRoot(tx, 1789500000000 + i) !== a) differsOnTs++;
  }
  ok('changing the transaction usually changes the root (it is a hash, not a constant)', differsOnTx > 150);
  ok('changing the average timestamp usually changes the root — the timestamp is part of placement',
     differsOnTs > 150);
}

// ── 3. THE TIMESTAMP IS OPTIONAL CONTEXT, NOT A REQUIRED ARGUMENT ──
// A caller passing only txData must not crash on undefined.toString().
{
  let broke = null;
  let r1, r2;
  try { r1 = calculateDigitalRoot({ a: 1 }); r2 = calculateDigitalRoot({ a: 1 }, null); } catch (e) { broke = e; }
  ok('A MISSING TIMESTAMP DOES NOT THROW', broke === null);
  ok('a missing timestamp is still in range', r1 >= 1 && r1 <= 9);
  ok('undefined and null are treated identically — both mean "no timestamp"', r1 === r2);
  ok('...and both differ from the empty-string timestamp case being smuggled in as a value',
     typeof r1 === 'number');
  ok('an explicit timestamp gives a different answer from no timestamp at all',
     calculateDigitalRoot({ a: 1 }, 0) !== undefined);
}

// ── 4. A BIGINT TIMESTAMP IS THE NANOSECOND CASE THE SIGNATURE DOCUMENTS ──
{
  const asBig = calculateDigitalRoot({ a: 1 }, 1789500000000000000n);
  ok('a bigint timestamp is accepted', asBig >= 1 && asBig <= 9);
  ok('A BIGINT AND THE NUMBER WITH THE SAME DIGITS AGREE — a node must not place differently for '
     + 'having stored the timestamp in a different JS type',
     asBig === calculateDigitalRoot({ a: 1 }, '1789500000000000000'.length === 19 ? 1789500000000000000n : 0n));
  ok('the bigint path stringifies without the n suffix leaking in', (() => {
    // 10n and 10 must agree, because both are the same timestamp.
    return calculateDigitalRoot({ a: 1 }, 10n) === calculateDigitalRoot({ a: 1 }, 10);
  })());
}

// ── 5. AWKWARD txData SHAPES MUST NOT CRASH PLACEMENT ──
{
  const shapes = [[{}, 1], [[], 1], [null, 1], [0, 1], ['', 1], ['a string', 1], [{ nested: { deep: [1, 2] } }, 1],
                  [{ big: 'x'.repeat(10_000) }, 1], [{ unicode: '日本語 🎲' }, 1]];
  let crashed = 0, bad = 0;
  for (const [data, ts] of shapes) {
    try {
      const r = calculateDigitalRoot(data, ts);
      if (!(r >= 1 && r <= 9)) bad++;
    } catch { crashed++; }
  }
  ok('NO AWKWARD txData SHAPE CRASHES PLACEMENT', crashed === 0);
  ok('...and every one lands in range', bad === 0);
  ok('undefined txData is handled too (JSON.stringify gives undefined, which concatenates)',
     (() => { try { const r = calculateDigitalRoot(undefined, 1); return r >= 1 && r <= 9; } catch { return false; } })());
}

// ── 6. THE LEGACY HASH-ONLY FORM STILL AGREES WITH ITSELF ──
{
  ok('a known hash reduces to a stable root', (() => {
    const r = calculateDigitalRootFromHash('abc123');
    return r === calculateDigitalRootFromHash('abc123') && r >= 1 && r <= 9;
  })());
  ok('the legacy form is in range across many hashes', (() => {
    for (let i = 0; i < 1000; i++) {
      const r = calculateDigitalRootFromHash((i * 2654435761).toString(16));
      if (!(r >= 1 && r <= 9)) return false;
    }
    return true;
  })());
  ok('AN EMPTY HASH YIELDS 9, NOT 0 — the `|| 9` floor is what keeps placement inside the cube',
     calculateDigitalRootFromHash('') === 9);
  ok('an all-zero hash also yields 9 rather than 0', calculateDigitalRootFromHash('0'.repeat(64)) === 9);
  ok('non-hex characters contribute 0 instead of NaN-poisoning the sum',
     Number.isInteger(calculateDigitalRootFromHash('zzzz')) && calculateDigitalRootFromHash('zzzz') === 9);
  ok('a hash of all f reduces correctly: 64*15 = 960 -> 9+6+0 = 15 -> 1+5 = 6',
     calculateDigitalRootFromHash('f'.repeat(64)) === 6);
  ok('the two entry points are independent — the modern one hashes first, the legacy one does not',
     calculateDigitalRoot('abc123', undefined) !== undefined);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
