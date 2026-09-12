// XCL composition — contract-to-contract interaction with reentrancy IMPOSSIBLE BY DESIGN.
//
// The mandate: XMBL contracts must be at least as powerful and secure as Ethereum. Composition
// (a contract using another contract) is the power; reentrancy safety is the security. EVM couples
// the two — synchronous nested CALL gives composition AND the reentrancy footgun that every drained
// contract forgot to guard (the DAO). XCL decouples them:
//   - synchronous cross-contract READ (xmbl_read): executes NO peer code, so it is reentrancy-free
//     and served from pre-staged state — this is balanceOf/oracle/allowance, the usable-composition case;
//   - asynchronous message SEND (xmbl_send): the peer runs as a SEPARATE frame AFTER the sender
//     completes, never nested — so a contract can NEVER yield control to another mid-execution.
// There is no primitive by which the DAO pattern (call out → get re-entered before state updates)
// can even be expressed. This is not a library guard a developer can forget; it is the architecture.
//
// These prove the OUTCOMES, not the mechanism:
//   1. the canonical DAO-vulnerable withdraw (send BEFORE zeroing balance) CANNOT be drained;
//   2. a synchronous cross-contract read returns the peer's real state and the caller uses it;
//   3. a read outside the declared footprint traps (fail-closed);
//   4. a non-terminating message cascade hits the frame cap and REVERTS wholly (no partial commit);
//   5. any frame that throws reverts the WHOLE cascade — no earlier frame's writes land.
import assert from 'node:assert';
import { ComputeRuntime } from '@xmbl/storage-compute';
import { ContractHost, slotKey } from './index.js';

let pass = 0, fail = 0;
const check = async (n, f) => {
  try { await f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; }
};

// ── Minimal WASM encoders (self-contained, same style as compute.test.mjs). ──────────────────
const HDR = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const I32 = 0x7f;
const uleb = (n) => { const b = []; let v = n; do { let x = v & 0x7f; v = Math.floor(v / 128); if (v > 0) x |= 0x80; b.push(x); } while (v > 0); return b; };
const sleb = (n) => {
  const b = []; let more = true; let val = n | 0;
  while (more) {
    let byte = val & 0x7f; val >>= 7;
    if ((val === 0 && (byte & 0x40) === 0) || (val === -1 && (byte & 0x40) !== 0)) more = false; else byte |= 0x80;
    b.push(byte & 0xff);
  }
  return b;
};
const wname = (s) => [...uleb(s.length), ...Array.from(s, (c) => c.charCodeAt(0))];
const sect = (id, body) => [id, ...uleb(body.length), ...body];
const vec = (items) => [...uleb(items.length), ...items.flat()];
const ftype = (params, results) => [0x60, ...uleb(params.length), ...params, ...uleb(results.length), ...results];
const func = (localGroups, instrs) => {
  const locals = [...uleb(localGroups.length)];
  for (const [cnt, ty] of localGroups) locals.push(...uleb(cnt), ty);
  const body = [...locals, ...instrs, 0x0b];
  return [...uleb(body.length), ...body];
};
const imp = (mod, nm, typeIdx) => [...wname(mod), ...wname(nm), 0x00, ...uleb(typeIdx)];
const exp = (nm, funcIdx) => [...wname(nm), 0x00, ...uleb(funcIdx)];
const B = (...b) => Uint8Array.from(b);
const mod = (...sections) => Uint8Array.from([...HDR, ...sections.flat()]);
// opcode shorthands
const I32C = (n) => [0x41, ...sleb(n)];
const GET = (i) => [0x20, ...uleb(i)];
const SET = (i) => [0x21, ...uleb(i)];
const CALL = (i) => [0x10, ...uleb(i)];
const ADD = 0x6a, DROP = 0x1a, IF = [0x04, 0x40], END = 0x0b, UNREACHABLE = 0x00;

// t_g = (i32)->i32 [verkle_get, xmbl_read as (i32,i32)->i32 uses t_gs], t_gs = (i32,i32)->i32
// [verkle_set, xmbl_send, xmbl_read], t_1v = (i32)->() [withdraw/receive/go/set], t_1r = (i32)->i32
// [read], t_0v = ()->() [boom].
const T_G = ftype([I32], [I32]);        // idx 0 where used
const T_GS = ftype([I32, I32], [I32]);
const T_1V = ftype([I32], []);
const T_1R = ftype([I32], [I32]);
const T_0V = ftype([], []);

