import net from 'net';
import fs from 'fs';
import { createHash } from 'crypto';
import { collectEarnings } from './earnings.js';
import { sign, VERSION as IDENTITY_VERSION } from '@xmbl/identity';   // the ONE signature seam — a chain claim the broker can verify is signed HERE or nowhere
import { VERSION as NETWORKING_VERSION } from '@xmbl/networking';
import { VERSION as CUBIC_LEDGER_VERSION, validateXid, micromineTx } from '@xmbl/cubic-ledger';
import { VERSION as STATE_MACHINE_VERSION } from '@xmbl/state-machine';
import { VERSION as CONSENSUS_VERSION } from '@xmbl/consensus';
import { VERSION as STORAGE_COMPUTE_VERSION } from '@xmbl/storage-compute';
import { VERSION as ZERO_KNOWLEDGE_VERSION } from '@xmbl/zero-knowledge';
import { VERSION as CORE_VERSION } from './index.js';
import { codeDigest } from './release.js';   // the VERSION PROOF: a digest of the @xmbl code this process loaded

// THE VERSIONS THIS PROCESS IS RUNNING. Each package reads its own manifest at import time (see the VERSION
// export in every @xmbl/* root), so this names the code in memory — an install that lands on disk after boot
// changes the files, not these values. Reported on `status` (the op the coordinator already polls) so nobody
// has to read node_modules to learn what a node is executing, and never has to trust that reading.
const RUNNING_VERSIONS = Object.freeze({
  core: CORE_VERSION,
  identity: IDENTITY_VERSION,
  networking: NETWORKING_VERSION,
  'cubic-ledger': CUBIC_LEDGER_VERSION,
  'state-machine': STATE_MACHINE_VERSION,
  consensus: CONSENSUS_VERSION,
  'storage-compute': STORAGE_COMPUTE_VERSION,
  'zero-knowledge': ZERO_KNOWLEDGE_VERSION,
});

// WHAT THIS LEDGER DOES WITH AN UNTYPED ANCHOR — ASKED OF THE RUNNING CODE, not of a version string. The
// coordinator needs to know, BEFORE it hands over a feed, whether this node's rebuild requires every anchor to
// carry a micromined xid: hand a typed-only node the default canonical feed (~3,990 rows that predate typing
// and can never be back-mined) and it rebuilds to an EMPTY chain — measured, 0 of 4008. A version read cannot
// answer it safely: the coordinator's own on-disk probe takes a min across install dirs and reads 0.1.9 while
// the process runs 0.1.11, i.e. INVERTED polarity at exactly the moment it matters (during an OTA). So the
// answer is taken by RUNNING the check once, at load, against both a typed and an untyped anchor.
const TYPED_ANCHOR_POLICY = (() => {
  const hash = createHash('sha256').update('ledger-capability-probe').digest('hex');
  const bare = { type: 'anchor', event: 'capability.probe', hash, ts: 0 };
  let refuses_untyped = false, accepts_typed = false;
  try { validateXid(bare); } catch (e) { refuses_untyped = e && e.code === 'UNTYPED'; }
  try { accepts_typed = validateXid(micromineTx({ ...bare })) === true; } catch { accepts_typed = false; }
  return Object.freeze({ refuses_untyped, accepts_typed });
})();

// THE VERSION PROOF (operator, 2026-09-16: every node must PROVE it runs the latest version or be suspended).
// A version string can be typed; this cannot: a sha-256 over the bytes of every @xmbl module this process
// loaded (release.js codeDigest — sorted paths, tests excluded), computed ONCE at boot from the files in
// memory's provenance. It rides inside the SIGNED chain claim next to `versions`, so a verifier that knows the
// digest of the published release compares digests, not claims. Per-package digests are served by `release`.
const RUNNING_BUILD = (() => {
  try {
    const b = codeDigest();
    return Object.freeze({ digest: b.digest, packages: Object.freeze(Object.fromEntries(Object.entries(b.packages).map(([n, p]) => [n, p ? { version: p.version, files: p.files, digest: p.digest } : null]))) });
  } catch (e) { return Object.freeze({ digest: null, error: e.message, packages: {} }); }
})();
// The suspension a caller sees on every producing op: a node behind the latest published version has stopped
// producing until it is updated (the daemon's OTA loop suspends, updates and restarts it).
const suspendedReply = (core) => ({ ok: false, suspended: core.suspended, error: `node suspended: ${core.suspended.reason}${core.suspended.detail ? ' — ' + core.suspended.detail : ''}` });

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
 * Ops: status, peers, wallet, submit_tx, submit_batch, compute_job, roles, detach, leaders, earnings,
 * validations, zk, state_tree, apply_backfill, apply_canonical, rebuild_ledger, evict,
 * ledger_capabilities, identity_status, contract_deploy, contract_call, contracts, addrs, connect,
 * xsc, store_shard, list_cube_keys, chain, publish, subscribe.
 * Every op EXCEPT `subscribe` is a single request/reply (no waiter-hold pattern). `subscribe`
 * holds the connection open and STREAMS one JSON line per received pubsub message (the handoff
 * message-relay transport — see handoff src/xmbl-relay.ts). Every handler is wrapped so a throw
 * or rejection becomes a JSON error — the daemon must never crash or hang on a control request.
 */

