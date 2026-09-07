// VALIDATION RETRY POLICY (8e91d994 commit-2) — PURE + DEPENDENCY-INJECTED.
//
// A lone/trickled tx stalls below quorum in mempool.raw because the per-tx validation TASK doesn't reliably reach
// all validators (floodsub drop / pickup gap) and there was NO retry of an unvalidated raw tx. This is the policy
// that decides, each sweep, WHAT to re-gossip for a stuck tx. It holds NO transport, NO libp2p, NO timers, NO
// node state of its own — core/index.js injects the real gossip fns + the workflow's read-only stuck-tx view and
// drives this on an interval. That separation is deliberate: consensus STATE lives in the workflow, TRANSPORT in
// core, and the retry POLICY here is unit-testable in isolation against the real bytes (no full-node import).
//
// Two idempotent re-gossips per stuck tx (both rely on pre-existing idempotency — _ingested / _appliedReports /
// the commit-1 dedup + finalized guard — so a retry can never double-count or re-seal):
//   (1) the RAW TX with its ORIGINAL leaders set → a validator that MISSED its task ingests + validates it ONCE
//       (its first, correct timestamp). Nodes that already hold it skip via _ingested; a sealed tx is a no-op via
//       the finalized guard. It NEVER re-runs validation on an already-validated node.
//   (2) OUR OWN stored report VERBATIM (the exact {taskId,validatorId,timestamp} we minted once) → a node that
//       missed our report now counts it. This is a pure re-attestation: re-emitting a stored report, NEVER
//       re-running validation to regenerate one (a fresh Date.now() would give the same validator a second,
//       different timestamp → validatorAverageTimestamp → validatedHash DIVERGES across nodes → seal disagreement).
//       This is the C#5 invariant, enforced structurally: this policy has no way to mint a timestamp — it can only
//       re-broadcast what was already stored.
//
// Bounded: a tx is re-gossiped at most `maxRetries` times, then given up on (a genuinely un-validatable / poison
// tx is not re-gossiped forever). `retries` + `myReports` are the caller's Maps; this mutates them (prune + count)
// so bookkeeping survives across ticks and does not leak. Returns per-tick counts for logging/tests.
export function runValidationRetryTick(deps) {
  const { stuck, isProcessed, myReports, retries, maxRetries, broadcastRawTx, broadcastReport } = deps;
  const stuckIds = new Set(stuck.map((s) => s.rawTxId));
  // Prune bookkeeping so BOTH Maps stay bounded (no leak fed by the given-up / abandoned path). A tx that WAS
  // tracked (in retries) but is no longer stuck has SEALED or aged past maxAge — drop it from retries AND drop our
  // stored report for it (dead weight once we'll never re-attest it). We only touch a report that was actively
  // retried, so a report for a still-too-fresh tx (validated but < minAge, never in retries) is never dropped early.
  for (const id of [...retries.keys()]) if (!stuckIds.has(id)) { retries.delete(id); myReports.delete(id); }
  // Also prune a report for a tx that sealed on the FAST happy path (before it ever became stuck / entered retries).
  for (const id of [...myReports.keys()]) { try { if (isProcessed(id)) myReports.delete(id); } catch { /* */ } }

  let reBroadcastRaw = 0, reBroadcastReport = 0, gaveUp = 0;
  for (const s of stuck) {
    const n = retries.get(s.rawTxId) || 0;
    if (n >= maxRetries) { gaveUp++; continue; }   // bounded — never re-gossip a poison/un-validatable tx forever
    retries.set(s.rawTxId, n + 1);
    if (s.txData) { broadcastRawTx(s.submitterId, s.txData, s.leaders); reBroadcastRaw++; }   // (1) recruit missing validators
    const mine = myReports.get(s.rawTxId);
    if (mine) { broadcastReport(mine); reBroadcastReport++; }                                  // (2) re-attest our stored report
  }
  return { reBroadcastRaw, reBroadcastReport, gaveUp };
}
