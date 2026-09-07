import { Identity } from '@xmbl/identity';
import { XNNode } from '@xmbl/networking';
import { Ledger } from '@xmbl/cubic-ledger';
import { StateMachine } from '@xmbl/state-machine';
import { ConsensusWorkflow, ConsensusGossip, ValidationWorker, runValidationRetryTick, SealRoundManager, sealSetHash } from '@xmbl/consensus';
import { StorageNode, MarketPricing, ComputeNode } from '@xmbl/storage-compute';
import { LeadWorker } from './lead-worker.js';

// SINGLE SOURCE OF TRUTH for mainnet-readiness. While true, an XMBL_PROFILE=mainnet boot
// is refused (see start()'s safety gate) because the protocol's ⛔ AUDIT gates in
// MAINNET-GATES.md are still open (unaudited MAYO fork + novel cubic-curve construction).
// Flipping this to false is the reviewed code change that opens mainnet — make it ONLY when
// every ⛔ AUDIT gate in MAINNET-GATES.md is genuinely closed.
export const AUDIT_GATES_OPEN = true;

// LIVE means live. Filters the presence registry to lead-role addresses that are BOTH permitted (allowlist)
// and FRESH (seen within ttlMs). `self` is always eligible: a node never gossips presence to itself, so its
// own lastSeen is stamped once at construction and never refreshed — ageing it out would be nonsense. Falls
// back to [self] when nothing qualifies, because a node alone is still a complete validator set under
// user-as-validator (see xpc _getValidationLeaders). `now` is a parameter so this is testable without clocks.
export function liveLeadsFrom(peerRegistry, self, leadAllowlist, ttlMs, now = Date.now()) {
  const leads = [...peerRegistry.entries()]
    .filter(([a, v]) => v && v.roles && v.roles.lead && (!leadAllowlist || leadAllowlist.has(a)))
    .filter(([a, v]) => a === self || (now - (v.lastSeen || 0)) < ttlMs)
    .map(([a]) => a);
  return leads.length ? leads : [self];
}

export class XMBLCore {
  constructor(config = {}) {
    this.config = config;
    // CONSENSUS-V2 (ab5932a5): agree-before-seal (2b) + the commit-2 retry, one atomic flag. Read ONCE here so the
    // Ledger seals via cross-node agreement (not local-count) and the retry sweep both key off the same switch.
    // OFF (default) = today's local-seal, prod byte-unchanged.
    this._consensusV2 = process.env.XPC_CONSENSUS_V2 === '1';

    // Initialize network first
    this.xn = new XNNode(config.network || {});

    // Initialize identity system
    this.xid = null; // Will be set when identity is created

    // Initialize ledger with network integration
    this.xclt = new Ledger({
      dbPath: config.ledger?.dbPath,
      xn: this.xn,
      xid: this.xid,
      consensusV2: this._consensusV2
    });

    // Initialize state machine with ledger integration
    this.xvsm = new StateMachine({
      totalShards: config.stateMachine?.totalShards,
      dbPath: config.stateMachine?.dbPath,
      xclt: this.xclt
    });

    // E4 (lead role): opt-in via roles.lead. Constructed HERE (not in
    // start(), unlike E1/E3) because ConsensusWorkflow's tx:finalized
    // listener — wired in its own constructor, right below — needs the
    // batchSealer callback at construction time, not after.
    this.leadBatchesSealed = 0;
    this.leadWorker = this.config.roles?.lead
      ? new LeadWorker({ xclt: this.xclt, onBatchSealed: (n) => { this.leadBatchesSealed += n; } })
      : null;

    // Initialize consensus workflow with integrations. Thread the consensus
    // dbPath so its mempool LevelDB lives under the configured data_dir instead
    // of leaking to ./data/xpc relative to cwd.
    this.xpc = new ConsensusWorkflow({
      dbPath: config.consensus?.dbPath,
      xid: this.xid,
      xclt: this.xclt,
      xn: this.xn,
      batchSealer: this.leadWorker ? (txData) => this.leadWorker.handleFinalizedTx(txData) : null,
    });

    // Now that xpc exists, wire the lead worker's OTHER job: driving
    // tx:processing -> finalizeTransaction. Nothing else in the daemon calls
    // finalizeTransaction (only xsim's simulator does, standing in for a
    // leader in local dev sims) — without this, a lead node's own processed
    // txs would sit unfinalized forever.
    if (this.leadWorker) {
      this.leadWorker.start(this.xpc);
    }

    // Gossip is constructed after xn.start() (see start()) — its constructor
    // only subscribes to its topic if xn.started is already true, and xn is
    // never started yet at this point in the constructor.
    this.gossip = null;

    // E1 (validate role): honest 0 until the validate role is enabled and a
    // validation actually completes — see metrics-server.js's collectMetrics.
    this.validationsCompleted = 0;
    this.validationWorker = null;
    // Per-tx validation EVENTS (distinct from the validationsCompleted counter above): a bounded ring of
    // the most recent genuine passes, so a viz can show WHICH tx this node just validated, not just a
    // rising number. Never grows unbounded — oldest entries drop as new ones arrive.
    this.recentValidations = [];
    // E3 (compute role): constructed after xn.start() too, for the same
    // reason — its xn-topic subscription only takes effect if xn.started is
    // already true. Opt-in via roles.compute (see start()).
    this.computeNode = null;

    // Initialize storage and compute
    this.pricing = new MarketPricing();
    this.xsc = new StorageNode({
      capacity: config.storage?.capacity,
      dbPath: config.storage?.dbPath,
      xn: this.xn,
      xpc: this.xpc,
      xclt: this.xclt
    });
  }
  
