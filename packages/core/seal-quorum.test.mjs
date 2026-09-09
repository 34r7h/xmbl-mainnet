// @xmbl/core seal-quorum denominator (MAINNET-GATES §@xmbl/consensus, T7.1 — the core half).
//
// The seal boundary's no-fork safety (proven at the policy layer in
// packages/consensus/src/byzantine-matrix.test.mjs) rests on ONE numeric property: the seal quorum is a
// strict majority of the FIXED configured lead set — never the presence-live subset. If the denominator
// shrinks under a partition, each side computes a smaller majority, both seal, and the ledger forks
// PERMANENTLY (a sealed member cannot be re-adopted into the other side's set). This suite pins that
// denominator. Run: node seal-quorum.test.mjs
import assert from 'node:assert';
import { sealQuorumFrom, XMBLCore } from './index.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };

// ---- the pure threshold ---------------------------------------------------------------------------------
check('no allowlist ⇒ single-node dev: quorum 1 (seals alone)', () => {
  assert.strictEqual(sealQuorumFrom(null), 1);
  assert.strictEqual(sealQuorumFrom(undefined), 1);
  assert.strictEqual(sealQuorumFrom([]), 1);
});
check('strict majority of the configured lead set', () => {
  assert.strictEqual(sealQuorumFrom(['a']), 1);
  assert.strictEqual(sealQuorumFrom(['a', 'b']), 2);
  assert.strictEqual(sealQuorumFrom(['a', 'b', 'c']), 2);
  assert.strictEqual(sealQuorumFrom(['a', 'b', 'c', 'd']), 3);
  assert.strictEqual(sealQuorumFrom(['a', 'b', 'c', 'd', 'e']), 3);
});
check('ANTI-FORK INVARIANT: 2·quorum > n for every size ⇒ no two disjoint quorums can both seal', () => {
  for (let n = 1; n <= 32; n++) {
    const set = Array.from({ length: n }, (_, i) => `lead${i}`);
    const q = sealQuorumFrom(set);
    assert.ok(2 * q > n, `size ${n}: 2·${q} !> ${n} — two disjoint partitions could both reach quorum (FORK)`);
  }
});

// ---- the load-bearing regression: _sealQuorum ignores liveness -----------------------------------------
// _sealQuorum reads ONLY this._leadAllowlist. We drive it with a bare stub (no full node) that ALSO exposes
// a presence-shrunk getLiveLeaders — the value the buggy version used. A partition-independent quorum must
// be blind to it. MUTATION that this asserts: revert _sealQuorum to `getLiveLeaders()`-derived counting →
// the shrunk stub returns 1 instead of 3 and this fails.
check('_sealQuorum derives from the FIXED allowlist, never the presence-live subset', () => {
  const four = ['a', 'b', 'c', 'd'];
  assert.strictEqual(XMBLCore.prototype._sealQuorum.call({ _leadAllowlist: four }), 3, 'quorum of a 4-lead allowlist must be 3');
  // Same allowlist, but the node is partitioned down to seeing only itself live. Quorum MUST stay 3.
  const partitioned = { _leadAllowlist: four, xid: { address: 'a' }, xpc: { getLiveLeaders: () => ['a'] } };
  assert.strictEqual(XMBLCore.prototype._sealQuorum.call(partitioned), 3, 'seal quorum shrank with the live-lead view — this is the permanent-fork bug');
});
check('_sealQuorum with no allowlist configured ⇒ dev quorum 1', () => {
  assert.strictEqual(XMBLCore.prototype._sealQuorum.call({ _leadAllowlist: null }), 1);
  assert.strictEqual(XMBLCore.prototype._sealQuorum.call({}), 1);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
