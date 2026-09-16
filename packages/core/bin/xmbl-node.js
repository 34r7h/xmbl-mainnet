#!/usr/bin/env node
// xmbl-node daemon — the runnable form of @xmbl/core. `npx xmbl-node start --config <path>` boots XMBLCore
// with every protocol module wired (identity, networking, cubic-ledger, state-machine, consensus,
// storage-compute) and exposes the control socket + metrics endpoint a supervisor talks to.
//
// This is the SAME daemon the handoff fleet's coordinators supervise; it ships here so a deployment can depend
// on the published package instead of vendoring a copy of core/ that drifts from it.
//
// Lifecycle around XMBLCore (core/index.js), driven by the node config
// (core/node-config.js, A5a):
//   node node.js start  --config <path>   boot XMBLCore, write pidfile + status
//   node node.js stop   --config <path>   SIGTERM the running node, wait for exit 0
//   node node.js status --config <path>   report liveness + peer id from disk
//
// `start` runs the node in the FOREGROUND: the process it launches IS the node a
// coordinator supervises. `stop`/`status` are separate short-lived invocations
// that act on the running node via its pidfile.
//
// Scope (A5b): lifecycle only. Role flags are passed through and recorded, not
// used to gate subsystems (that is group-E).
//
// Identity (A5e): the node loads a STABLE identity from the C1 keystore at
// `config.identity_path` on start (create-once if absent, 0600) and hands it to
// XMBLCore BEFORE boot, so restarts keep the same xmbl `address` instead of
// minting a fresh XMBLCore identity each time. D3 (submit_tx from the node wallet)
// and E1 (validation tasks assigned to the submitting identity) require this
// stability. NOTE: this binds the xmbl `address` (the wallet/signing identity);
// the libp2p `peer_id` is xn's own key and is NOT persisted here — see
// scripts/node-identity-check.mjs and the A5e submission note.
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../node-config.js';
import { createControlServer } from '../control-socket.js';
import { createMetricsServer } from '../metrics-server.js';
import { ensureIdentityAtPath, loadIdentityAtPath } from '@xmbl/identity';
import { loadOrCreatePeerKey } from '@xmbl/networking';
// NOTE: XMBLCore is imported lazily inside `start` only. Importing core/index.js
// pulls in xvsm/xpc/xsc, which print startup banners at module-load time — that
// would pollute the machine-readable stdout of `status`/`stop`, which are pure
// filesystem operations and must not boot the core stack.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) flags[name] = argv[++i];
      else flags[name] = true;
    } else pos.push(a);
  }
  return { command: pos[0], flags };
}

const pidFile = (dataDir) => path.join(dataDir, 'node.pid');
const statusFile = (dataDir) => path.join(dataDir, 'node.status.json');
const sockFile = (dataDir) => path.join(dataDir, 'node.sock');