  async start() {
    // MAINNET SAFETY GATE. On a mainnet profile (XMBL_PROFILE=mainnet), refuse to boot
    // while the protocol's ⛔ AUDIT gates in MAINNET-GATES.md are open. This makes that
    // file load-bearing instead of merely documented: the node cannot silently run as
    // mainnet on unaudited crypto (the MAYO fork + the novel cubic-curve construction).
    //
    // There is deliberately NO environment override. An "I acknowledge it's unaudited"
    // flag would just be a checkbox that lets someone run unaudited crypto against real
    // value — the exact outcome this gate exists to prevent. The ONLY way to open mainnet
    // is to flip AUDIT_GATES_OPEN to false in source, which is a reviewed code change made
    // when the audits in MAINNET-GATES.md actually close. Non-mainnet profiles
    // (dev/testnet, the default) are unaffected.
    if (process.env.XMBL_PROFILE === 'mainnet' && AUDIT_GATES_OPEN) {
      throw new Error(
        'XMBL mainnet boot refused: the protocol\'s security audits are not complete.\n' +
        'Load-bearing crypto (the MAYO fork and the novel cubic-curve construction) is\n' +
        'UNAUDITED — see the ⛔ AUDIT gates in MAINNET-GATES.md. Run a non-mainnet profile,\n' +
        'or close those gates and set AUDIT_GATES_OPEN=false in packages/core/index.js.',
      );
    }

    // Start network
    await this.xn.start();

    // Now that xn is started, construct gossip so its constructor's
    // subscribe-if-started check actually subscribes to the topic.
    this.gossip = new ConsensusGossip({
      xn: this.xn
    });

    // E3: opt-in (roles.compute) compute-provider role. Same xn.started
    // requirement as gossip above — construct it here, not in the
    // constructor, so its job-request topic subscription actually takes.
    if (this.config.roles?.compute) {
      this.computeNode = new ComputeNode({
        xn: this.xn,
        maxTime: this.config.compute?.cpuMs,
        maxMemory: (this.config.compute?.memMb ?? 512) * 1024 * 1024,
      });
    }

    // Create default identity if needed
    if (!this.xid) {
      this.xid = await Identity.create();
      // Update references
      this.xclt.xid = this.xid;
      this.xpc.xid = this.xid;
    }

    // E1: opt-in (roles.validate) worker that claims + completes this node's
    // own validation tasks (user-as-validator). Needs this.xid.address, so it
    // starts after identity is resolved above.
    if (this.config.roles?.validate) {
      const RECENT_VALIDATIONS_MAX = 50;
      this.validationWorker = new ValidationWorker({
        workflow: this.xpc,
        identityAddress: this.xid.address,
        onValidationCompleted: ({ rawTxId, taskId, count, required } = {}) => {
          this.validationsCompleted += 1;
          // `count`/`required` give consumers (e.g. the activity timeline) an "N/3" progress label — omitted
          // entirely rather than a fabricated 0 when the workflow couldn't report a count for some reason.
          this.recentValidations.push({
            tx_id: rawTxId, task_id: taskId, validator: this.xid.address, ts: Date.now(),
            ...(typeof count === 'number' ? { count } : {}),
            ...(typeof required === 'number' ? { required } : {}),
          });
          if (this.recentValidations.length > RECENT_VALIDATIONS_MAX) this.recentValidations.shift();
        },
      });
      this.validationWorker.start();
    }

    // Wire the DISTRIBUTED consensus round-trip (presence discovery + cross-node validation).
    // Without this, a submitted tx only ever gets its submitter's own 1 validation and never
    // reaches the 3-of-3 quorum, so nothing seals — regardless of how many peers connect.
    this._setupConsensusNetwork();
    // Stranded-pool recovery must wait for presence gossip to populate the peer registry — at boot the
    // live-lead set is just [self] and validation slots fall back to placeholders no node claims.
    this.xpc?.startStrandedRecoverySweep?.();
    // CUBE SYNC — the catch-up that never existed. A node that missed a seal round could never acquire that
    // cube; three boxes ended up with three different 14-cube sets. Verification is self-certifying (the
    // receiver recomputes the cube id from the payload), so this needs no allowlist and no trusted peer.
    (async () => {
      try {
        const { CubeSyncManager } = await import('@xmbl/cubic-ledger');
        this.cubeSync = new CubeSyncManager({ xn: this.xn, ledger: this.xclt, nodeId: this.xid?.address || 'node' });
        await this.cubeSync.start();
      } catch (e) { console.warn('[XCS-SYNC] not started:', e.message); }
    })();
    // Drain the pre-guard backlog. Deferred because the predicate needs the peer registry populated —
    // getPublicKeyByAddress resolves nothing at boot, which would make the check vacuously false.
    for (const delay of [20000, 60000, 180000]) {
      const t = setTimeout(() => { this.xpc?.drainInvalidMempool?.().catch(() => {}); }, delay);
      if (t.unref) t.unref();
    }

    // MEMPOOL REAPER — started UNCONDITIONALLY, deliberately NOT beside the retry sweep.
    // The retry sweep is gated behind XPC_CONSENSUS_V2 because it and the agreement-seal are one atomic
    // consensus unit. The reaper is not part of that unit and must never inherit its gate: it is the only
    // thing bounding raw-mempool growth, so wiring it behind a consensus feature flag would mean flipping
    // that flag off silently removes the bound and the pool grows forever again (2026-08-01: 12k txs).
    this._startMempoolReaper();

    // XZK cube-commitment (opt-in XZK_COMMIT=1). ADDITIVE + NON-BLOCKING + NOT consensus-load-bearing (xzk is
    // experimental/unaudited): on each sealed face, commit the cube's coordinate curve and prove a derived point.
    await this._setupZkCommit();

    console.log('XMBL Core started');
    console.log(`Network node: ${this.xn.getPeerId()}`);
    console.log(`Identity: ${this.xid.address}`);
  }

