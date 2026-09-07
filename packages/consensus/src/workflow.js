import { Mempool } from './mempool.js';
import { ValidationTaskManager } from './validation-tasks.js';
import { EventEmitter } from 'events';
import { createHash } from 'crypto';

export class ConsensusWorkflow extends EventEmitter {
  constructor(options = {}) {
    super();
    const dbPath = options.dbPath || './data/xpc';
    this.mempool = new Mempool({ dbPath: `${dbPath}/mempool` });
    this.taskManager = new ValidationTaskManager({ store: this.mempool });
    // Stage 2 rehydration: the mempool loads all five tiers from LevelDB, then the task manager adopts the
    // persisted validation tasks. Awaiting `ready` before submitting work guarantees a restarted node resumes
    // its assigned tasks instead of stranding the raw pool.
    this.ready = Promise.resolve(this.mempool.ready).then(() => {
      const n = this.taskManager.hydrate();
      if (n) console.log(`[XPC] stage 2 rehydrated: ${n} validation task(s) restored from disk`);
      const s = this.rehydrateSubmitters();
      const r = this.recoverStrandedRawTxs();
      return { tasks: n, submitters: s, recovered: r };
    }).catch(() => ({ tasks: 0, submitters: 0, recovered: 0 }));
    // The threshold is the consensus design's to set, not this constructor's to guess — but the value that
    // core/config.js resolves (XPC_VALIDATIONS) was being discarded here, so no deployment could configure
    // it at all. Honour the passed/configured value, keeping 3 as the default so behaviour is unchanged
    // unless someone deliberately sets it.
    this.requiredValidations = Math.max(1,
      Number(options.requiredValidations) || Number(process.env.XPC_VALIDATIONS) || 3);
    this.rawTxToId = new Map(); // Map rawTxId to leaderId for lookup
    // rawTxIds that have already moved to processing (finalized). SAME-BOOT, in-memory — like core's
    // _appliedReports floodsub-dedup set. Guards against a re-ingest/re-gossip re-running validation on a tx
    // that already sealed (addRawTransaction resets validationTimestamps to [], so a bare re-ingest would restart
    // the quorum and could re-seal the SAME tx). rawTxId is a deterministic hash of txData (mempool._hashTransaction),
    // so this reliably identifies a re-arrival. A re-ingest spanning a process RESTART is a documented residual —
    // the durable guard is a ledger "already-sealed?" check, which lives in xclt, not here.
    this._processedRawTxIds = new Set();

    // Integration: xid for signature verification
    this.xid = options.xid || null;
    
    // Integration: xclt for final transaction inclusion
    this.xclt = options.xclt || null;
    
    // Integration: xn for network gossip
    this.xn = options.xn || null;
    
    // Validation leaders (actual identity addresses)
    this.validationLeaders = options.validationLeaders || null;
    
    // Function to lookup public key by address (for signature verification)
    this.getPublicKeyByAddress = options.getPublicKeyByAddress || null;

    // Function returning the live lead-role identity addresses (from the peer registry,
    // includes self). Injected by core; drives _getValidationLeaders on a real swarm.
    this.getLiveLeaders = options.getLiveLeaders || null;

    // Per-rawTx leader set actually used (so a receiver that was handed an explicit set
    // reports the same tasks back, instead of recomputing a possibly-different set).
    this.rawTxLeaders = new Map();

    // Integration: optional batch-sealing hook (E4 lead role). When provided
    // (roles.lead, see core/lead-worker.js), finalized transactions route
    // through it instead of the legacy per-tx xclt.addTransaction call below —
    // the deterministic addSealedBatch path D3a introduced but left unwired.
    this.batchSealer = options.batchSealer || null;

    // Listen for finalized transactions and add to ledger
    this.on('tx:finalized', async (data) => {
      console.log('[XPC] tx:finalized listener triggered, xclt:', !!this.xclt, 'txData:', !!data.txData);
      if (this.batchSealer) {
        try {
          console.log('[XPC] Routing finalized tx through lead batchSealer:', data.txId || data.txData?.id);
          await this.batchSealer(data.txData);
        } catch (error) {
          console.error('[XPC] batchSealer failed on finalized tx:', error);
        }
        return;
      }
      if (this.xclt) {
        try {
          console.log('[XPC] Adding transaction to ledger:', data.txId || data.txData?.id);
          const result = await this.xclt.addTransaction(data.txData);
          console.log('[XPC] Transaction added to ledger successfully, blockId:', result?.blockId);
        } catch (error) {
          console.error('[XPC] Failed to add finalized transaction to ledger:', error);
          console.error('[XPC] Error stack:', error.stack);
        }
      } else {
        console.warn('[XPC] xclt is not available, cannot add transaction to ledger');
      }
    });
  }

