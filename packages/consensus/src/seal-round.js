// Stateful round-agreement ORCHESTRATOR (ab5932a5 / consensus 2b). One instance per LEVEL — L1 (blocks→faces)
// and L2 (faces→cubes) — wrapping the pure policy in seal-agreement.js. Transport (gossip), the seal action, and
// the adopt/reconstruct action are all INJECTED, so the state machine is unit-testable with no node.
//
// ROUND-NUMBER-AGNOSTIC by design: the agreement is keyed by the candidate's SET-HASH, not a round counter.
// Every node independently computes the SAME bounded lowest-prefix from the same unsealed set (deterministic
// content order), so honest nodes propose the identical set-hash and converge — no cross-node round-number to
// coordinate. A node whose unsealed set diverges (missing/extra item) proposes a DIFFERENT set-hash and simply
// STALLS until it converges (commit-2 delivers the missing data). Once a set seals, its members leave the pool so
// the next candidate (next-lowest prefix) differs → the next set-hash → the next agreement. The set-hash IS the
// round identity.
//
// SAFETY (the whole point): a set is sealed ONLY when a quorum (incl. me) proposed THAT EXACT set-hash. Never a
// local count. STALL on no-quorum. Pigeonhole (one proposal/node) ⇒ at most one set reaches a strict majority ⇒
// no split-brain double-seal (proved in seal-agreement.decideRound).
//
// deps: {
//   getItems()                 -> current UNSEALED items (blocks | faces)
//   keyFn(item)                -> node-consistent content key (block.hash | face.getMerkleRoot())
//   memberId(item)             -> the item's stable id, carried in the proposal so a minority can reconstruct
//   chunkSize                  -> 9 (L1) | 3 (L2)
//   quorum()                   -> current strict-majority threshold of live seal-leads
//   broadcast({setHash,memberIds}) -> gossip my proposal
//   sealSet(items)             -> seal EXACTLY these agreed items; MUST be idempotent (no-op if already sealed)
//   adoptSet(setHash, memberIds) -> reconstruct from ids + verify (recompute set-hash) + adopt; async -> true on
//                                 success, false to STALL (missing data; commit-2 will deliver, retry next tick)
// }
import { candidatePrefix, setHash, decideRound } from './seal-agreement.js';

// How many recently-resolved sets keep being vouched for each tick. Small on purpose: only the newest rounds
// can still have a peer counting votes, and every extra one is pure gossip volume.
const DONE_REBROADCAST = Math.max(1, Number(process.env.XPC_SEAL_DONE_REBROADCAST) || 3);

export class SealRoundManager {
  constructor(deps) {
    this.d = deps;
    this._peers = new Map();   // setHash -> Map(nodeId -> memberIds)   (peer proposals, deduped per node)
    this._done = new Set();    // setHashes we already sealed/adopted (ignore stale re-proposals for them)
    this._doneOrder = [];      // FIFO to cap _done growth
    // A SEALED SET MUST KEEP ANSWERING FOR ITSELF. See _rebroadcastDone() — this holds the memberIds of the
    // most recently resolved sets so they can be re-announced while a lagging peer is still counting votes.
    this._doneMembers = new Map();   // setHash -> memberIds
  }

  // THE DEADLOCK THIS EXISTS TO BREAK, measured on a 3-node mesh with one node per container/IP:
  //   n0 pooled 63 persisted 18 | n1 pooled 72 persisted 9 | n2 pooled 72 persisted 9
  // and those numbers did not move again — not in 105s, not ever. All 81 txs reached 3/3 validations and
  // finalized; the SEAL BOUNDARY is what deadlocked.
  //
  // WHY. A round needs a quorum of proposals for one set-hash, and gossip is not synchronous. n0 collected
  // n1's proposal for round-2 set B and sealed it. n1's own copy of n0's proposal had not arrived yet, so n1
  // sat at 1 vote for B. n0 then MARKED B DONE — and a done set is never proposed again (tick() returns idle
  // on `_done.has(myHash)`, and n0's pool has moved on to a different candidate anyway). So n1 waits forever
  // for a second vote on B that no node will ever send again, and every later round is blocked behind it.
  // The stall is permanent and completely silent: the tick is wrapped in `catch {}` and logs nothing.
  //
  // THE FIX, and why it is safe. Re-announcing a set this node ACTUALLY SEALED is a true statement about a
  // content-addressed set, not a new vote: setHash is sha256 over the sorted member keys, so a peer can only
  // count it toward the identical set it is already considering. It cannot manufacture a quorum for anything
  // else, and the pigeonhole safety argument in seal-agreement.decideRound is untouched — one proposal per
  // node per set. What it restores is LIVENESS: the node that already knows the answer keeps saying it until
  // the slower nodes have finished counting. Bounded to the few most recent sets so this never becomes an
  // unbounded replay of chain history.
  _rebroadcastDone() {
    const recent = this._doneOrder.slice(-Math.max(1, DONE_REBROADCAST));
    for (const h of recent) {
      const memberIds = this._doneMembers.get(h);
      if (memberIds) this.d.broadcast({ setHash: h, memberIds });
    }
  }

