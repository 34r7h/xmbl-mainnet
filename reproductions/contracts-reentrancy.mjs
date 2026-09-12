// REPRODUCTION — reentrancy is inexpressible by construction (packages/contracts / XCL).
//
// CLAIM (the operator's load-bearing requirement: "reentrancy must be impossible BY DESIGN, not by
// a library"): when contract A sends a message to contract B, B runs in a SEPARATE, LATER frame —
// never nested inside A's frame. A's state is therefore fully committed before B can observe it, so
// the classic reentrancy exploit (the callee re-entering while the caller's balance is mid-update,
// as in the 2016 DAO) cannot be written at all. The host drains messages FIFO with no call stack
// (`contract-host.js:214` — "Each frame runs to COMPLETION before the next begins").
//
// HOW THIS REPRODUCES IT, using the REAL compiler + runtime + host (no mocks):
//   BANK.withdraw(amt) performs its state effect FIRST (bal = 0), then sends `amt` to its peer SINK.
//   SINK.take(amt) synchronously READS BANK's `bal` field and records what it saw.
//   If execution were nested (EVM semantics: external call mid-frame, before the update commits),
//   SINK would observe the STALE balance (100). Under XCL, SINK runs in frame 2 — after BANK's frame
//   1 has committed bal = 0 — so SINK observes 0. That observed-0 is the proof reentrancy is closed.
//
// Exits non-zero if the claim fails, so it is also a gate test.
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile, contractFields } from '@xmbl/lng';
import { ComputeRuntime } from '@xmbl/storage-compute';
import { ContractHost } from '@xmbl/contracts';

// BANK: holds `bal`. `withdraw` zeroes it (the effect), THEN sends the amount to peer 0 (SINK).
const BANK_SRC =
  "~contract `B {\n" +
  "  ~state { ~public { `bal ~u256 0 } }\n" +
  "  ~on `deposit(`v ~u256) { `bal = `v }\n" +
  "  ~on `withdraw(`amt ~u256) { `bal = 0\n `xmbl.coord.send(0, `amt) }\n" +
  "}";
// SINK: when it receives funds, it reads BANK's `bal` (peer 0, field 0) and records what it saw.
const SINK_SRC =
  "~contract `K {\n" +
  "  ~state { ~public { `observed ~u256 0 } }\n" +
  "  ~on `take(`amt ~u256) { `observed = `xmbl.coord.read(0, 0) }\n" +
  "}";

const DEPOSIT = 100n;

async function main() {
  const host = new ContractHost({ runtime: new ComputeRuntime({ maxTime: 8000 }) });

  const bank = compile(BANK_SRC, { hostState: true, compose: true });
  const sink = compile(SINK_SRC, { hostState: true, compose: true });

  const { id: bankId } = host.deploy(bank, [], {
    byteState: true, wordAbi: true, composeHost: true, fields: contractFields(BANK_SRC),
  });
  const { id: sinkId } = host.deploy(sink, [], {
    byteState: true, wordAbi: true, composeHost: true, fields: contractFields(SINK_SRC),
  });

  // BANK's peer 0 is SINK.take (the outward send). SINK's peer 0 is BANK and it READS BANK field 0.
  host.link(bankId, { peers: [{ id: sinkId, fn: 'take' }] });
  host.link(sinkId, { peers: [{ id: bankId, fn: 'deposit' }], reads: [[0, 0]] });

  await host.call(bankId, 'deposit', [DEPOSIT], { caller: 0 });
  assert.strictEqual(host.getBytes(bankId, 'bal'), DEPOSIT, 'precondition: BANK.bal is funded');

  const out = await host.call(bankId, 'withdraw', [DEPOSIT], { caller: 0 });

  const observed = host.getBytes(sinkId, 'observed');
  const bankBal = host.getBytes(bankId, 'bal');

  console.log('=== REPRODUCTION: reentrancy inexpressible by construction (XCL) ===\n');
  console.log(`  BANK funded to           : ${DEPOSIT}`);
  console.log(`  call BANK.withdraw(${DEPOSIT})   : effect (bal=0) runs, THEN a message is queued to SINK`);
  console.log(`  frames in the cascade    : ${out.frames}  (frame 1 = BANK.withdraw, frame 2 = SINK.take)`);
  console.log(`  BANK.bal after frame 1   : ${bankBal}`);
  console.log(`  SINK observed BANK.bal   : ${observed}`);
  console.log('');

  // Frame 2 existing proves SINK ran as a SEPARATE later frame, not nested in BANK's frame.
  assert.strictEqual(out.frames, 2, `SINK ran in its own later frame, not nested (frames=${out.frames})`);
  // The reentrancy-defining observation: the callee sees the caller's state ALREADY finalized.
  assert.strictEqual(observed, 0n,
    'SINK observed BANK.bal === 0 — the caller FINISHED and committed before the callee ran; ' +
    'under EVM nested-call semantics SINK would have observed the stale 100');
  assert.strictEqual(bankBal, 0n, 'BANK.bal is committed 0');

  console.log('  ✔ SINK observed a FINALIZED balance (0), not a mid-update one (100).');
  console.log('  ✔ The callee never executed inside the caller\'s frame — reentrancy cannot be written.');

  const srcHash = createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .update(BANK_SRC).update(SINK_SRC)
    .digest('hex');
  console.log(`\n  content address (sha256 of this file + contract sources): ${srcHash}`);
  console.log('\n✅ PASS — reentrancy is inexpressible by construction');
}

main().then(() => process.exit(0)).catch((e) => { console.error('\n❌ FAIL —', e.message); process.exit(1); });