// VAULT.withdraw(_:i32): the DAO-vulnerable ordering — read balance, SEND it out, THEN zero it.
//   bal = get(0); if bal != 0 { send(peer0, bal); set(1, get(1)+bal); set(0, 0) }
// imports: verkle_get(0), verkle_set(1), xmbl_send(2). slot0 = balance, slot1 = cumulative payout.
const VAULT = mod(
  sect(1, vec([T_G, T_GS, T_1V])),
  sect(2, vec([imp('env', 'xmbl_verkle_get', 0), imp('env', 'xmbl_verkle_set', 1), imp('env', 'xmbl_send', 1)])),
  sect(3, vec([[2]])),                      // func3 : type T_1V
  sect(7, vec([exp('withdraw', 3)])),
  sect(10, vec([func([[1, I32]], [        // local1 = bal
    ...I32C(0), ...CALL(0), ...SET(1),      // bal = get(0)
    ...GET(1), ...IF,                        // if bal != 0
      ...I32C(0), ...GET(1), ...CALL(2), DROP, // send(peer0, bal)   ← BEFORE state update (vulnerable order)
      ...I32C(1), ...I32C(1), ...CALL(0), ...GET(1), ADD, ...CALL(1), DROP, // set(1, get(1)+bal)
      ...I32C(0), ...I32C(0), ...CALL(1), DROP, // set(0, 0)  ← balance zeroed AFTER the send
    END,
  ].flat())])),
);

// ATTACKER.receive(amount:i32): RECORD what it was paid (slot0 = amount), then immediately re-enter
// the vault. Recording the amount pins the message PAYLOAD — a cascade that ran 3 frames but carried
// a zeroed amount would leave slot0 = 0, so the test's payout assertion cannot pass for the wrong
// reason. imports: verkle_set(0), xmbl_send(1).
//   set(0, amount); send(peer0 /* vault.withdraw */, amount)
const ATTACKER = mod(
  sect(1, vec([T_GS, T_1V])),
  sect(2, vec([imp('env', 'xmbl_verkle_set', 0), imp('env', 'xmbl_send', 0)])),
  sect(3, vec([[1]])),                      // func2 : type T_1V
  sect(7, vec([exp('receive', 2)])),
  sect(10, vec([func([], [
    ...I32C(0), ...GET(0), ...CALL(0), DROP, // set(0, amount) — record the payout observed
    ...I32C(0), ...GET(0), ...CALL(1), DROP, // send(peer0, amount)
  ].flat())])),
);

// PING(setVal).go(_:i32): write slot0=setVal, then message peer0 — a non-terminating cross-contract
// cycle when two are linked to each other. imports: verkle_set(0), xmbl_send(1).
const PING = (setVal) => mod(
  sect(1, vec([T_GS, T_1V])),
  sect(2, vec([imp('env', 'xmbl_verkle_set', 0), imp('env', 'xmbl_send', 0)])),
  sect(3, vec([[1]])),
  sect(7, vec([exp('go', 2)])),
  sect(10, vec([func([], [
    ...I32C(0), ...I32C(setVal), ...CALL(0), DROP, // set(0, setVal)
    ...I32C(0), ...I32C(0), ...CALL(1), DROP,       // send(peer0, 0)
  ].flat())])),
);
const PINGA = PING(1), PINGB = PING(2);

// THROWER.boom(): traps. A message target that reverts its frame. imports: none.
const THROWER = mod(
  sect(1, vec([T_0V])),
  sect(3, vec([[0]])),
  sect(7, vec([exp('boom', 0)])),
  sect(10, vec([func([], [UNREACHABLE])])),
);

// SENDER.go(_:i32): write slot0=7, then message peer0 (the thrower). If the cascade is NOT atomic,
// the slot0=7 write would survive the peer's trap. imports: verkle_set(0), xmbl_send(1).
const SENDER = mod(
  sect(1, vec([T_GS, T_1V])),
  sect(2, vec([imp('env', 'xmbl_verkle_set', 0), imp('env', 'xmbl_send', 0)])),
  sect(3, vec([[1]])),
  sect(7, vec([exp('go', 2)])),
  sect(10, vec([func([], [
    ...I32C(0), ...I32C(7), ...CALL(0), DROP,  // set(0, 7)
    ...I32C(0), ...I32C(0), ...CALL(1), DROP,  // send(peer0 /* thrower */, 0)
  ].flat())])),
);

// SOURCE.set(v:i32): slot0 = v. A plain slot contract another contract reads from. imports: verkle_set(0).
const SOURCE = mod(
  sect(1, vec([T_GS, T_1V])),
  sect(2, vec([imp('env', 'xmbl_verkle_set', 0)])),
  sect(3, vec([[1]])),
  sect(7, vec([exp('set', 1)])),
  sect(10, vec([func([], [
    ...I32C(0), ...GET(0), ...CALL(0), DROP,   // set(0, v)
  ].flat())])),
);

// READER.read(_:i32)->i32: return xmbl_read(peer0, slot). A synchronous cross-contract read.
// READER reads the DECLARED [0,0]; READER_BAD reads the UNDECLARED [0,5] → traps. imports: xmbl_read(0).
const mkReader = (slot) => mod(
  sect(1, vec([T_GS, T_1R])),
  sect(2, vec([imp('env', 'xmbl_read', 0)])),
  sect(3, vec([[1]])),                        // func1 : type T_1R (i32)->i32
  sect(7, vec([exp('read', 1)])),
  sect(10, vec([func([], [
    ...I32C(0), ...I32C(slot), ...CALL(0),     // return read(peer0, slot)
  ].flat())])),
);
const READER = mkReader(0), READER_BAD = mkReader(5);