  // e49408b7 / OPERATOR DIRECTIVE ("disconnect from coordinators that spam"): NODE INGRESS GUARD for the
  // value-tx pool. A type='anchor' datum can NEVER reach 3/3 (it skips value validation) — it only clogs the
  // rawTx pool + re-inflates it (the 18946 flood, re-observed live at ~11-60/min from a stale coordinator).
  // (a) DROP such junk at ingress; validatable type-6 value-txs (type='tx', from+to+amount) pass cleanly.
  // (b) a submitter exceeding XPC_JUNK_BAN_MAX anchors in XPC_JUNK_WINDOW_MS is BANNED (further submissions
  //     dropped) + a 'submitter:banned' event fires so CORE can hangUp the peer at the transport layer.
  // Flag-gated (XPC_INGRESS_GUARD=0 disables = rollback switch) + LOGGED (never a silent drop). Scoped to
  // type='anchor' ONLY (the confirmed spam) so legit non-value types (identity/contract/state_diff) are never
  // dropped — widen only if advisor confirms those never use the value-tx pool.
  // INGRESS GUARD — reject what the chain can never use, admit everything else.
  //
  // ⛔ THE PREVIOUS VERSION DROPPED EVERY type:'anchor'. The line `if (!txData || txData.type !== 'anchor')
  // return true;` let non-anchors through and fell anchors into an unconditional `return false`. Anchors are
  // the dominant real traffic on this network (13,368 of 13,740 pooled on one box, 15,526 of 15,959 on
  // another), so the guard blackholed the chain's main input while calling it "confirmed spam".
  //
  // THE REAL DISQUALIFIER IS A MISSING SIGNATURE. Measured 2026-08-02 across the fleet: laptop 856/856 signed,
  // agentic 13,740/13,740 signed, ifix 15,959/15,959 signed — but prod carried 31 UNSIGNED, 30 of them from a
  // sender literally named `xmbl-seal-driver-payer`. That is the junk: chain-fill artifacts with no `sig`.
  //
  // ⚠ PRESENCE CHECK ONLY, NEVER VERIFICATION. An earlier guard that cryptographically verified signatures at
  // ingress had to be removed: the verifier returns false for legitimate identities holding older SPKI-DER
  // keys, so it blackholed valid anchors. Checking that `sig` and `from` EXIST cannot produce that false
  // negative — an unsigned tx is unusable under any key format. Verification stays where it belongs, in
  // completeValidation, where a failure costs one tx instead of an identity's whole stream.
  // `local` = submitted through THIS node's own control socket, not gossiped from a peer.
  //
  // ⛔ THE FLOOD CAP MUST NOT APPLY TO LOCAL SUBMISSIONS. A bulk replay of the broker's own history submits
  // thousands of legitimate txs from one address in seconds; with the cap applied it banned its own node
  // after 500 and silently dropped 3,036 of 3,536. Rate-limiting exists to stop a REMOTE peer flooding this
  // node's pool — a local submit is already gated by the broker's own auth.
  _admitToPool(submitterId, txData, local = false) {
    if (process.env.XPC_INGRESS_GUARD === '0') return true;                 // rollback switch
    if (!this._junkCounts) { this._junkCounts = new Map(); this._bannedSubmitters = new Set(); }
    if (this._bannedSubmitters.has(submitterId)) return false;
    if (!txData || typeof txData !== 'object') return false;

    // 1. UNSIGNED -> reject. No signature or no sender means nothing can ever validate it.
    const signed = typeof txData.sig === 'string' && txData.sig.length > 0
      && (typeof txData.from === 'string' ? txData.from.length > 0 : Array.isArray(txData.from) && txData.from.length > 0);
    if (!signed) {
      console.warn(`ingress-guard: REJECT unsigned ${txData.type || 'tx'} from ${submitterId}`);
      return false;
    }

    if (local) return true;                                                  // local submits are not a flood vector

    // 2. FLOOD -> rate-limit per submitter, applied to every type rather than singling one out. One identity
    // accounted for 13,737/13,740 and 15,955/15,959 of two pools; that is the actual abuse pattern.
    const WINDOW = Math.max(1000, Number(process.env.XPC_JUNK_WINDOW_MS) || 60000);
    const MAX = Math.max(1, Number(process.env.XPC_JUNK_BAN_MAX) || 500);
    const now = Date.now();
    let e = this._junkCounts.get(submitterId);
    if (!e || now - e.start > WINDOW) { e = { start: now, count: 0 }; this._junkCounts.set(submitterId, e); }
    e.count++;
    if (e.count > MAX) {
      if (!this._bannedSubmitters.has(submitterId)) {
        this._bannedSubmitters.add(submitterId);
        console.warn(`ingress-guard: BAN ${submitterId} — ${e.count} txs in ${WINDOW}ms exceeds ${MAX}`);
        this.emit('submitter:banned', { submitterId, reason: 'flood', count: e.count, windowMs: WINDOW });
      }
      return false;
    }
    return true;
  }

  // USER-AS-VALIDATOR: a transaction is validated by ITS OWN USER (README, "Consensus Process" 4-6) — tasks
  // are created for the submitting user, that user performs them, and only then does the tx advance to
  // processing. There are no miners and no validator cartel to fall back on.
  //
  // The direct consequence, and it is the rule this enforces: A TRANSACTION WHOSE USER CANNOT BE RESOLVED
  // CAN NEVER ADVANCE. Nobody else is permitted to complete its tasks, so it is not "pending", it is
  // finished — and pooling it is pure accumulation. Measured on production before this existed: 20,777 raw
  // txs held forever with 0 sealed, which cost ~64% of a CPU in GC marking a live set that only grew.
  // Rejecting at ingress is what makes that impossible in principle rather than merely bounded after the
  // fact; the pool cap below is the belt to this braces.
  //
  // Deliberately NARROW: it refuses only when the user is positively unresolvable, never on a heuristic
  // about whether they seem likely to respond. A slow or briefly-offline user is not an invalid one, and
  // the project has been burnt before by an ingress check that rejected legitimate identities (the
  // SPKI-DER key episode in README) — "we could not resolve it" must mean exactly that, or valid chain
  // writes are silently lost. Set XPC_REQUIRE_RESOLVABLE_USER=0 to disable.
  _userCanValidate(txData) {
    if (process.env.XPC_REQUIRE_RESOLVABLE_USER === '0') return true;
    if (typeof this.getPublicKeyByAddress !== 'function') return true;   // no resolver wired: cannot judge, admit
    const from = txData && txData.from;
    if (!from) return true;                                              // no claimed user: other guards own this
    try { return !!this.getPublicKeyByAddress(from); } catch { return true; }
  }

  async submitTransaction(leaderId, txData) {
    if (!this._admitToPool(leaderId, txData, true)) return null;   // INGRESS GUARD: unsigned (local: no flood cap)
    if (await this._isPositivelyInvalid(txData)) {           // INGRESS GUARD: signed but provably invalid
      console.log(`[XPC-GUARD] ingress REJECT from ${txData.from}: signature does not verify (submit)`);
      return null;
    }
    if (!this._userCanValidate(txData)) {                    // INGRESS GUARD: no user => no validator => never advances
      console.log(`[XPC-GUARD] ingress REJECT from ${txData.from}: user unresolvable — under user-as-validator nothing can ever validate this`);
      return null;
    }
    // Lock UTXOs
    const utxos = this._extractUtxos(txData);
    await this.mempool.lockUtxos(utxos);
    
    // Add to raw_tx_mempool
    const rawTxId = await this.mempool.addRawTransaction(leaderId, txData);
    this.rawTxToId.set(rawTxId, leaderId);
    
    // Emit event
    this.emit('raw_tx:added', { leaderId, rawTxId, txData });
    
    // Create validation tasks
    await this.createValidationTasks(rawTxId);
    
    return rawTxId;
  }

  async createValidationTasks(rawTxId, leadersOverride = null) {
    // Get leaders for validation. user-as-validator (E1): the identity that
    // submitted this tx (this.rawTxToId) always gets a validation task back
    // for its own submission, alongside whatever other leaders are available.
    // A RECEIVER passes leadersOverride = the submitter's broadcast set, so every
    // node builds the IDENTICAL task set (and thus can count each other's reports).
    const submitterId = this.rawTxToId.get(rawTxId);
    const leaders = (leadersOverride && leadersOverride.length) ? leadersOverride.slice() : this._getValidationLeaders(submitterId);
    this._recordLeaders(rawTxId, leaders);
    const tasks = this.taskManager.createTasks(rawTxId, leaders);
    this.taskManager.assignTasks(rawTxId, tasks);

    this.emit('validation_tasks:created', { rawTxId, tasks });
    return leaders;
  }

