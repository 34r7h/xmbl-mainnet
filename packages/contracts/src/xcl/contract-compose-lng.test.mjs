// XCL composition from LNG SOURCE — the `~u256` word form of the composition ABI, compiled from
// `~contract` source by @xmbl/lng rather than hand-encoded. This closes T6.2 remainder (b)'s first
// half: `xmbl.coord.send` is now EMITTED by the compiler and lowered to the real env.xmbl_send host
// import, carrying a FULL 256-bit value across the message boundary.
//
// These prove OUTCOMES, not the mechanism:
//   1. an LNG contract's `xmbl.coord.send(peer, amount)` delivers a message to a peer LNG contract,
//      whose persisted `~u256` field becomes EXACTLY the sent amount — and the amount exceeds 2^64,
//      so it proves the word value crossed intact, NOT truncated to i32/i64 (the send-idx-after-
//      state-imports path: compiled { hostState, compose });
//   2. the same works with compose as the ONLY import (send at index 0: compiled { compose });
//   3. an out-of-range peer index makes xmbl_send return -1 and enqueues NO frame (fail-safe).
import assert from 'node:assert';
import { compile, contractFields } from '@xmbl/lng';
import { ComputeRuntime } from '@xmbl/storage-compute';
import { ContractHost } from './index.js';

let pass = 0, fail = 0;
const check = async (n, f) => {
  try { await f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; }
};

// RECEIVER: a plain LNG contract whose `take(amount)` persists the amount into its `got` field.
const RECEIVER_SRC = "~contract `R {\n  ~state { ~public { `got ~u256 0 } }\n  ~on `take(`amount ~u256) { `got = `amount }\n}";
// SENDER (stateful): records the amount in `sent`, then messages peer 0. Compiled { hostState,
// compose } so env.xmbl_send sits at import index 2 (just above the two state imports).
const SENDER_SRC = "~contract `S {\n  ~state { ~public { `sent ~u256 0 } }\n  ~on `fire(`amount ~u256) { `sent = `amount\n `xmbl.coord.send(0, `amount) }\n}";
// SENDER2 (stateless): only messages peer 0. Compiled { compose } so env.xmbl_send is the ONLY
// import, at index 0 — exercising the other side of the index arithmetic.
const SENDER2_SRC = "~contract `S2 {\n  ~on `fire(`amount ~u256) { `xmbl.coord.send(0, `amount) }\n}";
// SENDER_BAD: messages a peer index that is not linked → xmbl_send returns -1, no frame enqueued.
const SENDER_BAD_SRC = "~contract `SB {\n  ~on `fire(`amount ~u256) { `xmbl.coord.send(5, `amount) }\n}";
// SENDER_HIMASK: messages peer index 2^32 (0x1_0000_0000). Its LOW 32 bits are 0 — a VALID peer
// index — so a host that masked the index to its low limb would FAIL OPEN and deliver to peer 0.
// The full-word range check must reject it instead. 2^32 is under Number.MAX_SAFE_INTEGER, so the
// source literal is exact.
const SENDER_HIMASK_SRC = "~contract `SH {\n  ~on `fire(`amount ~u256) { `xmbl.coord.send(4294967296, `amount) }\n}";

const newHost = () => new ContractHost({ runtime: new ComputeRuntime({ maxTime: 8000 }) });

// A value that exceeds 2^64 (and 2^32) so a truncated payload could NOT equal it — the fidelity pin.
const BIG = (1n << 100n) + 7n;

await check('LNG `xmbl.coord.send` delivers the FULL 256-bit amount to a peer LNG contract (send idx 2)', async () => {
  const host = newHost();
  const receiver = compile(RECEIVER_SRC, { hostState: true });
  const sender = compile(SENDER_SRC, { hostState: true, compose: true });
  const { id: receiverId } = host.deploy(receiver, [], { byteState: true, wordAbi: true });
  const { id: senderId } = host.deploy(sender, [], { byteState: true, wordAbi: true, composeHost: true });
  host.link(senderId, { peers: [{ id: receiverId, fn: 'take' }] });

  const out = await host.call(senderId, 'fire', [BIG], { caller: 0 });

  assert.strictEqual(out.frames, 2, `the cascade ran sender→receiver (got ${out.frames} frames)`);
  assert.strictEqual(host.getBytes(receiverId, 'got'), BIG, 'the peer received the EXACT 256-bit amount (no i32/i64 truncation)');
  assert.strictEqual(host.getBytes(senderId, 'sent'), BIG, "the sender's own `~u256` state persisted");
});

