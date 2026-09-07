import net from 'net';
import fs from 'fs';
import { createHash } from 'crypto';
import { collectEarnings } from './earnings.js';

/**
 * Local control socket for the xmbl-node daemon — how the handoff coordinator
 * talks to a running node. A newline-delimited JSON op server over a unix socket
 * at data_dir/node.sock.
 *
 * PROTOCOL — deliberately byte-identical to the handoff coordinator socket
 * (~/.handoff/handoff-coordinator.mjs) so the handoff side reuses its existing
 * client (handoff-lib `coordCall`) by pointing HANDOFF_COORD_SOCK at node.sock,
 * with NO new client:
 *   request:  one JSON line `{"op":"<name>", ...args}\n`
 *   reply:    one JSON line `JSON.stringify(obj) + "\n"` (NEVER pretty-printed —
 *             coordCall reads up to the first \n and parses)
 *   success:  { ok: true, ... }
 *   failure:  { ok: false, error: "..." }
 *   unknown:  { ok: false, error: "unknown op" }
 * Bad JSON on a line is ignored (matches the coordinator).
 *
 * Ops: status, peers, wallet, submit_tx, compute_job, roles, detach, leaders, earnings, validations,
 * xsc, store_shard, list_cube_keys, chain, publish, subscribe.
 * Every op EXCEPT `subscribe` is a single request/reply (no waiter-hold pattern). `subscribe`
 * holds the connection open and STREAMS one JSON line per received pubsub message (the handoff
 * message-relay transport — see handoff src/xmbl-relay.ts). Every handler is wrapped so a throw
 * or rejection becomes a JSON error — the daemon must never crash or hang on a control request.
 */

const SUBMIT_TIMEOUT_MS = 5000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

/**
 * Create + bind the control socket for a running node.
 * @param {object} ctx
 * @param {import('./index.js').XMBLCore} ctx.core - the live core
 * @param {object} ctx.config - the node config (roles etc.)
 * @param {string} ctx.sockPath - data_dir/node.sock
 * @param {() => object} ctx.statusSnapshot - returns the current status object
 * @returns {Promise<net.Server>}
 */
// Is a LIVE daemon already answering on this socket path? The coordinator has always asked this before
// unlinking (handoff-coordinator.mjs: "unlinking here would delete the WINNER's live socket"); this daemon
// did not, and paid for it. ECONNREFUSED/ENOENT ⇒ the path is a corpse and is safe to remove; a successful
// connect ⇒ someone owns it and we must not touch it.
function probeLiveOwner(sockPath) {
  return new Promise((resolve) => {
    const c = net.connect(sockPath);
    const done = (live) => { try { c.destroy(); } catch { /* already gone */ } resolve(live); };
    c.on('connect', () => done(true));
    c.on('error', () => done(false));
    setTimeout(() => done(false), 1500).unref?.();
  });
}

