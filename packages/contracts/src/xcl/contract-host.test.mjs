// XCL conformance — the contract layer binding compiled WASM to real chain state.
// Proves OUTCOMES on a real hand-encoded contract that calls the XCL host ABI:
//   1. deploy is deterministic and places the contract on a real (non-collinear) plane;
//   2. a call reads committed slot state (read-set) and persists its writes (write-set);
//   3. repeated calls accumulate — state is durable across calls;
//   4. two independent hosts fed the same calls converge to the same state root;
//   5. a real @xmbl/state-machine VerkleStateTree can be injected in place of the default;
//   6. an LNG-compiled contract runs in the delegated sandbox, deterministically.
import assert from 'node:assert';
import { ComputeRuntime } from '@xmbl/storage-compute';
import { VerkleStateTree } from '@xmbl/state-machine';
import { ContractHost, InMemoryState, contractCoordinates, contractId } from './index.js';
import { compile } from '@xmbl/lng';

let pass = 0, fail = 0;
const check = async (n, f) => {
  try { await f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; }
};
const B = (...b) => Uint8Array.from(b);
const HDR = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

// A real "counter" contract in raw WASM:
//   import env.xmbl_verkle_get(i32)->i32 ; import env.xmbl_verkle_set(i32,i32)->i32
//   export increment()->i32 { let v = get(0) + 1; set(0, v); return v }
// It exercises the exact host ABI @xmbl/contracts defines — read-set in, write-set out.
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

const runtime = () => new ComputeRuntime({ maxTime: 4000 });

await check('deploy is deterministic and places on a non-collinear plane', async () => {
  const h1 = new ContractHost({ runtime: runtime() });
  const h2 = new ContractHost({ runtime: runtime() });
  const a = h1.deploy(COUNTER, [0]);
  const b = h2.deploy(COUNTER, [0]);
  assert.strictEqual(a.id, b.id, 'same bytes must yield same id on every node');
  assert.strictEqual(a.id, contractId(COUNTER));
  const p = a.coordinates.coordinates;
  assert.strictEqual(p.length, 3);
  const u = { x: p[1].x - p[0].x, y: p[1].y - p[0].y, z: p[1].z - p[0].z };
  const v = { x: p[2].x - p[0].x, y: p[2].y - p[0].y, z: p[2].z - p[0].z };
  const n = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
  assert.ok(n.x !== 0 || n.y !== 0 || n.z !== 0, 'plane normal must be non-zero');
});

await check('call reads committed state and persists writes (0 → 1 → 2)', async () => {
  const host = new ContractHost({ runtime: runtime() });
  const { id } = host.deploy(COUNTER, [0]);
  const r1 = await host.call(id, 'increment');
  assert.strictEqual(r1.result, 1);
  assert.deepStrictEqual(r1.writes, [[0, 1]]);
  const r2 = await host.call(id, 'increment');
  assert.strictEqual(r2.result, 2);
  assert.strictEqual(host.getSlot(id, 0), 2);
});

await check('two independent hosts converge to the same state root', async () => {
  const a = new ContractHost({ runtime: runtime() });
  const b = new ContractHost({ runtime: runtime() });
  const ida = a.deploy(COUNTER, [0]).id;
  const idb = b.deploy(COUNTER, [0]).id;
  for (let i = 0; i < 3; i++) { await a.call(ida, 'increment'); await b.call(idb, 'increment'); }
  assert.strictEqual(a.state.getRoot(), b.state.getRoot(), 'same calls → same root');
  assert.strictEqual(a.getSlot(ida, 0), 3);
});

await check('a real VerkleStateTree from @xmbl/state-machine can be injected', async () => {
  const state = new VerkleStateTree();
  const host = new ContractHost({ runtime: runtime(), state });
  const { id } = host.deploy(COUNTER, [0]);
  const root0 = state.getRoot();
  await host.call(id, 'increment');
  await host.call(id, 'increment');
  assert.strictEqual(host.getSlot(id, 0), 2);
  assert.notStrictEqual(state.getRoot(), root0, 'committing contract state must move the Verkle root');
});

await check('default store is the in-memory fallback (standalone works)', async () => {
  const host = new ContractHost({ runtime: runtime() });
  assert.ok(host.state instanceof InMemoryState);
});

await check('missing runtime is refused (XCL never sandboxes itself)', async () => {
  assert.throws(() => new ContractHost({}), /requires a runtime/);
});

await check('a contract call does NOT widen a shared runtime’s allow surface', async () => {
  const rt = runtime(); // empty allowedImports
  const host = new ContractHost({ runtime: rt });
  const { id } = host.deploy(COUNTER, [0]);
  await host.call(id, 'increment');
  // The per-call host binding must not have leaked into the runtime's standing allow-list...
  assert.deepStrictEqual(rt.allowedImports, [], 'runtime allow-list must stay empty after a call');
  // ...so a later RAW job (no host) that declares the same import is still denied.
  await assert.rejects(() => rt.execute(COUNTER, 'increment', []), /denied import: env\.xmbl_verkle_get/);
});

await check('an LNG-compiled contract runs in the delegated sandbox, deterministically', async () => {
  const wasm = compile('~contract `Calc { ~on `add(`a ~u256, `b ~u256) { return `a + `b } }');
  const rt = runtime();
  // LNG's WASM backend uses an internal u256 memory ABI, so the raw return is not a plain
  // integer we assert a value for — we assert it runs sandboxed and is deterministic.
  const a = await rt.execute(wasm, 'add', [2, 3]);
  const b = await runtime().execute(wasm, 'add', [2, 3]);
  assert.strictEqual(a, b, 'same inputs must yield the same output');
  assert.strictEqual(typeof a, 'number');
});

console.log(`\nXCL conformance: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
