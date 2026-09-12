// Gate test for the XMBL LocalDevnet (the "hardhat for XMBL").
//
// Self-contained: asserts and exits non-zero on failure (the protocol hard-gate contract).
// It drives the REAL modules — MAYO identities, the cubic ledger with signature verification
// ON — through a network pipeline and asserts the OUTCOME by count: N signed transfers
// submitted → N landed → blocks sealed into a face, with a negative control proving the
// verification is live (a tampered tx is rejected). It then PINS the two currently-broken
// consensus→ledger seams so that a later protocol fix makes this test fail loudly (forcing the
// assertions to be updated) instead of the bug silently returning. See ../DEVNET-SEAM-FINDING.md.
import assert from 'node:assert/strict';
import { LocalDevnet } from './devnet.js';
import { Identity } from '../../identity/index.js';

let pass = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name}${detail ? ' — ' + detail : ''}`);
  console.log('  ok  ' + name);
  pass++;
};

// ── 1) REAL network pipeline: signed transfers land, a face seals, verification is live ──
{
  const net = await new LocalDevnet({ identities: 4 }).start();
  ok('devnet mints the requested real identities', net.metrics.identities === 4, `got ${net.metrics.identities}`);
  ok('every identity has a distinct MAYO address', new Set(net.identities.map((i) => i.address)).size === 4);

  // 12 distinct signed transfers through the direct ledger path (verification ON).
  const N = 12;
  for (let k = 0; k < N; k++) {
    const r = await net.submitTransfer(0, 1, 1 + k); // id0 → id1, varying amount ⇒ distinct blocks
    assert.ok(r.ok, `transfer ${k} rejected: ${r.error}`);
  }
  ok('all signed transfers were submitted', net.metrics.submitted === N, `submitted=${net.metrics.submitted}`);
  ok('all signed transfers LANDED in the ledger', net.metrics.landed === N, `landed=${net.metrics.landed}`);
  ok('none were rejected', net.metrics.rejected === 0, `rejected=${net.metrics.rejected}`);
  ok('≥1 face sealed from the 12 blocks (9 per face)', net.metrics.facesCompleted >= 1, `faces=${net.metrics.facesCompleted}`);

  const m = await net.getMetrics();
  ok('ledger exposes a state root after activity', m.root !== null && m.root !== undefined, `root=${m.root}`);

  // Balance is the net of APPLIED deltas — real state, not fabricated.
  const sent = Array.from({ length: N }, (_, k) => 1 + k).reduce((a, b) => a + b, 0); // 1..12 = 78
  ok('recipient balance equals the net of landed transfers', net.balanceOf(net.addressOf(1)) === sent, `bal=${net.balanceOf(net.addressOf(1))} expected=${sent}`);
  ok('sender balance is the negation', net.balanceOf(net.addressOf(0)) === -sent, `bal=${net.balanceOf(net.addressOf(0))}`);
  ok('an unknown address has zero balance', net.balanceOf('xmbdoesnotexist') === 0);

  // NEGATIVE CONTROL — verification is actually ON: a tx tampered after signing is rejected.
  const from = net.identities[0];
  const signed = await from.signTransaction({ id: 'tamper_1', type: 'utxo', from: from.address, to: net.addressOf(1), amount: 5, timestamp: Date.now() });
  const tampered = { ...signed, amount: 9999 }; // mutate a signed field
  let threw = '';
  try { await net.ledger.addTransaction(tampered); } catch (e) { threw = e.message; }
  ok('ledger REJECTS a tampered signed tx (verification is live)', /Invalid transaction signature|address mismatch/.test(threw), `threw="${threw}"`);

  await net.stop();
}

// ── 2) REGRESSION PINS — the two broken consensus→ledger seams (fix ⇒ these flip) ──
{
  const net = await new LocalDevnet({ identities: 2 }).start();
  const from = net.identities[0];
  const signed = await from.signTransaction({ id: 'seam_client_id', type: 'utxo', from: from.address, to: net.addressOf(1), amount: 7, timestamp: Date.now() });

  // (a) consensus/src/workflow.js:781-784 overwrites the signed `id` with validatedHash; the
  //     legacy finalize path then re-verifies the mutated tx and the signature can't match.
  const idOverwritten = { ...signed, id: 'validatedHash_' + 'ab'.repeat(8) };
  let aThrew = '';
  try { await net.ledger.addTransaction(idOverwritten); } catch (e) { aThrew = e.message; }
  ok('PIN(a): id-overwritten signed tx fails re-verification (workflow.js:781-784)', /Invalid transaction signature|address mismatch/.test(aThrew), `threw="${aThrew}"`);

  // (b) cubic-ledger/src/ledger.js:249 calls this.xid.verify(...), absent on an Identity instance.
  ok('Identity instances have no .verify (only static verifyTransaction)', typeof from.verify === 'undefined' && typeof Identity.verifyTransaction === 'function');
  let bThrew = '';
  try { await net.ledger.addSealedBatch([{ ...signed }]); } catch (e) { bThrew = e.constructor.name + ': ' + e.message; }
  ok('PIN(b): addSealedBatch throws TypeError on this.xid.verify (ledger.js:249)', /TypeError.*verify is not a function/.test(bThrew), `threw="${bThrew}"`);

  await net.stop();
}

console.log(`\n✅ devnet: ${pass} checks passed`);
process.exit(0);
