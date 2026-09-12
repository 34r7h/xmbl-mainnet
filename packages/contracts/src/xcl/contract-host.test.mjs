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
import { VerkleStateTree, StateMachine } from '@xmbl/state-machine';
import { Block } from '@xmbl/cubic-ledger';
import { ContractHost, InMemoryState, contractCoordinates, contractId, utxoKey, spendKey } from './index.js';
import { compile } from '@xmbl/lng';
import {
  Identity, mintGrant, mintZspToken, signAction, makeAuthorizer, RevocationSet, DurableNonceRegistry,
  cubicSigKeyGen, cubicSigSign, MAYOWasm,
} from '@xmbl/identity';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// ============================================================================
// BYTE-POINTER ABI (T6.1) — a FULL LNG-compiled contract drives PERSISTENT state.
// Before this, an LNG contract ran import-free with its `~u256` fields living only in the
// call's module memory, so nothing persisted across calls (each call is a fresh worker with
// fresh memory). Compiled with `{hostState:true}` it imports env.xmbl_verkle_get/set (the
// §3.1 byte-pointer ABI), and XCL stages the read-set / applies the write-set through Verkle —
// so the two ABIs (hand-written host-ABI contract ↔ LNG-compiled contract) now MEET.
// ============================================================================
// A no-arg increment (the `1` is a literal, not a param): LNG's `~u256` PARAMS arrive as
// memory pointers, and ContractHost.call passes raw i32 args (arg marshalling is a separate,
// unbuilt concern — noted in abi.js). A literal-increment counter isolates the property this
// gate is about: STATE that persists across calls, not argument passing.
const LNG_COUNTER = '~contract `Counter { ~state { ~public { `count ~u256 0 } } '
  + '~on `inc() { `count = `count + 1; return `count } '
  + '~on `get() { return `count } }';

await check('LNG-compiled contract PERSISTS state across calls via the byte-pointer ABI (0 → 1 → 2 → 3)', async () => {
  const wasm = compile(LNG_COUNTER, { hostState: true });
  const host = new ContractHost({ runtime: runtime() });
  const { id } = host.deploy(wasm, [], { byteState: true });

  assert.strictEqual(host.getBytes(id, 'count'), 0n, 'fresh contract state is 0');
  const r1 = await host.call(id, 'inc');
  assert.ok(r1.writes.some((w) => w[0] === 'bytes'), 'a byte write is staged back');
  assert.strictEqual(host.getBytes(id, 'count'), 1n, 'call 1 persists count=1');
  // Call 2 is a FRESH worker (fresh module memory): count=2 is only possible if it read the
  // committed 1 back through xmbl_verkle_get — the exact cross-call persistence the gate needs.
  await host.call(id, 'inc');
  assert.strictEqual(host.getBytes(id, 'count'), 2n, 'call 2 read call 1’s write, then persisted 2');
  await host.call(id, 'inc');
  assert.strictEqual(host.getBytes(id, 'count'), 3n, 'accumulates across three independent calls');
});

await check('byte-pointer state persists through a real VerkleStateTree and two hosts converge', async () => {
  const wasm = compile(LNG_COUNTER, { hostState: true });
  const a = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
  const b = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
  const ida = a.deploy(wasm, [], { byteState: true }).id;
  const idb = b.deploy(wasm, [], { byteState: true }).id;
  const root0 = a.state.getRoot();
  for (let i = 0; i < 3; i++) { await a.call(ida, 'inc'); await b.call(idb, 'inc'); }
  assert.strictEqual(a.getBytes(ida, 'count'), 3n, 'real Verkle-backed state accumulates to 3');
  assert.notStrictEqual(a.state.getRoot(), root0, 'committing byte-keyed state moves the Verkle root');
  assert.strictEqual(a.state.getRoot(), b.state.getRoot(), 'same calls → same Verkle root');
});