  // Record a peer's proposal for a candidate set-hash. Idempotent per (setHash,nodeId).
  onPeerProposal(p) {
    if (!p || !p.setHash || !p.nodeId) return;
    // A proposal for a set WE already sealed is not a straggler to drop — it is a peer telling us it is still
    // short of quorum on a set we can vouch for. Dropping it silently is half of the deadlock above; the other
    // half is never re-announcing. Answer immediately (and _rebroadcastDone keeps answering on the tick).
    if (this._done.has(p.setHash)) {
      const memberIds = this._doneMembers.get(p.setHash);
      if (memberIds) { try { this.d.broadcast({ setHash: p.setHash, memberIds }); } catch { /* transport is best-effort */ } }
      return;
    }
    if (!this._peers.has(p.setHash)) this._peers.set(p.setHash, new Map());
    this._peers.get(p.setHash).set(p.nodeId, p.memberIds || null);
  }

  // One agreement step. Returns the action taken this tick (for logging/tests): idle|seal|adopt|stall.
  async tick() {
    // Vouch for what we already sealed BEFORE any early return. The node most likely to be ahead is exactly the
    // one whose pool has drained below chunkSize — if it stops answering there, the peers still counting votes
    // on its last round are stranded, which is the deadlock in the reverse direction.
    this._rebroadcastDone();

    const cand = candidatePrefix(this.d.getItems(), this.d.keyFn, this.d.chunkSize, 1);
    if (cand.length === 0) return { action: 'idle' };    // < chunkSize unsealed — nothing to seal

    const myHash = setHash(cand, this.d.keyFn);
    if (this._done.has(myHash)) return { action: 'idle' };   // already sealed this set; pool will refresh next tick
    const myMemberIds = cand.map(this.d.memberId);

    // (Re)broadcast my current candidate every tick — idempotent; a slow peer that missed the first hears it again.
    this.d.broadcast({ setHash: myHash, memberIds: myMemberIds });

    const peers = [];
    for (const [h, byNode] of this._peers) for (const [nodeId, memberIds] of byNode) peers.push({ nodeId, setHash: h, memberIds });
    const decision = decideRound({ setHash: myHash, memberIds: myMemberIds }, peers, this.d.quorum());

    if (decision.action === 'seal') {
      await this.d.sealSet(cand);                        // idempotent seal of the agreed set
      this._markDone(myHash, myMemberIds);
      return { action: 'seal', setHash: myHash };
    }
    if (decision.action === 'adopt') {
      const adopted = await this.d.adoptSet(decision.setHash, decision.memberIds);
      if (adopted) { this._markDone(decision.setHash, decision.memberIds); return { action: 'adopt', setHash: decision.setHash }; }
      return { action: 'stall-adopt', setHash: decision.setHash };   // missing data — retry next tick (commit-2 delivers)
    }
    return { action: 'stall' };                          // no quorum — SAFETY: retain everything, retry next tick
  }

  // A resolved set: drop its proposal tally and remember it so stale re-proposals are ignored. Cap _done so it
  // can't grow unbounded (like core's _appliedReports precedent).
  _markDone(h, memberIds = null) {
    this._peers.delete(h);
    if (memberIds) this._doneMembers.set(h, memberIds);
    if (!this._done.has(h)) {
      this._done.add(h); this._doneOrder.push(h);
      if (this._doneOrder.length > 4096) { const old = this._doneOrder.shift(); this._done.delete(old); this._doneMembers.delete(old); }
    }
    // Keep the vouching window small — only the most recent sets can still have a peer counting votes on them.
    if (this._doneMembers.size > DONE_REBROADCAST * 4) {
      for (const k of this._doneMembers.keys()) {
        if (this._doneMembers.size <= DONE_REBROADCAST * 4) break;
        if (!this._doneOrder.slice(-DONE_REBROADCAST * 4).includes(k)) this._doneMembers.delete(k);
      }
    }
  }
}
