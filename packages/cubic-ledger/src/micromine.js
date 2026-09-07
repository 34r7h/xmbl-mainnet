// Content-addressed micromining — the CHAIN's copy of the algorithm, byte-identical to the app's
// src/stores/api.js hash() and to the broker's src/xmbl-micromine.ts (e49408b7). The chain re-runs
// verifyMicromine() on every incoming type-6 `tx` so content-addressing is part of validation: a datum
// whose body was tampered, or that carries the wrong nonce / a non-"06" xid, is rejected. Golden vectors
// v1 (nonce 15, 06f0e70f…) and v2 (nonce 594, 061d1740…) pin this to the app — see the test.
//
// oid = SHA256(JSON.stringify({ data })). JSON.stringify emits INSERTION order, so a body MUST be built in
// the canonical key order (type6TxBody below); any other order diverges the oid and fails verification.
import { createHash } from 'node:crypto';

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

/** The 2-hex-char prefix a datum of numeric `type` mines to. 6 -> "06", 7 -> "07". */
export function typePrefix(type) { return '0' + String(type); }

/** oid = SHA256(JSON.stringify({ data })) — the content id of a datum body. */
export function oidOf(data) { return sha256hex(JSON.stringify({ data })); }

/** Micromine `data` to numeric `type`: smallest nonce>=0 s.t. xid=SHA256(oid+String(nonce)) starts with the
 *  type prefix. Byte-identical to the app + broker (golden-vector pinned). */
export function micromine(data, type) {
  const oid = oidOf(data);
  const prefix = typePrefix(type);
  let nonce = 0, xid = '';
  for (; nonce <= 1000000; nonce++) { xid = sha256hex(oid + String(nonce)); if (xid.startsWith(prefix)) break; }
  if (!xid.startsWith(prefix)) throw new Error(`micromine: no nonce<=1e6 for type ${type} (prefix ${prefix})`);
  return { oid, nonce, xid, key: `${xid}_${nonce}` };
}

/** Verify a datum's content-addressing: recompute oid from `data`, confirm xid=SHA256(oid+nonce) matches the
 *  claimed xid AND carries the type prefix. A tampered body or a mistyped key fails. The chain runs this on
 *  every incoming type-6 tx — content-addressing IS part of validation. */
export function verifyMicromine(data, nonce, xid, type) {
  const recomputed = sha256hex(oidOf(data) + String(nonce));
  return recomputed === xid && xid.startsWith(typePrefix(type));
}

/** Build a type-6 VALUE-UNIT body in the CANONICAL key order (chain,from,to,asset,amount,seq,prev,unspent).
 *  `amount`/`unspent` are decimal strings. `unspent` (operator schema bump 2026-07-26) = the value unit's
 *  IMMUTABLE denomination-at-mint: fungible token = spendable value (consumed by a type-7 how='spend' pointer
 *  referencing this xid; spent-ness is DERIVED from the pointer graph, never by mutating this datum),
 *  non-fungible asset = whole unit, "" = a non-value payment record. Any other key order diverges the oid. */
export function type6TxBody(t) {
  return { chain: t.chain, from: t.from ?? [], to: t.to ?? [], asset: t.asset, amount: t.amount, seq: t.seq, prev: t.prev ?? '', unspent: t.unspent ?? '' };
}

/** Build a type-7 pointer body in canonical key order (from,to,how). */
export function type7PointerBody(p) {
  return { from: p.from ?? [], to: p.to ?? [], how: p.how };
}