// ============================================================================
// WORD-ABI ARGUMENT MARSHALLING (T6.1-b) — an LNG-compiled entrypoint takes its `~u256`
// ARGUMENTS through ContractHost, and returns a decoded value. Before this, ContractHost
// passed raw integers straight to the runtime, where the WASM read each as a memory ADDRESS
// (an LNG `~u256` param is a POINTER to a 32-byte little-endian word) — so `add(7,3)` returned
// a garbage pointer, not 10. The proof is PARITY against BigInt: the ContractHost path must
// agree with the reference semantics for the same contract and args (the exact discrimination
// @xmbl/lng's own WASM harness makes, now driven through the full XCL binding).
// ============================================================================
const ALU = '~contract `A {'
  + ' ~on `add(`a ~u256, `b ~u256) { return `a + `b }'
  + ' ~on `sub(`a ~u256, `b ~u256) { return `a - `b }'
  + ' ~on `mul(`a ~u256, `b ~u256) { return `a * `b }'
  + ' ~on `div(`a ~u256, `b ~u256) { return `a / `b }'
  + ' ~on `mod(`a ~u256, `b ~u256) { return `a % `b }'
  + ' ~on `shl(`a ~u256, `b ~u256) { return `a b< `b }'
  + ' ~on `shr(`a ~u256, `b ~u256) { return `a b> `b } }';
const MASK = (1n << 256n) - 1n;

await check('word-ABI args through ContractHost match BigInt (add/sub/mul/div/mod/shl/shr) over random 256-bit operands', async () => {
  const host = new ContractHost({ runtime: runtime() });
  const { id } = host.deploy(compile(ALU), [], { wordAbi: true });
  const rnd = () => { let v = 0n; for (let i = 0; i < 4; i++) v = (v << 64n) | (BigInt(Math.floor(Math.random() * 2 ** 32)) << 32n) | BigInt(Math.floor(Math.random() * 2 ** 32)); return v & MASK; };
  const val = async (fn, a, b) => (await host.call(id, fn, [a, b])).result;
  for (let t = 0; t < 24; t++) {
    const a = rnd(), b = rnd();
    if ((a + b) <= MASK) assert.strictEqual(await val('add', a, b), a + b, 'add');
    if (a >= b) assert.strictEqual(await val('sub', a, b), a - b, 'sub');
    const ma = a >> 128n, mb = b >> 128n;
    assert.strictEqual(await val('mul', ma, mb), (ma * mb) & MASK, 'mul');
    if (b !== 0n) { assert.strictEqual(await val('div', a, b), a / b, 'div'); assert.strictEqual(await val('mod', a, b), a % b, 'mod'); }
    const sh = b % 200n;
    assert.strictEqual(await val('shl', a, sh), (a << sh) & MASK, 'shl');
    assert.strictEqual(await val('shr', a, sh), a >> sh, 'shr');
  }
  // 256-bit landmarks + the empirical break that started this
  assert.strictEqual((await host.call(id, 'add', [7, 3])).result, 10n, 'add(7,3) is 10, not a pointer');
  assert.strictEqual((await host.call(id, 'mul', [1n << 100n, 1n << 100n])).result, 1n << 200n, '2^100 * 2^100 = 2^200');
  assert.strictEqual((await host.call(id, 'div', [MASK, 3n])).result, MASK / 3n, '(2^256-1)/3 exact');
});

await check('word-ABI accepts Number, BigInt and >2^53 args across the worker boundary', async () => {
  const host = new ContractHost({ runtime: runtime() });
  const { id } = host.deploy(compile(ALU), [], { wordAbi: true });
  assert.strictEqual((await host.call(id, 'add', [7, 3])).result, 10n, 'plain Number args');
  assert.strictEqual((await host.call(id, 'add', [7n, 3n])).result, 10n, 'BigInt args');
  assert.strictEqual((await host.call(id, 'add', [1n << 200n, 1n << 200n])).result, 1n << 201n, 'args far beyond 2^53');
});

await check('word-ABI overflow/underflow/div-zero still TRAP (revert) through ContractHost', async () => {
  const host = new ContractHost({ runtime: runtime() });
  const { id } = host.deploy(compile(ALU), [], { wordAbi: true });
  await assert.rejects(() => host.call(id, 'add', [MASK, 1n]), 'overflow reverts');
  await assert.rejects(() => host.call(id, 'sub', [3n, 5n]), 'underflow reverts');
  await assert.rejects(() => host.call(id, 'div', [6n, 0n]), 'div-by-zero reverts');
});

