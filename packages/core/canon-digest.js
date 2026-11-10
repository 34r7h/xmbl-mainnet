// THE CANONICAL JOURNAL'S HASH CHAIN — the node's own computation of the broker's position digest.
//
// The broker numbers every anchor it journals (seq 1, 2, 3 … within one numbering, `gen`) and chains a digest
// over them: d_0 = sha256('xmbl-canon-v1'), d_seq = sha256(d_{seq-1} + U+001E + line_seq), where line_seq joins
// seq, event, hash, ts, xid, nonce and prior with U+001F (an absent field is ''). It is the same spec as the
// broker's src/xmbl-canon-journal.ts, pinned by the same golden vectors on both sides (canon-digest.test.mjs).
//
// WHY THE NODE COMPUTES IT ITSELF. A delta (`?since=<seq>`) is only safe to append if it extends exactly the set
// this node holds. The broker says where the delta starts (prev_root) and where it ends (to_root); the node
// recomputes the chain over the rows it actually received from the root IT holds, and appends only when its own
// answer equals to_root. A dropped, reordered, edited or duplicated row changes the digest, so the node refuses it
// and asks for a full set instead — it never has to trust that the page it got is the page the broker meant.
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s).digest('hex');

export const CANON_D0 = sha('xmbl-canon-v1');

export function canonLine(seq, a) {
  return [String(seq), a.event, a.hash, a.ts, a.xid ?? '', a.nonce == null ? '' : String(a.nonce), a.prior ?? ''].join('\x1f');
}

export function canonStep(prev, seq, a) { return sha(prev + '\x1e' + canonLine(seq, a)); }

/** The digest over a list numbered from `from + 1`, starting at `prev` (CANON_D0 for a whole set). */
export function canonRoot(list, prev = CANON_D0, from = 0) {
  let d = prev;
  (Array.isArray(list) ? list : []).forEach((a, i) => { d = canonStep(d, from + i + 1, a); });
  return d;
}

/**
 * Verify a run of journal rows that each carry their own `seq`: contiguous from `from + 1`, chained from `prev`.
 * Returns { ok, root, to_seq } or { ok:false, reason }.
 */
export function verifyCanonRun(rows, prev, from) {
  const list = Array.isArray(rows) ? rows : [];
  let d = prev;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const want = from + i + 1;
    if (!a || a.seq !== want) return { ok: false, reason: `row ${i} carries seq ${a && a.seq} where ${want} was expected` };
    if (typeof a.event !== 'string' || typeof a.hash !== 'string' || typeof a.ts !== 'string') return { ok: false, reason: `row seq ${want} is missing event, hash or ts` };
    d = canonStep(d, want, a);
  }
  return { ok: true, root: d, to_seq: from + list.length };
}
