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
import { compile } from '@xmbl/lng';
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

console.log(`\nXCL composition from LNG: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