await check('a word-ABI deploy over a non-LNG contract (no __alloc) fails LOUDLY, never silently passes ints through', async () => {
  const host = new ContractHost({ runtime: runtime() });
  const { id } = host.deploy(COUNTER, [0], { wordAbi: true }); // hand-encoded, exports no __alloc
  await assert.rejects(() => host.call(id, 'increment', [1]), /__alloc/);
});

await check('word-ABI + byteState together: `inc(by)` marshals the arg AND persists 5 → 42 across calls', async () => {
  const wasm = compile('~contract `Counter { ~state { ~public { `count ~u256 0 } } '
    + '~on `inc(`by ~u256) { `count = `count + `by; return `count } }', { hostState: true });
  const host = new ContractHost({ runtime: runtime() });
  const { id } = host.deploy(wasm, [], { byteState: true, wordAbi: true });
  const r1 = await host.call(id, 'inc', [5]);
  assert.strictEqual(r1.result, 5n, 'arg 5 read through the pointer, not as an address');
  assert.ok(r1.writes.some((w) => w[0] === 'bytes'), 'the field is flushed to Verkle');
  const r2 = await host.call(id, 'inc', [37n]);
  assert.strictEqual(r2.result, 42n, 'call 2 read the committed 5, added 37');
  assert.strictEqual(host.getBytes(id, 'count'), 42n, 'committed field agrees with the decoded return');
});

// ============================================================================
// CRYPTO HOST CALLS (T6.1-c) — a contract asks the chain to VERIFY a signature, and the
// verdict comes from the REAL @xmbl/identity verifiers (Cubic-SIG in pure JS; MAYO whose
// WASM is loaded ONCE via the worker's async init hook — the "async" the operator chose).
// The signature MATERIAL is chain-staged (identical on every node → deterministic verdict);
// the guest supplies only the message bytes. A VALID signature verifies to 1, a signature
// over a DIFFERENT message to 0 — a real cryptographic outcome, not a callable-stub check.
// ============================================================================
// A hand-encoded contract (like COUNTER, no LNG dependency for the runtime half) that imports
// both crypto verifiers, holds a message in a data segment, exports its memory, and calls each
// verifier over (msgPtr=0, msgLen=N).
function cryptoContract(msg) {
  const uleb = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };
  const vec = (items) => [...uleb(items.length), ...items.flat()];
  const section = (id, body) => [id, ...uleb(body.length), ...body];
  const s = (t) => [...uleb(t.length), ...[...t].map((c) => c.charCodeAt(0))];
  const N = msg.length;
  const fnBody = (callIdx) => { const code = [0x00, 0x41, ...uleb(0), 0x41, ...uleb(N), 0x10, ...uleb(callIdx), 0x0b]; return [...uleb(code.length), ...code]; };
  return Uint8Array.from([
    ...HDR,
    ...section(1, vec([[0x60, ...vec([0x7f, 0x7f]), ...vec([0x7f])], [0x60, ...vec([]), ...vec([0x7f])]])),
    ...section(2, vec([
      [...s('env'), ...s('xmbl_cubic_sig_verify'), 0x00, ...uleb(0)],
      [...s('env'), ...s('xmbl_mayo_verify'), 0x00, ...uleb(0)],
    ])),
    ...section(3, vec([uleb(1), uleb(1)])),
    ...section(5, vec([[0x01, ...uleb(1), ...uleb(1)]])),
    ...section(7, vec([
      [...s('memory'), 0x02, ...uleb(0)],
      [...s('check_cubic'), 0x00, ...uleb(2)],
      [...s('check_mayo'), 0x00, ...uleb(3)],
    ])),
    ...section(10, vec([fnBody(0), fnBody(1)])),
    ...section(11, vec([[0x00, 0x41, ...uleb(0), 0x0b, ...vec([...msg])]])),
  ]);
}

await check('crypto host call: Cubic-SIG verifies a VALID signature to 1 and a tampered one to 0 through ContractHost', async () => {
  const msg = Uint8Array.from([11, 22, 33, 44, 55, 66]);
  const host = new ContractHost({ runtime: new ComputeRuntime({ maxTime: 10000 }), state: new VerkleStateTree() });
  const { id, coordinates } = host.deploy(cryptoContract(msg), [], { cryptoHost: true });
  const { sk, pk } = cubicSigKeyGen();
  const cubeContext = { cubeAddress: id, coordinates: coordinates.coordinates };
  const good = cubicSigSign(msg, sk, pk, cubeContext);
  const bad = cubicSigSign(Uint8Array.from([1, 2, 3]), sk, pk, cubeContext); // signs a DIFFERENT message
  const call = async (sig) => (await host.call(id, 'check_cubic', [], { crypto: { cubicSig: { sig, pk, cubeContext } } })).result;
  assert.strictEqual(await call(good), 1, 'a valid Cubic-SIG over the presented message verifies');
  assert.strictEqual(await call(bad), 0, 'a signature over a different message is rejected');
});

