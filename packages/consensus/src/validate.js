// THE ORDER OF CONSENSUS VALIDATION (operator, 2026-09-16):
//   1. can the transaction happen   — a known type with its required fields, authorized (signed by a sender, or
//                                     content-addressed per the type table's `authority`), a value that can exist;
//   2. is the xid correct           — the micromined xid carries the type's prefix and content-addresses the
//                                     type's canonical body at the carried nonce (every tx is typed by its xid);
//   3. is the geometric placement   — a sealed face's positions are the hash ranks of its nine, a cube's face
//      right                          indices the ranks of its three roots — re-derived and compared.
// Stages 1 and 2 run on every transaction at the door (ingress); stage 3 runs on every face/cube a node seals
// or adopts. Each result names its stage, so a refusal is legible: REJECT [can-happen] / [xid] / [placement].
import { validateShape, validateXid, verifyPlacement, authorityOf } from '@xmbl/cubic-ledger';

export const STAGES = Object.freeze(['can-happen', 'xid', 'placement']);
const fail = (stage, reason) => ({ ok: false, stage, reason });

/** Stage 1. */
export function validateCanHappen(tx) {
  if (!tx || typeof tx !== 'object') return fail('can-happen', 'not a transaction object');
  try { validateShape(tx); } catch (e) { return fail('can-happen', e.message); }
  const from = tx.from;
  const hasSender = typeof from === 'string' ? from.length > 0 : Array.isArray(from) && from.length > 0;
  // AUTHORIZATION — READ FROM THE TYPE TABLE (tokens.json `authority`), never from a hardcoded type name.
  // 'content-addressed' (types 6 and 7) carries no in-body signature BY DESIGN and its authority is its xid,
  // re-derived at stage 2: a type-6's payer sig is the deferred type-7 pointer, and an ANCHOR is a pointer to a
  // digest that moves no value, minted by a node-less custodial broker that no end user ever signs for.
  // MEASURED 2026-09-16 before this read the table: a broker anchor — correctly typed, xid verifying — was
  // refused here as "unsigned", so every typed anchor the nodes produced died at stage 1 and "0 untyped
  // anchors" was unreachable no matter what the broker did. Everything else must still be signed by a sender.
  const contentAddressed = authorityOf(tx.type) === 'content-addressed';
  const signed = typeof tx.sig === 'string' && tx.sig.length > 0 && hasSender;
  if (!contentAddressed && !signed) return fail('can-happen', 'unsigned: no signature or no sender — nothing can ever validate it');
  // A type-6 names its payer in the mined body, so a missing one is a broken body. An anchor names no sender at
  // all (its body is {from:[prior],to:[hash],how:'anchor'}), so requiring one would refuse every genuine anchor.
  if (tx.type === 'tx' && !hasSender) return fail('can-happen', 'type-6 with no payer');
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