  // Presence discovery + the cross-node validate→report→count loop. Fully peer-to-peer: every
  // node gossips its own {address, publicKey, roles}, builds an identical registry, and counts
  // every peer's validation toward its OWN quorum. No central directory, no coordinator.
  _setupConsensusNetwork() {
    const self = this.xid.address;
    this.peerRegistry = new Map();           // address -> { publicKey, roles, lastSeen }
    this.peerRegistry.set(self, { publicKey: this.xid.publicKey, roles: this.config.roles || {}, lastSeen: Date.now() });
    this._appliedReports = new Set();        // `rawTxId:validatorId` already counted (dedupe floodsub dups)
    this._pendingReports = new Map();        // reports that arrived before their tx did
    this._ingested = new Set();              // `submitter:sig` already ingested
    this._myReports = new Map();             // rawTxId -> OUR OWN {rawTxId,taskId,validatorId,timestamp} — for idempotent re-gossip (8e91d994 commit-2)

    // OPT-IN consensus-membership allowlist: XPC_LEAD_ALLOWLIST=<addr>,<addr>,...
    // UNSET (the default) ⇒ every lead-role peer counts, i.e. byte-identical to the previous behaviour.
    //
    // Env, not config.json, and deliberately so: node-config.js validateConfig REJECTS unknown top-level
    // keys and loadConfig THROWS on the error, so a new config section would not be ignored — it would
    // refuse to boot until the schema (which that file documents as vendored from upstream and required to
    // stay in sync) was changed too. Every other consensus knob here is already env — XPC_CONSENSUS_V2,
    // XPC_SEAL_ROUND_MS, XPC_RETRY_MAX_AGE_MS — so this follows the established idiom. Read ONCE at wiring
    // time, like XPC_CONSENSUS_V2 at :15: changing it on a running process does nothing, it takes effect on
    // (re)start, and it must therefore be present in that restart's launch environment (pm2 save / dump.pm2)
    // or a reboot silently drops it.
    //
    // Why this exists. `lead` is SELF-DECLARED: a peer announces roles.lead in its own presence gossip and
    // every receiver takes it at face value, so the live-lead set is whoever shows up claiming the role —
    // including a node running code that cannot hold up its end. That is not hypothetical. On prod the set
    // reached SIX, and both consumers of it broke in different directions:
    //   * _getValidationLeaders (xpc/src/workflow.js:403) returns [submitter, ...others.sort()].slice(0, 3),
    //     so with six leads the two non-submitter slots go to whichever addresses sort lowest. Those were two
    //     REMOTE nodes on a pre-fix core; the two co-located helpers running the correct code were never
    //     handed a task at all and validated nothing, however healthy their peering looked.
    //   * _sealQuorum() below is floor(n/2)+1 over this same set: six leads ⇒ 4, while only three nodes run
    //     the v2 seal rounds. At most three matching proposals can ever exist, so decideRound stalls forever.
    // Both are the same root fault — counting a node as a consensus participant on nothing but its own say-so.
    // Fixing it at the two call sites would leave the rule in two places and let them drift apart again (they
    // already disagree: xpc.requiredValidations is a hardcoded 3), so the constraint belongs HERE, where
    // membership is computed, once. Everything downstream inherits it consistently.
    //
    // The allowlist is a FILTER, never a source: an address must still be present in the registry with
    // roles.lead to count, so allowlisting a node that is down or not announcing adds nothing. `self` remains
    // the floor — a node is never left with an empty lead set — which also means allowlisting only unreachable
    // peers degrades to solo operation rather than to a hang.
    const allowlistRaw = String(process.env.XPC_LEAD_ALLOWLIST || '').split(',').map((a) => a.trim()).filter(Boolean);
    const leadAllowlist = allowlistRaw.length ? new Set(allowlistRaw) : null;
    this._leadAllowlist = leadAllowlist ? [...leadAllowlist] : null;   // surfaced by the control socket's `leaders` op
    if (leadAllowlist) {
      console.log(`[consensus] XPC_LEAD_ALLOWLIST ACTIVE (${leadAllowlist.size} addresses) — only these count toward validation-leader selection and seal quorum`);
    }

    // xpc resolves leaders + submitter public keys from the LIVE registry.
    // NOTE the asymmetry: public-key resolution reads the FULL registry, unfiltered. The allowlist scopes who
    // may VALIDATE, not whose signatures we can verify — narrowing the key lookup would break verification of
    // txs submitted by non-allowlisted peers, which we still ingest and still relay.
    this.xpc.getPublicKeyByAddress = (addr) => this.peerRegistry.get(addr)?.publicKey || (addr === self ? this.xid.publicKey : null);
    // LIVENESS IS THE WHOLE POINT OF THE NAME, and it was never checked. `lastSeen` was written on every
    // presence and read by NOTHING but the status display, so this filtered on roles.lead alone: every peer
    // this node had EVER seen stayed a validator forever. Once a mesh had come and gone, _getValidationLeaders
    // handed each new tx a 3-member set while ONE validator existed, _requiredFor returned 3, and every tx
    // stalled at 1/3 — moveToProcessing never fired, so tx:processing never fired, so LeadWorker never
    // finalized, so no block was admitted, so the membership pool froze below 9 and NOTHING SEALED.
    // MEASURED on this box before the fix: peer_count 0, mempool.raw 180, processing 0, membership pool stuck
    // at 7/9, pendingfaces 1/3, last cube 2026-08-23T19:33Z (~20h). The node log shows the flip exactly —
    // 2223 txs closed at 1/1 while genuinely solo, then 471 stranded above their real validator count
    // (210 at 0/3, 179 at 0/2, 53 at 1/3, 28 at 2/3), and every validation after the last successful
    // moveToProcessing reads 1/3. A node alone must seal alone; a stale registry is not a quorum.
    // Presence re-announces every 4s (_presenceTimer below), so a lead that has missed several announces is
    // gone, not slow. Self is exempt: it never gossips presence to itself, so its lastSeen never refreshes.
    // Exported as a PURE function (not inlined in the closure) so the regression test drives THE SAME code
    // the node runs. The test that was supposed to cover this — xpc-solo-seals — injected its own
    // getLiveLeaders, so it never touched this filter and stayed green for the entire outage.
    const PRESENCE_TTL_MS = Math.max(8000, Number(process.env.XPC_PRESENCE_TTL_MS) || 20000);
    this.xpc.getLiveLeaders = () => liveLeadsFrom(this.peerRegistry, self, leadAllowlist, PRESENCE_TTL_MS);

    // --- presence gossip ---
    const announce = () => this.gossip.broadcastPresence({ address: self, publicKey: this.xid.publicKey, roles: this.config.roles || {} }).catch(() => {});
    this.gossip.on('presence:received', ({ address, publicKey, roles }) => {
      if (!address || address === self) return;
      this.peerRegistry.set(address, { publicKey, roles: roles || {}, lastSeen: Date.now() });
    });
    this.xn.on('peer:connected', () => announce());   // greet a newly connected peer immediately
    this._presenceTimer = setInterval(announce, 4000);
    if (this._presenceTimer.unref) this._presenceTimer.unref();
    announce();

    // RE-ARM RECOVERY WHEN THE LEAD SET CHANGES. startStrandedRecoverySweep stops itself the first time a pass
    // finds nothing to assign — correct then, wrong forever after: a tx is not stranded only at boot, it becomes
    // stranded the moment the leads it was assigned to go away (or, symmetrically, a solo-assigned tx can take a
    // wider set once peers arrive). With the sweep dead, the 471 txs already carrying a departed set had nothing
    // left that would ever revisit them. The live-lead set is the exact signal — when it changes, re-arm.
    let leadSig = (this.xpc.getLiveLeaders() || []).slice().sort().join(',');
    this._leadWatchTimer = setInterval(() => {
      const sig = (this.xpc.getLiveLeaders() || []).slice().sort().join(',');
      if (sig === leadSig) return;
      console.log(`[consensus] live lead set changed (${leadSig || 'none'} -> ${sig || 'none'}) — re-arming stranded-pool recovery`);
      leadSig = sig;
      if (!this.xpc._recoverySweep) this.xpc.startStrandedRecoverySweep?.();
    }, 5000);
    if (this._leadWatchTimer.unref) this._leadWatchTimer.unref();

    // --- a peer's raw tx: replicate it locally + validate the task addressed to us ---
    this.gossip.on('raw_tx:received', async ({ leaderId, tx, leaders }) => {
      if (!tx || leaderId === self) return;             // our own submission is already in our mempool
      // Per-tx dedup key. A CONTENT-ADDRESSED tx (type-6) is UNSIGNED, so `tx.sig` is empty and EVERY such tx
      // from a leader would collapse to `${leaderId}:` — only the first ingests, the rest are dropped as false
      // "duplicates" and never validate on peers (no cross-node quorum → no seal). Prefer the stable 06 content
      // address `tx.xid` (unique per distinct tx, identical across nodes by construction); signed txs keep `tx.sig`.
      const dedup = `${leaderId}:${tx.xid || tx.sig || ''}`;
      if (this._ingested.has(dedup)) return;
      this._ingested.add(dedup);
      try {
        const rawTxId = await this.xpc.ingestRemoteTransaction(leaderId, tx, leaders);
        this._flushPendingReports(rawTxId);             // apply any reports that beat the tx here
      } catch (e) { /* malformed / duplicate — ignore */ }
    });

    // --- broadcast OUR validation results so every peer can count them ---
    if (this.validationWorker) {
      this.validationWorker.on('validation:reported', ({ rawTxId, taskId, validatorId, timestamp }) => {
        this._appliedReports.add(`${rawTxId}:${validatorId}`);   // ours is already counted locally
        // STORE our own report verbatim so the retry sweep can RE-GOSSIP THIS EXACT report (same timestamp) — an
        // idempotent re-attestation. NEVER re-run validation to regenerate it (a fresh Date.now() would give the
        // same validator a second, different timestamp → validatorAverageTimestamp → validatedHash DIVERGES across
        // nodes → seal disagreement). The timestamp is minted once, here-carried, forever.
        this._myReports.set(rawTxId, { rawTxId, taskId, validatorId, timestamp });
        // TEST-ONLY force-drop (XMBL_TEST_DROP_FIRST_REPORT): simulate a lost gossip by SKIPPING the FIRST outbound
        // broadcast of each report on this node, so the tx stalls below quorum and the retry sweep must recover it
        // by re-gossiping the STORED report (same timestamp). This is the integration gate for commit-2 — it proves
        // the retry recovers AND all nodes seal the IDENTICAL cube. INERT in prod (env unset); it never touches our
        // local count (_appliedReports already added above) nor the stored report (already set) — only whether peers
        // hear THIS report the first time. Drops once per rawTxId, then normal broadcast resumes.
        if (process.env.XMBL_TEST_DROP_FIRST_REPORT) {
          if (!this._droppedFirstReport) this._droppedFirstReport = new Set();
          if (!this._droppedFirstReport.has(rawTxId)) {
            this._droppedFirstReport.add(rawTxId);
            console.log(`[TEST] XMBL_TEST_DROP_FIRST_REPORT: dropped first report broadcast for ${rawTxId} — retry sweep must recover it`);
            return;
          }
        }
        // TEST-ONLY random-drop (XMBL_TEST_DROP_RANDOM=<prob 0..1>): drop THIS outbound report with the given
        // probability — PARTIAL, non-uniform message loss. This is diag#2's NEGATIVE CONTROL: run on BASE bytes
        // (consensus v2 OFF → no retry) to answer "does message-loss ALONE fork the base local-seal?" vs the
        // commit-2 force-drop's "does the retry's non-uniform recovery fork?". Partial (not every-first) loss is
        // required: deterministic-every-first + no-retry = total stall (nothing seals, no fork visible). INERT in
        // prod (env unset). Drops the OUTBOUND broadcast ONLY — _appliedReports (local count) + _myReports (stored
        // report) are already set above, untouched. Math.random is fine here: this is node runtime, not a workflow.
        const dropProb = Number(process.env.XMBL_TEST_DROP_RANDOM);
        if (dropProb > 0 && Math.random() < dropProb) {
          console.log(`[TEST] XMBL_TEST_DROP_RANDOM(${dropProb}): dropped report broadcast for ${rawTxId}`);
          return;
        }
        this.gossip.broadcastValidationReport({ rawTxId, taskId, validatorId, timestamp }).catch(() => {});
      });
    }

    // --- CONSENSUS V2 (XPC_CONSENSUS_V2): the retry sweep (commit-2) + the seal-boundary agreement (2b) are ONE
    // ATOMIC UNIT and MUST flip together. The retry recovers stuck txs at NON-UNIFORM times; without 2b's
    // agree-before-seal that non-uniform finalization forks the ledger (proven by the force-drop harness). So the
    // retry is gated behind the SAME flag as the agreement seal: OFF (default) = today's local-seal path, prod
    // unchanged, no retry; ON = retry + agreement-seal together (the only safe combination). Never retry-without-2b.
    // (this._consensusV2 is read once in the constructor — the retry AND the agreement-seal flip together.)
    if (this._consensusV2) { this._startValidationRetrySweep(); this._startSealRounds(); }

    // --- a peer's validation result: count it toward our quorum (dedup + out-of-order safe) ---
    this.gossip.on('validation_report:received', ({ rawTxId, taskId, validatorId, timestamp }) => {
      if (!rawTxId || !validatorId || validatorId === self) return;
      if (this._appliedReports.has(`${rawTxId}:${validatorId}`)) return;
      if (this.xpc.rawTxLeaders && this.xpc.rawTxLeaders.has(rawTxId)) {
        // REPORT-GUARD (advisor): only an ASSIGNED leader's report counts toward the quorum. Makes the
        // node-consistency of the validator set an ENFORCED invariant instead of a topological accident (a
        // spurious/foreign report can't inflate the count). Placed INSIDE the leaders-known branch so a legitimate
        // report arriving BEFORE the leader set is known still buffers below (never wrongly rejected).
        const leaders = this.xpc.rawTxLeaders.get(rawTxId);
        if (Array.isArray(leaders) && !leaders.includes(validatorId)) return;   // not an assigned validator — ignore
        this._applyReport(rawTxId, taskId, timestamp, validatorId);
      } else {
        const q = this._pendingReports.get(rawTxId) || [];
        q.push({ taskId, timestamp, validatorId });
        this._pendingReports.set(rawTxId, q);
      }
    });
  }

