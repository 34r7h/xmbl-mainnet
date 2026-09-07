// PURE seal-boundary agreement policy (ab5932a5 / consensus 2b). No transport, no timers, no node state — the
// node injects the current unsealed items + the peer proposals and this decides WHAT set is the bounded candidate,
// its agreement digest, and whether a round SEALS / ADOPTS / STALLS. Correctness lives here, unit-testable in
// isolation (no full node). It is LEVEL-AGNOSTIC and applied RECURSIVELY at both levels:
//   L1 blocks→faces : items=unsealed blocks, keyFn = b => b.hash (content sha256, node-consistent), chunkSize=9
//   L2 faces →cubes : items=unsealed faces,  keyFn = f => f.getMerkleRoot() (content merkle, node-consistent), chunkSize=3
//
// WHY THIS EXISTS: the seal boundary used to be LOCAL — seal every N items in local ARRIVAL order (blocks→faces
// at addSealedBatch, faces→cubes at _finalizeFace's "first cube with room"). Deterministic given the SAME set, but
// WHICH N are pooled when the Nth arrives is TIMING-dependent → identical sets, divergent partition → permanent
// fork (no reconciliation). The fix: a node NEVER seals on a local count — only on a QUORUM-AGREED set. This
// module is the agreement's pure heart; the stateful gossip/round loop injects into it.
import { createHash } from 'crypto';

// THE BOUNDED, STABLE CANDIDATE: the lowest (chunkSize * maxChunks) items by keyFn, key-sorted, taking ONLY
// complete chunks. Bounded is the load-bearing property — a full "all unsealed items" candidate is a MOVING
// TARGET under continuous arrival (changes on every new item → peers rarely hold a byte-identical set at once →
// chronic stall). A bounded lowest-K*chunk prefix is STABLE against high-key arrivals (a new item whose key is
// above the prefix does NOT disturb the prefix), so a quorum converges even under steady load. A late LOWER-key
// straggler is NOT rejected: round-scope has no global key order, so it lands in a later round's prefix, sealed in
// a later chunk, CONSISTENTLY across nodes. Returns [] when < chunkSize items exist (→ nothing to seal this round).
export function candidatePrefix(items, keyFn, chunkSize, maxChunks = 1) {
  const sorted = [...items].sort((a, b) => { const ka = keyFn(a), kb = keyFn(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
  const completeChunks = Math.floor(sorted.length / chunkSize);
  const take = Math.min(completeChunks, Math.max(1, maxChunks)) * chunkSize;   // only whole chunks, bounded
  return sorted.slice(0, take);
}

// THE AGREEMENT DIGEST over a candidate set: sha256 of the SORTED keys. Two nodes holding the byte-identical set
// produce the identical digest; sorting makes it order-free (arrival order irrelevant). This is the single value
// the quorum agrees on — equal digest ⟺ equal set (keys are content hashes), so agreeing the digest agrees the set.
export function setHash(items, keyFn) {
  return createHash('sha256').update(items.map(keyFn).sort().join('|')).digest('hex');
}

// THE QUORUM DECISION. `mine` = { setHash, memberIds } for MY candidate (or null if I have no candidate this
// round); `peers` = [{ nodeId, setHash, memberIds }] peer proposals THIS round; `quorum` = the majority threshold
// (strictly > half of the live seal-leads). Returns exactly one of:
//   { action:'seal',  setHash }            — a quorum (incl. me) proposed MY set → seal it locally.
//   { action:'adopt', setHash, memberIds } — a quorum proposed a DIFFERENT set → I'm the minority; ADOPT that set
//                                            (reconstruct from memberIds; STALL until I have all member data).
//   { action:'stall' }                     — no set reached quorum → retain everything, retry next round (SAFETY:
//                                            NEVER seal a non-agreed set; this is the whole anti-fork property).
// PIGEONHOLE SAFETY: each node contributes exactly ONE setHash, so at most ONE setHash can reach a strict
// majority → no two disjoint majorities → no split-brain double-seal, at either level.
export function decideRound(mine, peers, quorum) {
  const proposals = [];
  if (mine && mine.setHash) proposals.push({ ...mine, _self: true });
  for (const p of (peers || [])) if (p && p.setHash) proposals.push(p);
  const votes = new Map();
  for (const pr of proposals) votes.set(pr.setHash, (votes.get(pr.setHash) || 0) + 1);
  let win = null, winCount = 0;
  for (const [h, c] of votes) if (c > winCount) { win = h; winCount = c; }
  if (win === null || winCount < quorum) return { action: 'stall' };
  if (mine && win === mine.setHash) return { action: 'seal', setHash: win };
  const winning = proposals.find((pr) => pr.setHash === win);
  return { action: 'adopt', setHash: win, memberIds: winning ? winning.memberIds : null };
}