export async function createControlServer({ core, config, sockPath, statusSnapshot, detachPpidWatch }) {
  // NEVER UNLINK A SOCKET SOMEONE IS ANSWERING ON. This used to rmSync unconditionally, reasoning that
  // cmdStart had already refused to start beside a live instance — but that guard reads a PIDFILE, and a
  // pidfile is not a lock: it is cleared as "stale" whenever the recorded pid is not alive (node.js:115),
  // it is absent if a node was started without one, and it says nothing at all about a SECOND data_dir
  // pointing at the same path. When that guard let a second process through, this line deleted the LIVE
  // node's directory entry while the live node went on listening to an orphaned inode.
  // MEASURED: node 87513 up 33h, metrics serving on :62336, 698 cubes in its ledger — and every client
  // connecting to <data_dir>/node.sock got ENOENT. So the broker reported node_reachable:false, every
  // surface fell back to "derived from broker-anchors", and a chain with 698 sealed cubes displayed none.
  // The daemon that already solved this (handoff-coordinator.mjs) connect-probes and EXITS WITHOUT CLEANUP
  // when it loses the race. Same rule here: probe, and refuse to bind rather than clobber the winner.
  if (await probeLiveOwner(sockPath)) {
    throw new Error(`control socket ${sockPath} is already owned by a LIVE daemon — refusing to unlink and rebind (that would orphan the running node's socket)`);
  }
  try { fs.rmSync(sockPath, { force: true }); } catch { /* nothing to remove */ }

  async function handleOp(req) {
    switch (req.op) {
      case 'status':
        return { ok: true, ...statusSnapshot() };
      case 'peers': {
        const peers = core.xn.getConnectedPeers().map((p) => p.toString());
        return { ok: true, peers, count: peers.length };
      }
      case 'wallet':
        // The node's wallet is its xmbl identity (no separate wallet subsystem).
        return core.xid
          ? { ok: true, address: core.xid.address, public_key: core.xid.publicKey }
          : { ok: false, error: 'identity not initialized' };
      case 'roles':
        return { ok: true, roles: config.roles };
      case 'detach': {
        // Cancel the `--ppid` self-shutdown watch so this node SURVIVES its launching coordinator being
        // restarted (auto-update). Without it a coordinator reload takes its own node down, and this node
        // is a lead in the sealing mesh — losing one mid-round is the seal_quorum divergence the whole
        // hot-reload design exists to avoid. The replacement coordinator re-adopts this node via `status`.
        // `armed:false` means no watch was ever set (pm2/systemd owns us), which is a SUCCESS for the
        // caller's purpose — nothing here will kill this node when its caller exits.
        if (typeof detachPpidWatch !== 'function') return { ok: true, armed: false, note: 'no ppid watch in this build' };
        return detachPpidWatch();
      }
      case 'leaders': {
        // MESH instrument: which peers this node counts as LIVE LEAD validators, and the presence
        // registry that decides it. `roles` above answers "what am I configured to be"; this answers
        // the question that actually gates a seal — "who does the node hand a validation task to".
        //
        // Why the distinction is load-bearing: _getValidationLeaders (xpc/src/workflow.js) builds the
        // per-tx leader set from getLiveLeaders() and pads any shortfall with the placeholders
        // `leader1`/`leader2` that NO node claims. That set rides on the raw_tx broadcast, so a peer
        // absent from it gets no task addressed to itself, its ValidationWorker claims nothing, and it
        // contributes ZERO validations however well it is CONNECTED — quorum can never form. `peers`
        // shows transport (libp2p peer ids); this shows consensus membership (xmbl addresses from
        // presence gossip). A node with peers but an empty/self-only registry is the exact signature.
        // Read-only.
        const live = core.xpc && typeof core.xpc.getLiveLeaders === 'function' ? core.xpc.getLiveLeaders() : null;
        const registry = core.peerRegistry
          ? [...core.peerRegistry.entries()].map(([address, v]) => ({
              address,
              self: address === (core.xid && core.xid.address),
              lead: !!(v.roles && v.roles.lead),
              validate: !!(v.roles && v.roles.validate),
              last_seen: v.lastSeen ?? null,
            }))
          : null;
        // Both quorum numbers, side by side, because they are computed independently and CAN disagree:
        // required_validations is xpc's hardcoded 3, seal_quorum is floor(live/2)+1. A tx can then reach
        // 3/3 and finalize while the seal round it feeds stalls forever waiting for a 4th proposal — which
        // is invisible unless the two are read together. lead_allowlist reports whether membership is being
        // filtered, so an ACTIVE filter is never mistaken for peers having silently dropped out.
        // Read the allowlist the CORE actually resolved at wiring time, never process.env: XPC_LEAD_ALLOWLIST
        // is read once at (re)start, so an env var edited afterwards would report a filter that is not in
        // force. core._leadAllowlist is the value genuinely in effect.
        const allow = Array.isArray(core._leadAllowlist) && core._leadAllowlist.length ? core._leadAllowlist : null;
        return {
          ok: true,
          self: (core.xid && core.xid.address) || null,
          live_leaders: live,
          live_lead_count: Array.isArray(live) ? live.length : null,
          required_validations: core.xpc ? core.xpc.requiredValidations ?? null : null,
          seal_quorum: Array.isArray(live) ? Math.floor(Math.max(1, live.length) / 2) + 1 : null,
          lead_allowlist: allow,
          lead_allowlist_active: !!allow,
          peer_registry: registry,
          peer_registry_count: registry ? registry.length : null,
        };
      }
      case 'earnings':
        return { ok: true, ...collectEarnings(core) };
      case 'validations':
        // E1c follow-up: per-tx validation EVENTS (who validated which tx, when) — distinct from the
        // validationsCompleted counter. Bounded ring (core/index.js), newest-first for a viz to render
        // directly. Empty array (not an error) when roles.validate is off or nothing has validated yet.
        return { ok: true, validations: (core.recentValidations || []).slice().reverse() };
      case 'zk':
        return { ok: true, ...(core.getZkCommitments ? core.getZkCommitments(req.limit || 20) : { enabled: false, count: 0 }) };
      case 'state_tree': {
        // The VERKLE TREE ITSELF — real nodes, real parent->child edges, the actual structure that commits
        // state. Everything the chain surfaced before this described transactions ABOUT the tree; nothing
        // could describe the tree. Read-only, bounded on depth and node count, and it reports `truncated`
        // plus each node's descendant count so a cut branch is never mistaken for a leaf.
        if (!core.xvsm || !core.xvsm.stateTree) return { ok: false, error: 'state machine not initialized' };
        const t = core.xvsm.stateTree;
        if (typeof t.getTreeShape !== 'function') {
          return { ok: false, error: 'this node predates state_tree — reinstall the node bundle' };
        }
        if (req.key) return { ok: true, mode: 'key', ...t.keyPath(String(req.key)) };
        return t.getTreeShape({
          maxDepth: Math.min(Math.max(Number(req.max_depth) || 4, 1), 8),
          maxNodes: Math.min(Math.max(Number(req.max_nodes) || 600, 16), 4000),
          at: Array.isArray(req.at) ? req.at.map(Number).filter(Number.isFinite) : [],
        });
      }
      case 'apply_backfill': {
        // Apply every block already on disk into the Verkle state tree — the ONE operation that can move
        // state_root on a deployment whose apply step never ran. It reads the ledger's own block: rows, so it
        // needs neither the block:added doorbell nor a validation quorum, and it is idempotent (the root is a
        // function of the final key set, not of application order). Deliberately NOT automatic on boot: it is
        // an O(blocks) LevelDB scan, and a state mutation should be a decision an operator takes, not a side
        // effect of a restart. Returns real counts and the resulting root, never a claim of success.
        if (!core.xvsm) return { ok: false, error: 'state machine not initialized' };
        if (typeof core.xvsm.backfillFromLedger !== 'function') {
          return { ok: false, error: 'this node predates apply_backfill — reinstall the node bundle' };
        }
        const before = (() => { try { return core.xvsm.getStateRoot(); } catch { return null; } })();
        const r = await core.xvsm.backfillFromLedger(core.xclt && core.xclt.db);
        return { ok: r.started !== false, state_root_before: before, ...r };
      }
      case 'apply_canonical': {
        // Adopt the broker's canonical anchor set authoritatively: clear the tree and rebuild from exactly the
        // provided [{event,hash,ts}], so this node's root becomes a pure function of that set — identical on
        // every node that applies the same set, regardless of what junk its own ledger accumulated. This is
        // the NAT-proof convergence primitive: the mesh cannot gossip, but every node can be handed one set.
        if (!core.xvsm) return { ok: false, error: 'state machine not initialized' };
        if (typeof core.xvsm.rebuildFromCanonical !== 'function') {
          return { ok: false, error: 'this node predates apply_canonical — reinstall the node bundle' };
        }
        const anchors = Array.isArray(req.anchors) ? req.anchors : [];
        if (!anchors.length) return { ok: false, error: 'apply_canonical requires anchors[]' };
        const before = (() => { try { return core.xvsm.getStateRoot(); } catch { return null; } })();
        const r = await core.xvsm.rebuildFromCanonical(anchors);
        return { ok: r.started !== false, state_root_before: before, ...r };
      }
      case 'rebuild_ledger': {
        // Rebuild BOTH the cube ledger (xclt) AND the verkle state (xvsm) as pure functions of the broker's
        // canonical anchor set, so every node that applies the same set holds a byte-identical sealed chain —
        // the drift-proof convergence primitive. apply_canonical only moved the state root; this also wipes and
        // deterministically re-seals the cube ledger (blocks/faces/cubes), which is what "0 sealed / nodes
        // disagree" actually needed. Returns real counts and the resulting roots, never a claim of success.
        if (!core.xclt) return { ok: false, error: 'ledger not initialized' };
        if (typeof core.xclt.rebuildFromAnchors !== 'function') {
          return { ok: false, error: 'this node predates rebuild_ledger — reinstall the node bundle' };
        }
        const anchors = Array.isArray(req.anchors) ? req.anchors : [];
        if (!anchors.length) return { ok: false, error: 'rebuild_ledger requires anchors[]' };
        const ledger = await core.xclt.rebuildFromAnchors(anchors);
        let state_root = null;
        if (core.xvsm && typeof core.xvsm.rebuildFromCanonical === 'function') {
          try { const s = await core.xvsm.rebuildFromCanonical(anchors); state_root = s && s.state_root; } catch { /* state parity is best-effort */ }
        }
        // `faces_sealed_since_boot` (the UI's FACES SEALED tile) reads core.leadBatchesSealed — the seal-round
        // counter. A deterministic rebuild seals faces outside that path, so set the counter to the rebuilt
        // face total: the chain genuinely holds that many sealed faces this boot, and every node lands on the
        // same number, so the UI reflects the sealed, agreed chain instead of a stale 0.
        try { core.leadBatchesSealed = ledger.faces_sealed; } catch { /* counter is advisory */ }
        core._chainCounts = null;   // force `chain` to re-scan the freshly-sealed ledger
        return { ok: true, ...ledger, state_root };
      }
      case 'submit_tx': {
        if (!req.tx || typeof req.tx !== 'object') {
          return { ok: false, error: 'submit_tx requires a tx object' };
        }
        // Guarded + time-boxed so a control request can never hang the daemon.
        const txId = await withTimeout(core.submitTransaction(req.tx), SUBMIT_TIMEOUT_MS, 'submit_tx');
        return { ok: true, tx_id: txId };
      }
      case 'compute_job': {
        if (!core.computeNode) {
          return { ok: false, error: 'compute role not enabled (roles.compute)' };
        }
        if (!req.job || typeof req.job !== 'object') {
          return { ok: false, error: 'compute_job requires a job object' };
        }
        // Guarded + time-boxed so a control request can never hang the daemon
        // even if runJob's own cap enforcement somehow didn't (defense in depth).
        const result = await withTimeout(core.computeNode.runJob(req.job), SUBMIT_TIMEOUT_MS, 'compute_job');
        return result;
      }
      case 'addrs': {
        // This node's own peer id + dialable listen multiaddrs (each embeds the peer id). A peer
        // broker/coordinator needs these to add this node to its bootstrap_peers or `connect` to it.
        if (!core.xn) return { ok: false, error: 'network layer not initialized' };
        const addrs = (core.xn.getAddresses() || []).map((a) => a.toString());
        const peer_id = core.xn.getPeerId ? String(core.xn.getPeerId() || '') : '';
        return { ok: true, peer_id, addrs };
      }
      case 'connect': {
        // Dial another node by multiaddr (must include /p2p/<peerId>). Lets a coordinator peer two
        // nodes at runtime without a restart/bootstrap-config change — the mesh the relay rides on.
        if (!core.xn) return { ok: false, error: 'network layer not initialized' };
        if (!req.address || typeof req.address !== 'string') return { ok: false, error: 'connect requires an address (multiaddr)' };
        await withTimeout(core.xn.connect(req.address), SUBMIT_TIMEOUT_MS, 'connect');
        return { ok: true, address: req.address };
      }
      case '@xmbl/storage-compute': {
        // STORAGE + COMPUTE, THE MODULE NOBODY COULD PROBE. xsc has been constructed in core all along
        // (StorageNode always; ComputeNode when roles.compute), and its counters reach the metrics HTTP
        // endpoint — which binds 127.0.0.1 INSIDE the node's own host, so the broker, /xmbl/prove and
        // /config/xmbl could never read it. The result: every other module (xn xpc xclt xvsm xid xzk) had a
        // proof card and xsc had none, so "the p2p storage and compute is implemented" was a claim with no
        // reachable evidence behind it. Same channel as every other op, so the same surfaces can show it.
        const stor = core.xsc || null;
        const comp = core.computeNode || null;
        const capacity = stor && typeof stor.getCapacity === 'function' ? stor.getCapacity() : (stor ? stor.capacity : null);
        const used = stor && typeof stor.getUsed === 'function' ? stor.getUsed() : (stor ? stor.used : null);
        return {
          ok: true,
          storage: stor ? {
            enabled: true,
            shards_stored: stor.shardsStored ?? 0,
            capacity_bytes: capacity ?? null,
            used_bytes: used ?? null,
            // A percentage the caller does not have to compute (and cannot get subtly wrong).
            used_pct: capacity ? Math.round(((used || 0) / capacity) * 1000) / 10 : null,
          } : { enabled: false, reason: 'no storage node on this core' },
          // COMPUTE IS OPT-IN AND SAYS SO. roles.compute defaults false, so a node reporting enabled:false is
          // configured that way, not broken — the distinction a surface must show rather than render as a zero.
          compute: comp ? { enabled: true, jobs_run: comp.computeJobsRun ?? 0 }
                        : { enabled: false, reason: 'roles.compute is false on this node — set it to accept compute jobs' },
          roles: config.roles,
        };
      }
      case 'store_shard': {
        // THE STORAGE ROUND TRIP, PROVABLE FROM OUTSIDE THE BOX. xsc could be READ (the `xsc` op above) but
        // never EXERCISED — there was no way to ask a node to actually hold bytes and give them back, so
        // "p2p storage is implemented" rested on a counter that nothing could move. This stores a shard,
        // reads it straight back, and compares the bytes, returning the counter before and after: a delta an
        // operator can see rather than a claim to believe.
        // Deliberately small and capped — this is a proof, not a storage API.
        const stor = core.xsc;
        if (!stor) return { ok: false, error: 'no storage node on this core' };
        const payload = typeof req.data === 'string' ? req.data : `xmbl-storage-proof:${Date.now()}`;
        if (payload.length > 65536) return { ok: false, error: 'proof payload capped at 64KB' };
        const before = stor.shardsStored ?? 0;
        const usedBefore = typeof stor.getUsed === 'function' ? stor.getUsed() : stor.used;
        try {
          const { StorageShard } = await import('@xmbl/storage-compute');
          const bytes = Buffer.from(payload, 'utf8');
          const shard = new StorageShard(0, bytes, false, bytes.length);
          const shardId = await withTimeout(stor.storeShard(shard), SUBMIT_TIMEOUT_MS, 'store_shard');
          // Read it back through the SAME public path a peer would use; a store that cannot be retrieved is
          // not storage, and a counter that moved without the bytes surviving is exactly the false green
          // this endpoint exists to make impossible.
          const got = await withTimeout(stor.getShard(shardId), SUBMIT_TIMEOUT_MS, 'get_shard');
          const roundTripped = !!got && Buffer.from(got.data).equals(bytes);
          return {
            ok: true,
            shard_id: shardId,
            bytes: bytes.length,
            round_tripped: roundTripped,
            shards_stored_before: before,
            shards_stored_after: stor.shardsStored ?? 0,
            used_bytes_before: usedBefore ?? null,
            used_bytes_after: (typeof stor.getUsed === 'function' ? stor.getUsed() : stor.used) ?? null,
            capacity_bytes: (typeof stor.getCapacity === 'function' ? stor.getCapacity() : stor.capacity) ?? null,
          };
        } catch (e) { return { ok: false, error: String(e?.message || e), shards_stored: stor.shardsStored ?? 0 }; }
      }
      case 'list_cube_keys': {
        // 2b fork-detector (ab5932a5): return the CONSENSUS identity of every persisted cube — {id, merkleRoot}
        // + a digest over the SORTED set — so a caller can compare it ACROSS the co-located helper nodes and
        // detect a real seal divergence. It compares CONSENSUS fields ONLY (id + merkleRoot, both content-derived
        // = sha256 of sorted face merkle roots), NEVER the raw persisted cubeData: the stored `faces:[0,1,2]`
        // index array + coordinate metadata are NODE-LOCAL and legitimately differ even when the cube AGREES, so a
        // raw byte-compare would FALSE-FLAG a fork. This is the cross-helper check /xmbl/status structurally can't
        // give (chain reads only the hub's own ledger). Read-only.
        const led = core.xclt;
        if (!led || !led.db) return { ok: false, error: 'ledger not available' };
        const cubes = [];
        try {
          for await (const [k, v] of led.db.iterator({ gte: 'cube:', lt: 'cube;' })) {
            void k;
            try { const c = JSON.parse(v.toString()); cubes.push({ id: c.id, merkleRoot: c.merkleRoot ?? null }); }
            catch { /* skip an unparseable row */ }
          }
        } catch (e) { return { ok: false, error: `cube scan failed: ${e?.message || e}` }; }
        cubes.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
        const set_digest = createHash('sha256').update(cubes.map((c) => `${c.id}:${c.merkleRoot}`).join('|')).digest('hex');
        return { ok: true, count: cubes.length, cubes, set_digest };   // compare set_digest across the 3 helpers
      }
      case 'chain': {
        // Read-only "xmblscan" snapshot of xvsm/consensus state for a client to render:
        // current state root, a count of transactions this node knows, and the most-recent
        // raw transactions (id + type + timestamp). Every read below is a REAL API on the
        // live subsystems (core.xvsm / core.xpc) and is synchronous, so there is nothing to
        // stream or time-box — anything unavailable becomes null (never fabricated), and any
        // throw is caught by the outer wrapper (handleLine) → { ok:false } rather than a crash.
        if (!core.xvsm) return { ok: false, error: 'state machine not initialized' };

        // state_root: verkle state-tree root. After a bare submit_tx this is the empty root
        // ('0'*64) — the tx sits in the mempool and is only applied to the tree via ledger
        // block processing (multi-node consensus), so an all-zero root here is genuine, not a bug.
        let state_root = null;
        try { state_root = core.xvsm.getStateRoot(); } catch { state_root = null; }

        // xvsm applied-transaction statistics (executed → state-diff'd txs).
        let stats = null;
        try { stats = core.xvsm.getStatistics(); } catch { stats = null; }

        // Consensus mempool tiers: { raw, processing, final, lockedUtxos }. `raw` moves the
        // instant a tx is submitted, so this is the count that actually reflects activity.
        let mempool = null;
        try { mempool = core.xpc && typeof core.xpc.getMempoolStats === 'function' ? core.xpc.getMempoolStats() : null; } catch { mempool = null; }

        // recent_tx: the most-recent RAW mempool transactions. rawTx is Map<leaderId,
        // Map<rawTxId, { txData, txTimestamp, ... }>>; each rawTxId is the same hash submit_tx
        // returns as tx_id. Raw is the right tier for a testnet scan — txs seldom finalize, and
        // single-node validation can't advance (needs ≥3 leaders), so submitted txs live here.
        const recent = [];
        try {
          const rawTx = core.xpc && core.xpc.mempool ? core.xpc.mempool.rawTx : null;
          if (rawTx && typeof rawTx.values === 'function') {
            for (const leaderMempool of rawTx.values()) {
              if (!leaderMempool || typeof leaderMempool.entries !== 'function') continue;
              for (const [rawTxId, entry] of leaderMempool.entries()) {
                recent.push({
                  id: rawTxId,
                  type: entry && entry.txData && entry.txData.type != null ? entry.txData.type : null,
                  timestamp: entry && entry.txTimestamp != null ? entry.txTimestamp : null,
                });
              }
            }
          }
        } catch { /* leave `recent` with whatever it collected */ }
        recent.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        const recent_tx = recent.slice(0, 20);

        // tx_count: transactions this node currently knows across all mempool tiers — a real
        // number that increments on submit_tx. Falls back to the raw list length if no mempool.
        const tx_count = mempool ? (mempool.raw + mempool.processing + mempool.final) : recent_tx.length;

        // cube_curve: the SEALING layer (xclt), which the xvsm reads above never see — the lead
        // worker seals finalized txs into 9-block faces / 3-face cubes HERE, so a chain view that
        // only reports state_root/applied shows "0 sealed" while faces are genuinely sealing.
        // In-memory maps are this boot's live state; block:/cube: rows in LevelDB are durable
        // across restarts (the ledger does not rehydrate them at boot), so both are reported.
        let cube_curve = null;
        try {
          const led = core.xclt;
          if (led) {
            let faces_in_memory = 0;
            try { for (const cube of led.cubes.values()) faces_in_memory += cube.faces ? cube.faces.size : 0; } catch { /* leave partial */ }
            // COUNTED ONCE, THEN MAINTAINED — never re-scanned per call.
            //
            // This walked EVERY block: and cube: key in LevelDB to produce two integers, so its cost was
            // O(total chain size) and grew with the chain. Timed straight at the node's control socket:
            // 40067ms / 40011ms / 40004ms — three calls, all hitting a 40s ceiling without returning, on a
            // 33 MB ledger of 12,281 blocks. The broker gives this op 1500ms and its health watchdog kills
            // the process at 8s, so there is NO budget that both succeeds and survives. Every surface that
            // reads the chain — the 3D city, /config/xmbl, the homepage landmark — went blind because of it.
            //
            // The counts only ever grow (blocks and cubes are appended, never deleted), so one scan at first
            // call establishes the baseline and every seal increments it from there. `chain` becomes O(1).
            // CHAIN_COUNT_RESCAN_MS forces a periodic re-baseline for anything that mutates the ledger
            // outside the seal path; 0 disables re-scanning entirely.
            let blocks_persisted = null; let cubes_persisted = null;
            try {
              const RESCAN_MS = Number(process.env.CHAIN_COUNT_RESCAN_MS ?? 3600000);
              const nowMs = Date.now();
              const stale = !core._chainCounts
                || (RESCAN_MS > 0 && nowMs - core._chainCounts.at > RESCAN_MS);
              if (stale) {
                let b = 0, c = 0;
                for await (const k of led.db.keys({ gte: 'block:', lt: 'block;' })) { void k; b += 1; }
                for await (const k of led.db.keys({ gte: 'cube:', lt: 'cube;' })) { void k; c += 1; }
                core._chainCounts = { at: nowMs, blocks: b, cubes: c };
                // Keep the baseline current without re-scanning: the ledger emits on every seal.
                if (!core._chainCountsWired && led.on) {
                  core._chainCountsWired = true;
                  const bump = (k) => () => { if (core._chainCounts) core._chainCounts[k] += 1; };
                  try { led.on('block:added', bump('blocks')); } catch { /* older ledger: falls back to rescan */ }
                  // The ledger emits 'cube:complete' on every sealed cube (xclt/src/ledger.js) — there is NO
                  // 'cube:sealed' event, so this listener NEVER fired and cubes_persisted was frozen at the
                  // first-call baseline scan (every surface then showed a stale/zero cube count while cubes
                  // kept sealing on disk). Listen for the event the ledger actually emits.
                  try { led.on('cube:complete', bump('cubes')); } catch { /* ditto */ }
                }
              }
              blocks_persisted = core._chainCounts.blocks;
              cubes_persisted = core._chainCounts.cubes;
            } catch { blocks_persisted = null; cubes_persisted = null; }
            cube_curve = {
              blocks_in_memory: led.blocks ? led.blocks.size : null,
              cubes_in_memory: led.cubes ? led.cubes.size : null,
              faces_in_memory,
              pooled_blocks: Array.isArray(led._membershipPool) ? led._membershipPool.length : null,
              blocks_persisted,                                // durable, survives restart
              cubes_persisted,                                 // durable, survives restart
              faces_sealed_since_boot: typeof core.leadBatchesSealed === 'number' ? core.leadBatchesSealed : null,
              validations_completed: typeof core.validationsCompleted === 'number' ? core.validationsCompleted : null,
            };
          }
        } catch { cube_curve = null; }

        return {
          ok: true,
          state_root,
          tx_count,
          mempool,                                             // {raw,processing,final,lockedUtxos} | null
          applied_tx_count: stats ? stats.totalTransactions : null,  // xvsm-executed tx count
          state_diffs: stats ? stats.totalDiffs : null,        // xvsm state-diff count
          cube_curve,                                          // the SEALING layer — see above
          recent_tx,                                           // [{ id, type, timestamp }]
        };
      }
      case 'publish': {
        // Broadcast a message onto the libp2p (floodsub) mesh under `topic`. This is the
        // SEND side of the handoff message-relay transport: a broker publishes each stored
        // envelope so peer brokers subscribed to the recipient's topic receive it.
        if (!req.topic || typeof req.topic !== 'string') return { ok: false, error: 'publish requires a topic' };
        if (!core.xn) return { ok: false, error: 'network layer not initialized' };
        await withTimeout(core.xn.publish(req.topic, req.data ?? {}), SUBMIT_TIMEOUT_MS, 'publish');
        return { ok: true, topic: req.topic };
      }
      default:
        return { ok: false, error: 'unknown op' };
    }
  }

  // `subscribe` is special: it holds THIS connection open and streams a JSON line per received
  // pubsub message on `topic` (the RECEIVE side of the handoff relay). The listener is removed and
  // the topic unsubscribed when the client disconnects, so a dropped relay never leaks handlers.
  async function handleSubscribe(sock, req) {
    const reply = (o) => { try { sock.write(JSON.stringify(o) + '\n'); } catch { /* client gone */ } };
    const topic = req.topic;
    if (!topic || typeof topic !== 'string') { reply({ ok: false, error: 'subscribe requires a topic' }); return; }
    if (!core.xn) { reply({ ok: false, error: 'network layer not initialized' }); return; }
    try { await core.xn.subscribe(topic); } catch (e) { reply({ ok: false, error: String(e?.message || e) }); return; }
    const listener = (data) => reply({ ok: true, event: 'message', topic, data });
    core.xn.on(`message:${topic}`, listener);
    reply({ ok: true, event: 'subscribed', topic });
    const cleanup = () => { try { core.xn.removeListener(`message:${topic}`, listener); } catch { /* */ } };
    sock.on('close', cleanup);
    sock.on('error', cleanup);
  }

  function handleLine(sock, line) {
    let req;
    try { req = JSON.parse(line); } catch { return; } // ignore malformed lines
    const reply = (o) => { try { sock.write(JSON.stringify(o) + '\n'); } catch { /* client gone */ } };
    // `subscribe` holds the socket open and streams — handled separately from the request/reply ops.
    if (req.op === 'subscribe') { void handleSubscribe(sock, req).catch((e) => reply({ ok: false, error: String(e?.message || e) })); return; }
    // Any throw/rejection in an op becomes a JSON error — never an unhandled crash.
    Promise.resolve()
      .then(() => handleOp(req))
      .then(reply)
      .catch((e) => reply({ ok: false, error: String(e?.message || e) }));
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sock.setEncoding('utf8');
      let buf = '';
      sock.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) handleLine(sock, line);
        }
      });
      sock.on('error', () => {}); // a client disconnecting mid-write must not crash the daemon
    });
    server.on('error', (e) => reject(e));
    server.listen(sockPath, () => {
      try { fs.chmodSync(sockPath, 0o600); } catch { /* best effort */ }
      resolve(server);
    });
  });
}
