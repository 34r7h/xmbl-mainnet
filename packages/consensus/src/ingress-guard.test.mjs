// INGRESS GUARD POLICY TEST.
//
// ⛔ POLICY CHANGED 2026-08-02, and the previous test asserted the OLD policy verbatim: "DROPS a type=anchor
// (the confirmed spam)" while ADMITTING unsigned value-txs. That is backwards, and the node data says so:
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
import { createHash } from 'node:crypto';
import { micromineTx, micromine, type6TxBody, authorityOf, contentAddressedTypes } from '@xmbl/cubic-ledger';

let pass = 0;
const check = (n, c) => { assert.ok(c, n); console.log('  ok  ', n); pass++; };
const mk = () => new ConsensusWorkflow({});
// An anchor's `hash` is a sha-256 digest by contract (cubic-ledger validateTransaction), so fixtures mine one
// from a label rather than passing the label itself.
const digest = (label) => createHash('sha256').update(String(label)).digest('hex');
// EVERY TX IS TYPED BY ITS XID (2026-09-16): fixtures mine the type identity the way the broker and the node do.
const signedAnchor = (h = 'h') => ({ ...micromineTx({ type: 'anchor', event: 'task.created', hash: digest(h), ts: 1 }), from: 'xmbA', sig: 'SIG' });
const typed = (tx) => micromineTx(tx);
const mined6 = () => { const t = { chain: 'xmbl', from: ['a'], to: ['b'], asset: 'USDC', amount: '1.50', seq: 1, prev: '', unspent: '' }; const { xid, nonce } = micromine(type6TxBody(t), 6); return { type: 'tx', ...t, xid, nonce }; };

// (a) SIGNED traffic is admitted — including anchors
{
  const w = mk();
  check('admits a SIGNED anchor (the dominant real traffic)', w._admitToPool('nodeA', signedAnchor()) === true);
  check('admits a signed type-6 value-tx', w._admitToPool('nodeA', { ...mined6(), sig: 'S' }) === true);
  check('admits a signed utxo', w._admitToPool('nodeA', { ...typed({ type: 'utxo', from: 'a', to: 'b', amount: '1' }), sig: 'S' }) === true);
  check('admits a signed identity tx', w._admitToPool('nodeA', { ...typed({ type: 'identity', publicKey: 'pk', signature: 'sg', from: 'a' }), sig: 'S' }) === true);
}

// (a2) UNTYPED is refused at the door, whatever else it carries — every tx is typed by its xid (stage 2)
{
  const w = mk();
  check('REJECTS a signed utxo with NO xid (untyped)', w._admitToPool('nodeA', { type: 'utxo', from: 'a', to: 'b', amount: '1', sig: 'S' }) === false);
  check('REJECTS a signed anchor with NO xid (untyped)', w._admitToPool('nodeA', { type: 'anchor', event: 'task.created', hash: digest('u'), ts: 1, from: 'xmbA', sig: 'SIG' }) === false);
  const a = signedAnchor('p');
  check('REJECTS a typed anchor whose xid was mined for another body', w._admitToPool('nodeA', { ...a, hash: digest('q') }) === false);
  check('REJECTS a typed anchor whose prior is missing (its pointer body cannot be re-mined)', w._admitToPool('nodeA', (({ prior, ...rest }) => rest)(a)) === false);
  const u = typed({ type: 'utxo', from: 'a', to: 'b', amount: '1' });
  check('REJECTS a utxo whose xid carries another type prefix', w._admitToPool('nodeA', { ...u, xid: '07' + u.xid.slice(2), sig: 'S' }) === false);
  check('REJECTS a typed utxo whose amount was changed after mining', w._admitToPool('nodeA', { ...u, amount: '2', sig: 'S' }) === false);
  check('REJECTS a typed, signed utxo whose amount cannot happen (negative) — stage 1 before stage 2', w._admitToPool('nodeA', { ...typed({ type: 'utxo', from: 'a', to: 'b', amount: '-5' }), sig: 'S' }) === false);
}

// (b) UNSIGNED is rejected regardless of type — this is the actual junk
{
  const w = mk();
  check('REJECTS an unsigned anchor', w._admitToPool('nodeA', { type: 'anchor', event: 'x', hash: digest('h'), from: 'a' }) === false);
  check('REJECTS a tx with sig but no from', w._admitToPool('nodeA', { type: 'anchor', event: 'x', hash: digest('h'), sig: 'S' }) === false);
  check('REJECTS the seal-driver chain-fill junk (no sig)', w._admitToPool('nodeA', { type: 'tx', from: 'xmbl-seal-driver-payer', amount: '1' }) === false);
  check('REJECTS an empty-string signature', w._admitToPool('nodeA', { type: 'anchor', event: 'x', hash: digest('h'), from: 'a', sig: '' }) === false);
  check('REJECTS a signed anchor whose hash is a label, not a digest (the ledger rule, applied at the door)', w._admitToPool('nodeA', { type: 'anchor', event: 'proof.mined', hash: 'proofofmined-1789450900844', from: 'a', sig: 'S' }) === false);
  check('REJECTS a signed anchor missing its event (required by tokens.json)', w._admitToPool('nodeA', { type: 'anchor', hash: digest('h'), from: 'a', sig: 'S' }) === false);
  check('REJECTS a null/garbage payload', w._admitToPool('nodeA', null) === false);
  check('accepts array-form `from` (type-6 shape, typed)', w._admitToPool('nodeA', { ...mined6(), sig: 'S' }) === true);
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
  check('banned submitter dropped even for a valid value-tx', w._admitToPool('flooder', { ...mined6(), sig: 'S' }) === false);
  check('a DIFFERENT submitter is unaffected', w._admitToPool('genuine', signedAnchor()) === true);
  delete process.env.XPC_JUNK_BAN_MAX;
}