await check('crypto host call: MAYO (async-loaded) verifies a VALID signature to 1 and a tampered one to 0 through ContractHost', async () => {
  const msg = Uint8Array.from([7, 7, 7, 7, 8, 8]);
  const host = new ContractHost({ runtime: new ComputeRuntime({ maxTime: 10000 }), state: new VerkleStateTree() });
  const { id } = host.deploy(cryptoContract(msg), [], { cryptoHost: true });
  const mayo = await MAYOWasm.load();
  const kp = await mayo.keygen();
  const good = await mayo.sign(msg, kp.privateKey);
  const bad = await mayo.sign(Uint8Array.from([9, 9, 9]), kp.privateKey); // signs a DIFFERENT message
  const call = async (signature) => (await host.call(id, 'check_mayo', [], { crypto: { mayo: { signature, publicKey: kp.publicKey } } })).result;
  assert.strictEqual(await call(good), 1, 'a valid MAYO signature over the presented message verifies');
  assert.strictEqual(await call(bad), 0, 'a MAYO signature over a different message is rejected');
});

await check('crypto host call: the same import declared WITHOUT cryptoHost is denied (deny-by-default holds)', async () => {
  const msg = Uint8Array.from([1, 2, 3, 4]);
  const host = new ContractHost({ runtime: runtime() });
  const { id } = host.deploy(cryptoContract(msg), []); // NO cryptoHost → no crypto init attached
  await assert.rejects(() => host.call(id, 'check_cubic'), /denied import: env\.xmbl_cubic_sig_verify/);
});

// ============================================================================
// TRUE-IMPUTE ENFORCEMENT — a gated contract runs ONLY under a valid delegation chain.
// The gate is load-bearing: an unauthorized call is REFUSED before the WASM ever runs and
// before any slot is written, so the state root does NOT move on a rejected call.
// ============================================================================
await check('gated contract with NO authorizer configured fails closed (never runs)', async () => {
  const host = new ContractHost({ runtime: runtime() });         // no authorizer
  const { id } = host.deploy(COUNTER, [0], { gated: true });
  await assert.rejects(() => host.call(id, 'increment'), /gated but no authorizer/);
  assert.strictEqual(host.getSlot(id, 0), 0, 'no state written on a fail-closed refusal');
});

await check('gated contract runs under a valid root→coordinator→agent chain, and is rejected without one', async () => {
  // Real MAYO identities for the whole chain.
  const root = await Identity.create();
  const coord = await Identity.create();
  const agent = await Identity.create();
  const host0 = new ContractHost({ runtime: runtime() });
  const { id } = host0.deploy(COUNTER, [0]);                     // learn the id (audience) deterministically

  const grant = await mintGrant(root, { coordinatorPub: coord.publicKey, scope: ['increment'], exp: 4000000000, tee: null });
  const token = await mintZspToken(coord, { grant, agentPub: agent.publicKey, aud: `contract:${id}`, scope: ['increment'], ttlSeconds: 3600 });
  const { sig: actionSig, nonce } = await signAction(agent, { token, action: 'increment', args: [] });
  const presentation = { grant, token, actionSig, nonce };      // action/args filled in by ContractHost from the call

  const rev = new RevocationSet();
  const authorizer = makeAuthorizer({ rootAddress: root.address, aud: `contract:${id}`, isRevoked: (h) => rev.isRevoked(h) });
  const host = new ContractHost({ runtime: runtime(), authorizer });
  host.deploy(COUNTER, [0], { gated: true });

  // (a) no authorization presented → refused, no state change
  await assert.rejects(() => host.call(id, 'increment'), /unauthorized \(no-authorization-presented\)/);
  assert.strictEqual(host.getSlot(id, 0), 0);

  // (b) valid chain → runs, state advances
  const r = await host.call(id, 'increment', [], { auth: presentation });
  assert.strictEqual(r.result, 1, 'authorized call executes the real WASM');
  assert.strictEqual(host.getSlot(id, 0), 1);

  // (b2) REPLAY of the SAME presentation is refused — one signed action = one state transition.
  // Without single-use, this same actionSig would drive the counter up on every resend (double-spend).
  await assert.rejects(() => host.call(id, 'increment', [], { auth: presentation }), /unauthorized \(action-replayed\)/);
  assert.strictEqual(host.getSlot(id, 0), 1, 'a replayed action must not advance state');

  // (c) an action the token does not scope → refused before running
  const { sig: badSig, nonce: badNonce } = await signAction(agent, { token, action: 'selfdestruct', args: [] });
  await assert.rejects(
    () => host.call(id, 'selfdestruct', [], { auth: { grant, token, actionSig: badSig, nonce: badNonce } }),
    /unauthorized \(action-out-of-scope\)/,
  );

  // (d) burn the token → the very same presentation is now refused (revocation is live)
  rev.burn(token);
  await assert.rejects(() => host.call(id, 'increment', [], { auth: presentation }), /unauthorized \(revoked\)/);
  assert.strictEqual(host.getSlot(id, 0), 1, 'a revoked call must not advance state');
});

