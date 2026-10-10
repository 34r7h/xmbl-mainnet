#!/usr/bin/env node
// A FLEET OF REAL NODES ON ONE MACHINE. Every claim about throughput, storage spread and recovery has to be
// counted on separate xmbl-node processes talking over real sockets, not on subsystems wired together inside one
// test. This boots N `xmbl-node start` daemons on loopback — each with its own data dir, identity, libp2p key,
// machine lock and control socket — and gives a script the handles to drive them: call any control op, kill a
// node, restart it, and read the counts back.
//
// No seed: every node is handed every other node's address as a bootstrap peer, so the mesh does not depend on
// node 0 being up (kill it and the rest stay joined).
//
// Library:  import { startFleet } from './fleet.mjs'
//   const f = await startFleet({ n: 10, env: { XPC_CONSENSUS_V2: '1' } });
//   await f.call(3, { op: 'status' }); await f.kill(3); await f.restart(3); await f.stop();
// CLI:      node scripts/fleet.mjs [n=4] [--keep]   boots n nodes, waits for the mesh, prints one row per node.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadOrCreatePeerKey } from '@xmbl/networking';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_BIN = path.resolve(HERE, '../packages/core/bin/xmbl-node.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One newline-delimited JSON request on a node's control socket; null on timeout or a refused connection.
export function callSock(sock, req, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const s = net.connect(sock);
    const chunks = [];
    const t = setTimeout(() => { s.destroy(); resolve(null); }, timeoutMs);
    s.on('data', (d) => {
      chunks.push(d);
      if (d.includes(10)) {
        clearTimeout(t); s.end();
        const line = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(line.slice(0, line.indexOf('\n')))); } catch { resolve(null); }
      }
    });
    s.on('error', () => { clearTimeout(t); resolve(null); });
    s.on('connect', () => s.write(JSON.stringify(req) + '\n'));
  });
}

async function freePorts(n) {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise((res, rej) => {
    const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => res(s));
  })));
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

export async function startFleet({ n = 4, env = {}, roles = {}, dir = null, keep = false, bootTimeoutMs = 90000, log = () => {} } = {}) {
  // Short base dir: a unix socket path is capped near 104 bytes on macOS.
  const base = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'xf-'));
  const ports = await freePorts(n);
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const d = path.join(base, `n${i}`);
    fs.mkdirSync(path.join(d, 'id', `fleet-n${i}`), { recursive: true });
    const { privateKey } = await loadOrCreatePeerKey(path.join(d, 'id', `fleet-n${i}`, 'libp2p-peer.key'));
    nodes.push({ i, dir: d, port: ports[i], peerId: peerIdFromPrivateKey(privateKey).toString(), sock: path.join(d, 'node.sock'), proc: null, exits: [] });
  }
  const addrOf = (nd) => `/ip4/127.0.0.1/tcp/${nd.port}/p2p/${nd.peerId}`;
  for (const nd of nodes) {
    const cfg = {
      identity_path: path.join(nd.dir, 'id', `fleet-n${nd.i}`, 'xmbl.json'),
      data_dir: nd.dir,
      listen_addrs: [`/ip4/127.0.0.1/tcp/${nd.port}`],
      bootstrap_peers: nodes.filter((o) => o !== nd).map(addrOf),
      roles: { validate: true, storage: true, compute: false, relay: true, lead: true, ...roles },
    };
    fs.writeFileSync(path.join(nd.dir, 'config.json'), JSON.stringify(cfg, null, 2));
  }

  const launch = (nd) => {
    const out = fs.openSync(path.join(nd.dir, 'node.log'), 'a');
    const p = spawn(process.execPath, [NODE_BIN, 'start', '--config', path.join(nd.dir, 'config.json')], {
      env: { ...process.env, XMBL_OTA: '0', XMBL_MACHINE_LOCK: path.join(nd.dir, 'machine.lock'), ...env },
      stdio: ['ignore', out, out],
    });
    fs.closeSync(out);
    nd.proc = p;
    p.on('exit', (code, signal) => { nd.exits.push({ code, signal, at: Date.now() }); if (nd.proc === p) nd.proc = null; });
    return p;
  };
  const waitUp = async (nd) => {
    const until = Date.now() + bootTimeoutMs;
    while (Date.now() < until) {
      if (!nd.proc) throw new Error(`node ${nd.i} exited during boot: ${JSON.stringify(nd.exits.at(-1))} — see ${path.join(nd.dir, 'node.log')}`);
      const r = fs.existsSync(nd.sock) ? await callSock(nd.sock, { op: 'status' }, 2000) : null;
      if (r && r.ok) return r;
      await sleep(250);
    }
    throw new Error(`node ${nd.i} did not answer status within ${bootTimeoutMs} ms — see ${path.join(nd.dir, 'node.log')}`);
  };

  const fleet = {
    base, nodes,
    call: (i, req, timeoutMs) => callSock(nodes[i].sock, req, timeoutMs),
    alive: () => nodes.filter((nd) => nd.proc).map((nd) => nd.i),
    async kill(i, signal = 'SIGKILL') {
      const nd = nodes[i];
      if (!nd.proc) return false;
      const p = nd.proc;
      const gone = new Promise((r) => p.once('exit', r));
      p.kill(signal);
      await gone;
      // SIGKILL leaves the machine lock and the socket file behind, as a real crash does; the next start
      // reclaims a lock whose holder is dead, and a stale socket nobody answers is unlinked on boot.
      return true;
    },
    async restart(i) { await fleet.kill(i, 'SIGTERM'); launch(nodes[i]); await waitUp(nodes[i]); log(`node ${i} restarted`); },
    async start(i) { if (nodes[i].proc) return; launch(nodes[i]); await waitUp(nodes[i]); },
    // Every live node connected to every other live node (or to `min` of them).
    async waitMesh({ min = null, timeoutMs = 60000 } = {}) {
      const until = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < until) {
        const live = fleet.alive();
        const want = min ?? live.length - 1;
        last = await Promise.all(live.map(async (i) => { const r = await fleet.call(i, { op: 'peers' }, 3000); return r?.count ?? 0; }));
        if (last.every((c) => c >= want)) return last;
        await sleep(500);
      }
      throw new Error(`mesh incomplete after ${timeoutMs} ms: peers per live node ${JSON.stringify(last)}`);
    },
    async stop() {
      await Promise.all(nodes.map((nd) => fleet.kill(nd.i, 'SIGTERM').catch(() => {})));
      if (!keep) fs.rmSync(base, { recursive: true, force: true });
    },
  };

  // Boot all at once — the order must not matter.
  for (const nd of nodes) launch(nd);
  try { await Promise.all(nodes.map(waitUp)); }
  catch (e) { await fleet.stop(); throw e; }
  log(`${n} nodes up under ${base}`);
  return fleet;
}

// ---- CLI ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const n = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) || 4);
  const keep = process.argv.includes('--keep');
  const t0 = Date.now();
  const f = await startFleet({ n, keep, log: (m) => console.log(m) });
  const peers = await f.waitMesh().catch((e) => { console.log(e.message); return null; });
  console.log(`mesh: ${peers ? peers.join(',') : 'incomplete'} peers per node, ${Date.now() - t0} ms after launch`);
  for (const nd of f.nodes) {
    const c = await f.call(nd.i, { op: 'chain' });
    const s = c?.stmt ? JSON.parse(c.stmt) : c;
    console.log(JSON.stringify({ node: nd.i, pid: nd.proc?.pid ?? null, state_root: s?.state_root ?? null, height: s?.height ?? null }));
  }
  await f.stop();
  if (keep) console.log(`kept ${f.base}`);
}
