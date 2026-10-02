// ⛔ NO SEED IS LOAD-BEARING FOR A NODE THAT HAS MET THE MESH BEFORE.
//
// MEASURED 2026-10-01: the one published seed went down (heap OOM ×12, supervisor gave up), a fresh public node
// booted with 0 peers, and the broker's deploy gate rolled a release back on it. Before 0.1.21 a node remembered no
// peer across a restart, so its seed list was its single point of failure. This asserts the OUTCOME on started
// nodes: A meets C, the seed B dies, A restarts with only the dead seed configured — and reaches C from memory.
// The negative control is the same restart WITHOUT the cache, which must hold 0 peers: otherwise the positive
// result could have come from somewhere else (mDNS is disabled on every node here for the same reason).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XNNode } from './node.js';
import { PeerCache } from './peer-cache.js';

process.env.XN_BOOTSTRAP_RETRY_MS = '5000';
process.env.XN_REJOIN_RETRY_MS = '1000';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100); } return fn(); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xn-peer-cache-'));
const cacheFile = path.join(dir, 'known-peers.json');
const node = (o) => new XNNode({ mdns: false, ...o });

// ── the unit half: the cache survives a torn write, never boots empty, and evicts a peer that keeps failing ──
{
  const f = path.join(dir, 'unit.json');
  const c1 = new PeerCache(f, { allowPrivate: true });
  c1.record('12D3KooWUnitPeerA', ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWUnitPeerA', '/ip4/127.0.0.1/tcp/4001/p2p-circuit']);
  c1.save();
  c1.record('12D3KooWUnitPeerB', ['/ip4/127.0.0.1/tcp/4002']);
  c1.save();                                            // .prev now holds the one-peer file
  fs.writeFileSync(f, '{"v":1,"peers":[{"id":"12D3K');  // a write torn by a crash
  const c2 = new PeerCache(f, { allowPrivate: true });
  check('a torn cache file falls back to the previous good copy, not to empty', c2.peers.size === 1 && c2.peers.has('12D3KooWUnitPeerA'), `${c2.peers.size} peer(s) loaded`);
  check('a relay (/p2p-circuit) address is never remembered as a peer address', c2.peers.get('12D3KooWUnitPeerA')?.addrs.every((a) => !a.includes('p2p-circuit')));
  const pub = new PeerCache(path.join(dir, 'pub.json'));
  pub.record('12D3KooWUnitPeerC', ['/ip4/127.0.0.1/tcp/4003', '/ip4/192.168.1.7/tcp/4003']);
  check('without allowPrivate, loopback and private addresses are not remembered', pub.peers.size === 0);
  const ev = new PeerCache(path.join(dir, 'ev.json'), { allowPrivate: true, maxFailures: 3 });
  ev.record('12D3KooWUnitPeerD', ['/ip4/127.0.0.1/tcp/4004']);
  ev.failed('12D3KooWUnitPeerD'); ev.failed('12D3KooWUnitPeerD');
  const kept = ev.peers.has('12D3KooWUnitPeerD');
  ev.failed('12D3KooWUnitPeerD');
  check('a peer that keeps failing is evicted after maxFailures, not dialled forever', kept && !ev.peers.has('12D3KooWUnitPeerD'));
}

// ── the outcome half ──
const B = node({ addresses: ['/ip4/127.0.0.1/tcp/0'] });        // the configured seed — it will die
await B.start();
const seedB = `${B.getAddresses().find((a) => String(a).includes('/tcp/'))}`;
const C = node({ addresses: ['/ip4/127.0.0.1/tcp/0'], bootstrap: [seedB] });   // a peer A meets
await C.start();
const addrC = `${C.getAddresses().find((a) => String(a).includes('/tcp/'))}`;
const idC = C.getPeerId().toString();

const A1 = node({ addresses: ['/ip4/127.0.0.1/tcp/0'], bootstrap: [seedB], peerCache: cacheFile, peerCacheAllowPrivate: true });
await A1.start();
await A1.connect(addrC);
await waitFor(() => A1.peerCache.peers.has(idC), 5000);
await A1.stop();
const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
check('a node writes the peers it connected to into its data_dir on stop', saved.peers.some((p) => p.id === idC), `${saved.peers.length} peer(s) saved`);

await B.stop();                                                  // the seed dies

// negative control: same restart, same dead seed, no memory
const N = node({ addresses: ['/ip4/127.0.0.1/tcp/0'], bootstrap: [seedB] });
await N.start();
await sleep(4000);
const nPeers = N.getConnectedPeers().length;
await N.stop();
check('CONTROL: without the cache, a node whose only seed is dead holds 0 peers', nPeers === 0, `${nPeers} peer(s)`);

const A2 = node({ addresses: ['/ip4/127.0.0.1/tcp/0'], bootstrap: [seedB], peerCache: cacheFile, peerCacheAllowPrivate: true });
await A2.start();
const reached = await waitFor(() => A2.getConnectedPeers().map(String).includes(idC), 8000);
check('with the cache, the same node reaches the mesh from memory while its only seed is dead', reached, `${A2.getConnectedPeers().length} peer(s), C ${reached ? 'connected' : 'NOT connected'}`);
await A2.stop();
await C.stop();

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