  // Ingest a raw tx that arrived from a PEER (not locally submitted): replicate it into this
  // node's mempool under the submitter's id and build the same validation tasks, so this
  // node's ValidationWorker validates the task addressed to it. Mirrors submitTransaction
  // minus the re-broadcast. Idempotent-ish: a duplicate arrival just re-adds (same rawTxId).
  async ingestRemoteTransaction(submitterId, txData, leaders = null) {
    if (!this._admitToPool(submitterId, txData)) return null;   // INGRESS GUARD: unsigned / flood
    if (await this._isPositivelyInvalid(txData)) {              // INGRESS GUARD: signed but provably invalid
      console.log(`[XPC-GUARD] ingress REJECT from ${txData.from}: signature does not verify (ingest)`);
      return null;
    }
    // FINALIZED GUARD: if this exact tx already moved to processing (sealed), a re-arrival (re-gossip / retry) must
    // NOT restart its validation. addRawTransaction resets validationTimestamps to [], so a bare re-ingest would
    // re-run the whole quorum and could re-seal the SAME tx. rawTxId is a deterministic hash of txData, so we can
    // recognize the re-arrival BEFORE touching the mempool and return the id as an idempotent no-op.
    const rawTxId = this.mempool._hashTransaction(txData);
    if (this._processedRawTxIds.has(rawTxId)) {
      console.warn(`ingestRemoteTransaction: ${rawTxId} already processed — ignoring re-arrival (no re-validation)`);
      return rawTxId;
    }
    const utxos = this._extractUtxos(txData);
    try { await this.mempool.lockUtxos(utxos); } catch (e) { /* already locked on a duplicate — fine */ }
    await this.mempool.addRawTransaction(submitterId, txData);
    this.rawTxToId.set(rawTxId, submitterId);
    this.emit('raw_tx:added', { leaderId: submitterId, rawTxId, txData });
    await this.createValidationTasks(rawTxId, leaders);
    return rawTxId;
  }

  // rawTxToId maps a rawTxId to the identity that submitted it, and it was memory-only — so after a restart
  // the submitter of every pooled tx was unknown and createValidationTasks could not name the user-as-validator.
  // The mapping is recoverable for free: the raw_tx_mempool is keyed BY submitter
  // (rawTx: Map<leaderId, Map<rawTxId, ...>>), so walking the persisted tier rebuilds it exactly.
  // THE RECORDED SET MUST OUTLIVE THE PROCESS. rawTxLeaders drives _requiredFor, and _requiredFor falls back
  // to 1 when it holds no entry — so a memory-only map meant every pooled tx came back after a restart
  // claiming it needed ONE validation, whatever set it was actually admitted under. On a solo node that is
  // merely true; on a mesh it is a fork generator: a restarted node would promote and admit blocks its peers
  // (still holding the 3-member sets) do not, and with the legacy local-9 seal that is divergent face
  // membership — precisely what D3a/2b exist to prevent. The set rides the raw-tx entry, which is already
  // persisted whole (mempool._saveRawTx), so it costs nothing and rehydrates with the pool.
  _recordLeaders(rawTxId, leaders) {
    if (!Array.isArray(leaders) || !leaders.length) return;
    this.rawTxLeaders.set(rawTxId, leaders);
    const leaderId = this.rawTxToId.get(rawTxId);
    const entry = leaderId && this.mempool.rawTx.get(leaderId)?.get(rawTxId);
    if (!entry) return;
    entry.validationLeaders = leaders.slice();
    this.mempool._saveRawTx?.(leaderId, rawTxId, entry);   // fire-and-forget; the map is already correct
  }

  rehydrateSubmitters() {
    let n = 0;
    for (const [leaderId, txs] of this.mempool.rawTx) {
      for (const [rawTxId, entry] of txs) {
        if (!this.rawTxToId.has(rawTxId)) { this.rawTxToId.set(rawTxId, leaderId); n++; }
        // Restore the REQUIREMENT alongside the submitter. Without this, _requiredFor's absent-set fallback
        // of 1 silently re-scoped every restored tx to solo rules.
        const persisted = entry && entry.validationLeaders;
        if (Array.isArray(persisted) && persisted.length && !this.rawTxLeaders.has(rawTxId)) {
          this.rawTxLeaders.set(rawTxId, persisted.slice());
        }
      }
    }
    if (n) console.log(`[XPC] ${n} raw-tx submitter mapping(s) rebuilt from the persisted pool`);
    return n;
  }

  // STRANDED-POOL RECOVERY. Stage 2 was never persisted, so a restart restored the raw pool with NO tasks
  // attached and nothing regenerated them — measured live: raw 856, validation_tasks 0, validations_completed
  // 0, every entry predating process start. Those txs could never progress. With stage 2 now durable this runs
  // once at boot to repair pools stranded BEFORE the fix.
  //
  // ⚠ Only txs still in stage 1 are touched. A tx that already reached processing/final has a committed
  // validatedHash derived from its averaged validator timestamps; re-validating it would mint fresh timestamps,
  // change that hash, and fork the ledger. Recovery must never reach past stage 1.
  // maxPerPass bounds the boot-time write burst: one box holds 13,740 pooled txs, and assigning tasks for all
  // of them at once would write ~69k task records (5 leaders each) into LevelDB in a single pass. The sweep
  // re-runs on an interval, so a bounded pass still drains the whole pool, just without the stall.
  recoverStrandedRawTxs(opts = {}) {
    const maxPerPass = opts.maxPerPass ?? Number(process.env.XPC_RECOVERY_MAX_PER_PASS || 2000);
    let recovered = 0;
    for (const [leaderId, txs] of this.mempool.rawTx) {
      for (const rawTxId of txs.keys()) {
        if (this.mempool.processingTx.has(rawTxId)) continue;   // already past stage 1
        // Never assign tasks to a tx the drain is about to evict. Recovery ran BEFORE the drain and happily
        // built 5 tasks each for 13,740 provably-invalid txs on a 1GB box — ~69k LevelDB writes for work that
        // was going to be thrown away. Load average hit 30 and the box ran out of memory. Cheap sync check
        // first; the async predicate is only consulted by the drain itself.
        const entry = txs.get(rawTxId);
        if (entry && this._knownInvalid && this._knownInvalid.has(rawTxId)) continue;
        // Skip only if a full quorum of REAL validators already holds a task for this tx. Merely having
        // SOME task is not enough: recovery can run before presence gossip has populated the peer registry,
        // in which case _getValidationLeaders filled slots 2..n with `leaderN` placeholders that no node ever
        // claims. Those txs look assigned and can never reach quorum, so they must be re-assigned once real
        // peers appear. Placeholders are identified by the exact shape the padder emits.
        const isPlaceholder = (id) => /^leader\d+$/.test(id);
        // A HOLDER THAT CANNOT VALIDATE IS NOT A HOLDER. Placeholders were the known-fake case, but a
        // departed peer's address is every bit as inert and does not match /^leader\d+$/: after a mesh comes
        // and goes, this node's tasks sit under three real-looking addresses of which exactly one still
        // exists. realHolders then counted 3, the tx looked fully covered, recovery skipped it, and it
        // stayed stranded forever. MEASURED after a restart with the fix to getLiveLeaders in place: 180 raw
        // txs, 1946 rehydrated tasks, "recovery: complete, sweep stopped" — and 0 validations, because every
        // one of those txs was 'covered' by validators that were gone. Intersect with the live lead set so
        // coverage means coverage. Falls back to accepting any non-placeholder holder when no live-lead
        // resolver is wired (tests, static validationLeaders), preserving the previous behaviour there.
        const liveNow = (typeof this.getLiveLeaders === 'function' ? this.getLiveLeaders() : null);
        const liveSet = Array.isArray(liveNow) && liveNow.length ? new Set(liveNow) : null;
        const realHolders = this.taskManager.getKnownLeaderIds()
          .filter(id => !isPlaceholder(id))
          .filter(id => !liveSet || liveSet.has(id))
          .filter(id => this.taskManager.getTasksForLeader(id).some(t => t.task.startsWith(`${rawTxId}:`)));
        if (realHolders.length >= this._requiredFor(rawTxId)) continue;   // this tx's real set, not a node-count floor
        if (!this.rawTxToId.has(rawTxId)) this.rawTxToId.set(rawTxId, leaderId);
        try {
          const leaders = this._getValidationLeaders(this.rawTxToId.get(rawTxId));
          // RE-RECORD THE SET, DON'T JUST RE-ASSIGN THE TASKS. rawTxLeaders was written once at
          // addRawTransaction and never again, while _requiredFor reads it — so a tx admitted while three
          // leads were live kept REQUIRING three after two of them vanished. Recovery then dutifully rebuilt
          // a 1-member task set for a tx whose requirement still said 3, and it stalled at 1/3 forever.
          // (Measured: 471 such txs on one box, 180 still in the raw pool, 0 cubes for 20h.) Recovery only
          // runs when realHolders < required, so this can only ever shrink the requirement toward the
          // validators that ACTUALLY exist — which is the stated rule ("requiredValidations is a CAP ... never
          // a floor", see _getValidationLeaders). It never raises one, so it cannot false-quorum a tx.
          if (leaders.length) this._recordLeaders(rawTxId, leaders);
          const tasks = this.taskManager.createTasks(rawTxId, leaders);
          this.taskManager.assignTasks(rawTxId, tasks);   // idempotent
          this.emit('validation_tasks:created', { rawTxId, tasks });
          recovered++;
          if (recovered >= maxPerPass) {
            console.log(`[XPC] stranded-pool recovery: pass capped at ${maxPerPass}, continuing next sweep`);
            return recovered;
          }
        } catch { /* leave this one stranded rather than half-assign */ }
      }
    }
    if (recovered) console.log(`[XPC] stranded-pool recovery: assigned validation tasks for ${recovered} raw tx(s)`);
    return recovered;
  }

