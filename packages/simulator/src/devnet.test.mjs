// Gate test for the XMBL LocalDevnet (the "hardhat for XMBL").
//
// Self-contained: asserts and exits non-zero on failure (the protocol hard-gate contract).
// It drives the REAL modules — MAYO identities, the cubic ledger with signature verification
// ON — through a network pipeline and asserts the OUTCOME by count: N signed transfers
// submitted → N landed → blocks sealed into a face, with a negative control proving the
// verification is live (a tampered tx is rejected). It then proves the two consensus→ledger
// seams documented in ../DEVNET-SEAM-FINDING.md are now FIXED, each with a live negative
// control so a regression fails loudly.
import assert from 'node:assert/strict';
import { LocalDevnet } from './devnet.js';
import { micromineTx } from '../../cubic-ledger/index.js';
import { Identity } from '../../identity/index.js';
import { Ledger } from '@xmbl/cubic-ledger';
import { ConsensusWorkflow } from '../../consensus/index.js';

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
  const signed = await from.signTransaction(micromineTx({ id: 'tamper_1', type: 'utxo', from: from.address, to: net.addressOf(1), amount: 5, timestamp: Date.now() }));
  const tampered = { ...signed, amount: 9999 }; // mutate a signed field
  let threw = '';
  try { await net.ledger.addTransaction(tampered); } catch (e) { threw = e.message; }
  ok('ledger REJECTS a tampered signed tx (verification is live)', /Invalid transaction signature|address mismatch/.test(threw), `threw="${threw}"`);

  await net.stop();
}

