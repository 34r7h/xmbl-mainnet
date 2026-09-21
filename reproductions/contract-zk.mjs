// REPRODUCTION — a contract USES xmbl's coordinate/curve zero-knowledge, provably (packages/contracts
// × packages/zero-knowledge × packages/storage-compute × packages/state-machine).
//
// CLAIM (the operator's demand: "zk is a giant component … contracts must be able to use xmbl's zk"):
// a deployed contract can ask the chain to VERIFY a coordinate/curve ZK proof and GATE a real Verkle
// state transition on the verdict — and the verdict is bound to the coordinate the CONTRACT asserts
// (bytes in its own linear memory), not a trusted host flag. So zk is genuinely wired INTO the
// contract system, not a standalone library sitting beside it.
//
// WHAT xmbl's zk proves here (packages/zero-knowledge, the FRI cube-curve commitment): a prover
// commits a blinded, degree-bounded curve through PUBLIC anchor points and a DERIVED coordinate,
// revealing nothing about the secret points. The statement is "the committed curve passes through
// the public points AND through (derivedX, derivedY)". A contract that knows only the public points
// and the proof can check whether a coordinate IT asserts lies on that secret curve.
//
// HOW THIS REPRODUCES IT, with the REAL zk module + runtime + host (no mocks):
//   • A hand-encoded contract imports env.xmbl_zk_verify(x_ptr, y_ptr) and env.xmbl_verkle_set(slot,
//     val). It bakes a coordinate (x, y) into its own memory and does: if zk_verify(x,y) then set
//     slot 7 = 1. The coordinate is READ FROM THE GUEST'S MEMORY — the guest supplies it.
//   • ContractHost stages the proof + public points (chain-provided, identical on every node) and
//     attaches the async zk init that import()s @xmbl/zero-knowledge inside the compute worker.
//   1. GENUINE coordinate  → zk_verify returns 1 → the contract commits slot 7 → the Verkle ROOT MOVES.
//   2. TAMPERED coordinate (y+1) → zk_verify returns 0 → no write → the Verkle ROOT IS UNMOVED.
//      (This is the binding proof: the verdict tracked the contract's asserted bytes.)
//   3. The same import declared WITHOUT the zkHost opt-in → DENIED (deny-by-default holds).
//   4. A MALFORMED staged proof → zk_verify returns 0, never traps → root unmoved (fail-closed, not DoS).
//   5. Two independent nodes run the genuine call → the SAME root (deterministic verdict).
//
// OPT-IN / UNAUDITED: @xmbl/zero-knowledge is an experimental, UNAUDITED post-quantum FRI prototype
// (MAINNET-GATES ⛔). This wiring is per-contract opt-in (the `zkHost` deploy flag) and does NOT gate
// consensus, the ledger, or sealing — a contract that does not opt in never touches it.
//
// Exits non-zero if any claim fails, so it is also a hard-gate test (reproductions.test.mjs).
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ComputeRuntime } from '@xmbl/storage-compute';
import { VerkleStateTree } from '@xmbl/state-machine';
import { ContractHost } from '@xmbl/contracts';
import { setup, blindedCurve, prove, verify } from '@xmbl/zero-knowledge';