  // THE THRESHOLD IS ONLY EVER CHECKED INSIDE completeValidation — so a tx that ALREADY holds enough
  // attestations sits in the raw pool forever if the comparison never runs again. Two ways in: a restart
  // (attestations are persisted in the mempool, the in-memory rawTxLeaders that drives _requiredFor is not,
  // so a tx reloads already at or above its requirement and nothing looks), and a shrinking validator set (a
  // tx that needed 3 needs 1 once the other two leads are gone, and no new validation will ever arrive to
  // trigger the check). Both were live here: 180 raw txs each carrying their own validator's attestation,
  // requirement 1, promoted by nothing. This is the missing re-evaluation — pure promotion, it never creates
  // or counts an attestation, so it can only release txs that already met the same test completeValidation
  // applies. Returns how many it moved, so a caller logs a number instead of asserting a state.
  async promoteSatisfiedRawTxs() {
    // NOT REENTRANT, and the guard is load-bearing. The sweep fires this on an interval; the processingTx
    // check below happens BEFORE an `await moveToProcessing`, so two overlapping passes could both clear it
    // for the same tx and both finalize it — two handleFinalizedTx calls, two addSealedBatch calls, and TWO
    // pool entries for one transaction, because ledger.addSealedBatch pushes onto _membershipPool without
    // deduping by block id (the `this.blocks.set(block.id, ...)` above it silently overwrites instead).
    // That is not a cosmetic over-count: candidatePrefix sorts the WHOLE unsealed pool and takes the lowest
    // 9, so a submitter holding phantom entries its peers do not can never produce their set-hash. MEASURED
    // on the container testnet: the submitter ended with 81 blocks from 69 finalizations while its peers sat
    // at ~59 with pooled 5 — three ledgers, three cube-set digests, L1 permanently unable to agree.
    if (this._promoting) return 0;
    this._promoting = true;
    try {
      return await this._promoteSatisfiedRawTxs();
    } finally { this._promoting = false; }
  }

  async _promoteSatisfiedRawTxs() {
    let promoted = 0;
    for (const [, pool] of [...this.mempool.rawTx]) {
      for (const rawTxId of [...pool.keys()]) {
        if (this._processedRawTxIds.has(rawTxId)) continue;
        if (this.mempool.processingTx.has(rawTxId)) continue;
        // A second, per-tx claim taken BEFORE the await. The in-flight guard above stops two sweep passes
        // overlapping; this stops any other caller (a future direct invocation, a retry path) racing the same
        // tx through the same window. Claim first, act second — the same discipline ValidationWorker uses.
        if (!this._promotingIds) this._promotingIds = new Set();
        if (this._promotingIds.has(rawTxId)) continue;
        this._promotingIds.add(rawTxId);
        // FORK GUARD for the pre-existing pool. A tx admitted before validationLeaders was persisted has no
        // recorded set, and _requiredFor's absent-set fallback is 1 — true on a solo node, a fork generator
        // on a mesh (we would promote and admit blocks peers still holding the 3-member set do not, and the
        // legacy local-9 seal turns divergent block sets into divergent face membership). So a tx whose set
        // is UNKNOWN is promoted only when this node is demonstrably the only validator there is; a tx whose
        // set is KNOWN is judged against that set, mesh or not. New txs always carry a recorded set, so this
        // clause only ever applies to the backlog that predates it.
        if (!this.rawTxLeaders.has(rawTxId)) {
          const live = (typeof this.getLiveLeaders === 'function' ? this.getLiveLeaders() : null) || [];
          if (live.length > 1) { this._promotingIds.delete(rawTxId); continue; }
        }
        const have = this._getValidationCount(rawTxId);
        const need = this._requiredFor(rawTxId);
        if (have < need) { this._promotingIds.delete(rawTxId); continue; }
        try {
          console.log(`[XPC] promote: ${rawTxId} already holds ${have}/${need} — moving to processing`);
          await this.moveToProcessing(rawTxId);
          promoted++;
        } catch { /* one bad tx must not stop the sweep */ }
        finally { this._promotingIds.delete(rawTxId); }
      }
    }
    if (promoted) console.log(`[XPC] promoted ${promoted} raw tx(s) that already satisfied their validation requirement`);
    return promoted;
  }