function readPid(dataDir) {
  try {
    const pid = parseInt(fs.readFileSync(pidFile(dataDir), 'utf8').trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

// process.kill(pid, 0) throws ESRCH if the process is gone, EPERM if it exists
// but we can't signal it (still "alive").
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Map the node config (A5a shape) onto the XMBLCore/app config shape.
function toCoreConfig(cfg, dataDir) {
  return {
    network: { addresses: cfg.listen_addrs, bootstrap: cfg.bootstrap_peers, announce: cfg.announce_addrs || [] },
    ledger: { dbPath: path.join(dataDir, 'ledger') },
    stateMachine: { dbPath: path.join(dataDir, 'xvsm'), totalShards: 4 },
    consensus: { dbPath: path.join(dataDir, 'xpc') },
    storage: { dbPath: path.join(dataDir, 'storage'), capacity: cfg.resource_caps.disk_mb * 1024 * 1024 },
    // E3: this node's own compute-job caps (A5a resource_caps), read by
    // XMBLCore.start() when constructing the opt-in ComputeNode.
    compute: { cpuMs: cfg.resource_caps.compute_cpu_ms, memMb: cfg.resource_caps.compute_mem_mb },
    logging: { level: 'info' },
    // group-E role opt-ins (E1's validate worker reads roles.validate, E3's
    // compute worker reads roles.compute; see XMBLCore.start()). A5b left these
    // passed-through/recorded only — this is group-E actually gating subsystems
    // on them.
    roles: cfg.roles,
  };
}

// Set by the `--ppid` watch below when one is armed; called by the control socket's `detach` op. Null
// when no watch exists (a pm2/systemd-managed node), which the op reports honestly rather than faking.
let detachPpidWatch = null;
let detached = false;

async function cmdStart(cfgPath, flags = {}) {
  const startTime = Date.now(); // for the metrics uptime counter
  const cfg = loadConfig(cfgPath);
  const dataDir = path.resolve(cfg.data_dir);
  fs.mkdirSync(dataDir, { recursive: true });

  const existing = readPid(dataDir);
  if (existing && isAlive(existing)) {
    console.error(`xmbl-node already running (pid ${existing})`);
    process.exit(1);
  }
  if (existing) fs.rmSync(pidFile(dataDir), { force: true }); // stale pidfile

  // ONE NODE PER MACHINE. The guard above is per-DATA_DIR, so two nodes with different data dirs both passed
  // it and both ran on the same box. That is not a supported topology and it does not fail cleanly: the second
  // node's WebTorrent conn-pool binds the same fixed UTP port and, before that transport learned to degrade,
  // took the whole daemon down with an unhandled EADDRINUSE mid-boot; two nodes also share one machine's
  // libp2p mDNS view and mint two identities that look like a mesh while sharing one failure domain.
  // A TESTNET WANTS REAL NODES ON REAL ADDRESSES: run each one in its own container (Apple `container`, one
  // IP per node on 192.168.64.0/24 — see scripts/xmbl-mesh/container-testnet.mjs). A container is a separate
  // machine for this purpose and gets its own lock, so the rule and the testnet do not conflict.
  // Set XMBL_ALLOW_COLOCATED_NODES=1 only to deliberately reproduce the co-location failure.
  const MACHINE_LOCK = process.env.XMBL_MACHINE_LOCK || '/var/tmp/xmbl-node.machine.lock';
  let machineLockHeld = false;
  if (process.env.XMBL_ALLOW_COLOCATED_NODES !== '1') {
    for (let attempt = 0; attempt < 2 && !machineLockHeld; attempt++) {
      try {
        // wx is an ATOMIC create-or-fail — two racing starts cannot both win it.
        fs.writeFileSync(MACHINE_LOCK, JSON.stringify({ pid: process.pid, data_dir: dataDir, at: new Date().toISOString() }), { flag: 'wx' });
        machineLockHeld = true;
      } catch (e) {
        if (e.code !== 'EEXIST') { console.warn(`xmbl-node: could not take the machine lock at ${MACHINE_LOCK} (${e.code}) — continuing`); break; }
        let held = null;
        try { held = JSON.parse(fs.readFileSync(MACHINE_LOCK, 'utf8')); } catch { /* unreadable ⇒ treat as stale */ }
        if (held && held.pid && isAlive(held.pid)) {
          console.error(`xmbl-node: another node is ALREADY RUNNING ON THIS MACHINE (pid ${held.pid}, data_dir ${held.data_dir}).`);
          console.error('One node per machine. For a multi-node testnet give each node its own container/IP:');
          console.error('  node scripts/xmbl-mesh/container-testnet.mjs up --nodes 3');
          process.exit(1);
        }
        fs.rmSync(MACHINE_LOCK, { force: true });   // the holder is gone — its lock is stale
      }
    }
  }
  const releaseMachineLock = () => {
    if (!machineLockHeld) return;
    // Only remove a lock that is still OURS — never another node's, if ours was reaped and replaced.
    try { const h = JSON.parse(fs.readFileSync(MACHINE_LOCK, 'utf8')); if (h.pid !== process.pid) return; } catch { return; }
    try { fs.rmSync(MACHINE_LOCK, { force: true }); } catch { /* best effort */ }
  };
  process.on('exit', releaseMachineLock);

  const { XMBLCore } = await import('../index.js'); // lazy: see top-of-file note
  const coreCfg = toCoreConfig(cfg, dataDir);

  // A5f: persist xn's libp2p key next to the C1 keystore (0600) so the node's
  // peer_id is STABLE across restarts — the libp2p analog of A5e's stable address.
  // Create-once if absent, load if present, then hand it to XNNode via
  // config.network BEFORE core.start() constructs libp2p (else it mints a fresh
  // peer_id each boot). D3/E1 (validation tasks keyed to a stable node) and a
  // bootstrap seed's published multiaddr (which embeds its peer_id) require this.
  const peerKeyPath = path.join(path.dirname(cfg.identity_path), 'libp2p-peer.key');
  const peerKeyInfo = await loadOrCreatePeerKey(peerKeyPath);
  coreCfg.network.privateKey = peerKeyInfo.privateKey;
  const core = new XMBLCore(coreCfg);

  // A5e: bind a STABLE node identity from the C1 keystore at cfg.identity_path
  // BEFORE start(). loadConfig has already rejected a missing/empty identity_path,
  // so there is no silent-mint fallback: create-once (0600) if the keystore file is
  // absent, load it if present, then hand it to XMBLCore (which skips its own
  // fresh-mint because xid is now set).
  const idInfo = await ensureIdentityAtPath(cfg.identity_path);
  const identity = await loadIdentityAtPath(cfg.identity_path);
  core.setIdentity(identity);

  await core.start();

  // start() opens no LevelDB (level is lazy). Open the ledger and write a boot
  // marker so the database is genuinely exercised — otherwise a stop/restart
  // cycle would flush and reopen nothing and prove nothing about integrity.
  await core.xclt.db.open();
  const peerId = core.xn.getPeerId() ? core.xn.getPeerId().toString() : null;
  await core.xclt.db.put(
    'node:boot',
    JSON.stringify({ peer_id: peerId, at: new Date().toISOString() }),
  );

  // Health + metrics endpoint (A5d): loopback-only HTTP, OS-assigned port. The
  // port is published in node.status.json + the control-socket status so the
  // coordinator can discover it without a fixed port or a config change.
  const metrics = await createMetricsServer({ core, port: 0, startTime });
  const metricsUrl = `http://127.0.0.1:${metrics.port}/`;

  fs.writeFileSync(pidFile(dataDir), String(process.pid), { mode: 0o644 });
  const status = {
    pid: process.pid,
    peer_id: peerId,
    address: core.xid ? core.xid.address : null,
    roles: cfg.roles,
    listen_addrs: cfg.listen_addrs,
    metrics_url: metricsUrl,
    started_at: new Date().toISOString(),
  };
  fs.writeFileSync(statusFile(dataDir), JSON.stringify(status, null, 2), { mode: 0o644 });

  // Local control socket (A5c): how the coordinator talks to this running node.
  const sockPath = sockFile(dataDir);
  const server = await createControlServer({
    core,
    config: cfg,
    sockPath,
    statusSnapshot: () => ({
      pid: process.pid,
      peer_id: peerId,
      address: core.xid ? core.xid.address : null,
      roles: cfg.roles,
      listen_addrs: cfg.listen_addrs,
      metrics_url: metricsUrl,
      started_at: status.started_at,
      // Rides the ALREADY-POLLED status op (broker calls nodeStatus() on every /xmbl/status; no new
      // round-trip, not gated behind the slower `chain` O(blocks) scan) — same in-memory ring the
      // dedicated `validations` op also serves, just cheaply duplicated onto the hot path too.
      validations: (core.recentValidations || []).slice().reverse(),
    }),
    // `detach` op plumbing — see the ppid watch in this file. Returns a truthful shape in all three
    // states so a coordinator can decide whether restarting is safe: watch armed (detaches), no watch
    // armed (nothing to do — pm2/systemd owns this node), already detached (idempotent).
    detachPpidWatch: () => {
      if (detached) return { ok: true, already: true };
      if (!detachPpidWatch) return { ok: true, armed: false };
      return { ok: true, armed: true, ...detachPpidWatch() };
    },
  });
  console.log(
    `xmbl-node started pid=${process.pid} address=${core.xid ? core.xid.address : null}` +
      ` (identity ${idInfo.created ? 'created' : 'loaded'} at ${idInfo.path}) peer=${peerId} sock=${sockPath} metrics=${metricsUrl}`,
  );

  // Keep the process alive even if no networking role holds the loop open, and
  // shut down cleanly on signal: close the control socket, flush every LevelDB
  // (core.stop), then remove the pidfile/status/sock and exit 0.
  const keepAlive = setInterval(() => {}, 1 << 30);
  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(keepAlive);
    try {
      // server.close() only calls back once EVERY connection has ended, and the `subscribe` op holds its
      // connection open forever by design. So one attached subscriber — e.g. the coordinator's message relay,
      // still attached when the coordinator itself died — made SIGTERM hang here indefinitely: the node stopped
      // shutting down and had to be SIGKILLed, which is how a node ends up orphaned with a stale pidfile.
      // Drop the connections first, then close. (closeAllConnections: Node >=18.2; optional-called for older.)
      server.closeAllConnections?.();
      await Promise.race([
        new Promise((r) => server.close(r)),
        new Promise((r) => setTimeout(r, 5000).unref?.()),
      ]);
    } catch { /* already closed */ }
    try {
      await new Promise((r) => metrics.server.close(r));
    } catch { /* already closed */ }
    try {
      await core.stop();
    } catch (e) {
      console.error(`xmbl-node shutdown error: ${e.message}`);
    }
    fs.rmSync(pidFile(dataDir), { force: true });
    fs.rmSync(statusFile(dataDir), { force: true });
    fs.rmSync(sockPath, { force: true });
    releaseMachineLock();
    console.log(`xmbl-node stopped (${sig})`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // B2b: LIFECYCLE COUPLING — no orphans. A coordinator spawns this node as a plain
  // (non-detached) child, but an ungraceful coordinator death (SIGKILL, crash) does NOT
  // propagate to a non-detached child on POSIX — the node would keep running with no
  // supervisor left to talk to it. `--ppid <pid>` (same shape as client/tunnel_agent.mjs's
  // WATCH_PPID) has this node poll its launcher's pid and self-shutdown the moment it's
  // gone, instead of relying on the coordinator to always exit cleanly.
  //
  // advisor finding (PID-REUSE hole, folded per handoff-claude's fold-now decision): isAlive(pid)
  // is process.kill(pid,0), which only asks "does SOME process have this pid" — if the coordinator
  // dies and the OS reuses its pid for an unrelated process before the next 3s poll, isAlive stays
  // true FOREVER and this node never notices — a permanent orphan, exactly what B2b exists to
  // prevent. process.ppid is reuse-safe: this node is a DIRECT child (spawn detached:false), so
  // process.ppid === watchPpid at start; the moment the real parent dies the OS reparents this
  // process (process.ppid becomes 1 or a subreaper), which is instant and cannot be faked by pid
  // reuse — it reflects who ACTUALLY owns this process right now, not "does a pid exist". Checked
  // first (belt-and-suspenders): isAlive stays as the fallback for platforms/cases where reparenting
  // doesn't apply.
  const watchPpid = flags.ppid ? Number(flags.ppid) : 0;
  if (watchPpid) {
    const ppidCheck = setInterval(() => {
      if (process.ppid !== watchPpid || !isAlive(watchPpid)) {
        clearInterval(ppidCheck);
        console.log(`xmbl-node: launcher pid ${watchPpid} is gone — shutting down (no orphan)`);
        shutdown('parent-death');
      }
    }, 3000);
    ppidCheck.unref?.(); // never itself the reason the process stays alive
    // DETACH (control socket `detach` op) — how a coordinator RELOADS without forking the chain.
    //
    // The watch above is correct for a coordinator that DIES, and fatal for one that RESTARTS: this node
    // is a lead in the sealing mesh, seal_quorum derives from live_lead_count, and a lead that vanishes
    // mid-round is the self-sealing divergence in docs/xmbl-node-hotreload-design.md. Reparenting fires
    // instantly and cannot be re-pointed after the fact, so a coordinator that re-execs kills its own
    // node every time — which would make auto-update strictly worse than updating by hand.
    //
    // So the coordinator announces the restart FIRST: `detach` cancels the watch, the coordinator exits,
    // this node keeps running and holding its quorum position, and the replacement coordinator ADOPTS it
    // (startXmblNode's `status` probe already returns 'already running' and declines to spawn a second).
    // Deliberately one-way and un-armable: a node told to survive one restart must never silently
    // re-arm against a pid that no longer means anything.
    detachPpidWatch = () => {
      clearInterval(ppidCheck);
      detached = true;
      console.log(`xmbl-node: ppid watch DETACHED (was pid ${watchPpid}) — surviving a coordinator restart`);
      return { was: watchPpid };
    };
  }
}

async function cmdStop(cfgPath) {
  const cfg = loadConfig(cfgPath);
  const dataDir = path.resolve(cfg.data_dir);
  const pid = readPid(dataDir);
  if (!pid || !isAlive(pid)) {
    if (pid) fs.rmSync(pidFile(dataDir), { force: true }); // clear stale pidfile
    console.error('xmbl-node not running');
    process.exit(1);
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && isAlive(pid)) await sleep(100);
  if (isAlive(pid)) {
    console.error(`xmbl-node (pid ${pid}) did not stop within 15s`);
    process.exit(1);
  }
  console.log(`xmbl-node stopped (pid ${pid})`);
}

function cmdStatus(cfgPath) {
  const cfg = loadConfig(cfgPath);
  const dataDir = path.resolve(cfg.data_dir);
  const pid = readPid(dataDir);
  if (!pid) {
    console.log(JSON.stringify({ running: false, reason: 'no pidfile' }));
    return;
  }
  if (!isAlive(pid)) {
    console.log(JSON.stringify({ running: false, reason: 'stale pidfile', pid }));
    return;
  }
  let status = {};
  try {
    status = JSON.parse(fs.readFileSync(statusFile(dataDir), 'utf8'));
  } catch {
    /* status file may lag pidfile by a moment */
  }
  console.log(JSON.stringify({ running: true, ...status }, null, 2));
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const cfgPath = flags.config || './config.node.json';
  switch (command) {
    case 'start':
      await cmdStart(cfgPath, flags);
      break;
    case 'stop':
      await cmdStop(cfgPath);
      break;
    case 'status':
      cmdStatus(cfgPath);
      break;
    default:
      console.error('usage: xmbl-node <start|stop|status> [--config <path>]');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`xmbl-node: ${e.message}`);
  process.exit(1);
});
