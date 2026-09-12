// UTXO ↔ VERKLE, ACROSS A SMALL SET OF TEST NODES — the reproduction proof.
//
// The XCL conformance suite proves the link in-process on one host. This proves it REPRODUCES
// across independent nodes built from the REAL node subsystems: each node is a genuine
// { Ledger + StateMachine } pair (exactly what @xmbl/core composes), fed the identical set of
// xmbl `utxo` transactions. The ledger seals them through its hash-sorted face partition (a pure
// function of the SET) and the state machine derives `utxo:<block.id>` keys into its Verkle tree.
//
// What is proven as OUTCOMES (state roots taken after the fact, not a passing mechanism):
//   1. Three independent nodes fed the SAME utxo set converge on ONE identical state root — the
//      ledger→Verkle link reproduces without any coordination between them.
//   2. A contract that SPENDS a ledger-produced UTXO and creates a conserved output, run on each
//      node over its own tree, leaves all three STILL at one identical root — contract-driven
//      value transfer is reproducible across nodes.
//   3. Every node commits the same spend-marker (nullifier) and the same new UTXO record.
//
// This uses the real ledger seal + state-derivation path (not the full networking/consensus stack,
// which @xmbl/consensus's byzantine-matrix covers). It is deliberately in-process-multi-node: a
// small set of test nodes, reproducing one state, exactly as the mandate asks.
import assert from 'node:assert';
import { ComputeRuntime } from '@xmbl/storage-compute';
import { StateMachine } from '@xmbl/state-machine';
import { Ledger } from '@xmbl/cubic-ledger';
import { ContractHost, utxoKey, spendKey } from './index.js';
import { TRANSFER, RECIP } from './utxo-fixtures.mjs';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};
const ZERO = '0'.repeat(64);

// Nine utxo txs seal exactly one face (9 blocks/face). The SET is identical on every node; the
// timestamps are fixed so the content-addressed ids (and thus the sealed set) are identical too.
const UTXO_SET = Array.from({ length: 9 }, (_, i) => ({
  type: 'utxo', from: `payer${i}`, to: `payee${i}`, amount: 100 + i, timestamp: 1_700_000_000_000 + i,
}));

const bootNode = async (label) => {
  const dir = await mkdtemp(join(tmpdir(), `xmbl-node-${label}-`));
  const xclt = new Ledger({ dbPath: join(dir, 'ledger') });
  await xclt.db.open().catch(() => {});
  xclt._dbOpen = true;
  const xvsm = new StateMachine({ dbPath: join(dir, 'vsm'), xclt });
  await new Promise((r) => setTimeout(r, 150)); // let both LevelDBs finish opening
  return { dir, xclt, xvsm };
};
const shutdown = async ({ dir, xclt, xvsm }) => {
  await xclt.db.close().catch(() => {});
  await xvsm.db.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
};
const runtime = () => new ComputeRuntime({ maxTime: 4000 });

// Boot three independent nodes and feed each the identical utxo set through the REAL ledger.
const nodes = [await bootNode('a'), await bootNode('b'), await bootNode('c')];
for (const n of nodes) {
  for (const tx of UTXO_SET) await n.xclt.addTransaction(tx);
}
await new Promise((r) => setTimeout(r, 400)); // the block:added → state-machine handler is async

await check('three independent nodes derive the SAME Verkle root from the same utxo set', async () => {
  const roots = nodes.map((n) => n.xvsm.getStateRoot());
  assert.notStrictEqual(roots[0], ZERO, 'each node actually sealed and applied the utxo set');
  assert.strictEqual(roots[0], roots[1], 'node A and node B converged');
  assert.strictEqual(roots[1], roots[2], 'node B and node C converged');
});

await check('every node produced the identical set of ledger utxo keys', async () => {
  const keysOf = (n) => [...n.xvsm.stateTree.state.keys()].filter((k) => k.startsWith('utxo:')).sort();
  const a = keysOf(nodes[0]);
  assert.strictEqual(a.length, 9, 'nine utxo records committed');
  assert.deepStrictEqual(a, keysOf(nodes[1]), 'A and B hold the same utxo keys');
  assert.deepStrictEqual(a, keysOf(nodes[2]), 'B and C hold the same utxo keys');
});

// Deterministically pick ONE ledger-produced UTXO to spend — the same one on every node.
const pickId = (n) => [...n.xvsm.stateTree.state.keys()].filter((k) => k.startsWith('utxo:')).sort()[0].slice('utxo:'.length);

await check('a contract spends a ledger UTXO on each node, and all three STILL converge', async () => {
  const results = [];
  for (const n of nodes) {
    const host = new ContractHost({ runtime: runtime(), state: n.xvsm.stateTree });
    const { id } = host.deploy(TRANSFER, [], { utxoHost: true });
    const spendId = pickId(n);
    const r = await host.call(id, 'transfer', [], { inputs: [spendId] });
    results.push({ spendId, r, root: n.xvsm.getStateRoot() });
  }
  assert.strictEqual(results[0].spendId, results[1].spendId, 'nodes chose the same UTXO to spend');
  assert.strictEqual(results[1].spendId, results[2].spendId, 'all nodes chose the same UTXO');
  assert.strictEqual(results[0].root, results[1].root, 'A and B still converge after the contract spend');
  assert.strictEqual(results[1].root, results[2].root, 'B and C still converge after the contract spend');
  // The spend conserved value and committed the same marker + output on every node.
  for (const { spendId, r, } of results) {
    assert.deepStrictEqual(r.utxo.spent, [spendId], 'the ledger UTXO was spent');
    assert.strictEqual(r.utxo.created[0].to, RECIP, 'output went to the contract-chosen recipient');
  }
  for (const n of nodes) {
    assert.notStrictEqual(n.xvsm.stateTree.get(spendKey(results[0].spendId)), undefined, 'spend-marker committed');
    assert.notStrictEqual(n.xvsm.stateTree.get(utxoKey(results[0].r.utxo.created[0].id)), undefined, 'new UTXO committed');
  }
});

for (const n of nodes) await shutdown(n);
console.log(`\nUTXO multi-node reproduction: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