  // Recovery at boot runs before presence gossip has populated the peer registry, so the live-lead set is just
  // [self]. Re-run as peers arrive, and stop as soon as a pass finds nothing left to assign. Bounded so a
  // permanently-solo node does not retry forever.
  // THE PADDER IS GONE (see _getValidationLeaders), and with it the reason this sweep waited for a peer count:
  // [self] is a complete, valid validator set under user-as-validator, so recovery must run on a solo node
  // instead of gating on live.length >= requiredValidations and leaving the pool stranded until peers show up.
  startStrandedRecoverySweep(opts = {}) {
    const intervalMs = opts.intervalMs ?? Number(process.env.XPC_RECOVERY_SWEEP_MS) ?? 15000;
    const maxPasses = opts.maxPasses ?? Number(process.env.XPC_RECOVERY_MAX_PASSES) ?? 40;
    let passes = 0;
    // async because it AWAITS the promote pass (see below); setInterval ignores the returned promise, and the
    // in-flight guard inside promoteSatisfiedRawTxs is what actually prevents two passes overlapping.
    const tick = async () => {
      passes++;
      const live = (typeof this.getLiveLeaders === 'function' ? this.getLiveLeaders() : []) || [];
      {
        // DRAIN FIRST. Recovering a pool that is mostly provably-invalid is pure waste — and on a small box it
        // is actively harmful (see the 1GB box that OOM'd building tasks for 13,740 doomed txs).
        this.drainInvalidMempool().catch(() => {});
        const n = this.recoverStrandedRawTxs();
        // Promote BEFORE deciding the sweep is done: a tx that is already satisfied is not "stranded" by
        // recoverStrandedRawTxs's test, so a sweep that only counted recoveries declared itself complete
        // while the pool was still full of txs one comparison away from processing.
        // AWAITED, not fired. A floating promise here let tick N+1 start while tick N was still walking the
        // pool — the overlap the in-flight guard now also refuses. Awaiting is the honest fix: the tick is
        // already async and nothing downstream depends on it returning fast.
        const p = await this.promoteSatisfiedRawTxs().catch(() => 0);
        if (n === 0 && p === 0 && this._recoverySweep) {
          clearInterval(this._recoverySweep); this._recoverySweep = null;
          console.log('[XPC] stranded-pool recovery: complete, sweep stopped');
        }
        if (n === 0) return;
      }
      if (passes >= maxPasses) { clearInterval(this._recoverySweep); this._recoverySweep = null;
        console.log(`[XPC] stranded-pool recovery: sweep gave up after ${passes} passes (live leads ${live.length}/${this.requiredValidations})`); }
    };
    this._recoverySweep = setInterval(tick, intervalMs);
    if (this._recoverySweep.unref) this._recoverySweep.unref();
    return this._recoverySweep;
  }

  // POSITIVELY-INVALID PREDICATE — the ONE test used at ingress, at validation, and by the drain, so the three
  // can never drift apart. Drift is the fork: a node rejecting a tx the others seal loses that cube forever.
  //
  // Returns true ONLY when the tx carries sig+from, its key RESOLVES, and verification returns false. It is
  // deliberately false for: unsigned txs (handled separately by the presence check), unresolved keys (cannot
  // prove invalid -> admit), and any throw. That asymmetry is what keeps it fork-safe — an earlier guard that
  // rejected on unresolved keys blackholed legitimate identities holding older SPKI-DER keys.
  //
  // Fork-safety: a tx this rejects would have failed validation on every node and could never have sealed, so
  // refusing it early cannot cost this node a cube.
  async _isPositivelyInvalid(txData) {
    if (!(txData && txData.sig && txData.from)) return false;
    if (typeof this.getPublicKeyByAddress !== 'function') return false;
    let publicKey = null;
    try { publicKey = this.getPublicKeyByAddress(txData.from); } catch { return false; }
    if (!publicKey) return false;
    try {
      const { Identity } = await import('@xmbl/identity');
      return (await Identity.verifyTransaction(txData, publicKey)) === false;
    } catch { return false; }
  }

  // Remove a raw tx from BOTH the in-memory tier and LevelDB. Without this a failed validation left the tx in
  // the pool and validation-retry re-chewed it forever — which is how one stale coordinator
  // (xmbc3d2a9792ed66d53c8db961f884484ef7a4441de) accumulated 13,737 entries on one box and 15,955 on another.
  // Failure with no eviction path is the churn.
  async _evictRawTx(rawTxId) {
    const leaderId = this.rawTxToId.get(rawTxId);
    if (leaderId != null) {
      this.mempool.rawTx.get(leaderId)?.delete(rawTxId);
      await this.mempool._deleteRawTx(leaderId, rawTxId);
    }
    this.rawTxToId.delete(rawTxId);
    this.taskManager.clearTasksForRawTx?.(rawTxId);
  }

  // Clears the pre-guard backlog that _loadState reloads from LevelDB on every boot. Must run AFTER the peer
  // registry populates, or getPublicKeyByAddress resolves nothing and the predicate is vacuously false.
  async drainInvalidMempool() {
    let evicted = 0, scanned = 0;
    for (const [leaderId, leaderMap] of this.mempool.rawTx) {
      for (const [rawTxId, entry] of leaderMap) {
        scanned++;
        if (entry && await this._isPositivelyInvalid(entry.txData)) {
          leaderMap.delete(rawTxId);
          await this.mempool._deleteRawTx(leaderId, rawTxId);
          this.rawTxToId.delete(rawTxId);
          this.taskManager.clearTasksForRawTx?.(rawTxId);
          evicted++;
        }
      }
    }
    if (evicted) console.log(`[XPC-GUARD] mempool drain: evicted ${evicted} positively-invalid raw tx of ${scanned} scanned`);
    return { scanned, evicted };
  }

  getValidationTasks(rawTxId) {
    const submitterId = this.rawTxToId.get(rawTxId);
    const leaders = this.rawTxLeaders.get(rawTxId) || this._getValidationLeaders(submitterId);
    const allTasks = [];
    leaders.forEach(leaderId => {
      const tasks = this.taskManager.getTasksForLeader(leaderId);
      const relevantTasks = tasks.filter(t => t.task.startsWith(`${rawTxId}:`));
      allTasks.push(...relevantTasks);
    });
    return allTasks;
  }

  // ABANDONED-TX REAPER — the bound that makes unbounded mempool growth structurally impossible.
  //
  // The 2026-08-01 incident: 12,031 raw txs pooled on the main node, ~11,965 from a single coordinator,
  // dating back weeks. Nothing ever removed them. A raw tx leaves the pool on exactly one path today —
  // reaching quorum and sealing (moveToProcessing -> _removeRawTransaction). A tx that CANNOT seal has no
  // exit at all: validation-retry abandons it at XPC_RETRY_MAX_AGE_MS (default 5 min — getStuckRawTxs
  // skips anything older) and nothing re-drives it afterward, yet it stays in the map AND in LevelDB,
  // which _loadState faithfully reloads on every boot. Permanent, compounding, invisible.
  //
  // This reaper closes that path by AGE ALONE, deliberately making no judgment about a tx's validity.
  // An earlier version of this fix rejected txs at ingress whose signature failed verification; it was
  // REMOVED after the verifier was shown to return false for transactions signed by a legitimate
  // identity holding an older SPKI-DER-format key (see README.md). That would have converted a visible
  // clog into silent, fleet-wide loss of valid chain writes. "Our verifier said no" is not "provably
  // invalid", and a mempool bound must not depend on a cryptographic judgment to be safe.
  //
  // Fork-safety: a tx older than maxAgeMs has already been abandoned by validation-retry and can never be
  // re-gossiped or re-driven toward quorum, so it cannot seal on ANY node. Evicting it by the same purely
  // age-based rule everywhere is symmetric and can never cost this node a cube the others seal. Entries
  // with no numeric txTimestamp are never reaped — unknown age is not proof of abandonment.
  async reapAbandonedRawTxs(maxAgeMs) {
    const now = Date.now();
    let evicted = 0;
    for (const [leaderId, pool] of this.mempool.rawTx) {
      for (const [rawTxId, entry] of [...pool]) {
        const ts = entry && entry.txTimestamp;
        if (typeof ts !== 'number') continue;
        if (this._processedRawTxIds.has(rawTxId)) continue;
        if ((now - ts) > maxAgeMs) {
          pool.delete(rawTxId);
          await this.mempool._deleteRawTx(leaderId, rawTxId);   // map AND LevelDB, else _loadState reloads it
          this.rawTxToId.delete(rawTxId);
          evicted++;
        }
      }
    }
    if (evicted) console.log(`[XPC-REAPER] evicted ${evicted} raw txs abandoned past ${maxAgeMs}ms`);
    return evicted;
  }

