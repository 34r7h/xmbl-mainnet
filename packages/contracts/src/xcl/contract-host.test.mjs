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
import {
  Identity, mintGrant, mintZspToken, signAction, makeAuthorizer, RevocationSet, DurableNonceRegistry,
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

console.log(`\nXCL conformance: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