// (b2 durable) The SAME anti-replay guarantee holds when single-use is backed by the DURABLE
// store (T1.1) injected as policy.nonces — INCLUDING across a restart of that store between the
// first presentation and the replay. The slot state is continuous (one host); only the nonce
// ledger is the external durable store being restarted (close the file, reopen it). Without
// durability the reopened store would have forgotten the nonce and the replay would drive the
// counter a second time — the exact hole the in-memory registry leaves open.
await check('gated seam: a durable nonce store rejects a replay action-replayed across a store restart, slot unchanged', async () => {
  const root = await Identity.create();
  const coord = await Identity.create();
  const agent = await Identity.create();
  const host0 = new ContractHost({ runtime: runtime() });
  const { id } = host0.deploy(COUNTER, [0]);

  const grant = await mintGrant(root, { coordinatorPub: coord.publicKey, scope: ['increment'], exp: 4000000000, tee: null });
  const token = await mintZspToken(coord, { grant, agentPub: agent.publicKey, aud: `contract:${id}`, scope: ['increment'], ttlSeconds: 3600 });
  const { sig: actionSig, nonce } = await signAction(agent, { token, action: 'increment', args: [] });
  const presentation = { grant, token, actionSig, nonce };

  const dir = mkdtempSync(join(tmpdir(), 'xmbl-xcl-nonce-'));
  const dbPath = join(dir, 'nonces.db');

  const host = new ContractHost({ runtime: runtime() });
  host.deploy(COUNTER, [0], { gated: true });

  // First run: authorizer over the durable store → the call advances the slot and burns the nonce to disk.
  const store1 = new DurableNonceRegistry({ path: dbPath });
  host.authorizer = makeAuthorizer({ rootAddress: root.address, aud: `contract:${id}`, nonces: store1 });
  const r = await host.call(id, 'increment', [], { auth: presentation });
  assert.strictEqual(r.result, 1, 'authorized call executes');
  assert.strictEqual(host.getSlot(id, 0), 1);
  store1.close(); // == restart of the durable nonce store

  // After restart: a fresh authorizer over the REOPENED file. The slot state is unchanged (same host);
  // the replayed, authorized call must be rejected because the durable store remembers the burn.
  const store2 = new DurableNonceRegistry({ path: dbPath });
  host.authorizer = makeAuthorizer({ rootAddress: root.address, aud: `contract:${id}`, nonces: store2 });
  await assert.rejects(() => host.call(id, 'increment', [], { auth: presentation }), /unauthorized \(action-replayed\)/);
  assert.strictEqual(host.getSlot(id, 0), 1, 'a replayed action must not advance state, even across a store restart');
  store2.close();

  rmSync(dir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
// UTXO ↔ VERKLE LINK — a contract spends xmbl UTXOs and creates new ones, committed
// into the SAME Verkle state machine, with value conservation enforced fail-closed.
// TRANSFER/MINT are the hand-encoded UTXO contracts (shared with the cross-node
// reproduction test via utxo-fixtures.mjs, so a single bytecode drives both).
// ────────────────────────────────────────────────────────────────────────────
const { TRANSFER, TRANSFER_FEE, SPLIT, CONSOLIDATE, MINT, RECIP, FEE, PART } = await import('./utxo-fixtures.mjs');

const seedUtxo = async (state, id, amount, from = 'genesis', to = 'alice') =>
  state.insert(utxoKey(id), { from, to, amount: String(amount) });

await check('utxo: a valid transfer spends an input and creates a conserved output, moving the root', async () => {
  const state = new VerkleStateTree();
  await seedUtxo(state, 'U1', 100);
  const host = new ContractHost({ runtime: runtime(), state });
  const { id } = host.deploy(TRANSFER, [], { utxoHost: true });
  const root0 = state.getRoot();
  const r = await host.call(id, 'transfer', [], { inputs: ['U1'] });
  assert.deepStrictEqual(r.utxo.spent, ['U1'], 'the presented input was spent');
  assert.strictEqual(r.utxo.created.length, 1, 'one output created');
  assert.strictEqual(r.utxo.created[0].amount, '100', 'output amount equals input (conserved)');
  assert.strictEqual(r.utxo.created[0].to, RECIP, 'output goes to the contract-chosen recipient');
  assert.notStrictEqual(state.get(spendKey('U1')), undefined, 'a spend-marker (nullifier) was written');
  const rec = state.get(utxoKey(r.utxo.created[0].id));
  assert.strictEqual(rec.amount, '100', 'the new UTXO record is committed to Verkle');
  assert.notStrictEqual(state.getRoot(), root0, 'committing the transfer moved the Verkle root');
});

await check('utxo: a mint (out > in) is refused fail-closed and the state root is unmoved', async () => {
  const state = new VerkleStateTree();
  const host = new ContractHost({ runtime: runtime(), state });
  const { id } = host.deploy(MINT, [], { utxoHost: true });
  const root0 = state.getRoot();
  await assert.rejects(() => host.call(id, 'mint', [], { inputs: [] }), /value not conserved|mint refused/);
  assert.strictEqual(state.getRoot(), root0, 'a refused mint must apply NOTHING — root unmoved');
});

await check('utxo: a double-spend of the same input is refused and the root is unmoved', async () => {
  const state = new VerkleStateTree();
  await seedUtxo(state, 'U1', 100);
  const host = new ContractHost({ runtime: runtime(), state });
  const { id } = host.deploy(TRANSFER, [], { utxoHost: true });
  await host.call(id, 'transfer', [], { inputs: ['U1'] });  // first spend succeeds
  const root1 = state.getRoot();
  await assert.rejects(() => host.call(id, 'transfer', [], { inputs: ['U1'] }), /already spent|double-spend/);
  assert.strictEqual(state.getRoot(), root1, 'the refused re-spend must move nothing');
});

await check('utxo: two independent hosts fed the same transfer converge to one root', async () => {
  const mk = async () => {
    const state = new VerkleStateTree();
    await seedUtxo(state, 'U1', 100);
    const host = new ContractHost({ runtime: runtime(), state });
    const { id } = host.deploy(TRANSFER, [], { utxoHost: true });
    await host.call(id, 'transfer', [], { inputs: ['U1'] });
    return state.getRoot();
  };
  const [ra, rb] = [await mk(), await mk()];
  assert.strictEqual(ra, rb, 'same seed + same call → same root on independent nodes');
});

await check('utxo: a contract spends a LEDGER-PRODUCED key (real Block + StateMachine derivation)', async () => {
  // The key is not fabricated: Block.fromTransaction content-addresses the utxo tx (id = its hash),
  // and StateMachine._stateChangesFor is the real mapping a node runs to place it in the Verkle tree.
  const utxoTx = { type: 'utxo', from: 'alice', to: 'bob', amount: 100, timestamp: 1 };
  const block = Block.fromTransaction(utxoTx);
  const changes = StateMachine.prototype._stateChangesFor.call(null, block);
  const key = Object.keys(changes)[0];
  assert.strictEqual(key, `utxo:${block.id}`, 'the ledger produces the utxo:<block.id> key the contract will spend');
  const state = new VerkleStateTree();
  await state.insert(key, changes[key]);           // exactly what _handleLedgerBlock inserts
  const host = new ContractHost({ runtime: runtime(), state });
  const { id } = host.deploy(TRANSFER, [], { utxoHost: true });
  const r = await host.call(id, 'transfer', [], { inputs: [block.id] });
  assert.deepStrictEqual(r.utxo.spent, [block.id], 'the contract spent the ledger-produced UTXO');
  assert.strictEqual(r.utxo.created[0].amount, '100', 'value conserved across the ledger→contract link');
  assert.notStrictEqual(state.get(spendKey(block.id)), undefined, 'the ledger UTXO now carries a spend-marker');
});

await check('utxo: the spend is provable against the verkle root and a tampered value is rejected', async () => {
  const state = new VerkleStateTree();
  await seedUtxo(state, 'U1', 100);
  const host = new ContractHost({ runtime: runtime(), state });
  const { id } = host.deploy(TRANSFER, [], { utxoHost: true });
  await host.call(id, 'transfer', [], { inputs: ['U1'] });
  const sk = spendKey('U1');
  const value = state.get(sk);
  const proof = state.generateProof(sk);
  assert.strictEqual(proof.root, state.getRoot(), 'the proof is against the committed state root');
  assert.strictEqual(VerkleStateTree.verifyProof(sk, value, proof), true, 'the spend is provable against the committed root');
  assert.strictEqual(VerkleStateTree.verifyProof(sk, { by: 'someone-else' }, proof), false, 'a tampered value fails the proof');
});

await check('utxo: the committed set reproduces the same root under any insertion order', async () => {
  const state = new VerkleStateTree();
  await seedUtxo(state, 'U1', 100);
  const host = new ContractHost({ runtime: runtime(), state });
  const { id } = host.deploy(TRANSFER, [], { utxoHost: true });
  await host.call(id, 'transfer', [], { inputs: ['U1'] });
  const entries = [...state.state.entries()];
  const replay = new VerkleStateTree();
  for (const [k, v] of [...entries].reverse()) await replay.insert(k, v);
  assert.strictEqual(replay.getRoot(), state.getRoot(), 'the UTXO-bearing state root is a function of the SET, not order');
});

// ── The `fee` term of the conservation check is load-bearing, in BOTH directions.
await check('utxo: a fee-bearing transfer conserves ONLY when opts.fee equals the withheld amount', async () => {
  // TRANSFER_FEE spends 100 and creates 90; the missing 10 is the fee. sumIn(100) === sumOut(90)+fee
  // holds iff fee === 10, so the same call+bytecode is accepted at fee=10 and refused at 9 and 11 —
  // proving the fee term actually discriminates (a wrong sign or a dropped term would not).
  const mk = async () => { const state = new VerkleStateTree(); await seedUtxo(state, 'U1', 100); const host = new ContractHost({ runtime: runtime(), state }); const { id } = host.deploy(TRANSFER_FEE, [], { utxoHost: true }); return { state, host, id }; };
  const under = await mk();
  await assert.rejects(() => under.host.call(under.id, 'transfer', [], { inputs: ['U1'], fee: FEE - 1 }), /value not conserved/, 'fee too small: in=100 out=90 fee=9 → refused');
  assert.strictEqual(under.state.get(spendKey('U1')), undefined, 'the refused call spent nothing');
  const over = await mk();
  await assert.rejects(() => over.host.call(over.id, 'transfer', [], { inputs: ['U1'], fee: FEE + 1 }), /value not conserved/, 'fee too large: in=100 out=90 fee=11 → refused');
  const exact = await mk();
  const r = await exact.host.call(exact.id, 'transfer', [], { inputs: ['U1'], fee: FEE });
  assert.strictEqual(r.utxo.created[0].amount, String(100 - FEE), 'the output is input − fee');
  assert.notStrictEqual(exact.state.get(spendKey('U1')), undefined, 'the exact-fee call committed the spend');
});

await check('utxo: a fee charged on a full-value output (nothing withheld) is refused — fee cannot mint', async () => {
  // TRANSFER creates the WHOLE 100; charging any fee makes sumOut+fee exceed sumIn, so it is refused.
  // This is the reverse of the above: it proves the fee is added to the OUTPUT side, not the input side.
  const state = new VerkleStateTree();
  await seedUtxo(state, 'U1', 100);
  const host = new ContractHost({ runtime: runtime(), state });
  const { id } = host.deploy(TRANSFER, [], { utxoHost: true });
  const root0 = state.getRoot();
  await assert.rejects(() => host.call(id, 'transfer', [], { inputs: ['U1'], fee: FEE }), /value not conserved/);
  assert.strictEqual(state.getRoot(), root0, 'a fee that would have to be minted moves nothing');
});

// ── Multi-OUTPUT conservation: one input split into two outputs that sum to it (a real change tx).
await check('utxo: a split creates TWO outputs summing to the input (multi-output conservation)', async () => {
  const state = new VerkleStateTree();
  await seedUtxo(state, 'U1', 100);
  const host = new ContractHost({ runtime: runtime(), state });
  const { id } = host.deploy(SPLIT, [], { utxoHost: true });
  const r = await host.call(id, 'transfer', [], { inputs: ['U1'] });
  assert.strictEqual(r.utxo.created.length, 2, 'two outputs were created');
  const amounts = r.utxo.created.map((o) => Number(o.amount)).sort((a, b) => a - b);
  assert.deepStrictEqual(amounts, [PART, 100 - PART], 'the two outputs are PART and (input − PART)');
  assert.strictEqual(amounts[0] + amounts[1], 100, 'and they sum to the spent input — conserved');
  assert.notStrictEqual(r.utxo.created[0].id, r.utxo.created[1].id, 'the two outputs are distinct content-addressed UTXOs');
  for (const o of r.utxo.created) assert.strictEqual(state.get(utxoKey(o.id)).amount, o.amount, 'each output is committed to Verkle');
});

// ── Multi-INPUT: consolidate every presented input into one output; xmbl_input_count drives the loop.
await check('utxo: consolidate spends ALL presented inputs (input_count-driven) into one conserved output', async () => {
  const state = new VerkleStateTree();
  const inputs = ['A1', 'B2', 'C3', 'D4'];
  const amts = [11, 22, 33, 44];
  for (let i = 0; i < inputs.length; i++) await seedUtxo(state, inputs[i], amts[i]);
  const host = new ContractHost({ runtime: runtime(), state });
  const { id } = host.deploy(CONSOLIDATE, [], { utxoHost: true });
  const r = await host.call(id, 'transfer', [], { inputs });
  assert.deepStrictEqual([...r.utxo.spent].sort(), [...inputs].sort(), 'every presented input was spent (input_count enumerated them all)');
  assert.strictEqual(r.utxo.created.length, 1, 'consolidated into a single output');
  assert.strictEqual(r.utxo.created[0].amount, String(amts.reduce((a, b) => a + b, 0)), 'the output is the SUM of all inputs — conserved');
  for (const uid of inputs) assert.notStrictEqual(state.get(spendKey(uid)), undefined, `input ${uid} carries a spend-marker`);
});

// ── A partial spend is safe: an input the contract did NOT spend stays spendable in a later call.
await check('utxo: with two inputs staged, TRANSFER spends only input 0 and the other stays spendable', async () => {
  const state = new VerkleStateTree();
  await seedUtxo(state, 'U1', 100);
  await seedUtxo(state, 'U2', 250);
  const host = new ContractHost({ runtime: runtime(), state });
  const { id } = host.deploy(TRANSFER, [], { utxoHost: true });
  // inputIds is sorted, so input 0 is 'U1'; TRANSFER enumerates and spends only input 0.
  const r1 = await host.call(id, 'transfer', [], { inputs: ['U2', 'U1'] });
  assert.deepStrictEqual(r1.utxo.spent, ['U1'], 'only the first (sorted) input was spent');
  assert.strictEqual(r1.utxo.created[0].amount, '100', 'the output equals the spent input, not the sum — the other input was NOT burned');
  assert.strictEqual(state.get(spendKey('U2')), undefined, 'the unspent input carries no spend-marker');
  // U2 is therefore still a valid, unspent input for a later call.
  const r2 = await host.call(id, 'transfer', [], { inputs: ['U2'] });
  assert.deepStrictEqual(r2.utxo.spent, ['U2'], 'the previously-unspent input spends cleanly afterward');
  assert.strictEqual(r2.utxo.created[0].amount, '250', 'and for its own full amount');
});

console.log(`\nXCL conformance: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