  async completeValidation(rawTxId, taskId, timestamp = null, signature = null, validatorId = null) {
    // Already-finalized no-op: once a tx moved to processing its rawTx is removed, so this would already fail
    // harmlessly downstream — but short-circuit explicitly so a late/duplicate report on a sealed tx does no work
    // (and can never re-drive it toward a second seal). Belt-and-suspenders alongside the dedup + ingest guard.
    if (this._processedRawTxIds.has(rawTxId)) return false;
    // Use nanosecond timestamp if not provided
    if (!timestamp) {
      timestamp = process.hrtime.bigint(); // Nanoseconds - timestamp when validator received tx to validate
    }
    // Find task leader
    const task = this._findTask(taskId);
    if (!task) return false;

    // Integration: Verify signature if xid available
    if (this.xid) {
      const rawTx = this._getRawTransaction(rawTxId);
      if (rawTx && rawTx.txData && rawTx.txData.sig && rawTx.txData.from) {
        try {
          const { Identity } = await import('@xmbl/identity');
          
          // Look up public key from address (from xid module or identity registry)
          // For now, we'll need to get it from the simulator's identities
          // In production, this would come from an identity registry
          let publicKey = null;
          
          // Try to get public key from lookup function (provided by simulator)
          if (this.getPublicKeyByAddress && typeof this.getPublicKeyByAddress === 'function') {
            publicKey = this.getPublicKeyByAddress(rawTx.txData.from);
          }
          
          // If we have public key, verify signature and address ownership
          if (publicKey) {
            const isValid = await Identity.verifyTransaction(rawTx.txData, publicKey);
            if (!isValid) {
              // EVICT, don't just fail. Returning false alone left the tx pooled and the retry sweep re-chewed
              // it on every pass — the mechanism behind the 13k/15k backlogs. It is provably invalid here, so
              // no node can ever seal it.
              console.warn(`Validation failed for ${rawTxId}: invalid signature or address mismatch — evicting`);
              await this._evictRawTx(rawTxId);
              return false;
            }
          } else {
            // If we can't get public key, skip verification (should not happen in production)
            console.warn('Validation: Could not lookup public key for address:', rawTx.txData.from);
          }
        } catch (error) {
          // If xid module not available, skip verification
          if (error.code !== 'ERR_MODULE_NOT_FOUND') {
            console.warn('Signature verification error:', error.message);
            return false;
          }
        }
      }
    }
    
    // Mark task complete
    this.taskManager.completeTask(task.leaderId, taskId);
    
    // Add validation timestamp with node ID
    // Validators put tx in next mempool by raw hash, append node id and timestamp
    await this._addValidationTimestamp(rawTxId, timestamp, validatorId || task.validatorId || 'unknown');
    
    // Emit validation complete event
    const validationData = {
      rawTxId,
      taskId,
      validatorId: validatorId || task.validatorId || 'unknown',
      timestamp: timestamp ? timestamp.toString() : null
    };
    console.log('[XPC] ===== EMITTING validation:complete =====');
    console.log('[XPC] Validation data:', JSON.stringify(validationData, null, 2));
    this.emit('validation:complete', validationData);
    console.log('[XPC] validation:complete event emitted');
    
    // Check if enough validations
    const validations = this._getValidationCount(rawTxId);
    const need = this._requiredFor(rawTxId);   // this tx's REAL validator set, not a global constant
    console.log(`Validation count for ${rawTxId}: ${validations}/${need}`);
    if (validations >= need) {
      console.log(`Moving transaction ${rawTxId} to processing`);
      await this.moveToProcessing(rawTxId);
    }
    return true;
  }

  async moveToProcessing(rawTxId) {
    // Get raw transaction
    const rawTx = this._getRawTransaction(rawTxId);
    if (!rawTx) {
      console.warn(`moveToProcessing: No rawTx found for ${rawTxId}`);
      return;
    }
    // Mark FINALIZED before we remove the rawTx below, so any later re-ingest/re-gossip of the same tx is a no-op
    // (see the guard in ingestRemoteTransaction) instead of restarting validation on a fresh empty entry.
    this._processedRawTxIds.add(rawTxId);
    
    // Emit event for moving to processing
    this.emit('tx:moved_to_processing', {
      rawTxId,
      txId: rawTx.txData?.id || rawTxId
    });
    console.log(`moveToProcessing: Moving ${rawTxId} to processing with ${rawTx.validationTimestamps?.length || 0} validations`);
    
    // Calculate average timestamp from validators (nanoseconds)
    // Validators return timestamp of when they received tx to validate
    const avgTimestamp = this._averageTimestamps(rawTx.validationTimestamps);
    
    // Create validated hash: hash of (tx data + average timestamp)
    // This is the key for the processing mempool
    const validatedHash = this._hashTransaction({
      ...rawTx.txData,
      validationTimestamp: avgTimestamp
    });
    
    const leaderId = this.rawTxToId.get(rawTxId);
    const processingTxData = {
      rawTxId, // Keep reference to original raw tx
      timestamp: avgTimestamp,
      validationTimestamp: avgTimestamp, // Validator average timestamp (used only at level 1)
      txData: {
        ...rawTx.txData,
        validationTimestamp: avgTimestamp // Include in txData for xclt to use
      },
      sig: rawTx.txData.sig || null, // Leader signs
      leader: leaderId,
      validatorTimestamps: rawTx.validationTimestamps // Keep track of validator timestamps
    };
    
    // Key processing mempool by validated hash (tx data + avg timestamp)
    this.mempool.processingTx.set(validatedHash, processingTxData);
    await this.mempool._saveProcessingTx(validatedHash, processingTxData);
    
    // Remove from raw_tx_mempool
    await this._removeRawTransaction(rawTxId);
    
    console.log('[XPC] ===== EMITTING tx:processing =====');
    const processingData = { 
      txId: validatedHash, 
      rawTxId, 
      validationTimestamp: avgTimestamp ? avgTimestamp.toString() : null
    };
    console.log('[XPC] Processing transaction data:', JSON.stringify(processingData, null, 2));
    this.emit('tx:processing', processingData);
    console.log('[XPC] tx:processing event emitted');
  }

  isInProcessing(rawTxId) {
    // Check if transaction is in processing mempool
    for (const [txId, tx] of this.mempool.processingTx.entries()) {
      if (tx.txData && this._hashTransaction(tx.txData) === rawTxId) {
        return true;
      }
    }
    return false;
  }

  getProcessingTransaction(txId) {
    return this.mempool.processingTx.get(txId) || null;
  }