// ── WASM builder: a contract that GATES a state write on a zk proof over a coordinate it asserts ──
const HDR = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const uleb = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };
// signed LEB128 (i32.const operands). All operands here are small non-negative, but encode correctly
// for any value so the builder is not silently wrong if the layout changes.
const sleb = (n) => { let more = true; const b = []; while (more) { let x = n & 0x7f; n >>= 7; if ((n === 0 && !(x & 0x40)) || (n === -1 && (x & 0x40))) more = false; else x |= 0x80; b.push(x); } return b; };
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];
const s = (t) => [...uleb(t.length), ...[...t].map((c) => c.charCodeAt(0))];
// 32-byte little-endian word for a field element.
const word32 = (v) => { const b = new Uint8Array(32); let x = BigInt(v); for (let i = 0; i < 32; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };

// zkGatedContract(xWord, yWord): bakes x at offset 0, y at offset 32 in its own memory and exports
//   check() -> i32 { ok = xmbl_zk_verify(0, 32); if (ok) xmbl_verkle_set(7, 1); return ok }
function zkGatedContract(xWord, yWord) {
  const data = [...xWord, ...yWord]; // 64 bytes: x at 0, y at 32
  // check() body: 1 i32 local (ok).
  const code = [
    0x01, 0x01, 0x7f,            // locals: 1 group of 1 i32  (local 0 = ok)
    0x41, ...sleb(0),            // i32.const 0     (x_ptr)
    0x41, ...sleb(32),           // i32.const 32    (y_ptr)
    0x10, ...uleb(0),            // call 0          (xmbl_zk_verify) -> ok
    0x22, ...uleb(0),            // local.tee 0     (ok; leaves ok on stack)
    0x04, 0x40,                  // if (void)
    0x41, ...sleb(7),            //   i32.const 7   (slot)
    0x41, ...sleb(1),            //   i32.const 1   (value)
    0x10, ...uleb(1),            //   call 1        (xmbl_verkle_set) -> i32
    0x1a,                        //   drop
    0x0b,                        // end if
    0x20, ...uleb(0),            // local.get 0     (return ok)
    0x0b,                        // end func
  ];
  return Uint8Array.from([
    ...HDR,
    // Type: (i32,i32)->i32  and  ()->i32
    ...section(1, vec([[0x60, ...vec([0x7f, 0x7f]), ...vec([0x7f])], [0x60, ...vec([]), ...vec([0x7f])]])),
    // Import: env.xmbl_zk_verify:type0 (func 0), env.xmbl_verkle_set:type0 (func 1)
    ...section(2, vec([
      [...s('env'), ...s('xmbl_zk_verify'), 0x00, ...uleb(0)],
      [...s('env'), ...s('xmbl_verkle_set'), 0x00, ...uleb(0)],
    ])),
    // Function: one local func of type 1 (func 2)
    ...section(3, vec([uleb(1)])),
    // Memory: 1 page, bounded max 1
    ...section(5, vec([[0x01, ...uleb(1), ...uleb(1)]])),
    // Export: memory, check (func 2)
    ...section(7, vec([
      [...s('memory'), 0x02, ...uleb(0)],
      [...s('check'), 0x00, ...uleb(2)],
    ])),
    // Code
    ...section(10, vec([[...uleb(code.length), ...code]])),
    // Data: active segment at offset 0 with the baked coordinate
    ...section(11, vec([[0x00, 0x41, ...sleb(0), 0x0b, ...vec([...data])]])),
  ]);
}

const runtime = () => new ComputeRuntime({ maxTime: 15000 });
const line = (k, v) => console.log(`  ${k.padEnd(34)}: ${v}`);

async function main() {
  console.log('REPRODUCTION — a contract uses xmbl coordinate/curve zero-knowledge to gate state\n');

  // 1) Build a REAL zk proof (off-chain, as a prover would). The secret points never leave here.
  const ctx = setup();
  const publicPoints = [{ x: 11n, y: 101n }, { x: 12n, y: 205n }, { x: 13n, y: 313n }, { x: 14n, y: 419n }];
  const secretPoints = [{ x: 21n, y: 55555n }, { x: 22n, y: 66666n }, { x: 23n, y: 77777n }];
  const derivedX = 99n;
  const { Pt, derivedY } = blindedCurve(ctx, { publicPoints, secretPoints, derivedX });
  const proof = prove(ctx, { Pt, publicPoints, derivedX, derivedY });
  assert.strictEqual(verify(ctx, { proof, publicPoints, derivedX, derivedY }), true, 'sanity: genuine proof verifies standalone');
  assert.strictEqual(verify(ctx, { proof, publicPoints, derivedX, derivedY: derivedY + 1n }), false, 'sanity: a wrong coordinate is rejected standalone');
  line('derivedX (public coordinate)', derivedX);
  line('derivedY (on the secret curve)', derivedY);
  line('public anchor points', publicPoints.length);
  line('secret points (never revealed)', secretPoints.length);
  console.log('');

  const stagedZk = { opts: {}, proof, publicPoints }; // chain-staged material: identical on every node

  // 2) GENUINE coordinate → verify=1 → state write → Verkle root MOVES.
  const host = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
  const genuine = zkGatedContract(word32(derivedX), word32(derivedY));
  const { id: idH } = host.deploy(genuine, [7], { zkHost: true });
  const rootBeforeGenuine = host.state.getRoot();
  const rH = await host.call(idH, 'check', [], { zk: stagedZk });
  const rootAfterGenuine = host.state.getRoot();
  line('genuine: xmbl_zk_verify result', rH.result);
  line('genuine: slot 7 after call', host.getSlot(idH, 7));
  line('root before → after (genuine)', `${rootBeforeGenuine.slice(0, 12)}… → ${rootAfterGenuine.slice(0, 12)}…`);
  assert.strictEqual(rH.result, 1, 'genuine coordinate must verify to 1');
  assert.strictEqual(host.getSlot(idH, 7), 1, 'a verified proof must commit the gated state write');
  assert.notStrictEqual(rootAfterGenuine, rootBeforeGenuine, 'committing gated state must MOVE the Verkle root');
  console.log('');

  // 3) TAMPERED coordinate (y+1) → verify=0 → NO write → Verkle root UNMOVED. (binding proof)
  const tampered = zkGatedContract(word32(derivedX), word32(derivedY + 1n));
  const { id: idT } = host.deploy(tampered, [7], { zkHost: true });
  const rootBeforeTamper = host.state.getRoot();
  const rT = await host.call(idT, 'check', [], { zk: stagedZk });
  const rootAfterTamper = host.state.getRoot();
  line('tampered: xmbl_zk_verify result', rT.result);
  line('tampered: slot 7 after call', host.getSlot(idT, 7));
  line('root before → after (tampered)', `${rootBeforeTamper.slice(0, 12)}… → ${rootAfterTamper.slice(0, 12)}…`);
  assert.strictEqual(rT.result, 0, 'a coordinate the secret curve does not pass through must verify to 0');
  assert.strictEqual(host.getSlot(idT, 7), 0, 'a failed proof must NOT commit any state');
  assert.strictEqual(rootAfterTamper, rootBeforeTamper, 'a failed proof must leave the Verkle root UNMOVED');
  console.log('');

  // 4) DENY: the same import declared WITHOUT zkHost is refused (deny-by-default).
  let denied = 0;
  const hostNoZk = new ContractHost({ runtime: runtime() });
  const { id: idN } = hostNoZk.deploy(genuine, [7]); // NO zkHost → no zk init attached
  await assert.rejects(() => hostNoZk.call(idN, 'check', [], { zk: stagedZk }), /denied import: env\.xmbl_zk_verify/);
  denied += 1;
  line('denied-import refusals', denied);
  console.log('');

  // 5) NEVER TRAPS: a malformed staged proof → verify returns 0, no trap → root unmoved.
  const hostBad = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
  const { id: idB } = hostBad.deploy(genuine, [7], { zkHost: true });
  const rootBeforeBad = hostBad.state.getRoot();
  const rB = await hostBad.call(idB, 'check', [], { zk: { opts: {}, proof: { rootP: 'deadbeef', garbage: true }, publicPoints } });
  line('malformed proof: result (no trap)', rB.result);
  assert.strictEqual(rB.result, 0, 'a malformed proof must refuse (0), not trap');
  assert.strictEqual(hostBad.state.getRoot(), rootBeforeBad, 'a malformed proof must leave the root unmoved');
  console.log('');

  // 5b) F4 AT THE CONTRACT BOUNDARY: the staged object that carries the proof must NOT get to choose
  // the degree bound the proof is checked against. A prover builds a curve far outside the agreed
  // bound, proves it at its OWN inflated K, and stages opts that would make the host agree.
  const cheatCtx = setup({ degreeBound: 64 });
  const cheat = blindedCurve(cheatCtx, { publicPoints, secretPoints, derivedX, blindDegree: 45 });
  const cheatProof = prove(cheatCtx, { Pt: cheat.Pt, publicPoints, derivedX, derivedY: cheat.derivedY });
  assert.strictEqual(verify(cheatCtx, { proof: cheatProof, publicPoints, derivedX, derivedY: cheat.derivedY }), true,
    'the inflated proof must be internally consistent at its own bound (else this proves nothing)');
  const hostK = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
  const { id: idK } = hostK.deploy(genuine, [7], { zkHost: true });
  const rootBeforeK = hostK.state.getRoot();
  const rK = await hostK.call(idK, 'check', [], { zk: { opts: { degreeBound: 64 }, proof: cheatProof, publicPoints } });
  line('prover-staged degree bound: result', rK.result);
  assert.strictEqual(rK.result, 0, 'a staged degreeBound must NOT move the verifier parameters (F4)');
  assert.strictEqual(hostK.state.getRoot(), rootBeforeK, 'a staged degreeBound must leave the root unmoved');
  console.log('');

  // 6) DETERMINISM: two independent nodes run the genuine call → the same root.
  const n1 = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
  const n2 = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
  const i1 = n1.deploy(genuine, [7], { zkHost: true }).id;
  const i2 = n2.deploy(genuine, [7], { zkHost: true }).id;
  const o1 = await n1.call(i1, 'check', [], { zk: stagedZk });
  const o2 = await n2.call(i2, 'check', [], { zk: stagedZk });
  line('node1 root === node2 root', n1.state.getRoot() === n2.state.getRoot());
  assert.strictEqual(o1.result, o2.result, 'same staged proof → same verdict on both nodes');
  assert.strictEqual(n1.state.getRoot(), n2.state.getRoot(), 'same gated call → same root on both nodes');
  console.log('');

  const srcHash = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  line('content address (sha256 of file)', srcHash);
  console.log('\n✅ PASS — a contract verified a coordinate/curve ZK proof and gated Verkle state on it');
  console.log('   root moved on the verified coordinate, stayed unmoved on the tampered one, and the');
  console.log(`   unflagged import was denied (${denied} refusal).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('\n❌ FAIL —', e.message); process.exit(1); });