  async _applyReport(rawTxId, taskId, timestamp, validatorId) {
    const key = `${rawTxId}:${validatorId}`;
    if (this._appliedReports.has(key)) return;
    this._appliedReports.add(key);
    try { await this.xpc.completeValidation(rawTxId, taskId, timestamp, null, validatorId); }
    catch (e) { this._appliedReports.delete(key); }     // let a retry re-apply
  }

  _flushPendingReports(rawTxId) {
    const q = this._pendingReports.get(rawTxId);
    if (!q) return;
    this._pendingReports.delete(rawTxId);
    for (const r of q) this._applyReport(rawTxId, r.taskId, r.timestamp, r.validatorId);
  }

  // 8e91d994 commit-2 — VALIDATION RETRY SWEEP. A LONE/trickled tx stalls at 1/3–2/3 in mempool.raw because the
  // per-tx validation TASK doesn't reliably reach all validators (floodsub drop / pickup gap) and there was NO
  // retry of an unvalidated raw tx. This periodically finds raw txs stuck below quorum (workflow.getStuckRawTxs —
  // read-only STATE; the TRANSPORT lives HERE where the gossip primitives are) and re-gossips two idempotent things:
  //   (1) the RAW TX (with its ORIGINAL leaders set) — a validator that MISSED its task ingests + validates it ONCE
  //       (its first, correct timestamp). Nodes that already have it skip via _ingested; a SEALED tx is a no-op via
  //       the finalized guard. This never re-runs validation on an already-validated node → C#5 safe.
  //   (2) OUR OWN stored report (the EXACT original {taskId,validatorId,timestamp}) — a node that missed our report
  //       now counts it. Receivers dedup by rawTxId:validatorId, and the timestamp is the one we minted once, so
  //       re-gossip is a pure re-attestation — NEVER a fresh Date.now() (which would diverge validatorAverageTimestamp
  //       → validatedHash across nodes). This is advisor's C#5 invariant, enforced by re-emitting, not re-validating.
  // Bounded: at most MAX_RETRIES re-gossips per tx (a genuinely un-validatable tx is not retried forever). Idle when
  // nothing is stuck. All idempotency is pre-existing (_ingested / _appliedReports / the commit-1 dedup + guard).
  // Evict raw txs that can never seal, by AGE alone (xpc workflow.reapAbandonedRawTxs).
  //
  // A raw tx leaves the pool on exactly one path: reaching quorum and sealing. One that CANNOT seal has no
  // exit — validation-retry abandons it at XPC_RETRY_MAX_AGE_MS (5 min) and nothing re-drives it, yet it
  // stays in the map AND in LevelDB, which _loadState reloads on every boot. That is how 12,031 txs
  // accumulated over weeks. This is the bound.
  //
  // REAP_AGE_MS is orders of magnitude beyond the retry's abandon age on purpose: reaping is a bloat
  // backstop, never part of a consensus decision. Fork-safety needs no crypto judgment — a tx this old
  // cannot seal on ANY node, so the same age rule everywhere is symmetric.
  _startMempoolReaper() {
    const RETRY_MAX_AGE_MS = Math.max(1000, Number(process.env.XPC_RETRY_MAX_AGE_MS) || 300000);
    const REAP_AGE_MS = Math.max(RETRY_MAX_AGE_MS * 10, Number(process.env.XPC_REAP_AGE_MS) || 7 * 24 * 3600 * 1000);
    const REAP_SWEEP_MS = Math.max(60000, Number(process.env.XPC_REAP_SWEEP_MS) || 6 * 3600 * 1000);
    const reap = () => { this.xpc.reapAbandonedRawTxs?.(REAP_AGE_MS).catch(() => {}); };
    const boot = setTimeout(reap, 60000);   // one pass a minute in, clearing whatever _loadState restored
    if (boot.unref) boot.unref();
    this._reapTimer = setInterval(reap, REAP_SWEEP_MS);
    if (this._reapTimer.unref) this._reapTimer.unref();
    console.log(`[XPC-REAPER] wired — evicting raw txs abandoned past ${REAP_AGE_MS}ms, sweeping every ${REAP_SWEEP_MS}ms`);
    this._startMempoolBound();
  }