  /**
   * Finalize transaction - moves to tx_mempool for ledger inclusion
   * 
   * HASH-BASED SORTING:
   * - Transactions are added to xclt ledger which forms blocks
   * - 9 blocks form a face (sorted by hash, positions 0-8)
   * - 3 faces form a cube (sorted by hash, face indices 0-2)
   * - 9 cubes form a higher-level face (sorted by hash)
   * - 3 faces form a higher-level cube (sorted by hash)
   * - This continues recursively - cubes never stop growing
   * - Validator average timestamps only used at level 1 for ordering
   * - Higher levels use pure hash-based sorting (no timestamps)
   */
  async finalizeTransaction(validatedHash) {
    // validatedHash is the key in processing mempool (tx data + avg timestamp)
    const processingTx = this.mempool.processingTx.get(validatedHash);
    if (!processingTx) return false;
    
    // With hash-based sorting, placement is always valid
    // Blocks are sorted by hash when face has 9 blocks
    // Faces are sorted by hash when cube has 3 faces
    
    // Move to final tx_mempool
    // Keyed by validated hash (tx data + avg timestamp)
    this.mempool.tx.set(validatedHash, processingTx.txData);
    // Stamp arrival so the 60s finalized-tx sweep can age it out (mempool.sweepFinalizedTx).
    if (this.mempool._txAt) this.mempool._txAt.set(validatedHash, Date.now());
    await this.mempool._saveTx(validatedHash, processingTx.txData);
    
    // Remove from processing
    this.mempool.processingTx.delete(validatedHash);
    if (this.mempool._dbOpen) {
      try {
        await this.mempool.db.del(`processingTx:${validatedHash}`);
      } catch (error) {
        // Ignore delete errors
      }
    }
    
    // Unlock UTXOs
    const utxos = this._extractUtxos(processingTx.txData);
    await this.mempool.unlockUtxos(utxos);
    
    // Ensure txData has id property for xclt
    const txDataWithId = {
      ...processingTx.txData,
      id: validatedHash
    };
    
    // Emit finalized event - xclt will add this to ledger
    // Blocks are sorted by hash when face has 9 blocks
    // Faces are sorted by hash when cube has 3 faces
    console.log('[XPC] ===== EMITTING tx:finalized =====');
    
    // Convert BigInt values in txData to strings for serialization
    function serializeBigInt(obj) {
      if (obj === null || obj === undefined) return obj;
      if (typeof obj === 'bigint') return obj.toString();
      if (Array.isArray(obj)) return obj.map(serializeBigInt);
      if (typeof obj === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
          result[key] = serializeBigInt(value);
        }
        return result;
      }
      return obj;
    }
    
    const txDataSerialized = serializeBigInt(txDataWithId);
    