await check('compose works as the ONLY import (send idx 0): stateless LNG sender still delivers', async () => {
  const host = newHost();
  const receiver = compile(RECEIVER_SRC, { hostState: true });
  const sender = compile(SENDER2_SRC, { compose: true });
  const { id: receiverId } = host.deploy(receiver, [], { byteState: true, wordAbi: true });
  const { id: senderId } = host.deploy(sender, [], { wordAbi: true, composeHost: true });
  host.link(senderId, { peers: [{ id: receiverId, fn: 'take' }] });

  const out = await host.call(senderId, 'fire', [BIG], { caller: 0 });

  assert.strictEqual(out.frames, 2, `delivered in 2 frames (got ${out.frames})`);
  assert.strictEqual(host.getBytes(receiverId, 'got'), BIG, 'the peer received the exact amount via the index-0 send import');
});

await check('an out-of-range peer index makes xmbl_send a no-op (-1), enqueuing NO frame', async () => {
  const host = newHost();
  const receiver = compile(RECEIVER_SRC, { hostState: true });
  const senderBad = compile(SENDER_BAD_SRC, { compose: true });
  const { id: receiverId } = host.deploy(receiver, [], { byteState: true, wordAbi: true });
  const { id: senderId } = host.deploy(senderBad, [], { wordAbi: true, composeHost: true });
  host.link(senderId, { peers: [{ id: receiverId, fn: 'take' }] });   // only peer 0 exists; source sends to 5

  const out = await host.call(senderId, 'fire', [BIG], { caller: 0 });

  assert.strictEqual(out.frames, 1, 'no second frame was enqueued for the out-of-range peer');
  assert.strictEqual(host.getBytes(receiverId, 'got'), 0n, 'the peer was never messaged');
});

await check('a peer index with nonzero HIGH bits is rejected, not masked to a valid low-limb peer', async () => {
  const host = newHost();
  const receiver = compile(RECEIVER_SRC, { hostState: true });
  const senderHi = compile(SENDER_HIMASK_SRC, { compose: true });
  const { id: receiverId } = host.deploy(receiver, [], { byteState: true, wordAbi: true });
  const { id: senderId } = host.deploy(senderHi, [], { wordAbi: true, composeHost: true });
  host.link(senderId, { peers: [{ id: receiverId, fn: 'take' }] });   // peer 0 exists; source sends to 2^32

  const out = await host.call(senderId, 'fire', [BIG], { caller: 0 });

  assert.strictEqual(out.frames, 1, 'no frame was enqueued — the high-limb index was NOT masked to peer 0');
  assert.strictEqual(host.getBytes(receiverId, 'got'), 0n, 'peer 0 was never messaged by the masked-away index');
});

await check('linking a word-ABI sender to an i32-ABI peer is rejected at wiring time (no opaque runtime trap)', async () => {
  const host = newHost();
  const receiver = compile(RECEIVER_SRC, { hostState: true });
  const sender = compile(SENDER2_SRC, { compose: true });
  const { id: receiverId } = host.deploy(receiver, [], { byteState: true });   // deployed as an i32-ABI peer (no wordAbi)
  const { id: senderId } = host.deploy(sender, [], { wordAbi: true, composeHost: true });

  assert.throws(
    () => host.link(senderId, { peers: [{ id: receiverId, fn: 'take' }] }),
    /ABI mismatch/,
    'link() rejects a word sender wired to an i32 peer',
  );
});

// READER: reads peer 0's field 0 synchronously and mirrors it into its own `~u256` field. No
// message is sent, so the read adds NO frame — it returns the peer's committed word in-line.
const READER_SRC = "~contract `RD {\n  ~state { ~public { `mirror ~u256 0 } }\n  ~on `pull() { `mirror = `xmbl.coord.read(0, 0) }\n}";
// HOLDER2: two public fields with setters, so a reader can read field 0 AND field 1.
const HOLDER2_SRC = "~contract `H2 {\n  ~state { ~public { `a ~u256 0\n `b ~u256 0 } }\n  ~on `seta(`v ~u256) { `a = `v }\n  ~on `setb(`v ~u256) { `b = `v }\n}";
// TWOREADS: two reads in ONE expression (the alias discriminator) — sums peer field 0 and field 1.
const TWOREADS_SRC = "~contract `TW {\n  ~state { ~public { `mirror ~u256 0 } }\n  ~on `pull() { `mirror = `xmbl.coord.read(0, 0) + `xmbl.coord.read(0, 1) }\n}";