  // THE BOUND, ENFORCED ON A TIMER RATHER THAN ON A CODE PATH.
  //
  // Caps were added to both paths that write the raw pool (addRawTransaction and the _loadState restore) and
  // the pool STILL sat at 17,810 against a cap of 1000 on the live node — with the file deployed and
  // byte-identical to source, node_modules/xpc symlinked to it, the process started after the write, and a
  // probe proving _loadState ran. Every per-path cap can be defeated by a path nobody thought to look at,
  // and chasing which one is a worse use of time than removing the assumption: enforce the invariant on the
  // STATE, on a schedule, where it holds no matter who wrote it or how.
  //
  // This is the difference between a check and an invariant. A check runs where you put it. An invariant is
  // true whenever you look.
  //
  // Evicts only past the abandon age — at 15M tx/sec the pool is a working set and dropping the merely-oldest
  // would silently discard transactions that are actively advancing. If nothing is old enough, it evicts
  // nothing and says so: over the cap with everything in flight means loaded, not leaking, and the answer to
  // load is capacity, never silent data loss.
  _startMempoolBound() {
    const MAX = Math.max(100, Number(process.env.XPC_MEMPOOL_MAX) || (process.env.XMBL_LITE === '1' ? 1000 : 5000));
    const SWEEP_MS = Math.max(1000, Number(process.env.XPC_BOUND_SWEEP_MS) || 15000);
    const ABANDON_MS = Math.max(1000, Number(process.env.XPC_RETRY_MAX_AGE_MS) || 300000);
    const enforce = async () => {
      try {
        const mp = this.xpc && this.xpc.mempool;
        if (!mp || !mp.rawTx) { console.warn(`[XPC-BOUND] sweep: no mempool handle (xpc=${!!this.xpc} mempool=${!!mp})`); return; }
        let count = 0;
        for (const m of mp.rawTx.values()) count += m.size;
        // Logged whenever the pool is OVER the cap — not every pass (that filled 87 MB of node.log while
        // debugging), and not only when it evicts. A bound that is silent while doing nothing is
        // indistinguishable from one that is not running, which cost hours here: three enforcement points
        // all appeared deployed and inert with no way to tell which was failing. Under the cap it says
        // nothing, because then there is nothing to explain.
        if (count <= MAX) return;
        console.warn(`[XPC-BOUND] sweep: pool=${count} cap=${MAX} leaders=${mp.rawTx.size}`);
        const now = Date.now();
        const over = count - MAX;
        const victims = [];
        // XPC_BOUND_FORCE=1 — ONE-SHOT DRAIN, oldest-first, IGNORING the abandon window. Deliberately not
        // the default and deliberately not permanent: at high throughput evicting by position rather than by
        // age discards transactions that are actively advancing. It exists because an accumulated backlog
        // whose ages were all reset by re-gossip drains at the rate it was originally ingested — measured
        // ~50/min against 13,834 pooled, i.e. four hours — and an operator who has decided that backlog is
        // unsealable should not have to wait out a clock that was wrong in the first place. Turn it off once
        // the pool is at the cap; the age rule is what holds it there afterwards.
        const FORCE = process.env.XPC_BOUND_FORCE === '1';
        const cand = [];
        for (const [leaderId, m] of mp.rawTx) {
          for (const [id, e] of m) {
            const ts = e && e.txTimestamp;
            if (FORCE) { cand.push([leaderId, id, typeof ts === 'number' ? ts : 0]); continue; }
            if (typeof ts !== 'number') continue;            // unknown age is not proof of abandonment
            if (now - ts <= ABANDON_MS) continue;            // in flight — hands off
            victims.push([leaderId, id]);
            if (victims.length >= over) break;
          }
          if (!FORCE && victims.length >= over) break;
        }
        if (FORCE) {
          cand.sort((a, b) => a[2] - b[2]);                  // oldest first
          for (const [l, i] of cand.slice(0, over)) victims.push([l, i]);
        }
        for (const [lid, id] of victims) {
          mp.rawTx.get(lid)?.delete(id);
          if (typeof mp._tombstone === 'function') mp._tombstone(id);                  // or gossip re-adds it within the second
          if (typeof mp._deleteRawTx === 'function') await mp._deleteRawTx(lid, id);   // map AND disk, or the next boot restores it
        }
        if (mp._rawCountAt !== undefined) mp._rawCountAt = 0;
        let after = 0;
        for (const m of mp.rawTx.values()) after += m.size;
        if (victims.length) console.warn(`[XPC-BOUND] sweep: pool ${count} over cap ${MAX} — evicted ${victims.length} abandoned (now ${after})`);
        else console.warn(`[XPC-BOUND] sweep: pool ${count} over cap ${MAX} but nothing past ${ABANDON_MS}ms — in flight, not leaking`);
      } catch (e) { console.warn(`[XPC-BOUND] sweep error (ignored): ${e && e.message}`); }
    };
    const boot = setTimeout(enforce, 20000);
    if (boot.unref) boot.unref();
    this._boundTimer = setInterval(enforce, SWEEP_MS);
    if (this._boundTimer.unref) this._boundTimer.unref();
    console.log(`[XPC-BOUND] wired — pool capped at ${MAX}, sweeping every ${SWEEP_MS}ms, evicting past ${ABANDON_MS}ms`);
  }

