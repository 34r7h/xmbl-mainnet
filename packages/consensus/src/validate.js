// THE ORDER OF CONSENSUS VALIDATION (operator, 2026-09-16):
//   1. can the transaction happen   — a known type with its required fields, authorized (signed by a sender, or
//                                     content-addressed), carrying a value that can exist;
//   2. is the xid correct           — the micromined xid carries the type's prefix and content-addresses the
//                                     type's canonical body at the carried nonce (every tx is typed by its xid);
//   3. is the geometric placement   — a sealed face's positions are the hash ranks of its nine, a cube's face
//      right                          indices the ranks of its three roots — re-derived and compared.
// Stages 1 and 2 run on every transaction at the door (ingress); stage 3 runs on every face/cube a node seals
// or adopts. Each result names its stage, so a refusal is legible: REJECT [can-happen] / [xid] / [placement].
import { validateShape, validateXid, verifyPlacement } from '@xmbl/cubic-ledger';

export const STAGES = Object.freeze(['can-happen', 'xid', 'placement']);
const fail = (stage, reason) => ({ ok: false, stage, reason });

/** Stage 1. */
export function validateCanHappen(tx) {
  if (!tx || typeof tx !== 'object') return fail('can-happen', 'not a transaction object');
  try { validateShape(tx); } catch (e) { return fail('can-happen', e.message); }
  const from = tx.from;
  const hasSender = typeof from === 'string' ? from.length > 0 : Array.isArray(from) && from.length > 0;
  // AUTHORIZATION. A content-addressed type-6 carries no in-body signature by design (its payer sig is the
  // deferred type-7 pointer; its authority is the xid, stage 2). Every other type must be signed by a sender.
  const contentAddressed = tx.type === 'tx';
  const signed = typeof tx.sig === 'string' && tx.sig.length > 0 && hasSender;
  if (!contentAddressed && !signed) return fail('can-happen', 'unsigned: no signature or no sender — nothing can ever validate it');
  if (contentAddressed && !hasSender) return fail('can-happen', 'type-6 with no payer');
  // VALUE. Where the type carries an amount it must be a number that can exist.
  if ((tx.type === 'utxo' || tx.type === 'tx') && tx.amount !== undefined) {
    const n = Number(tx.amount);
    if (!Number.isFinite(n) || n < 0) return fail('can-happen', `amount ${JSON.stringify(tx.amount)} cannot happen`);
  }
  return { ok: true, stage: 'can-happen' };
}

/** Stage 2. */
export function validateXidStage(tx) {
  try { validateXid(tx); return { ok: true, stage: 'xid' }; }
  catch (e) { return fail('xid', e.message); }
}

/** Stage 3 — for a sealed face or a cube payload ({ faces:[{ blocks:[{hash, tx, location?}] }] }). */
export function validatePlacementStage(faceOrCube) {
  const r = verifyPlacement(faceOrCube);
  return r.ok ? { ok: true, stage: 'placement', faces: r.faces } : fail('placement', r.reason);
}

/** Stages 1 then 2, for one transaction at the door. The first failing stage is the answer. */
export function validateForConsensus(tx) {
  const a = validateCanHappen(tx); if (!a.ok) return a;
  const b = validateXidStage(tx);  if (!b.ok) return b;
  return { ok: true, stage: 'xid', next: 'placement' };
}
