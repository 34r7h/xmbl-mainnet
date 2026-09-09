// DurableNonceRegistry conformance — the property the in-memory NonceRegistry could not hold:
// single-use survives a process restart and is enforced across instances sharing the store, by the
// database's unique constraint (real CAS), not by JS single-threadedness. Every check asserts a
// REJECTION of a replay. Run: node durable-nonce-registry.test.mjs
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Identity } from './identity.js';
import { mintGrant, mintZspToken, signAction, tokenHash, makeAuthorizer } from './delegation.js';
import { DurableNonceRegistry } from './durable-nonce-registry.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const acheck = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };

const dir = mkdtempSync(join(tmpdir(), 'xmbl-durnonce-'));
const dbPath = join(dir, 'nonces.db');
const TH = 'zsp_deadbeef';

check('same contract: consume returns true first, false forever after', () => {
  const r = new DurableNonceRegistry({ path: dbPath });
  assert.strictEqual(r.consume(TH, 'n1', 0), true, 'first use wins');
  assert.strictEqual(r.consume(TH, 'n1', 0), false, 'second use is refused');
  assert.strictEqual(r.consume(TH, 'n1', 0), false, 'and stays refused');
  assert.strictEqual(r.has(TH, 'n1'), true);
  assert.strictEqual(r.consume(TH, 'n2', 0), true, 'a different nonce is independent');
  r.close();
});

check('DURABLE: a nonce burned before a restart is still burned after (reopen same file)', () => {
  // fresh file so this case is self-contained
  const p = join(dir, 'restart.db');
  const a = new DurableNonceRegistry({ path: p });
  assert.strictEqual(a.consume(TH, 'restart-nonce', 0), true, 'burned in the first run');
  a.close(); // == process exit
  const b = new DurableNonceRegistry({ path: p }); // == process restart
  assert.strictEqual(b.consume(TH, 'restart-nonce', 0), false, 'the replay must fail after restart');
  assert.strictEqual(b.has(TH, 'restart-nonce'), true, 'and the burn is visible');
  b.close();
});

check('ATOMIC / cross-instance: two registries on ONE file — only one consume of a pair wins', () => {
  const p = join(dir, 'shared.db');
  const nodeA = new DurableNonceRegistry({ path: p });
  const nodeB = new DurableNonceRegistry({ path: p }); // a second node sharing the store
  const a = nodeA.consume(TH, 'shared-nonce', 0);
  const b = nodeB.consume(TH, 'shared-nonce', 0);
  assert.strictEqual(a && b, false, 'both nodes must not accept the same nonce');
  assert.strictEqual(a || b, true, 'exactly one node accepts it');
  assert.notStrictEqual(a, b, 'one true, one false — the unique constraint decided it');
  nodeA.close(); nodeB.close();
});

check('eviction: an expired token\'s nonce is swept, an open one is retained', () => {
  const r = new DurableNonceRegistry({ path: join(dir, 'evict.db') });
  const past = Math.floor(Date.now() / 1000) - 10;
  const future = Math.floor(Date.now() / 1000) + 3600;
  r.consume(TH, 'dead', past);
  r.consume(TH, 'live', future);
  r.consume(TH, 'unknown', 0);
  const removed = r.sweepExpired();
  assert.strictEqual(removed, 1, 'exactly the expired row is evicted');
  assert.strictEqual(r.has(TH, 'dead'), false, 'expired nonce gone');
  assert.strictEqual(r.has(TH, 'live'), true, 'unexpired nonce kept');
  assert.strictEqual(r.has(TH, 'unknown'), true, 'exp=0 (unknown) kept');
  r.close();
});

// End-to-end at the load-bearing seam: makeAuthorizer with a DURABLE store rejects a replay
// ACROSS A RESTART — the exact hole the in-memory store leaves open.
await acheck('seam: makeAuthorizer over a durable store rejects a replay after a restart', async () => {
  const root = await Identity.create();
  const coordinator = await Identity.create();
  const agent = await Identity.create();
  const now = Math.floor(Date.now() / 1000);
  const grant = await mintGrant(root, { coordinatorPub: coordinator.publicKey, scope: ['transfer'], exp: now + 3600 });
  const token = await mintZspToken(coordinator, { grant, agentPub: agent.publicKey, aud: 'acct-1', scope: ['transfer'], ttlSeconds: 3600 });
  const { sig, nonce } = await signAction(agent, { token, action: 'transfer', args: [1] });
  const pres = { grant, token, action: 'transfer', args: [1], actionSig: sig, nonce };
  const policy = { rootAddress: root.address, aud: 'acct-1' };

  const seamPath = join(dir, 'seam.db');
  const store1 = new DurableNonceRegistry({ path: seamPath });
  const auth1 = makeAuthorizer({ ...policy, nonces: store1 });
  const first = await auth1.verify(pres);
  assert.strictEqual(first.ok, true, `first authorization must pass (got ${first.reason})`);
  const replaySameRun = await auth1.verify(pres);
  assert.strictEqual(replaySameRun.ok, false, 'a replay in the same run is refused');
  assert.strictEqual(replaySameRun.reason, 'action-replayed');
  store1.close(); // restart

  const store2 = new DurableNonceRegistry({ path: seamPath });
  const auth2 = makeAuthorizer({ ...policy, nonces: store2 });
  const replayAfterRestart = await auth2.verify(pres);
  assert.strictEqual(replayAfterRestart.ok, false, 'the SAME actionSig must not re-authorize after a restart');
  assert.strictEqual(replayAfterRestart.reason, 'action-replayed', 'single-use survived the restart');
  store2.close();
});

rmSync(dir, { recursive: true, force: true });
console.log(`\ndurable nonce registry: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