  _startValidationRetrySweep() {
    const SWEEP_MS = Math.max(1000, Number(process.env.XPC_RETRY_SWEEP_MS) || 5000);
    const MIN_AGE_MS = Math.max(1000, Number(process.env.XPC_RETRY_MIN_AGE_MS) || 5000);   // let the happy path try first
    const MAX_AGE_MS = Math.max(MIN_AGE_MS, Number(process.env.XPC_RETRY_MAX_AGE_MS) || 300000);   // abandon after this — bounds bookkeeping
    const MAX_RETRIES = Math.max(1, Number(process.env.XPC_RETRY_MAX) || 6);
    this._retryAttempts = new Map();   // rawTxId -> re-gossip attempts (survives ticks; pruned by the policy)
    // Wire the pure retry POLICY (xpc/validation-retry.js) to the real workflow state + gossip transport. The
    // policy decides WHAT to re-gossip + enforces the bound + C#5 (re-emit stored reports, never re-validate); this
    // only injects the read of stuck txs and the two broadcast fns. Kept trivially thin so all logic is testable.
    const tick = () => {
      let stuck = [];
      try { stuck = this.xpc.getStuckRawTxs(MIN_AGE_MS, MAX_AGE_MS); } catch { return; }
      try {
        runValidationRetryTick({
          stuck,
          isProcessed: (id) => { try { return this.xpc.isProcessed(id); } catch { return false; } },
          myReports: this._myReports,
          retries: this._retryAttempts,
          maxRetries: MAX_RETRIES,
          broadcastRawTx: (l, tx, ld) => { this.gossip.broadcastRawTransaction(l, tx, ld).catch(() => {}); },
          broadcastReport: (r) => { this.gossip.broadcastValidationReport(r).catch(() => {}); },
        });
      } catch { /* the sweep must never throw into the interval */ }
    };
    this._retryTimer = setInterval(tick, SWEEP_MS);
    if (this._retryTimer.unref) this._retryTimer.unref();
  }