// (d) rollback switch still admits everything
{
  process.env.XPC_INGRESS_GUARD = '0';
  const w = mk();
  check('XPC_INGRESS_GUARD=0 admits even an unsigned anchor (rollback)', w._admitToPool('nodeA', { type: 'anchor' }) === true);
  delete process.env.XPC_INGRESS_GUARD;
}

// (e) CONTENT-ADDRESSED ADMISSION (operator: "signed by a sender, OR content-addressed"; measured 2026-09-16).
// The broker that mints those anchors is NODE-LESS and CUSTODIAL: its type-7 pointer is authorized by its
// xid, not by an end-user signature. Before this, stage 1 refused it as "unsigned" and every typed anchor died
// at the door — "0 untyped anchors" was unreachable no matter what the broker did.
{
  const w = mk();
  const unsignedAnchor = micromineTx({ type: 'anchor', event: 'task.created', hash: digest('h9'), ts: 1 });
  check('ADMITS an UNSIGNED anchor whose xid verifies (the node-less broker\'s only shape)', w._admitToPool('broker', unsignedAnchor) === true);
  const chained = micromineTx({ type: 'anchor', event: 'task.verified', hash: digest('h10'), ts: 2, prior: unsignedAnchor.xid });
  check('ADMITS an unsigned anchor chained to a prior xid', w._admitToPool('broker', chained) === true);
  check('ADMITS an unsigned type-6 (unchanged)', w._admitToPool('broker', mined6()) === true);

  // The exemption is EXACTLY the two content-addressed types and nothing else — asserted against the type table.
  assert.deepStrictEqual(contentAddressedTypes(), ['anchor', 'tx'], 'content-addressed set must be exactly {anchor, tx}');
  check('the content-addressed set is exactly {anchor, tx} (2 of 7 types)', contentAddressedTypes().length === 2);
  for (const t of ['utxo', 'identity', 'token_creation', 'contract', 'state_diff']) {
    check(`authorityOf(${t}) is 'signed'`, authorityOf(t) === 'signed');
  }
  check('still REJECTS an unsigned utxo (value moves only on a signature)',
    w._admitToPool('attacker', typed({ type: 'utxo', from: 'a', to: 'b', amount: '1000000' })) === false);
  check('still REJECTS an unsigned identity tx', w._admitToPool('attacker', typed({ type: 'identity', publicKey: 'pk', signature: 'sg', from: 'a' })) === false);
  check('still REJECTS an unsigned state_diff', w._admitToPool('attacker', typed({ type: 'state_diff', function: 'f', args: [], from: 'a' })) === false);
  check('still REJECTS an UNTYPED anchor (no xid) even though its type is content-addressed',
    w._admitToPool('broker', { type: 'anchor', event: 'e', hash: digest('h11'), ts: 3 }) === false);
  check('still REJECTS a FORGED anchor xid (body changed after mining)',
    w._admitToPool('broker', { ...unsignedAnchor, hash: digest('tampered') }) === false);
  check('still REJECTS an anchor with no `prior` — the pointer body cannot be re-mined (what the wire must carry)',
    w._admitToPool('broker', (() => { const t = { ...unsignedAnchor }; delete t.prior; return t; })()) === false);
}

// (f) THE OUTCOME THE BROKER MEASURES: xpc.submitTransaction returns a rawTxId, not null, for an unsigned anchor
// whose user is unresolvable — all three guards, not just the first.
{
  const w = mk();
  w.getPublicKeyByAddress = () => null;   // node-less custodial broker: nothing resolves
  const a = micromineTx({ type: 'anchor', event: 'task.created', hash: digest('h12'), ts: 4 });
  const rawTxId = await w.submitTransaction('broker', a);
  check('submitTransaction ADMITS the unsigned anchor (returns a rawTxId, not the null that meant "rejected at ingress")',
    typeof rawTxId === 'string' && rawTxId.length > 0);
  const bad = await w.submitTransaction('attacker', typed({ type: 'utxo', from: 'a', to: 'b', amount: '5' }));
  check('submitTransaction still returns null for an unsigned utxo', bad === null);
}

console.log(`\nPASS — ${pass} checks\n`);
