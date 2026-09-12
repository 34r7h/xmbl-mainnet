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
// Minimal WASM encoders for the two metering fixtures below, which are large enough (a growable
// memory, a big loop constant) that hand-typed byte arrays would be error-prone.
const uleb = (n) => { const o = []; let v = n >>> 0; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; o.push(b); } while (v); return o; };
const sleb = (n) => { const o = []; let more = true; while (more) { let b = n & 0x7f; n >>= 7; if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40))) more = false; else b |= 0x80; o.push(b); } return o; };
const sect = (id, p) => [id, ...uleb(p.length), ...p];
const vec = (items) => [...uleb(items.length), ...items.flat()];
const wname = (s) => [...uleb(s.length), ...[...s].map((c) => c.charCodeAt(0))];

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

// trap()->i32 { unreachable }  export "trap" — a guest fault (this is what an LNG `~e` / imported
// Solidity require()/revert compiles to). It must surface as a REJECTION, so a load-bearing caller
// (XCL) commits no write-set: a trap on-chain is a revert, not a silent success.
const TRAP = B(
  ...HDR,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,                     // type ()->i32
  0x03, 0x02, 0x01, 0x00,                                       // func[0] : type 0
  0x07, 0x08, 0x01, 0x04, 0x74, 0x72, 0x61, 0x70, 0x00, 0x00,   // export "trap" func 0
  0x0a, 0x05, 0x01, 0x03, 0x00, 0x00, 0x0b,                     // code: unreachable; end
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

// grow()->() { memory.grow(8); drop }  — declares an exported, bounded (max 10) memory and grows
// it from 1 to 9 pages. Metering must read the run's PEAK memory (9 pages) off this, not an assumption.
const GROW = B(
  ...HDR,
  ...sect(1, vec([[0x60, 0x00, 0x00]])),                 // t0 ()->()
  ...sect(3, vec([[0x00]])),                              // func0 : t0
  ...sect(5, vec([[0x01, 0x01, 0x0a]])),                  // memory: flags1 (bounded), min 1, max 10
  ...sect(7, vec([[...wname('memory'), 0x02, 0x00], [...wname('grow'), 0x00, 0x00]])),
  ...sect(10, vec([(() => {
    const body = [0x41, ...sleb(8), 0x40, 0x00, 0x1a, 0x0b]; // i32.const 8; memory.grow 0; drop; end
    const entry = [0x00, ...body];                          // 0 locals
    return [...uleb(entry.length), ...entry];
  })()])),
);

// busy()->i32 { let i = 50_000_000; while (i) i -= 1; return i }  — a finite heavy loop. Metering
// must measure MORE cpuMs on this than on a trivial add: real work, not a fixed cost.
const BUSY = B(
  ...HDR,
  ...sect(1, vec([[0x60, 0x00, 0x01, 0x7f]])),            // t0 ()->i32
  ...sect(3, vec([[0x00]])),                              // func0 : t0
  ...sect(7, vec([[...wname('busy'), 0x00, 0x00]])),
  ...sect(10, vec([(() => {
    const body = [
      0x41, ...sleb(50_000_000), 0x21, 0x00,              // i = 50_000_000
      0x03, 0x40,                                          // loop
      0x20, 0x00, 0x41, 0x01, 0x6b, 0x21, 0x00,           //   i = i - 1
      0x20, 0x00, 0x0d, 0x00,                              //   br_if 0 (continue while i != 0)
      0x0b,                                                // end loop
      0x20, 0x00,                                          // push i (0) → return value
      0x0b,                                                // end func
    ];
    const entry = [0x01, 0x01, 0x7f, ...body];             // locals: 1 × i32
    return [...uleb(entry.length), ...entry];
  })()])),
);

// run()->i32 { memory.grow(8); let i = 20_000_000; while (i) i -= 1; return i }  — grows memory to
// a deterministic 9-page peak AND burns a deterministic slice of CPU. Pricing multiplies cpuMs by
// memoryMB, so a job priced strictly-positive needs BOTH terms nonzero: memory alone is not enough
// (cpuMs, now real per-thread CPU time not wall-clock, can round to 0 on a one-shot allocation).
const GROWBUSY = B(
  ...HDR,
  ...sect(1, vec([[0x60, 0x00, 0x01, 0x7f]])),            // t0 ()->i32
  ...sect(3, vec([[0x00]])),                              // func0 : t0
  ...sect(5, vec([[0x01, 0x01, 0x0a]])),                  // memory: flags1 (bounded), min 1, max 10
  ...sect(7, vec([[...wname('memory'), 0x02, 0x00], [...wname('run'), 0x00, 0x00]])),
  ...sect(10, vec([(() => {
    const body = [
      0x41, ...sleb(8), 0x40, 0x00, 0x1a,                 // i32.const 8; memory.grow 0; drop → peak 9 pages
      0x41, ...sleb(20_000_000), 0x21, 0x00,              // i = 20_000_000
      0x03, 0x40,                                          // loop
      0x20, 0x00, 0x41, 0x01, 0x6b, 0x21, 0x00,           //   i = i - 1
      0x20, 0x00, 0x0d, 0x00,                              //   br_if 0 (while i != 0)
      0x0b,                                                // end loop
      0x20, 0x00,                                          // push i (0) → return value
      0x0b,                                                // end func
    ];
    const entry = [0x01, 0x01, 0x7f, ...body];             // locals: 1 × i32
    return [...uleb(entry.length), ...entry];
  })()])),
);

await check('normal guest computes and returns (5 + 7 = 12)', async () => {
  const rt = new ComputeRuntime({ maxTime: 4000 });
  const r = await rt.execute(ADD, 'add', [5, 7]);
  assert.strictEqual(r, 12);
});

await check('a trapping guest (unreachable = revert) rejects, so no write-set is committed', async () => {
  const rt = new ComputeRuntime({ maxTime: 2000 });
  await assert.rejects(() => rt.execute(TRAP, 'trap', []));
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

// import env.emit(i32)->() ; export run(i32)->() { local.get 0; call emit }
// Proves the host hook end to end: staged read-set in (hostData.base), the guest calling a
// REAL in-worker host binding, and the write-set posted back to the parent.
const EMIT = B(
  ...HDR,
  0x01, 0x05, 0x01, 0x60, 0x01, 0x7f, 0x00,                         // type (i32)->()
  0x02, 0x0c, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x04, 0x65, 0x6d, 0x69, 0x74, 0x00, 0x00, // import env.emit func0
  0x03, 0x02, 0x01, 0x00,                                           // func[1] : type 0 (run)
  0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x01,             // export "run" func 1
  0x0a, 0x08, 0x01, 0x06, 0x00, 0x20, 0x00, 0x10, 0x00, 0x0b,       // code: local.get 0; call 0; end
);

await check('host hook: staged read-set in, write-set out (base 100 + arg 42 = 142)', async () => {
  const rt = new ComputeRuntime({ maxTime: 3000 });
  const host = {
    data: { base: 100 },
    source: '(ctx) => ({ "env.emit": (v) => { ctx.writes.push(ctx.data.base + v); } })',
  };
  const out = await rt.execute(EMIT, 'run', [42], { host });
  assert.deepStrictEqual(out.writes, [142]);
});

await check('host hook: a host that does NOT provide a declared import → denied', async () => {
  const rt = new ComputeRuntime({ maxTime: 2000 }); // empty allow-list, empty host
  const host = { source: '(ctx) => ({})' }; // provides nothing
  await assert.rejects(() => rt.execute(EMIT, 'run', [1], { host }), /denied import: env\.emit/);
});

// ============================================================================
// RESOURCE METERING (finding C1) — the runtime MEASURES the CPU time and peak memory a guest
// actually used, surfaces them from execute(), and a compute node PRICES the job from those
// measured figures via MarketPricing. Before this the price had no measured basis at all; the
// "fraction of the resources" claim can only ever rest on a real measurement, which is what
// these prove as OUTCOMES (a bigger guest measures bigger, and the price is exactly the model
// applied to the measurement) — NOT a comparison to Ethereum, which is a separate benchmark.
// ============================================================================
await check('metrics: the raw path stays bare by default, and returns measured { result, metrics } when metered', async () => {
  const rt = new ComputeRuntime({ maxTime: 4000 });
  const bare = await rt.execute(ADD, 'add', [5, 7]);
  assert.strictEqual(bare, 12, 'without { meter } the raw path returns the bare result (back-compat)');
  const { result, metrics } = await rt.execute(ADD, 'add', [5, 7], { meter: true });
  assert.strictEqual(result, 12, 'metered run computes the same result');
  assert.ok(Number.isFinite(metrics.cpuMs) && metrics.cpuMs >= 0, 'cpuMs is a real, finite, non-negative measurement');
  assert.ok(Number.isFinite(metrics.wallMs) && metrics.wallMs >= 0, 'wallMs (elapsed real time) is reported alongside');
  // cpuMs is per-thread CPU time, NOT wall-clock: on a single-threaded run the CPU consumed can
  // never exceed the real time elapsed. This invariant is what distinguishes the billed figure
  // from the old wall-clock measurement (which billed descheduled time the guest did not use).
  assert.ok(metrics.cpuMs <= metrics.wallMs + 1, `per-thread CPU (${metrics.cpuMs}ms) cannot exceed wall (${metrics.wallMs}ms)`);
  assert.strictEqual(typeof metrics.peakMemBytes, 'number', 'peak memory is reported');
});

await check('metrics: a memory-growing guest measures a LARGER peak than a guest with no memory', async () => {
  const rt = new ComputeRuntime({ maxMemory: 64 * 1024 * 16, maxTime: 4000 }); // 16-page cap: room to grow to 9
  const none = (await rt.execute(ADD, 'add', [1, 1], { meter: true })).metrics;   // ADD imports/declares no memory
  const grown = (await rt.execute(GROW, 'grow', [], { meter: true })).metrics;     // grows 1 → 9 pages
  assert.strictEqual(none.peakMemBytes, 0, 'a guest with no linear memory measures 0 peak bytes');
  assert.strictEqual(grown.peakMemPages, 9, 'the grown guest peaked at exactly 1 + 8 = 9 pages');
  assert.ok(grown.peakMemBytes > none.peakMemBytes, 'peak memory reflects what the guest actually allocated');
});

await check('metrics: a heavy compute guest measures MORE cpuMs than a trivial one', async () => {
  const rt = new ComputeRuntime({ maxTime: 4000 });
  const light = (await rt.execute(ADD, 'add', [1, 1], { meter: true })).metrics;
  const heavy = (await rt.execute(BUSY, 'busy', [], { meter: true })).metrics;
  assert.ok(heavy.cpuMs > light.cpuMs, `a 50M-iteration loop (${heavy.cpuMs}ms) must measure more CPU than one add (${light.cpuMs}ms)`);
});

await check('metrics: a compute node PRICES a completed job from its measured metrics (not an assumed cost)', async () => {
  const { ComputeNode } = await import('./compute-node.js');
  const { MarketPricing } = await import('./pricing.js');
  const node = new ComputeNode({ runtime: new ComputeRuntime({ maxTime: 4000 }) });
  const out = await node.runJob({ jobId: 'j1', wasmCode: GROWBUSY, functionName: 'run' });
  assert.strictEqual(out.ok, true, 'the job ran within caps');
  assert.strictEqual(out.metrics.peakMemPages, 9, 'the node carries the job’s measured peak memory');
  assert.ok(out.metrics.cpuMs > 0, 'the node carries the job’s measured per-thread CPU time');
  assert.strictEqual(typeof out.price, 'number', 'the completed job is priced');
  const expected = new MarketPricing().calculateComputePrice(out.metrics.cpuMs, out.metrics.peakMemBytes / (1024 * 1024));
  assert.strictEqual(out.price, expected, 'the price is exactly MarketPricing applied to the MEASURED cpuMs + peak memory');
  assert.ok(out.price > 0, 'a job that used real memory and CPU time has a strictly positive measured price');
});

await check('metrics: a completed job METERS its V8 heap use (not only WASM linear memory)', async () => {
  const rt = new ComputeRuntime({ maxTime: 4000 });
  const { metrics } = await rt.execute(ADD, 'add', [5, 7], { meter: true });
  // heapUsedBytes is the worker's V8 heap after the run — host-binding/marshalling allocations that
  // the WASM-linear peak (0 for ADD) does not see. It is always a positive real measurement (the
  // worker isolate itself occupies heap), so metering it closes the "capped but not metered" gap.
  assert.strictEqual(typeof metrics.heapUsedBytes, 'number', 'heap use is reported alongside WASM-linear peak');
  assert.ok(metrics.heapUsedBytes > 0, 'a real V8-heap figure is metered');
  assert.strictEqual(metrics.killed, false, 'a completed job is flagged not-killed');
});

await check('billing: a job KILLED at the deadline is BILLED (an infinite loop is not free)', async () => {
  const { ComputeNode } = await import('./compute-node.js');
  const { MarketPricing } = await import('./pricing.js');
  const node = new ComputeNode({ runtime: new ComputeRuntime({ maxTime: 250 }) });
  const out = await node.runJob({ jobId: 'kill1', wasmCode: SPIN, functionName: 'spin' });
  assert.strictEqual(out.ok, false, 'a killed job did not complete');
  assert.strictEqual(out.killed, true, 'it is reported as killed, not a plain refusal');
  assert.strictEqual(out.billed, true, 'the killed job is billed — it held a worker slot for the full deadline');
  assert.strictEqual(out.metrics.killed, true, 'its metrics carry the killed flag');
  assert.ok(out.metrics.cpuMs > 0, 'a killed job is charged for the time budget it occupied');
  const expected = new MarketPricing().calculateComputePrice(out.metrics.cpuMs, out.metrics.peakMemBytes / (1024 * 1024));
  assert.strictEqual(out.price, expected, 'priced by the same model as a completed job, at the maximum');
  assert.ok(out.price > 0, 'the price of a killed slot is strictly positive — the DoS hole is closed');
});

console.log(`\ncompute isolation: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