  // 2b (ab5932a5) SEAL-BOUNDARY AGREEMENT: two SealRoundManagers (L1 blocks→faces, L2 faces→cubes) run the
  // round-agreement over the ledger's candidate pools + the seal-proposal gossip, replacing local-count sealing
  // with a cross-node quorum-agreed set at BOTH levels. STATE is in the ledger (getMembershipPool/getPendingCubeFaces
  // + sealAgreedBlocks/sealAgreedCube), the AGREEMENT is the pure SealRoundManager, and TRANSPORT is here. A minority
  // node ADOPTS the quorum set by resolving member-ids from its pool (commit-2's retry delivers any it's missing) +
  // re-verifying the set-hash, then sealing the identical deterministic partition → identical bytes across nodes.
  _startSealRounds() {
    const self = this.xid?.address;
    // adoptSet(level): resolve the agreed member-ids from the pool, STALL if any are missing (commit-2 delivers +
    // next tick retries), re-verify the set-hash defensively, then seal the identical set → byte-identical result.
    const mkAdopt = (resolve, seal, keyFn) => async (agreedHash, memberIds) => {
      const items = resolve(memberIds);
      if (!items || items.length < memberIds.length) return false;           // missing member → stall
      if (sealSetHash(items, keyFn) !== agreedHash) return false;            // defensive: resolved set ≠ agreed set
      await seal(items);
      return true;
    };
    const L1 = new SealRoundManager({
      getItems: () => this.xclt.getMembershipPool(),
      keyFn: (b) => b.hash, memberId: (b) => b.id, chunkSize: 9,
      quorum: () => this._sealQuorum(),
      broadcast: ({ setHash, memberIds }) => { this.gossip.broadcastSealProposal({ level: 'L1', nodeId: self, setHash, memberIds }).catch(() => {}); },
      sealSet: (blocks) => this.xclt.sealAgreedBlocks(blocks),
      adoptSet: mkAdopt((ids) => this.xclt.getPoolBlocksByIds(ids), (b) => this.xclt.sealAgreedBlocks(b), (b) => b.hash),
    });
    const L2 = new SealRoundManager({
      getItems: () => this.xclt.getPendingCubeFaces(),
      keyFn: (f) => f.getMerkleRoot(), memberId: (f) => f.getMerkleRoot(), chunkSize: 3,
      quorum: () => this._sealQuorum(),
      broadcast: ({ setHash, memberIds }) => { this.gossip.broadcastSealProposal({ level: 'L2', nodeId: self, setHash, memberIds }).catch(() => {}); },
      sealSet: (faces) => this.xclt.sealAgreedCube(faces),
      adoptSet: mkAdopt((roots) => this.xclt.getPendingFacesByRoots(roots), (f) => this.xclt.sealAgreedCube(f), (f) => f.getMerkleRoot()),
    });
    this._sealRounds = { L1, L2 };
    // Route each peer proposal to its level's manager (ignore our own echo).
    this.gossip.on('seal_proposal:received', (p) => {
      if (!p || p.nodeId === self) return;
      (p.level === 'L2' ? L2 : L1).onPeerProposal({ nodeId: p.nodeId, setHash: p.setHash, memberIds: p.memberIds });
    });
    // Tick both levels: L1 first (its sealed faces feed L2's pool), then L2. Bounded, non-throwing, unref'd.
    const SEAL_MS = Math.max(500, Number(process.env.XPC_SEAL_ROUND_MS) || 2000);
    this._sealTimer = setInterval(async () => { try { await L1.tick(); await L2.tick(); } catch { /* never throw into the interval */ } }, SEAL_MS);
    if (this._sealTimer.unref) this._sealTimer.unref();
  }

  // Strict-majority quorum of the live seal-leads (same set consensus uses). n includes self; > half ⇒ pigeonhole
  // no-split-brain (seal-agreement.decideRound). Single-node dev (n=1) ⇒ quorum 1 (seals alone); the 3-node mesh ⇒ 2.
  _sealQuorum() {
    const leads = (this.xpc.getLiveLeaders && this.xpc.getLiveLeaders()) || [this.xid?.address];
    const n = Math.max(1, leads.length);
    return Math.floor(n / 2) + 1;
  }