// ── 2) SEAM FIXES — the two consensus→ledger defects are corrected (each with a neg-control) ──
{
  const net = await new LocalDevnet({ identities: 2 }).start();
  const from = net.identities[0];
  const signed = await from.signTransaction(micromineTx({ id: 'seam_client_id', type: 'utxo', from: from.address, to: net.addressOf(1), amount: 7, timestamp: Date.now() }));

  // FIX(a): consensus finalizeTransaction now PRESERVES the originator's signed `id`. It used to
  // overwrite it with validatedHash (workflow.js), corrupting the signed message so the ledger's
  // re-verification could never match. Driven at the real code site: a signed tx placed in the
  // processing mempool is finalized, and the emitted txData must keep its signed id AND still
  // verify against the signer's key. The consensus hash rides separately as the event's txId.
  {
    const w = new ConsensusWorkflow({});
    const validatedHash = 'validatedHash_' + 'ab'.repeat(8);
    w.mempool.processingTx.set(validatedHash, { txData: { ...signed }, validationTimestamp: null });
    let emitted = null;
    w.on('tx:finalized', (d) => { emitted = d; });
    await w.finalizeTransaction(validatedHash);
    ok('FIX(a): finalize PRESERVES the signed id (not validatedHash)', !!emitted && emitted.txData.id === 'seam_client_id', `id=${emitted?.txData?.id}`);
    ok('FIX(a): the finalized tx STILL verifies against the signer key', (await Identity.verifyTransaction(emitted.txData, from.publicKey)) === true);
    ok('FIX(a): the consensus hash is carried separately as the event txId', emitted.txId === validatedHash);
    // WHY A TX MUST NOT CARRY THE CONSENSUS CLOCK: identity's signingMessage covers every field except
    // sig/publicKey, so a `validationTimestamp` written into the body is a value the signer never saw.
    const withVt = { ...signed, validationTimestamp: '123' };
    ok('a tx carrying a validationTimestamp INSIDE the signed body does NOT re-verify (why A5 moved it out)',
       (await Identity.verifyTransaction(withVt, from.publicKey)) === false);
    try { await w.mempool?.db?.close?.(); } catch { /* in-memory / already closed */ }
  }

  // FIX(c) / A5 — DRIVEN AT THE REAL SITE, not asserted on a hand-built object. The previous version of this
  // block pinned the DEFECT by checking a property of verifyTransaction itself, which no amount of fixing
  // moveToProcessing could ever flip — a tripwire that could not trip. This runs the actual pipeline:
  // addRawTransaction → quorum timestamps → moveToProcessing → finalizeTransaction → the ledger, with a key
  // resolver wired exactly as the daemon wires it (B7). If consensus ever writes its clock back into the
  // signed body, the finalized tx stops verifying and the ledger refuses it — here, in the gate.
  {
    const w = new ConsensusWorkflow({});
    const rawTxId = await w.mempool.addRawTransaction('leaderA', { ...signed });
    w.rawTxToId.set(rawTxId, 'leaderA');
    const entry = w.mempool.rawTx.get('leaderA').get(rawTxId);
    entry.validationTimestamps = [
      { nodeId: 'v1', timestamp: 1789470971116000000n },
      { nodeId: 'v2', timestamp: 1789470971117000000n },
      { nodeId: 'v3', timestamp: 1789470971118000000n },
    ];
    await w.moveToProcessing(rawTxId);
    const [key, processing] = [...w.mempool.processingTx.entries()][0];
    ok('A5: the processing tx body carries NO validationTimestamp (the clock is a sibling)',
       processing.txData.validationTimestamp === undefined, `body=${JSON.stringify(Object.keys(processing.txData))}`);
    ok('A5: the clock travels BESIDE the tx and is non-null', processing.validationTimestamp != null);
    ok('A5: the processing tx STILL verifies against the signer key (the whole point)',
       (await Identity.verifyTransaction(processing.txData, from.publicKey)) === true);

    let fin = null;
    w.on('tx:finalized', (d) => { fin = d; });
    await w.finalizeTransaction(key);
    ok('A5: the FINALIZED tx verifies against the signer key', !!fin && (await Identity.verifyTransaction(fin.txData, from.publicKey)) === true);
    ok('A5: the finalized event carries the clock as its own field', fin.validationTimestamp != null && fin.txData.validationTimestamp === undefined);

    // B7 — the ledger, with the resolver the daemon now wires, verifies the same tx a SECOND time.
    const led = new Ledger({});
    led.xid = from;                                   // enables the ledger's signature check
    led.getPublicKeyByAddress = (addr) => (addr === from.address ? from.publicKey : null);
    const res = await led.addTransaction(fin.txData, { validationTimestamp: fin.validationTimestamp });
    ok('B7: a signed finalized tx is ACCEPTED at the ledger with re-verification ON', !!res && res.duplicate !== true);
    const block = [...led._membershipPool, ...led.blocks.values()].find((b) => b.tx && b.tx.id === 'seam_client_id');
    ok('B7: the block carries the consensus clock as its own field, and its tx does not',
       !!block && block.validationTimestamp != null && block.tx.validationTimestamp === undefined);
    let refused = '';
    try { await led.addTransaction({ ...fin.txData, amount: 424242 }, { validationTimestamp: fin.validationTimestamp }); }
    catch (e) { refused = e.message; }
    ok('B7: a tx tampered AFTER consensus is REFUSED at the ledger (the defense-in-depth layer is live)',
       /Invalid transaction signature|address mismatch/.test(refused), `threw="${refused}"`);
    try { await w.mempool?.db?.close?.(); } catch { /* in-memory / already closed */ }
    try { await led.close?.(); } catch { /* in-memory */ }
  }

  // FIX(a) negative control: mutating `id` AFTER signing (what the old overwrite effectively did)
  // is REJECTED by the ledger — `id` is inside the signed domain, which is exactly why consensus
  // must not overwrite it.
  const idMutated = { ...signed, id: 'attacker_reid' };
  let aThrew = '';
  try { await net.ledger.addTransaction(idMutated); } catch (e) { aThrew = e.message; }
  ok('FIX(a) neg-control: an id-mutated signed tx is REJECTED (id is signed)', /Invalid transaction signature|address mismatch/.test(aThrew), `threw="${aThrew}"`);

  // FIX(b): addSealedBatch now verifies via the static Identity.verifyTransaction. It used to call
  // this.xid.verify(...) — a method that does not exist on an Identity instance → TypeError, so its
  // signature check had never verified anything. Identity instances still expose no `.verify`
  // (only the static), so the corrected call site is the reason this now works.
  ok('Identity instances have no .verify (only static verifyTransaction)', typeof from.verify === 'undefined' && typeof Identity.verifyTransaction === 'function');
  const sealedResult = await net.ledger.addSealedBatch([{ ...signed }]);
  ok('FIX(b): addSealedBatch VERIFIES a valid sig and lands (no TypeError)', !!sealedResult && typeof sealedResult === 'object');

  // FIX(b) negative control: a tx tampered after signing is REJECTED on the sealed-batch path too.
  let bThrew = '';
  try { await net.ledger.addSealedBatch([{ ...signed, amount: 4242 }]); } catch (e) { bThrew = e.message; }
  ok('FIX(b) neg-control: addSealedBatch REJECTS a tampered tx (verification is live)', /Invalid signature|address mismatch/.test(bThrew), `threw="${bThrew}"`);

  await net.stop();
}

console.log(`\n✅ devnet: ${pass} checks passed`);
process.exit(0);