await check('LNG `xmbl.coord.read` returns a peer LNG contract\'s FULL 256-bit committed field (no new frame)', async () => {
  const host = newHost();
  const receiver = compile(RECEIVER_SRC, { hostState: true });
  const reader = compile(READER_SRC, { hostState: true, compose: true });
  const { id: receiverId } = host.deploy(receiver, [], { byteState: true, wordAbi: true, fields: contractFields(RECEIVER_SRC) });
  const { id: readerId } = host.deploy(reader, [], { byteState: true, wordAbi: true, composeHost: true, fields: contractFields(READER_SRC) });
  host.link(readerId, { peers: [{ id: receiverId, fn: 'take' }], reads: [[0, 0]] });

  await host.call(receiverId, 'take', [BIG], { caller: 0 });   // commit receiver.got = BIG
  const out = await host.call(readerId, 'pull', [], { caller: 0 });

  assert.strictEqual(out.frames, 1, `a synchronous read runs NO peer code — one frame (got ${out.frames})`);
  assert.strictEqual(host.getBytes(readerId, 'mirror'), BIG, 'the reader mirrored the peer\'s EXACT 256-bit field (result-pointer marshalling, no truncation)');
});

await check('two reads in ONE expression land DISTINCT values (the result buffers do not alias)', async () => {
  const host = newHost();
  const holder = compile(HOLDER2_SRC, { hostState: true });
  const tw = compile(TWOREADS_SRC, { hostState: true, compose: true });
  const { id: holderId } = host.deploy(holder, [], { byteState: true, wordAbi: true, fields: contractFields(HOLDER2_SRC) });
  const { id: twId } = host.deploy(tw, [], { byteState: true, wordAbi: true, composeHost: true, fields: contractFields(TWOREADS_SRC) });
  host.link(twId, { peers: [{ id: holderId, fn: 'seta' }], reads: [[0, 0], [0, 1]] });

  await host.call(holderId, 'seta', [BIG], { caller: 0 });   // a = BIG
  await host.call(holderId, 'setb', [5n], { caller: 0 });    // b = 5  (distinct, so aliasing would give 2·a or 2·b)
  const out = await host.call(twId, 'pull', [], { caller: 0 });

  assert.strictEqual(out.frames, 1, 'both reads are synchronous — still one frame');
  assert.strictEqual(host.getBytes(twId, 'mirror'), BIG + 5n, 'mirror == field0 + field1 (buffers distinct; no clobber)');
});

await check('the peer field list is DERIVED from source (declaration order), so index 0 reads `a`, not `b` (no transposition)', async () => {
  // The two-reads test cannot catch a transposed field list: read(0,0)+read(0,1) is commutative, so
  // swapping a/b leaves the sum unchanged. This pins the direction — index 0 must resolve to the
  // FIRST declared field. contractFields is derived from source, so the operator cannot mis-order it.
  assert.deepStrictEqual(contractFields(HOLDER2_SRC), ['a', 'b'], 'derived field list is exactly the declaration order');

  const host = newHost();
  const holder = compile(HOLDER2_SRC, { hostState: true });
  const reader = compile(READER_SRC, { hostState: true, compose: true });   // reads peer field 0 into `mirror`
  const { id: holderId } = host.deploy(holder, [], { byteState: true, wordAbi: true, fields: contractFields(HOLDER2_SRC) });
  const { id: readerId } = host.deploy(reader, [], { byteState: true, wordAbi: true, composeHost: true, fields: contractFields(READER_SRC) });
  host.link(readerId, { peers: [{ id: holderId, fn: 'seta' }], reads: [[0, 0]] });

  await host.call(holderId, 'seta', [BIG], { caller: 0 });   // a (field 0) = BIG
  await host.call(holderId, 'setb', [5n], { caller: 0 });    // b (field 1) = 5  — distinct, so a swap would surface
  const out = await host.call(readerId, 'pull', [], { caller: 0 });

  assert.strictEqual(out.frames, 1, 'synchronous read — one frame');
  assert.strictEqual(host.getBytes(readerId, 'mirror'), BIG, 'index 0 resolved to `a` (BIG), NOT `b` (5) — the derived order is authoritative');
});