const newHost = () => new ContractHost({ runtime: new ComputeRuntime({ maxTime: 4000 }) });

// ── 1. The un-drainable DAO. ──────────────────────────────────────────────────────────────────
await check('the DAO-vulnerable withdraw (send before zeroing) CANNOT be drained — one payout, not two', async () => {
  const host = newHost();
  const { id: vaultId } = host.deploy(VAULT, [0, 1], { composeHost: true });
  const { id: attackerId } = host.deploy(ATTACKER, [], { composeHost: true });
  host.link(vaultId, { peers: [{ id: attackerId, fn: 'receive' }] });    // vault pays peer0 = attacker.receive
  host.link(attackerId, { peers: [{ id: vaultId, fn: 'withdraw' }] });   // attacker re-enters peer0 = vault.withdraw
  await host.state.insert(slotKey(vaultId, 0), 100);                     // vault balance = 100

  const out = await host.call(vaultId, 'withdraw', [0]);

  // The attacker's re-entry ran (frames: vault → attacker → vault), but the second vault frame read
  // the balance the FIRST frame had already zeroed (read-your-writes across frames), so the payout
  // branch fired exactly ONCE. On EVM the identical ordering drains the vault to zero over N re-entries.
  assert.strictEqual(out.frames, 3, `the cascade ran vault→attacker→vault (got ${out.frames} frames)`);
  // The re-entry was REAL, not a no-op: the attacker's frame observed a payload of exactly 100 (it
  // recorded what it was paid), and its re-entrant withdraw ran a third frame. What neutralized the
  // drain was read-your-writes — not the message being empty. This pins the payload so the payout
  // assertion below cannot pass for the wrong reason (a silently-zeroed send would leave this 0).
  assert.strictEqual(host.getSlot(attackerId, 0), 100, 'the attacker was paid the real balance (100) and re-entered with it');
  assert.strictEqual(host.getSlot(vaultId, 1), 100, 'cumulative payout is the SINGLE withdrawal (100), not a drain (200)');
  assert.strictEqual(host.getSlot(vaultId, 0), 0, 'the balance was zeroed exactly once');
});

// ── 2. Synchronous cross-contract read (the composition-power primitive). ───────────────────────
await check('a contract synchronously READS another contract’s state and returns it (balanceOf-style composition)', async () => {
  const host = newHost();
  const { id: sourceId } = host.deploy(SOURCE, [0]);
  const { id: readerId } = host.deploy(READER, [], { composeHost: true });
  host.link(readerId, { peers: [{ id: sourceId, fn: 'set' }], reads: [[0, 0]] });

  await host.call(sourceId, 'set', [42]);
  const out = await host.call(readerId, 'read', [0]);
  assert.strictEqual(out.result, 42, 'reader observed the source’s committed slot 0 synchronously');
});

// ── 3. Reads are fenced to the declared footprint. ─────────────────────────────────────────────
await check('a read OUTSIDE the declared footprint traps (fail-closed) — the footprint is statically bounded', async () => {
  const host = newHost();
  const { id: sourceId } = host.deploy(SOURCE, [0]);
  const { id: readerBadId } = host.deploy(READER_BAD, [], { composeHost: true });
  host.link(readerBadId, { peers: [{ id: sourceId, fn: 'set' }], reads: [[0, 0]] }); // declares [0,0], reads [0,5]

  await assert.rejects(() => host.call(readerBadId, 'read', [0]), /undeclared foreign read/);
});

// ── 4. A non-terminating cascade reverts at the frame cap (bounded, never a partial commit). ────
await check('an unbounded message cascade hits the frame cap and REVERTS wholly (no partial commit)', async () => {
  const host = newHost();
  const { id: aId } = host.deploy(PINGA, [0], { composeHost: true });
  const { id: bId } = host.deploy(PINGB, [0], { composeHost: true });
  host.link(aId, { peers: [{ id: bId, fn: 'go' }] });
  host.link(bId, { peers: [{ id: aId, fn: 'go' }] });

  await assert.rejects(() => host.call(aId, 'go', [0], { maxFrames: 8 }), /exceeded 8 frames/);
  // The cascade was refused as a whole — neither contract's slot write landed.
  assert.strictEqual(host.getSlot(aId, 0), 0, 'A’s write reverted with the cascade');
  assert.strictEqual(host.getSlot(bId, 0), 0, 'B’s write reverted with the cascade');
});

// ── 5. A throw in any frame reverts the whole transaction. ──────────────────────────────────────
await check('a frame that throws reverts the WHOLE cascade — an earlier frame’s writes do not land', async () => {
  const host = newHost();
  const { id: throwerId } = host.deploy(THROWER, []);
  const { id: senderId } = host.deploy(SENDER, [0], { composeHost: true });
  host.link(senderId, { peers: [{ id: throwerId, fn: 'boom' }] });

  await assert.rejects(() => host.call(senderId, 'go', [0]), /WASM execution failed|unreachable|failed/i);
  assert.strictEqual(host.getSlot(senderId, 0), 0, 'the sender’s slot0=7 write reverted when the thrower’s frame trapped');
});

console.log(`\nXCL composition: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