const SUBMIT_TIMEOUT_MS = 5000;
const SUBMIT_BATCH_MAX = 500;   // one control request must stay bounded; a drainer pages beyond this
// Same bound for `evict`: each key costs a full `block:` keyspace scan in xclt.evict, so a caller with
// 1,158 keys to remove pages them rather than holding the daemon in one request.
const EVICT_MAX = 500;
// A contract call runs guest WASM under the compute runtime's own caps, but the CONTROL request must still
// be bounded — a cascade across frames can legitimately outlast the 5s a submit gets.
const CONTRACT_CALL_TIMEOUT_MS = 30000;
// The deploy block CARRIES the module to every node, so the module has to be small enough to be a block.
// 256 KiB is far above any LNG output (the counter is a few hundred bytes) and far below anything that
// would make the canonical feed unwieldy.
const CONTRACT_WASM_MAX = 256 * 1024;

// The one reply for "the node admitted nothing" — used by submit_tx and per-entry by submit_batch.
const rejectedAtIngress = () => ({
  ok: false, tx_id: null,
  error: 'rejected at ingress — the node admitted no transaction',
  hint: 'xpc.submitTransaction returns null when the tx is unsigned, its signature does not verify, its anchor is malformed, or its user is unresolvable; see the node log for the ingress-guard line naming which',
});

// Ordered semver compare on the MAJOR.MINOR.PATCH triple (no prerelease handling — @xmbl/* never publishes one).
function semverGte(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return true;
}

// REVIVE THE BIGINTS A JSON SOCKET CANNOT CARRY. The chain-staged material a zk / he / fhe / air
// contract reads is full of 256-bit values — curve coordinates, proof scalars, LWE ciphertext limbs —
// and this protocol is one JSON line. `JSON.stringify` THROWS on a BigInt, so a zk-gated contract was
// simply not drivable over this socket: the op existed and the one kind of call it was built for could
// not be expressed. Tagged `{"__bigint__":"123"}` is the convention the ledger's own Block.serialize
// already uses for exactly this, so a caller has one spelling to learn, not two.
function reviveBigInts(v) {
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.__bigint__ === 'string') return BigInt(v.__bigint__);
  if (Array.isArray(v)) return v.map(reviveBigInts);
  const out = {};
  for (const k of Object.keys(v)) out[k] = reviveBigInts(v[k]);
  return out;
}

// ANCHOR A CONTRACT FACT AS A BLOCK. A deploy or a call that lives only in this process is not on the
// chain: the next restart forgets the contract, and no other node ever learns of it. Mining the xid types
// the tx (every transaction is typed by its xid, operator 2026-09-16) and admitting it through the ledger's
// normal door puts it in the same block store the canonical primitives replicate and rebuild.
//
// Returns what it ACTUALLY recorded — `anchored:false` plus the reason when the ledger refused — never a
// claim. A refused anchor does NOT fail the deploy or the call: the state transition already happened in
// this node's tree, and reporting it as a failure would be a second lie on top of the first.
async function anchorContractTx(core, tx) {
  const out = { anchored: false, tx_id: null };
  if (!core.xclt || typeof core.xclt.addTransaction !== 'function') { out.anchor_error = 'ledger not initialized'; return out; }
  try {
    const typed = micromineTx({ ...tx, ts: Date.now() });
    const r = await withTimeout(core.xclt.addTransaction(typed), SUBMIT_TIMEOUT_MS, 'anchor contract tx');
    if (r && r.evicted) { out.anchor_error = 'evicted'; return out; }
    out.anchored = true;
    out.tx_id = typed.xid;
    out.duplicate = !!(r && r.duplicate);
  } catch (e) { out.anchor_error = String(e?.message || e); }
  return out;
}

// RE-DEPLOY EVERY CONTRACT THIS CHAIN ALREADY RECORDS. ContractHost keeps its registry in memory, so
// without this a restart silently forgets every contract and a node that never received the deploy CALL
// could not execute the contract at all — the chain would hold the deployment and the node would answer
// "unknown contract". Reads the ledger's own `block:` rows (the same source apply_backfill uses), so it
// needs no doorbell and no quorum, and it is idempotent: a re-deploy of identical bytes is the same
// content-addressed id, so replaying twice holds one contract, not two.
export async function replayContracts(core) {
  const out = { scanned: 0, deployed: 0, failed: 0, receipts: 0, keys_restored: 0 };
  if (!core.contractHost || !core.xclt || !core.xclt.db) { out.started = false; return out; }
  const receipts = [];
  try {
    for await (const [, value] of core.xclt.db.iterator({ gte: 'block:', lt: 'block;' })) {
      let raw; try { raw = JSON.parse(value.toString()); } catch { continue; }
      const tx = raw && raw.tx;
      if (!tx) continue;
      if (tx.type === 'state_diff' && tx.contractAddress && tx.args && Array.isArray(tx.args.writes)) { receipts.push(tx); continue; }
      if (tx.type !== 'contract' || !tx.bytecode) continue;
      out.scanned++;
      try {
        const bytes = new Uint8Array(Buffer.from(tx.bytecode, 'base64'));
        const abi = tx.abi && typeof tx.abi === 'object' ? tx.abi : {};
        core.contractHost.deploy(bytes, Array.isArray(abi.slots) ? abi.slots : [], abi.opts || {});
        out.deployed++;
      } catch { out.failed++; }
    }
  } catch { /* no blocks yet */ }
  // ⛔ RESTORING THE CODE IS NOT RESTORING THE CONTRACT. A deploy entry's `slots`/`byteKeys` are the
  // contract's STATE FOOTPRINT, and the host stages a call's read-set from them — they start EMPTY and
  // grow only as writes are observed. So a replayed contract read back ZERO for every field while its
  // committed values sat, untouched and correct, in the Verkle tree: MEASURED, a counter at 7 answered
  // `bump(1)` with 1 after a restart. The `state_diff` receipts record exactly which keys each call
  // wrote, so replaying them re-registers the footprint without re-executing anything.
  out.receipts = receipts.length;
  for (const r of receipts) {
    const entry = core.contractHost.contracts.get(r.contractAddress);
    if (!entry) continue;
    for (const w of r.args.writes) {
      if (!w) continue;
      const target = core.contractHost.contracts.get(w.contract || r.contractAddress);
      if (!target) continue;
      if (w.kind === 'bytes' && w.key !== undefined) { target.byteKeys.add(w.key); out.keys_restored++; }
      else if (w.kind === 'slot' && w.slot !== undefined) { target.slots.add(w.slot | 0); out.keys_restored++; }
    }
  }
  return out;
}

