// A WRITE IN FLIGHT ACROSS clear() NEVER LEAVES A LEAF THE MAP DOES NOT HOLD.
//
// insert() set the map, awaited the disk write, then placed the key in the trie; clear() swaps both for empty
// ones. So a write that started before a clear and finished after it put its key in the OLD map and the NEW
// trie: the root committed to a key state.keys() did not hold, and nothing could ever sweep it. MEASURED
// 2026-11-10: two nodes rebuilt from one 61-anchor set held identical key->value maps and published different
// roots across runs (canon-append.test.mjs). The same race for delete() left a removed key's leaf in place.
import { VerkleStateTree } from './verkle-tree.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n + (extra !== undefined ? ` — ${JSON.stringify(extra)}` : '')); } };

// A db whose every write waits until the test lets it go, so a clear() can land in the middle.
function slowDb() {
  const rows = new Map(), held = [];
  return {
    held,
    async open() {},
    put(k, v) { return new Promise((res) => held.push(() => { rows.set(k, v); res(); })); },
    del(k) { return new Promise((res) => held.push(() => { rows.delete(k); res(); })); },
    async clear() { rows.clear(); },
    async *iterator() { /* empty store */ },
    release() { while (held.length) held.shift()(); },
  };
}
const rootOf = async (entries) => { const t = new VerkleStateTree(); for (const [k, v] of entries) await t.insert(k, v); return t.getRoot(); };
const EMPTY = new VerkleStateTree().getRoot();

{
  const db = slowDb();
  const t = new VerkleStateTree({ db });
  await t.ready();
  const w = t.insert('anchor:x:1', { ts: 'a' });   // its disk write is held
  await t.clear();
  db.release();
  await w;
  ok('an insert in flight across clear() leaves the trie equal to the map', t.getRoot() === (await rootOf(t.state)), [t.getRoot(), t.state.size]);
  ok('and the root is the empty tree\'s when the map is empty', t.state.size !== 0 || t.getRoot() === EMPTY);
}
{
  const db = slowDb();
  const t = new VerkleStateTree({ db });
  await t.ready();
  const w1 = t.insert('anchor:a:1', { ts: 'a' }); db.release(); await w1;
  const w2 = t.insert('anchor:b:2', { ts: 'b' }); db.release(); await w2;
  const d = t.delete('anchor:a:1');   // its disk delete is held
  ok('a delete removes the leaf before its disk write returns', t.getRoot() === (await rootOf([['anchor:b:2', { ts: 'b' }]])));
  db.release(); await d;
  ok('and the root stays the root of what the map holds', t.getRoot() === (await rootOf(t.state)) && t.state.size === 1);
}
{
  // Many writes racing one clear(), then the set re-inserted: the root is the set's, whatever the timing.
  const db = slowDb();
  const t = new VerkleStateTree({ db });
  await t.ready();
  const set = Array.from({ length: 40 }, (_, i) => [`anchor:e:${i}`, { ts: String(i) }]);
  const stragglers = Array.from({ length: 25 }, (_, i) => t.insert(`tx:${i}`, { amount: i }));
  await t.clear();
  const reinserts = set.map(([k, v]) => t.insert(k, v));
  db.release();
  await Promise.all([...stragglers, ...reinserts]);
  db.release();
  ok('OUTCOME: stragglers across a clear leave no leaf outside the map', t.getRoot() === (await rootOf(t.state)), [t.state.size]);
  ok('OUTCOME: and the tree is exactly the set re-inserted after the clear', t.state.size === 40 && t.getRoot() === (await rootOf(set)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