await check('an UNDECLARED foreign read TRAPS and reverts the whole call (fail-closed, not a silent zero)', async () => {
  const host = newHost();
  const receiver = compile(RECEIVER_SRC, { hostState: true });
  const reader = compile(READER_SRC, { hostState: true, compose: true });
  const { id: receiverId } = host.deploy(receiver, [], { byteState: true, wordAbi: true, fields: contractFields(RECEIVER_SRC) });
  const { id: readerId } = host.deploy(reader, [], { byteState: true, wordAbi: true, composeHost: true, fields: contractFields(READER_SRC) });
  host.link(readerId, { peers: [{ id: receiverId, fn: 'take' }], reads: [] });   // source reads (0,0) but NOTHING is declared

  await host.call(receiverId, 'take', [BIG], { caller: 0 });
  await assert.rejects(host.call(readerId, 'pull', [], { caller: 0 }), /undeclared foreign read|denied|revert|trap|unreachable/i,
    'the undeclared read reverts the cascade');
  assert.strictEqual(host.getBytes(readerId, 'mirror'), 0n, 'nothing was committed — the reader never mirrored anything');
});

await check('link() rejects a word-read with an out-of-range field index, and a peer with no declared fields', async () => {
  const receiver = compile(RECEIVER_SRC, { hostState: true });
  const reader = compile(READER_SRC, { hostState: true, compose: true });

  // case A: peer with fields ['got'] (1 field) — index 5 is out of range.
  const hostA = newHost();
  const { id: rcvA } = hostA.deploy(receiver, [], { byteState: true, wordAbi: true, fields: contractFields(RECEIVER_SRC) });
  const { id: rdA } = hostA.deploy(reader, [], { byteState: true, wordAbi: true, composeHost: true, fields: contractFields(READER_SRC) });
  assert.throws(() => hostA.link(rdA, { peers: [{ id: rcvA, fn: 'take' }], reads: [[0, 5]] }),
    /field index 5 is out of range/, 'out-of-range field index refused at wiring time');

  // case B: peer deployed WITHOUT a field list — a word read cannot resolve a field index against
  // it. A fresh host so the no-fields deploy is that content-addressed id's only record.
  const hostB = newHost();
  const { id: rcvB } = hostB.deploy(receiver, [], { byteState: true, wordAbi: true });   // NO fields
  const { id: rdB } = hostB.deploy(reader, [], { byteState: true, wordAbi: true, composeHost: true, fields: contractFields(READER_SRC) });
  assert.throws(() => hostB.link(rdB, { peers: [{ id: rcvB, fn: 'take' }], reads: [[0, 0]] }),
    /declared no field list/, 'a read against a field-less peer is refused');
});

// RECEIVER2: a two-argument entrypoint that persists EACH arg into its own field — so a test can
// prove both crossed intact AND in order (a swap or a truncation would surface, which a sum hides).
const RECEIVER2_SRC = "~contract `R2 {\n  ~state { ~public { `first ~u256 0\n `second ~u256 0 } }\n  ~on `take2(`a ~u256, `b ~u256) { `first = `a\n `second = `b }\n}";
// SENDER_MULTI: forwards TWO ~u256 arguments to peer 0 in ONE message.
const SENDER_MULTI_SRC = "~contract `SM {\n  ~on `fire(`a ~u256, `b ~u256) { `xmbl.coord.send(0, `a, `b) }\n}";

await check('a MULTI-ARG message delivers TWO distinct 256-bit args intact and in order (one frame per message, not per arg)', async () => {
  const host = newHost();
  const receiver2 = compile(RECEIVER2_SRC, { hostState: true });
  const senderMulti = compile(SENDER_MULTI_SRC, { compose: true });
  const { id: rId } = host.deploy(receiver2, [], { byteState: true, wordAbi: true, fields: contractFields(RECEIVER2_SRC) });
  const { id: sId } = host.deploy(senderMulti, [], { wordAbi: true, composeHost: true });
  host.link(sId, { peers: [{ id: rId, fn: 'take2' }] });

  const A = (1n << 130n) + 9n;   // > 2^64 and distinct from B — a swap or i64 truncation would fail
  const B = (1n << 70n) + 11n;
  const out = await host.call(sId, 'fire', [A, B], { caller: 0 });

  assert.strictEqual(out.frames, 2, `the whole message is ONE frame regardless of arg count (got ${out.frames})`);
  assert.strictEqual(host.getBytes(rId, 'first'), A, 'arg 0 arrived as the EXACT 256-bit word (not truncated, not the second arg)');
  assert.strictEqual(host.getBytes(rId, 'second'), B, 'arg 1 arrived as the EXACT 256-bit word, in order (contiguous arg block, no clobber)');
});

console.log(`\nXCL composition from LNG: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
