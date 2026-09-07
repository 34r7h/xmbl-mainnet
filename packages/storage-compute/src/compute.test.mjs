// Isolation outcomes for the untrusted WASM compute market — the properties a paid
// compute node must hold against a hostile guest. Each guest below is a hand-encoded
// WASM module (no toolchain), so the test proves behaviour on real bytes:
//   1. a normal guest computes and returns;
//   2. a synchronous infinite-loop guest is KILLED by the deadline (not merely timed);
//   3. a guest importing anything is rejected before it runs (deny-by-default);
//   4. a guest declaring unbounded memory is rejected;
//   5. a guest declaring memory over the cap is rejected.
import assert from 'node:assert';
import { ComputeRuntime } from './compute.js';

let pass = 0, fail = 0;
const check = async (n, f) => {
  try { await f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; }
};
const B = (...b) => Uint8Array.from(b);
const HDR = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

// add(i32,i32)->i32 { local.get 0; local.get 1; i32.add }  export "add"
const ADD = B(
  ...HDR,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,       // type (i32,i32)->i32
  0x03, 0x02, 0x01, 0x00,                                       // func[0] : type 0
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,         // export "add" func 0
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b, // code
);

// spin()->() { loop; br 0; end }  export "spin"  — a synchronous infinite loop
const SPIN = B(
  ...HDR,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,                           // type ()->()
  0x03, 0x02, 0x01, 0x00,                                       // func[0] : type 0
  0x07, 0x08, 0x01, 0x04, 0x73, 0x70, 0x69, 0x6e, 0x00, 0x00,   // export "spin" func 0
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b, // code: loop void; br 0; end; end
);

// module importing env.foo (func ()->()) — nothing on the allow-list may pass
const IMPORT_FOO = B(
  ...HDR,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,                           // type ()->()
  0x02, 0x0b, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x03, 0x66, 0x6f, 0x6f, 0x00, 0x00, // import env.foo func 0
);

// memory section: min 1 page, NO maximum → unbounded growth
const MEM_UNBOUNDED = B(...HDR, 0x05, 0x03, 0x01, 0x00, 0x01);

// memory section: min 1, max 1000 pages → over a 1-page cap
const MEM_OVERSIZED = B(...HDR, 0x05, 0x05, 0x01, 0x01, 0x01, 0xe8, 0x07);

// memory section: flags 0x03 (shared + max), min 1, max 2 → shared memory, rejected
const MEM_SHARED = B(...HDR, 0x05, 0x04, 0x01, 0x03, 0x01, 0x02);

await check('normal guest computes and returns (5 + 7 = 12)', async () => {
  const rt = new ComputeRuntime({ maxTime: 4000 });
  const r = await rt.execute(ADD, 'add', [5, 7]);
  assert.strictEqual(r, 12);
});

await check('infinite-loop guest is terminated by the deadline', async () => {
  const rt = new ComputeRuntime({ maxTime: 300 });
  const t0 = Date.now();
  await assert.rejects(() => rt.execute(SPIN, 'spin', []), /time limit/i);
  const dt = Date.now() - t0;
  // The host regained control near the deadline, not "never" and not far past it.
  assert.ok(dt < 5000, `took ${dt}ms — deadline did not terminate the guest`);
});

await check('guest import is denied by default', async () => {
  const rt = new ComputeRuntime({ maxTime: 2000 }); // empty allow-list
  await assert.rejects(() => rt.execute(IMPORT_FOO, 'nope', []), /denied import: env\.foo/);
});

await check('guest with unbounded memory is rejected', async () => {
  const rt = new ComputeRuntime({ maxTime: 2000 });
  await assert.rejects(() => rt.execute(MEM_UNBOUNDED, 'x', []), /unbounded/i);
});

await check('guest memory over the cap is rejected', async () => {
  const rt = new ComputeRuntime({ maxMemory: 64 * 1024, maxTime: 2000 }); // 1 page cap
  await assert.rejects(() => rt.execute(MEM_OVERSIZED, 'x', []), /exceeds limit/i);
});

await check('guest with shared memory is rejected', async () => {
  const rt = new ComputeRuntime({ maxTime: 2000 });
  // Either our guard rejects it as shared, or the engine refuses to compile it — both
  // are a refusal, which is the property under test (no shared memory reaches a guest).
  await assert.rejects(() => rt.execute(MEM_SHARED, 'x', []), /shared|execution failed|compile/i);
});

console.log(`\ncompute isolation: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
