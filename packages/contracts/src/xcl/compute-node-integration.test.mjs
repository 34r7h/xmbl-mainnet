// "storage-compute includes state machine and smart contracting" — proven as composition,
// not duplication. A ComputeNode (storage-compute) injected with a ContractHost (contracts,
// composing that node's runtime + a real state-machine VerkleStateTree) executes a contract
// end to end, while its raw compute-market path still gets NO host binding.
import assert from 'node:assert';
import { ComputeRuntime, ComputeNode } from '@xmbl/storage-compute';
import { VerkleStateTree } from '@xmbl/state-machine';
import { ContractHost } from './index.js';

let pass = 0, fail = 0;
const check = async (n, f) => {
  try { await f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; }
};
const B = (...b) => Uint8Array.from(b);
const HDR = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const COUNTER = B(
  ...HDR,
  0x01, 0x10, 0x03, 0x60, 0x01, 0x7f, 0x01, 0x7f, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x60, 0x00, 0x01, 0x7f,
  0x02, 0x2d, 0x02,
  0x03, 0x65, 0x6e, 0x76, 0x0f, 0x78, 0x6d, 0x62, 0x6c, 0x5f, 0x76, 0x65, 0x72, 0x6b, 0x6c, 0x65, 0x5f, 0x67, 0x65, 0x74, 0x00, 0x00,
  0x03, 0x65, 0x6e, 0x76, 0x0f, 0x78, 0x6d, 0x62, 0x6c, 0x5f, 0x76, 0x65, 0x72, 0x6b, 0x6c, 0x65, 0x5f, 0x73, 0x65, 0x74, 0x00, 0x01,
  0x03, 0x02, 0x01, 0x02,
  0x07, 0x0d, 0x01, 0x09, 0x69, 0x6e, 0x63, 0x72, 0x65, 0x6d, 0x65, 0x6e, 0x74, 0x00, 0x02,
  0x0a, 0x18, 0x01, 0x16, 0x01, 0x01, 0x7f,
  0x41, 0x00, 0x10, 0x00, 0x41, 0x01, 0x6a, 0x21, 0x00, 0x41, 0x00, 0x20, 0x00, 0x10, 0x01, 0x1a, 0x20, 0x00, 0x0b,
);

await check('a compute node with an injected ContractHost executes a contract', async () => {
  const runtime = new ComputeRuntime({ maxTime: 4000 });
  const state = new VerkleStateTree();
  const contractHost = new ContractHost({ runtime, state });
  const node = new ComputeNode({ runtime, contractHost });
  const { id } = contractHost.deploy(COUNTER, [0]);

  const r1 = await node.runContract({ contractId: id, functionName: 'increment' });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.result, 1);
  const r2 = await node.runContract({ contractId: id, functionName: 'increment' });
  assert.strictEqual(r2.result, 2);
  assert.strictEqual(contractHost.getSlot(id, 0), 2);
});

await check('a compute node WITHOUT a ContractHost refuses contract execution', async () => {
  const node = new ComputeNode({ runtime: new ComputeRuntime({ maxTime: 2000 }) });
  const out = await node.runContract({ contractId: 'xc1_x', functionName: 'increment' });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /no ContractHost/);
});

await check('the raw compute-market path still denies the contract host import', async () => {
  const node = new ComputeNode({ runtime: new ComputeRuntime({ maxTime: 2000 }) });
  // A raw job submitting the contract WASM (which declares env.xmbl_verkle_get) gets NO host,
  // so it is refused — the market path never grants state access.
  const out = await node.runJob({ jobId: 'j1', wasmCode: COUNTER, functionName: 'increment' });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /denied import/);
});

console.log(`\ncompute-node + contracts: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