  // XZK cube-commitment (opt-in, XZK_COMMIT=1). On each sealed FACE, commit the cube's ordered coordinate curve
  // (the block hashes as public points) under a per-node hiding nonce and prove a cube-derived point — exactly the
  // call site xzk/README names. Stores {faceIndex, cubeId, rootP, verified} for query. STRICTLY ADDITIVE: xzk is
  // experimental + UNAUDITED, so this never feeds consensus, the ledger, or sealing — a failure is caught + logged.
  async _setupZkCommit() {
    if (process.env.XZK_COMMIT !== '1') return;
    let xzk, crypto;
    try { xzk = await import('@xmbl/zero-knowledge'); crypto = await import('node:crypto'); }
    catch (e) { console.warn('[xzk] module unavailable — commitment OFF:', e.message); return; }
    this.zkCommitments = [];
    const ctx = xzk.setup();
    const nodeSecret = crypto.createHash('sha256').update((this.xid?.address || 'node') + ':xzk').digest('hex');
    const fe = (s) => BigInt('0x' + crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 15));
    this.xclt.on('face:complete', (evt) => {
      try {
        const blocks = [...((evt.face && evt.face.blocks && evt.face.blocks.values && evt.face.blocks.values()) || [])];
        if (blocks.length < 2) return;
        const cubeId = String(evt.cubeId != null ? evt.cubeId : evt.faceIndex);
        const publicPoints = blocks.map((b, i) => ({ x: BigInt(i + 1), y: fe(b.hash || b.id || i) }));
        const secretPoints = [0, 1, 2].map((i) => ({ x: BigInt(100 + i), y: fe(nodeSecret + ':' + cubeId + ':' + i) }));
        const derivedX = (fe('dx:' + cubeId) | 1n) + 1000n;   // clear of public (1..n) + secret (100..102) x's
        const { Pt, derivedY } = xzk.blindedCurve(ctx, { publicPoints, secretPoints, derivedX });
        const proof = xzk.prove(ctx, { Pt, publicPoints, derivedX, derivedY });
        const verified = xzk.verify(ctx, { proof, publicPoints, derivedX, derivedY });
        const rec = { faceIndex: evt.faceIndex, cubeId, rootP: String(proof.rootP), rootC: String(proof.rootC), verified, blocks: blocks.length, at: new Date().toISOString() };
        this.zkCommitments.push(rec);
        if (this.zkCommitments.length > 500) this.zkCommitments.shift();
        console.log(`[xzk] committed face ${evt.faceIndex} (cube ${cubeId}) rootP=${rec.rootP.slice(0, 16)}… verified=${verified}`);
      } catch (e) { console.warn('[xzk] commit failed (non-blocking):', e.message); }
    });
    console.log('[xzk] ZK cube-commitment ON (experimental/unaudited, additive — NOT consensus-load-bearing)');
  }

  // Query the ZK commitments this node has produced (for the control socket / status).
  getZkCommitments(limit = 20) {
    const all = this.zkCommitments || [];
    return { enabled: process.env.XZK_COMMIT === '1', count: all.length, verified: all.filter((c) => c.verified).length, recent: all.slice(-limit).reverse() };
  }

  async stop() {
    if (this._presenceTimer) {
      clearInterval(this._presenceTimer);
      this._presenceTimer = null;
    }
    if (this._leadWatchTimer) {
      clearInterval(this._leadWatchTimer);
      this._leadWatchTimer = null;
    }
    if (this._retryTimer) {
      clearInterval(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._sealTimer) {
      clearInterval(this._sealTimer);
      this._sealTimer = null;
    }
    if (this.validationWorker) {
      this.validationWorker.stop();
    }
    if (this.leadWorker) {
      this.leadWorker.stop();
    }
    if (this.xn) {
      await this.xn.stop();
    }
    // Close EVERY LevelDB cleanly, not just the ledger — otherwise the storage
    // (xsc) and state-machine (xvsm) databases are left open and a restart can
    // reopen them mid-flush / with a stale LOCK. close() is the flush for
    // classic-level; there is no separate flush API.
    await closeLevelDb(this.xclt && this.xclt.db);
    await closeLevelDb(this.xvsm && this.xvsm.db);
    await closeLevelDb(this.xsc && this.xsc.db);
    await closeLevelDb(this.xpc && this.xpc.mempool && this.xpc.mempool.db);
  }
  
  async createIdentity() {
    this.xid = await Identity.create();
    this.xclt.xid = this.xid;
    this.xpc.xid = this.xid;
    return this.xid;
  }

  // Bind an externally-loaded identity (e.g. the C1 keystore identity the daemon
  // loads from disk at config.identity_path) as this node's identity, propagating
  // it to the two subsystems that sign/anchor with it (xclt, xpc) — the same three
  // references createIdentity() sets. Call this BEFORE start(): start() only mints
  // a fresh identity when none is set (`if (!this.xid)`), so a pre-set identity is
  // preserved and the node's address stays stable across restarts.
  setIdentity(identity) {
    this.xid = identity;
    this.xclt.xid = this.xid;
    this.xpc.xid = this.xid;
    return this.xid;
  }
  
  async submitTransaction(tx) {
    if (!this.xid) {
      throw new Error('Identity not initialized');
    }

    // TYPE-SCOPED (advisor security constraint, e49408b7): a CONTENT-ADDRESSED datum — a type-6 value-tx carries
    // an xid mined over its body {chain,FROM,to,asset,amount,seq,prev,unspent} where `from` is an ARRAY of payer
    // ids — is externally authorized (per the (c)/unspent ruling; its payer-sig is the deferred layer-b pointer).
    // The transport layer must NOT node-sign it: signTransaction would overwrite `from`->node and BREAK the
    // content-address (the mangled body no longer hashes to its xid; the validator correctly rejects, which was
    // the seal-blocker). Its sig-ownership check is skipped anyway (verifyTransaction only fires when
    // getPublicKeyByAddress(from) resolves, and a payer/array `from` returns null). NODE-AUTHORED types (string
    // `from`, no xid) KEEP sign+from-overwrite so their derivedAddress===from sig-ownership STILL fires — the
    // security invariant, NOT weakened by an unconditional preserve.
    const contentAddressed = typeof tx?.xid === 'string' && /^0[0-9]/.test(tx.xid) && Array.isArray(tx.from);
    const submitted = contentAddressed ? tx : await this.xid.signTransaction(tx);

    // Submit to consensus under this node's own stable identity (E1 user-as-validator: the leaderId, tracked
    // SEPARATELY from txData.from, so a preserved payer `from` never conflicts with the submitter identity).
    const rawTxId = await this.xpc.submitTransaction(this.xid.address, submitted);

    // Broadcast via gossip WITH the exact leader set we assigned, so every peer builds the identical validation
    // tasks and validates the one addressed to it.
    const leaders = this.xpc.rawTxLeaders ? this.xpc.rawTxLeaders.get(rawTxId) : null;
    await this.gossip.broadcastRawTransaction(this.xid.address, submitted, leaders);

    return rawTxId;
  }
}

// Close an abstract-level (LevelDB) handle cleanly, tolerating the two shapes
// that show up in practice: the in-memory Map fallback (xsc when LevelDB is
// unavailable — no close()), and an already-closed/closing handle (close()
// throws "Database is not open"). Only a genuinely open handle is flushed+closed.
async function closeLevelDb(db) {
  if (!db || typeof db.close !== 'function') return;
  if (db.status === 'closed' || db.status === 'closing') return;
  await db.close();
}





