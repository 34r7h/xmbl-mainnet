// The mainnet safety gate must be a real refusal, not a comment. While the protocol's
// ⛔ AUDIT gates are open (AUDIT_GATES_OPEN === true), an XMBL_PROFILE=mainnet boot MUST
// throw — with NO environment override — and any non-mainnet profile must be unaffected.
// We stub the network so the test exercises the gate, not libp2p.
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMBLCore, AUDIT_GATES_OPEN } from './index.js';

let pass = 0, fail = 0;
const check = async (n, f) => {
  try { await f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; }
};

// A node whose xn.start throws a SENTINEL, so start() reaches the gate and, if the gate
// passes, hits the sentinel just past it — proving "got past the gate". DB paths go to a
// temp dir so the constructor doesn't write under cwd.
const SENTINEL = 'GATE-PASSED-SENTINEL';
function nodeWithStubNet() {
  const dir = mkdtempSync(join(tmpdir(), 'xmbl-bootgate-'));
  const node = new XMBLCore({
    ledger: { dbPath: join(dir, 'xclt') },
    stateMachine: { dbPath: join(dir, 'xvsm') },
    consensus: { dbPath: join(dir, 'xpc') },
  });
  node.xn = { started: false, start: async () => { throw new Error(SENTINEL); },
              on() {}, subscribe: async () => {}, publish: async () => {} };
  return node;
}

const saved = { ...process.env };
const reset = () => {
  delete process.env.XMBL_PROFILE;
  delete process.env.XZK_COMMIT;
};

// The whole gate is meaningful only while audits are open; this repo ships that way.
await check('AUDIT_GATES_OPEN is true (repo is pre-audit)', async () => {
  assert.strictEqual(AUDIT_GATES_OPEN, true);
});

await check('mainnet while audits open → boot refused, names MAINNET-GATES.md', async () => {
  reset();
  process.env.XMBL_PROFILE = 'mainnet';
  await assert.rejects(() => nodeWithStubNet().start(), /boot refused[\s\S]*MAINNET-GATES\.md/);
});

await check('no ack env var can bypass the mainnet refusal', async () => {
  reset();
  process.env.XMBL_PROFILE = 'mainnet';
  process.env.XMBL_MAINNET_AUDIT_ACK = '1';   // must NOT open the gate
  process.env.XMBL_ALLOW_INSECURE_CURVE = '1'; // must NOT open the gate
  await assert.rejects(() => nodeWithStubNet().start(), /boot refused/);
  delete process.env.XMBL_MAINNET_AUDIT_ACK;
  delete process.env.XMBL_ALLOW_INSECURE_CURVE;
});

await check('no mainnet profile → gate is inert (reaches network start)', async () => {
  reset();
  await assert.rejects(() => nodeWithStubNet().start(), new RegExp(SENTINEL));
});

await check('testnet profile → gate is inert (reaches network start)', async () => {
  reset();
  process.env.XMBL_PROFILE = 'testnet';
  await assert.rejects(() => nodeWithStubNet().start(), new RegExp(SENTINEL));
});

Object.assign(process.env, saved);
console.log(`\nboot gate: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
