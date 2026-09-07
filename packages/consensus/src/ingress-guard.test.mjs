// INGRESS GUARD POLICY TEST.
//
// ⛔ POLICY CHANGED 2026-08-02, and the previous test asserted the OLD policy verbatim: "DROPS a type=anchor
// (the confirmed spam)" while ADMITTING unsigned value-txs. That is backwards, and the fleet data says so:
//
//   laptop  856 raw  — 826 anchors, 856/856 SIGNED
//   agentic 13,740   — 13,368 anchors, 13,740/13,740 SIGNED
//   ifix    15,959   — 15,526 anchors, 15,959/15,959 SIGNED
//   prod    865      — 829 anchors, 834 signed, 31 UNSIGNED (30 from `xmbl-seal-driver-payer`)
//
// Anchors are the chain's dominant legitimate input — the entire handoff->XMBL pipe emits them. Dropping every
// anchor blackholed the main traffic and is consistent with the observed validation-throughput-zero. The guard
// had already been stripped from prod's running tree for this reason.
//
// The real disqualifier is a MISSING SIGNATURE, and the flood is a per-submitter rate problem, not a type
// problem (one identity produced 13,737/13,740 and 15,955/15,959).
//
// ⚠ PRESENCE CHECK ONLY, NEVER CRYPTOGRAPHIC VERIFICATION AT INGRESS. An earlier verifying guard returned
// false for legitimate identities holding older SPKI-DER keys and blackholed valid anchors. Checking that
// `sig`/`from` EXIST cannot produce that false negative.
//
// Run: node ingress-guard.test.mjs
import { ConsensusWorkflow } from './workflow.js';
import assert from 'node:assert';

let pass = 0;
const check = (n, c) => { assert.ok(c, n); console.log('  ok  ', n); pass++; };
const mk = () => new ConsensusWorkflow({});
const signedAnchor = (h = 'h') => ({ type: 'anchor', event: 'task.created', hash: h, from: 'xmbA', sig: 'SIG' });

// (a) SIGNED traffic is admitted — including anchors
{
  const w = mk();
  check('admits a SIGNED anchor (the dominant real traffic)', w._admitToPool('nodeA', signedAnchor()) === true);
  check('admits a signed type-6 value-tx', w._admitToPool('nodeA', { type: 'tx', chain: 'xmbl', from: ['a'], to: ['b'], asset: 'USDC', amount: '1.50', xid: '06x', nonce: 1, sig: 'S' }) === true);
  check('admits a signed utxo', w._admitToPool('nodeA', { type: 'utxo', from: 'a', to: 'b', amount: '1', sig: 'S' }) === true);
  check('admits a signed identity tx', w._admitToPool('nodeA', { type: 'identity', publicKey: 'pk', from: 'a', sig: 'S' }) === true);
}

// (b) UNSIGNED is rejected regardless of type — this is the actual junk
{
  const w = mk();
  check('REJECTS an unsigned anchor', w._admitToPool('nodeA', { type: 'anchor', event: 'x', hash: 'h', from: 'a' }) === false);
  check('REJECTS a tx with sig but no from', w._admitToPool('nodeA', { type: 'anchor', event: 'x', hash: 'h', sig: 'S' }) === false);
  check('REJECTS the seal-driver chain-fill junk (no sig)', w._admitToPool('nodeA', { type: 'tx', from: 'xmbl-seal-driver-payer', amount: '1' }) === false);
  check('REJECTS an empty-string signature', w._admitToPool('nodeA', { type: 'anchor', event: 'x', hash: 'h', from: 'a', sig: '' }) === false);
  check('REJECTS a null/garbage payload', w._admitToPool('nodeA', null) === false);
  check('accepts array-form `from` (type-6 shape)', w._admitToPool('nodeA', { type: 'tx', from: ['a'], sig: 'S' }) === true);
  check('REJECTS an EMPTY array `from`', w._admitToPool('nodeA', { type: 'tx', from: [], sig: 'S' }) === false);
}

// (c) FLOOD ban applies per submitter, to every type
{
  process.env.XPC_JUNK_BAN_MAX = '3';
  const w = mk();
  let banned = null;
  w.on('submitter:banned', (d) => { banned = d; });
  for (let i = 0; i < 3; i++) check(`signed anchor ${i + 1} admitted (<=MAX)`, w._admitToPool('flooder', signedAnchor('h' + i)) === true);
  check('4th exceeds MAX -> dropped + ban', w._admitToPool('flooder', signedAnchor('h4')) === false);
  check('submitter:banned emitted with reason=flood', banned && banned.submitterId === 'flooder' && banned.reason === 'flood');
  check('banned submitter dropped even for a valid value-tx', w._admitToPool('flooder', { type: 'tx', from: ['a'], sig: 'S' }) === false);
  check('a DIFFERENT submitter is unaffected', w._admitToPool('honest', signedAnchor()) === true);
  delete process.env.XPC_JUNK_BAN_MAX;
}

// (d) rollback switch still admits everything
{
  process.env.XPC_INGRESS_GUARD = '0';
  const w = mk();
  check('XPC_INGRESS_GUARD=0 admits even an unsigned anchor (rollback)', w._admitToPool('nodeA', { type: 'anchor' }) === true);
  delete process.env.XPC_INGRESS_GUARD;
}

console.log(`\nPASS — ${pass} checks\n`);