    const finalizedData = { 
      txId: validatedHash, 
      txData: txDataSerialized,
      validationTimestamp: processingTx.validationTimestamp ? processingTx.validationTimestamp.toString() : null // Convert BigInt to string for serialization
    };
    console.log('[XPC] Finalized transaction data:', JSON.stringify(finalizedData, null, 2));
    this.emit('tx:finalized', finalizedData);
    console.log('[XPC] tx:finalized event emitted');
    return true;
  }



  getMempoolStats() {
    let rawCount = 0;
    for (const leaderMempool of this.mempool.rawTx.values()) {
      rawCount += leaderMempool.size;
    }
    
    return {
      raw: rawCount,
      processing: this.mempool.processingTx.size,
      final: this.mempool.tx.size,
      lockedUtxos: this.mempool.lockedUtxo.size
    };
  }

  _extractUtxos(txData) {
    // Extract UTXOs from transaction
    return txData.from ? (Array.isArray(txData.from) ? txData.from : [txData.from]) : [];
  }

  _getValidationLeaders(submitterId = null) {
    const need = this.requiredValidations;
    // Candidate leads: a static override (tests / explicit config) or the LIVE lead-role
    // identity addresses from the peer registry. This replaces the old `this.xn.nodes` branch,
    // which read a property XNNode never had → always fell to the fake leader1/2/3 placeholders
    // and stalled consensus at 1/3.
    let base = [];
    if (this.validationLeaders && Array.isArray(this.validationLeaders) && this.validationLeaders.length) {
      base = this.validationLeaders.slice();
    } else if (typeof this.getLiveLeaders === 'function') {
      base = [...new Set((this.getLiveLeaders() || []).filter(Boolean))];
    }
    // user-as-validator (E1): the submitter is always first, then the other live leads (sorted
    // for a stable set — though the submitter also broadcasts this exact set, so receivers match).
    const others = base.filter(a => a !== submitterId).sort();
    let leaders = submitterId ? [submitterId, ...others] : others.slice();
    // ⛔ NO PLACEHOLDER VALIDATORS. This used to pad the set with `leader1/leader2/leader3` until it had
    // `requiredValidations` slots, and no real node ever claims those — so a tx could only ever reach 3/3
    // when three live leads happened to exist, and otherwise sat at 1/3 forever. That is a peer-quorum rule
    // bolted onto a chain that does not have one: ARCHITECTURE.md states it outright — "Not '3 of 3 nodes
    // must validate every transaction'", "the user secures their own transaction". Under user-as-validator
    // the authority to validate belongs to the transaction's OWN user; the other leads are task distribution,
    // not permission. Fabricating validators to fill a quota does not make consensus stronger, it makes
    // sealing impossible below an arbitrary node count and then reports the stall as 1/3, which reads like a
    // network problem and is not one. Measured: a live chain with a resolvable user on every tx, 0 sealed.
    //
    // The set is now exactly the validators that REALLY exist for this tx — the user first, then live leads —
    // and requiredValidations is a CAP on how many are asked, never a floor that must be reached. One node
    // with a resolvable user seals; three live leads still take three, so a real quorum is unchanged.
    return leaders.slice(0, Math.max(1, Math.min(need, leaders.length)));
  }

  // How many validations THIS transaction actually needs: the real validator set for it, capped by
  // requiredValidations. Never a constant — a constant is what made sealing depend on node count.
  _requiredFor(rawTxId) {
    const set = this.rawTxLeaders.get(rawTxId);
    const real = Array.isArray(set) && set.length ? set.length : 1;
    return Math.max(1, Math.min(this.requiredValidations, real));
  }

  _findTask(taskId) {
    // Search every leaderId the task manager actually has tasks under, not
    // just the current _getValidationLeaders() output — that set can differ
    // per rawTxId (submitter-specific), so recomputing it here without the
    // submitterId would fail to find tasks assigned to that submitter.
    for (const leaderId of this.taskManager.getKnownLeaderIds()) {
      const task = this.taskManager.getTask(leaderId, taskId);
      if (task) return task;
    }
    return null;
  }

  async _addValidationTimestamp(rawTxId, timestamp, nodeId) {
    const leaderId = this.rawTxToId.get(rawTxId);
    if (!leaderId) {
      console.warn(`_addValidationTimestamp: No leaderId for ${rawTxId}`);
      return;
    }
    
    const leaderMempool = this.mempool.rawTx.get(leaderId);
    if (!leaderMempool) {
      console.warn(`_addValidationTimestamp: No leaderMempool for ${leaderId}`);
      return;
    }
    
    const rawTx = leaderMempool.get(rawTxId);
    if (rawTx) {
      if (!rawTx.validationTimestamps) {
        rawTx.validationTimestamps = [];
      }
      // DEDUP BY VALIDATOR: the quorum count must be DISTINCT validators, not raw report count. Without this a
      // single validator reporting twice (a duplicate gossip that slipped the app-layer _appliedReports guard, or
      // a re-validated task from a retry/re-gossip) would push validationTimestamps.length past the threshold and
      // FALSE-QUORUM a tx that <requiredValidations distinct validators actually attested. Keep the FIRST report
      // per validator (its timestamp is that validator's real attestation; a re-report is the same logical event).
      // Direction-of-error: if two DISTINCT validators ever collapsed here (only possible in the degenerate
      // 'unknown' fallback — the real paths carry this.identityAddress / the gossip validatorId), the tx merely
      // UNDER-counts and STALLS below quorum — safe (never seals) — never over-counts and seals bad data.
      if (rawTx.validationTimestamps.some(v => v.nodeId === nodeId)) {
        console.warn(`_addValidationTimestamp: duplicate report from ${nodeId} for ${rawTxId} — skipping (count is DISTINCT validators)`);
        return;
      }
      // Store {nodeId, timestamp} so we can track which validator provided which timestamp
      rawTx.validationTimestamps.push({ nodeId, timestamp });
      await this.mempool._saveRawTx(leaderId, rawTxId, rawTx);
      console.log(`Added validation timestamp for ${rawTxId} from ${nodeId}, count: ${rawTx.validationTimestamps.length}`);
    } else {
      console.warn(`_addValidationTimestamp: No rawTx found for ${rawTxId}`);
    }
  }

  _getValidationCount(rawTxId) {
    const leaderId = this.rawTxToId.get(rawTxId);
    if (!leaderId) return 0;
    
    const leaderMempool = this.mempool.rawTx.get(leaderId);
    if (!leaderMempool) return 0;
    
    const rawTx = leaderMempool.get(rawTxId);
    if (!rawTx || !rawTx.validationTimestamps) return 0;
    // Count DISTINCT validators, not raw report length. Dedup-at-write (_addValidationTimestamp) already keeps the
    // array one-per-validator, so this equals .length on the normal path; counting distinct here is defense-in-depth
    // so the quorum decision stays correct even if any future path appends a report without going through the dedup.
    return new Set(rawTx.validationTimestamps.map(v => v.nodeId)).size;
  }

  // Public wrapper for callers outside this module (e.g. ValidationWorker, reporting an "N/3" progress
  // label for a tx it just validated) — same value completeValidation already logs internally, exposed
  // without reaching into the underscore-prefixed internal. (haiku 12a06c2d)
  getValidationCount(rawTxId) { return this._getValidationCount(rawTxId); }

  // 8e91d994 commit-2: READ-ONLY view of raw txs STUCK below quorum, for CORE's validation-retry sweep. State
  // lives here (the mempool + the distinct-validator count); TRANSPORT (gossip re-broadcast) lives in core — this
  // method leaks NO gossip. A tx is "stuck" when it is NOT already finalized, has < requiredValidations DISTINCT
  // validators, and is older than minAgeMs (so the happy path gets first crack before any retry fires). Returns
  // exactly what core needs to re-broadcast the raw tx (txData + the ORIGINAL leaders set, so a validator that
  // missed it rebuilds the identical task set) plus the current count (for logging / give-up decisions).
  getStuckRawTxs(minAgeMs = 5000, maxAgeMs = 300000, now = Date.now()) {
    const out = [];
    for (const [leaderId, leaderMempool] of this.mempool.rawTx) {
      for (const [rawTxId, entry] of leaderMempool) {
        if (this._processedRawTxIds.has(rawTxId)) continue;                 // already sealed
        const distinct = new Set((entry.validationTimestamps || []).map(v => v.nodeId)).size;
        if (distinct >= this.requiredValidations) continue;                 // will seal on the next report — not stuck
        const age = entry.txTimestamp ? (now - entry.txTimestamp) : Infinity;
        if (age < minAgeMs) continue;                                       // too fresh — give the happy path time
        if (age > maxAgeMs) continue;                                       // too old — ABANDONED, stop retrying (bounds the retry/report bookkeeping to a finite window; a genuinely un-validatable tx is not chased forever)
        out.push({
          rawTxId,
          submitterId: leaderId,
          txData: entry.txData,
          leaders: this.rawTxLeaders.get(rawTxId) || null,
          distinctValidations: distinct,
          required: this.requiredValidations,
        });
      }
    }
    return out;
  }

  // Read-only: has this tx already moved to processing/sealed? Lets core prune its stored self-reports for sealed
  // txs without reaching into workflow internals.
  isProcessed(rawTxId) { return this._processedRawTxIds.has(rawTxId); }

  _getRawTransaction(rawTxId) {
    const leaderId = this.rawTxToId.get(rawTxId);
    if (!leaderId) return null;
    
    const leaderMempool = this.mempool.rawTx.get(leaderId);
    if (!leaderMempool) return null;
    
    return leaderMempool.get(rawTxId) || null;
  }

  async _removeRawTransaction(rawTxId) {
    const leaderId = this.rawTxToId.get(rawTxId);
    if (!leaderId) return;
    
    const leaderMempool = this.mempool.rawTx.get(leaderId);
    if (leaderMempool) {
      leaderMempool.delete(rawTxId);
      await this.mempool._deleteRawTx(leaderId, rawTxId);
    }
    this.rawTxToId.delete(rawTxId);
  }

  _averageTimestamps(validationTimestamps) {
    // validationTimestamps is array of {nodeId, timestamp}
    if (!validationTimestamps || validationTimestamps.length === 0) {
      return process.hrtime.bigint(); // Return nanosecond timestamp
    }
    
    // Extract timestamps (handle both {nodeId, timestamp} objects and plain timestamps)
    const timestamps = validationTimestamps.map(ts => 
      typeof ts === 'object' && ts.timestamp ? ts.timestamp : ts
    );
    
    // Handle both bigint (nanoseconds) and number (milliseconds) timestamps
    const sum = timestamps.reduce((a, b) => {
      const aVal = typeof a === 'bigint' ? a : BigInt(a * 1000000); // Convert ms to ns
      const bVal = typeof b === 'bigint' ? b : BigInt(b * 1000000);
      return aVal + bVal;
    }, BigInt(0));
    return sum / BigInt(timestamps.length); // Return as bigint (nanoseconds)
  }

  _hashTransaction(tx) {
    // Serialize BigInt values before stringifying
    const serialized = this._serializeBigInts(tx);
    const txStr = JSON.stringify(serialized);
    return createHash('sha256').update(txStr).digest('hex');
  }

  _serializeBigInts(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'bigint') return obj.toString();
    if (Array.isArray(obj)) return obj.map(item => this._serializeBigInts(item));
    if (typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this._serializeBigInts(value);
      }
      return result;
    }
    return obj;
  }
}