// DROP THE EVICTED ROWS BEFORE THEY REACH THE TREE. The verkle state machine has no eviction set — eviction
// is a LEDGER fact — so a canonical set handed straight to xvsm.rebuildFromCanonical re-inserts every key this
// node has already ruled out. MEASURED (evict-op.test.mjs, before this existed): after one rebuild from a
// stale feed the evicted anchors were absent from the ledger and PRESENT in the tree, i.e. the two stores
// disagreed and the state root committed the disagreement. Both ops that apply a canonical set filter here.
function dropEvicted(core, anchors) {
  const xclt = core && core.xclt;
  // isEvictedRow tests BOTH of a canonical row's names — its `<event>:<hash>` content key and its mined
  // `xid:<xid>` — because `evict` accepts either spelling. Testing only the content key let a row evicted by
  // xid keep its verkle key on the next apply, which is the very defect this filter exists to close.
  if (!xclt || typeof xclt.isEvictedRow !== 'function') return { kept: anchors, dropped: 0 };
  const kept = [];
  let dropped = 0;
  for (const a of anchors) {
    if (xclt.isEvictedRow(a)) { dropped++; continue; }
    kept.push(a);
  }
  return { kept, dropped };
}

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

  // RE-DEPLOY WHAT THE CHAIN ALREADY RECORDS, BEFORE THE FIRST REQUEST IS ANSWERED. Otherwise the very
  // first `contract_call` after a restart answers "unknown contract" for a contract this node's own block
  // store holds. Bounded (one scan of `block:`), idempotent (content-addressed ids), and it reports a real
  // count rather than claiming success — a node with the contracts role off skips it entirely.
  if (core && core.contractHost) {
    const replayed = await replayContracts(core);
    if (replayed.scanned) console.log(`[XCL] replayed ${replayed.deployed} of ${replayed.scanned} contract deployment(s) from the block store`
      + `, ${replayed.keys_restored} state key(s) re-registered from ${replayed.receipts} receipt(s)${replayed.failed ? `, ${replayed.failed} unreadable` : ''}`);
  }

  async function handleOp(req) {
    switch (req.op) {
      case 'status':
        return { ok: true, ...statusSnapshot(), versions: RUNNING_VERSIONS, build: RUNNING_BUILD.digest, suspended: core.suspended || null, ota: core.ota || null };
      case 'release':
        // The full version proof: what this process runs, package by package, and whether it is suspended.
        return { ok: true, versions: RUNNING_VERSIONS, build: RUNNING_BUILD, suspended: core.suspended || null, ota: core.ota || null };
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
        // An evicted anchor is not adopted just because the broker's set still names it — and THIS is the op
        // a node that cannot survive a wipe is driven by, so it is the one that most needs the filter.
        const { kept, dropped } = dropEvicted(core, anchors);
        const r = await core.xvsm.rebuildFromCanonical(kept);
        return { ok: r.started !== false, state_root_before: before, evicted_skipped: dropped, ...r };
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
        // A REFUSED REBUILD IS NOT A SUCCESSFUL ONE. The ledger refuses a set that would empty the chain and
        // touches nothing; say so with ok:false and the counts, so a coordinator driving the wrong feed fixes
        // the feed instead of reading a 0 as "the chain converged".
        if (ledger && ledger.refused) return { ok: false, error: ledger.reason, ...ledger };
        let state_root = null;
        if (core.xvsm && typeof core.xvsm.rebuildFromCanonical === 'function') {
          // The SAME filter the ledger just applied. Handing the unfiltered list here is what put an evicted
          // anchor back in the tree while the ledger correctly refused it.
          const { kept } = dropEvicted(core, anchors);
          try { const s = await core.xvsm.rebuildFromCanonical(kept); state_root = s && s.state_root; } catch { /* state parity is best-effort */ }
        }
        // `faces_sealed_since_boot` (the UI's FACES SEALED tile) reads core.leadBatchesSealed — the seal-round
        // counter. A deterministic rebuild seals faces outside that path, so set the counter to the rebuilt
        // face total: the chain genuinely holds that many sealed faces this boot, and every node lands on the
        // same number, so the UI reflects the sealed, agreed chain instead of a stale 0.
        try { core.leadBatchesSealed = ledger.faces_sealed; } catch { /* counter is advisory */ }
        core._chainCounts = null;   // force `chain` to re-scan the freshly-sealed ledger
        return { ok: true, ...ledger, state_root };
      }
      case 'evict': {
        // REMOVE NAMED ANCHORS AND NOTHING ELSE. `rebuild_ledger` is the only other way to drop an anchor a
        // node holds, and it gets there by wiping the whole block store — which is precisely the operation a
        // node answering `rescues_non_anchor_blocks: false` must never be given. So the nodes that most need
        // a specific row removed were the nodes with no way to remove it, and `ledger_capabilities` has been
        // advertising `evicts_invalid_for_good: true` for a method nothing on this socket could call.
        //
        // The removal is in THREE places because a row left in any one of them comes back:
        //   1. the ledger — block row, membership pool, anchor-dedup set, and the durable `evicted:` key that
        //      makes every later admission path refuse it (a resubmission, a sealed batch, AND a canonical
        //      rebuild whose feed still carries the anchor);
        //   2. the verkle tree — the `anchor:<event>:<hash>` key itself, or the state root does not move;
        //   3. the `diff:` row behind that key, or the next boot replays it into an empty tree.
        // Takes `keys: [...]` in either spelling — `anchor:<event>:<hash>` (what the state tree calls it) or
        // the bare `<event>:<hash>` content key (what the ledger calls it) — because a caller holding one
        // should not have to know the other. Reports what it ACTUALLY removed per key, never a claim: a key
        // this node never held comes back `was_present: false`, which is a legitimate and different answer
        // from a failure.
        if (!core.xclt) return { ok: false, error: 'ledger not initialized' };
        if (typeof core.xclt.evict !== 'function') {
          return { ok: false, error: 'this node predates evict — reinstall the node bundle' };
        }
        const raw = Array.isArray(req.keys) ? req.keys : (req.key ? [req.key] : null);
        if (!raw || !raw.length) return { ok: false, error: 'evict requires keys[] (anchor:<event>:<hash> or <event>:<hash>)' };
        if (raw.length > EVICT_MAX) return { ok: false, error: `evict capped at ${EVICT_MAX} keys per call (got ${raw.length})` };
        const before = (() => { try { return core.xvsm ? core.xvsm.getStateRoot() : null; } catch { return null; } })();
        const results = [];
        let evicted = 0, blocksDeleted = 0, wasPresent = 0;
        for (const k of raw) {
          if (typeof k !== 'string' || !k) { results.push({ key: k, evicted: false, block_deleted: 0, was_present: null, error: 'not a key' }); continue; }
          // ONE key, TWO spellings. `anchor:` is the state-tree prefix; the ledger's content key is what
          // follows it. Normalise both ways so each store is addressed the way it names things.
          const contentKey = k.startsWith('anchor:') ? k.slice('anchor:'.length) : k;
          const stateKey = k.startsWith('anchor:') ? k : (k.startsWith('xid:') ? null : `anchor:${k}`);
          const entry = { key: k, content_key: contentKey, state_key: stateKey };
          try {
            const r = await withTimeout(core.xclt.evict(contentKey, req.reason || 'operator eviction'), SUBMIT_TIMEOUT_MS, 'evict');
            entry.evicted = !!(r && r.evicted);
            entry.block_deleted = (r && r.rows_deleted) || 0;
            if (entry.evicted) evicted++;
            blocksDeleted += entry.block_deleted;
          } catch (e) { entry.evicted = false; entry.block_deleted = 0; entry.error = String(e?.message || e); }
          // The tree half. A node whose state machine never started still evicts from the ledger — say so
          // with was_present: null rather than reporting a removal that did not happen.
          if (stateKey && core.xvsm && typeof core.xvsm.forget === 'function') {
            try {
              const f = await core.xvsm.forget([stateKey]);
              entry.was_present = f.keys[0] ? f.keys[0].was_present : null;
              if (entry.was_present) wasPresent++;
            } catch (e) { entry.was_present = null; entry.state_error = String(e?.message || e); }
          } else entry.was_present = null;
          results.push(entry);
        }
        core._chainCounts = null;   // force `chain` to re-scan
        const after = (() => { try { return core.xvsm ? core.xvsm.getStateRoot() : null; } catch { return null; } })();
        return {
          ok: true, requested: raw.length, evicted, blocks_deleted: blocksDeleted, state_keys_present: wasPresent,
          state_root_before: before, state_root: after, root_moved: before !== after, keys: results,
        };
      }
      case 'submit_tx': {
        const tx = (req.params && req.params.tx) || req.tx;   // the coordinator spells it params.tx; the CLI, tx
        if (!tx || typeof tx !== 'object') {
          return { ok: false, error: 'submit_tx requires a tx object' };
        }
        if (core.suspended) return suspendedReply(core);     // a suspended node produces nothing
        // Guarded + time-boxed so a control request can never hang the daemon.
        const txId = await withTimeout(core.submitTransaction(tx), SUBMIT_TIMEOUT_MS, 'submit_tx');
        // ⛔ ok:true WITH tx_id:null WAS A LIE, and it is the whole reason 0 type-6 value txs ever reached the
        // chain while the broker's emission ledger recorded 12 as submitted. xpc.submitTransaction returns NULL
        // from each of its three ingress guards (unsigned, provably-invalid signature, unresolvable user) — a
        // REJECTION — and this handler reported it as a successful submit, so every rejected emission was marked
        // submitted upstream with an undefined tx_id and never re-sent. A submit that admitted nothing is not
        // ok — say so, and name which guards refuse so the caller fixes the envelope instead of re-sending the
        // same rejected bytes forever.
        if (!txId) return rejectedAtIngress();
        return { ok: true, tx_id: txId };
      }
      case 'submit_batch': {
        // The batch form the coordinator's drainer sends. Each tx is submitted through the SAME path and
        // judged by the SAME rule as submit_tx (a null id is a rejection, never a success), and the reply
        // carries one verdict per input in input order plus the two counts — so a caller can retry exactly
        // the rejected ones and never marks an admitted-nothing batch as delivered.
        // Wire shape (handoff src/xvsm-anchor.ts): { op:'submit_batch', params:{ txs:[<tx>, ...] } } — each <tx>
        // is the identical raw object submit_tx takes. The broker pages history at 500 per command. A re-applied
        // anchor is a root no-op on this ledger (content dedup) and counts as ACCEPTED, never as an error.
        const txs = Array.isArray(req.params && req.params.txs) ? req.params.txs : (Array.isArray(req.txs) ? req.txs : null);
        if (!txs) return { ok: false, error: 'submit_batch requires params.txs[]' };
        if (txs.length > SUBMIT_BATCH_MAX) return { ok: false, error: `submit_batch capped at ${SUBMIT_BATCH_MAX} txs per call (got ${txs.length})` };
        if (core.suspended) return suspendedReply(core);     // a suspended node produces nothing
        const results = [];
        let accepted = 0, failed = 0;
        for (const tx of txs) {
          if (!tx || typeof tx !== 'object') { results.push({ ok: false, tx_id: null, error: 'not a tx object' }); failed++; continue; }
          try {
            const txId = await withTimeout(core.submitTransaction(tx), SUBMIT_TIMEOUT_MS, 'submit_batch');
            if (txId) { results.push({ ok: true, tx_id: txId }); accepted++; }
            else { results.push(rejectedAtIngress()); failed++; }
          } catch (e) { results.push({ ok: false, tx_id: null, error: String(e?.message || e) }); failed++; }
        }
        // ok iff nothing failed — the one bit the caller reads today; the counts and per-tx results are what a
        // tracked dispatch resolves against, so a batch that admitted nothing can never be marked delivered.
        return { ok: failed === 0, accepted, failed, total: txs.length, results };
      }
      case 'ledger_capabilities': {
        // WHAT THE LEDGER THIS PROCESS IS RUNNING CAN DO — answered from the RUNNING code, not the install tree.
        // The coordinator asks this before issuing `rebuild_ledger`, which wipes the block store and rebuilds it
        // from the canonical anchor set: on a ledger that does not rescue non-anchor blocks, that op destroys
        // every value tx, utxo, identity and contract the node holds. `rescues_non_anchor_blocks` is therefore
        // a VETO, never an authorisation, and it is derived from the loaded module's own load-time version
        // (rescue landed in cubic-ledger 0.1.4) plus feature detection of the method itself — two reads that
        // must agree before the answer is true.
        if (!core.xclt) return { ok: false, error: 'ledger not initialized' };
        const v = CUBIC_LEDGER_VERSION;
        const rescues = typeof core.xclt.rebuildFromAnchors === 'function' && semverGte(v, '0.1.4');
        // Wire shape (handoff coord-xmbl-node.mjs probeLedgerRescue): r.ok, r.capabilities, and
        // r.capabilities.rescues_non_anchor_blocks STRICTLY === true is the only live grant to run rebuild_ledger;
        // anything else falls back to apply_canonical (no wipe). The other fields are informational.
        return {
          ok: true,
          version: v,
          versions: RUNNING_VERSIONS,
          capabilities: {
            rescues_non_anchor_blocks: rescues,
            reports_wiped_count: rescues,                                   // same release
            evicts_invalid_for_good: typeof core.xclt.evict === 'function', // 0.1.9+: an invalid tx is refused across restarts
            // 0.1.17+: the `evict` OP exists on this socket, so a caller can actually reach that method.
            // Until this release `evicts_invalid_for_good` advertised a capability nothing could invoke —
            // the coordinator gates XMBL_XOPS on this flag, so it must answer for the OP, not the method.
            evict_op: true,
            // 0.1.17+: an evicted key is refused by rebuildFromAnchors too, so a canonical feed that still
            // carries the anchor cannot mint it back on the next convergence tick.
            eviction_survives_rebuild: true,
            content_addressed_block_ids: semverGte(v, '0.1.9'),
            rekeys_legacy_rows_on_boot: semverGte(v, '0.1.11'),
            // ⚠ A SECOND VETO, and the one that decides WHICH FEED may be handed to this node. true = this
            // ledger refuses an anchor with no verifiable xid, so `rebuild_ledger` MUST be driven from the
            // broker's epoch-scoped, typed set (?from_epoch=1). Driving it from the default feed on a node
            // that answers true wipes the chain to empty — measured: 0 of 4008 rebuilt, 3991 untyped, 17
            // rejected. Feature-detected from the running code (TYPED_ANCHOR_POLICY), never from a disk
            // version, because the coordinator's on-disk read has inverted polarity during an OTA.
            requires_typed_anchors: TYPED_ANCHOR_POLICY.refuses_untyped && TYPED_ANCHOR_POLICY.accepts_typed,
            // The rebuild REPORTS what it refused — {untyped, rejected} come back in the rebuild_ledger reply —
            // so a coordinator that hands over the wrong feed sees it in the counts instead of a silent wipe.
            rebuild_counts_untyped: rescues,
            // The rebuild re-mines {from:[prior],to:[hash],how:'anchor'} and accepts when the xid matches: a
            // `prior` naming an anchor outside the set is a correct value. Continuity is NOT required, so the
            // broker's head-advance-at-mint does not block a rebuild. Order of arrival cannot change the result.
            rebuild_is_content_addressed: rescues,
            // apply_canonical reads only {event, hash, ts} and leaves the block store untouched, so it is safe
            // on ANY feed, typed or not — the correct holding pattern while a rollout is mid-flight.
            apply_canonical_accepts_untyped: typeof core.xvsm?.rebuildFromCanonical === 'function',
          },
        };
      }
      case 'identity_status': {
        // CAN THIS NODE SIGN A CHAIN CLAIM, AND IF NOT, WHY. A node holding a public key and no private key,
        // or a public and private key from DIFFERENT keypairs, comes up healthy, answers every op, and
        // publishes no chain block at all — the broker drops an unsigned or badly-signed claim silently. This
        // is the node saying so itself: present-field check plus a real sign→verify round trip through the same
        // seam the chain claim uses. Never returns key material.
        if (!core.xid) return { ok: false, error: 'identity not initialized' };
        if (typeof core.xid.verifySigning !== 'function') {
          return { ok: true, ...(core.xid.signingStatus ? core.xid.signingStatus() : { can_sign: !!(core.xid.address && core.xid.publicKey && core.xid.privateKey) }), keypair_consistent: null, source: 'presence-only (identity predates verifySigning)' };
        }
        const r = await withTimeout(core.xid.verifySigning(), SUBMIT_TIMEOUT_MS, 'identity_status');
        return { ok: true, ...r, source: 'identity.verifySigning()' };
      }
      case 'contract_deploy': {
        // PLACE A CONTRACT ON THIS CHAIN, and record the placement as a block so every node holds it.
        //
        // Deployment is content-addressed: id = contractId(wasm bytes), coordinates = a pure function of
        // the id, so two nodes handed the same bytes place the contract identically with no agreement
        // step. But ContractHost keeps its registry in MEMORY — a restart forgets every contract, and a
        // node that never saw the deploy call cannot execute the contract at all. So the deploy is
        // ANCHORED as a type-4 `contract` tx carrying the bytecode, which makes it part of the chain the
        // canonical primitives already replicate and re-derive. `replayContracts` re-deploys from those
        // blocks on boot; a node that never ran this op still ends up holding the contract.
        //
        // Takes EITHER `wasm` (base64 of the compiled module) or `lng_source`. LNG is compiled HERE, in
        // the daemon, so the bytes anchored are the bytes this node executes — compiling on the caller's
        // side and trusting the upload would make the source and the deployed code two different things.
        if (!core.contractHost) return { ok: false, error: 'contracts role not enabled (roles.contracts, which also requires roles.compute)' };
        if (core.suspended) return suspendedReply(core);
        let bytes, source = null;
        if (typeof req.wasm === 'string' && req.wasm) {
          try { bytes = new Uint8Array(Buffer.from(req.wasm, 'base64')); }
          catch (e) { return { ok: false, error: `wasm is not valid base64: ${e.message}` }; }
        } else if (typeof req.lng_source === 'string' && req.lng_source) {
          source = req.lng_source;
          // ⛔ REFUSE WHAT LNG CANNOT EMIT, rather than compiling a module without the import and
          // deploying it with the flag ON. The LNG backend's `compile` takes exactly four opt-ins —
          // hostState, compose, crypto, utxo — and its surface has builtins for only those
          // (xmbl.cubic.verify, xmbl.mayo.verify, xmbl.coord.read/send, xmbl.utxo.*). There is NO
          // zk / he / fhe / air builtin, so a `~contract` cannot call xmbl_zk_verify, xmbl_he_add,
          // xmbl_fhe_* or xmbl_air_verify at all. Those host functions are real and bound by XCL, but
          // today they are reachable only from hand-encoded WASM — pass `wasm` for those. Accepting
          // the flag here would produce a contract that declares a capability its bytes never use,
          // which is the false-green this whole op exists to avoid.
          const unreachable = ['zk_host', 'he_host', 'fhe_host', 'air_host'].filter((k) => req[k]);
          if (unreachable.length) {
            return { ok: false, error: `lng_source cannot reach ${unreachable.join(', ')} — the LNG backend emits only hostState/compose/crypto/utxo imports and has no zk/he/fhe/air builtin; deploy hand-encoded \`wasm\` for those`, lng_backends: ['hostState', 'compose', 'crypto', 'utxo'] };
          }
          try {
            const { compile } = await import('@xmbl/lng');
            // The backends are OPT-IN at compile time and the deploy flags below must AGREE with them:
            // a contract compiled without `hostState` has no Verkle imports to bind, and one compiled
            // with them but deployed without `byteState` runs against staging that is never applied.
            // One options object drives both, so the two cannot drift.
            bytes = compile(source, {
              hostState: req.byte_state !== false, crypto: !!req.crypto_host,
              utxo: !!req.utxo_host, compose: !!req.compose_host,
            });
            if (!(bytes instanceof Uint8Array)) bytes = Uint8Array.from(bytes);
          } catch (e) { return { ok: false, error: `lng compile failed: ${e.message}` }; }
        } else {
          return { ok: false, error: 'contract_deploy requires wasm (base64) or lng_source' };
        }
        if (bytes.length > CONTRACT_WASM_MAX) {
          return { ok: false, error: `contract module capped at ${CONTRACT_WASM_MAX} bytes (got ${bytes.length}) — a block carries these bytes to every node` };
        }
        const slots = Array.isArray(req.slots) ? req.slots.map((n) => n | 0) : [];
        const deployOpts = {
          gated: !!req.gated, byteState: req.byte_state !== false, wordAbi: req.word_abi !== false,
          cryptoHost: !!req.crypto_host, zkHost: !!req.zk_host, heHost: !!req.he_host,
          fheHost: !!req.fhe_host, airHost: !!req.air_host, utxoHost: !!req.utxo_host,
          composeHost: !!req.compose_host, fields: Array.isArray(req.fields) ? req.fields : undefined,
        };
        let placed;
        try { placed = core.contractHost.deploy(bytes, slots, deployOpts); }
        catch (e) { return { ok: false, error: `deploy failed: ${e.message}` }; }
        // ANCHOR IT. A deploy that only lives in this process is not a deployment — it is a local
        // side effect that the next restart erases.
        const anchored = await anchorContractTx(core, {
          type: 'contract',
          contractHash: placed.id,
          abi: { slots, opts: deployOpts, fields: deployOpts.fields ?? null },
          bytecode: Buffer.from(bytes).toString('base64'),
          deployer: core.xid?.address ?? null,
        });
        return {
          ok: true, contract_id: placed.id, coordinates: placed.coordinates,
          bytes: bytes.length, compiled_from_lng: source !== null,
          state_root: (() => { try { return core.xvsm.getStateRoot(); } catch { return null; } })(),
          ...anchored,
        };
      }
      case 'contract_call': {
        // EXECUTE a deployed contract against this node's real Verkle tree, and anchor the RECEIPT.
        //
        // The writes land in `core.xvsm.stateTree` because that is the store the host was constructed
        // with — so a call moves the same state root the canonical rebuild computes, and two nodes
        // running the same call converge (contract-host.test.mjs proves the convergence; this op is
        // what puts it on the chain). The receipt is anchored as a type-5 `state_diff` tx naming the
        // contract, the method and the applied write set, so a node replaying the chain applies the
        // same keys without re-executing.
        if (!core.contractHost) return { ok: false, error: 'contracts role not enabled (roles.contracts, which also requires roles.compute)' };
        if (core.suspended) return suspendedReply(core);
        const contractId = req.contract_id || req.contractId;
        const method = req.method || req.function_name;
        if (!contractId || !method) return { ok: false, error: 'contract_call requires contract_id and method' };
        const params = Array.isArray(req.params) ? req.params : (Array.isArray(req.args) ? req.args : []);
        const opts = { caller: req.caller ?? 0 };
        // Tagged BigInts are revived here, once, for every staged surface — see reviveBigInts. The
        // material is otherwise passed through UNINTERPRETED: it must be identical on every node for
        // the verdict to be deterministic, which makes it the chain's value to supply, not this
        // socket's to invent.
        for (const k of ['auth', 'crypto', 'zk', 'he', 'fhe', 'air', 'inputs']) if (req[k] !== undefined) opts[k] = reviveBigInts(req[k]);
        const rootBefore = (() => { try { return core.xvsm.getStateRoot(); } catch { return null; } })();
        let out;
        try { out = await withTimeout(core.contractHost.call(contractId, method, params, opts), CONTRACT_CALL_TIMEOUT_MS, 'contract_call'); }
        catch (e) {
          // A REVERT IS A RESULT, NOT A CRASH — and it applied nothing, which is the part a caller must
          // be able to see. ContractHost unwinds the whole cascade on a throw, so state is unchanged.
          return {
            ok: false, error: String(e?.message || e), reverted: true, contract_id: contractId, method,
            state_root: (() => { try { return core.xvsm.getStateRoot(); } catch { return null; } })(),
            state_root_before: rootBefore,
          };
        }
        const writeSet = (out.allWrites || out.writes || []).map((w) => (
          w && w.kind === 'bytes' ? { kind: 'bytes', contract: w.id, key: w.hk } : { kind: 'slot', contract: w.id, slot: w.slot }
        ));
        const anchored = await anchorContractTx(core, {
          type: 'state_diff',
          function: method,
          args: { params: params.map((p) => (typeof p === 'bigint' ? p.toString() : p)), writes: writeSet },
          contractAddress: contractId,
          caller: String(opts.caller ?? 0),
        });
        return {
          ok: true, contract_id: contractId, method,
          // BigInt is not JSON — the word ABI decodes a `~u256` return to one, and this reply is a
          // single JSON line on a socket. Stringify it rather than throwing on serialize.
          result: typeof out.result === 'bigint' ? out.result.toString() : out.result,
          write_set: writeSet, writes: writeSet.length, frames: out.frames ?? 1,
          coordinates: out.coordinates ?? null, utxo: out.utxo ?? null,
          state_root_before: rootBefore, state_root: out.stateRoot,
          root_moved: rootBefore !== out.stateRoot,
          ...anchored,
        };
      }
      case 'contracts': {
        // WHAT THIS NODE ACTUALLY HOLDS. Read-only: the ids, their coordinates and which opt-in hosts
        // each was deployed with — so a caller can tell a node that replayed the deploy from one that
        // never saw it, without guessing from a version.
        if (!core.contractHost) return { ok: false, error: 'contracts role not enabled (roles.contracts, which also requires roles.compute)' };
        const rows = [];
        for (const [id, e] of core.contractHost.contracts) {
          rows.push({
            contract_id: id, coordinates: e.coordinates, bytes: e.wasm.length, gated: !!e.gated,
            slots: [...e.slots], byte_keys: e.byteKeys.size,
            hosts: { byteState: !!e.byteState, wordAbi: !!e.wordAbi, crypto: !!e.cryptoHost, zk: !!e.zkHost,
                     he: !!e.heHost, fhe: !!e.fheHost, air: !!e.airHost, utxo: !!e.utxoHost, compose: !!e.composeHost },
          });
        }
        return {
          ok: true, count: rows.length, contracts: rows,
          // THE CAPABILITY GATE, ANSWERED BY THE RUNNING CODE. A coordinator needs ONE read to decide
          // whether it may issue contract_deploy/contract_call to this node, and a version string cannot
          // answer it safely (the on-disk probe has inverted polarity mid-OTA — the same reason
          // requires_typed_anchors is feature-detected). `ok:true` on this op IS the gate: a node
          // without the role answers ok:false naming the role. The rest says what a caller may ask for.
          capabilities: {
            contract_ops: true,                       // contract_deploy / contract_call / contracts exist
            anchors_receipts: true,                   // a deploy and every call are recorded as blocks
            replays_from_blocks: true,                // a restart re-deploys from the block store
            staged_bigints_tagged: true,              // {"__bigint__":"123"} is revived in auth/crypto/zk/he/fhe/air/inputs
            wasm_max_bytes: CONTRACT_WASM_MAX,
            call_timeout_ms: CONTRACT_CALL_TIMEOUT_MS,
            // Which opt-in hosts a contract may declare, and how each is reachable TODAY. `lng` means a
            // `~contract` can emit the import; `wasm` means hand-encoded only. Stated per backend so a
            // caller never deploys a module declaring a capability its bytes cannot use.
            hosts: {
              byteState: 'lng', wordAbi: 'lng', compose: 'lng', crypto: 'lng', utxo: 'lng',
              zk: 'wasm', he: 'wasm', fhe: 'wasm', air: 'wasm',
            },
            lng_backends: ['hostState', 'compose', 'crypto', 'utxo'],
          },
          state_root: (() => { try { return core.xvsm.getStateRoot(); } catch { return null; } })(),
        };
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
      case 'xsc': {
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
          // ⛔ THE ROUND TRIP IS NOT A DURABILITY CHECK, AND ON ITS OWN IT IS THE FALSE GREEN THIS OP EXISTS
          // TO PREVENT. A node whose LevelDB failed to open serves the read it just took out of memory, so
          // `round_tripped: true` is returned identically by a node that stored the bytes and one that will
          // lose them at the next restart. storeShard now refuses the undeclared case outright, but a node
          // running deliberately volatile still passes the round trip — so the answer states which it is.
          // (packages/storage-compute/src/storage-node.js and its durability.test.mjs.)
          const dur = typeof stor.ready === 'function' ? await stor.ready() : null;
          return {
            ok: true,
            shard_id: shardId,
            bytes: bytes.length,
            round_tripped: roundTripped,
            durable: dur ? dur.durable : null,
            volatile: dur ? dur.volatile : null,
            storage_path: dur ? dur.dbPath : null,
            storage_error: dur ? dur.error : null,
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

        // ── THE CLAIM, SIGNED ───────────────────────────────────────────────────────────────────────
        // Every number above reaches the broker second-hand: the coordinator reads this socket and POSTs
        // the result to the broker, where an agent key — ANY managed agent key, on any box — was the only
        // thing standing behind it. So a node's chain reading was whatever its coordinator said it was, and
        // the broker published it as that node's, by address.
        //
        // An xmbl address is SELF-CERTIFYING: deriveAddress(pk) === 'xmb'+sha256(pk)[:40]
        // (identity/src/identity.js). So a statement signed by THIS node's identity key, carrying its own
        // address, is the only form of this reading that binds to the node rather than to whoever relayed it.
        //
        // `stmt` is a CANONICAL STRING, not an object, and it is what gets signed. A verifier checks the
        // exact bytes it received and never re-serialises: key order, number formatting and unicode escaping
        // can then never make a valid claim fail, nor let a published number drift from a signed one.
        //
        // It covers EVERY field a consumer publishes as this node's chain — not just state_root. Signing the
        // root and leaving blocks_persisted unsigned beside it would publish a verified number next to an
        // unverified one and call the pair verified, which is the same defect one field over.
        //
        // ADDITIVE: the top-level fields are unchanged. A node that cannot sign (verification-only identity,
        // or no identity yet) returns the reading with no stmt — a consumer then treats the chain claim as
        // unsigned, which is exactly what it is.
        const blocks_persisted_s = cube_curve ? cube_curve.blocks_persisted : null;
        const stmtObj = {
          v: 1,
          node_address: (core.xid && core.xid.address) || null,
          // HEIGHT = blocks_persisted: the count of durable `block:` rows, which survives restart. Not
          // applied_tx_count, and emphatically not tx_count, which is mempool raw+processing+final and
          // DECREASES as transactions drain.
          height: blocks_persisted_s,
          state_root,
          tx_count,
          applied_tx_count: stats ? stats.totalTransactions : null,
          cubes_persisted: cube_curve ? cube_curve.cubes_persisted : null,
          faces_sealed: cube_curve ? (cube_curve.faces_sealed_since_boot ?? cube_curve.faces_in_memory) : null,
          blocks_persisted: blocks_persisted_s,
          mempool: mempool ? { raw: mempool.raw ?? 0, processing: mempool.processing ?? 0, final: mempool.final ?? 0 } : null,
          versions: RUNNING_VERSIONS,
          // THE VERSION PROOF, inside the signature: the digest of the code this process loaded (see RUNNING_BUILD),
          // and whether this node has suspended itself for running behind the latest published version.
          build: RUNNING_BUILD.digest,
          suspended: core.suspended ? { reason: core.suspended.reason, since: core.suspended.since, running: core.suspended.running ?? null, latest: core.suspended.latest ?? null } : null,
          // THE NODE'S OWN CLOCK, inside the signature — the one field a freshness gate depends on is the one
          // field the node must attest itself.
          ts: new Date().toISOString(),
        };
        let stmt = null, sig = null, pk = null;
        try {
          if (core.xid && core.xid.address && core.xid.publicKey && core.xid.privateKey) {
            stmt = JSON.stringify(stmtObj);
            sig = await withTimeout(sign(stmt, core.xid.privateKey), SUBMIT_TIMEOUT_MS, 'chain sign');
            pk = core.xid.publicKey;
          }
        } catch { stmt = null; sig = null; pk = null; }   // an unsignable reading is reported UNSIGNED, never as signed

        return {
          ok: true,
          state_root,
          tx_count,
          mempool,                                             // {raw,processing,final,lockedUtxos} | null
          applied_tx_count: stats ? stats.totalTransactions : null,  // xvsm-executed tx count
          state_diffs: stats ? stats.totalDiffs : null,        // xvsm state-diff count
          cube_curve,                                          // the SEALING layer — see above
          recent_tx,                                           // [{ id, type, timestamp }]
          versions: RUNNING_VERSIONS,                          // what this process is running (see status)
          build: RUNNING_BUILD.digest,                         // the version proof (see RUNNING_BUILD)
          suspended: core.suspended || null,
          // the same reading, bound to this node's identity — see the block above
          ...(stmt && sig && pk ? { stmt, sig, pk } : {}),
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
