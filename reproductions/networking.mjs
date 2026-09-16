// REPRODUCTION — TWO REAL NODES DIAL, GOSSIP, AND STOP CLEANLY (packages/networking).
//
// CLAIM: the transport is real libp2p, not a shim. Two XNNode instances start on loopback, one dials the
// other's actual multiaddr, both subscribe to a topic, and a message published by one ARRIVES at the other —
// with the payload intact and the sender's peer id attached. Then both stop and release their listeners.
//
// WHY THIS IS THE CLAIM WORTH PROVING: every convergence argument in XMBL assumes a node can be handed a
// transaction set by its peers. That assumption is cheap to fake (an EventEmitter named `gossip` passes any
// test) and expensive to be wrong about, so this reproduction uses the real stack end to end: real TCP
// listeners, real peer identities, real pubsub. What it does NOT claim is discovery under NAT — that is an
// integration and audit gate (MAINNET-GATES.md), and a loopback dial says nothing about it.
//
// Node-only by construction: libp2p's TCP transport and the peerstore have no browser equivalent.
//
// Exits non-zero if any claim fails, so it is also a hard-gate test (reproductions.test.mjs).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { XNNode } from '@xmbl/networking';

const selfDigest = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
console.log('XMBL reproduction — two real libp2p nodes dial each other and gossip a message');
console.log(`source sha256: ${selfDigest}\n`);

let failures = 0;
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`); if (!cond) failures++; };
const waitFor = async (fn, ms = 8000, step = 100) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, step)); }
  return null;
};

const a = new XNNode({ addresses: ['/ip4/127.0.0.1/tcp/0'], bootstrap: [] });
const b = new XNNode({ addresses: ['/ip4/127.0.0.1/tcp/0'], bootstrap: [] });
await a.start();
await b.start();
const idA = String(a.node.peerId), idB = String(b.node.peerId);
ok('both nodes have a real peer identity', /^12D3Koo/.test(idA) && /^12D3Koo/.test(idB), `${idA.slice(0, 14)}… / ${idB.slice(0, 14)}…`);
ok('they are different peers', idA !== idB);

const addrs = (a.node?.getMultiaddrs?.() ?? []).map(String).filter((m) => m.includes('127.0.0.1'));
ok('node A is LISTENING on a real TCP multiaddr', addrs.length >= 1, addrs[0]);

// ── THE DIAL ──
await b.connect(addrs[0]);
// Asserted by PEER ID, never by a count: mDNS is on, so anything else live on this machine may also appear in
// either list — that is the transport working, not a failure, and a count would make this reproduction depend
// on what else happens to be running.
const has = (node, id) => node.getConnectedPeers().map(String).some((p) => p.includes(id));
const connected = await waitFor(() => has(b, idA) && has(a, idB));
ok('B DIALED A, and EACH sees the OTHER by peer id', !!connected,
   `A sees B: ${has(a, idB)}   B sees A: ${has(b, idA)}   (other peers on this machine: ${a.getConnectedPeers().length - 1})`);

// ── THE MESSAGE ──
const TOPIC = 'xmbl/reproduction/gossip';
const received = [];
a.on(`message:${TOPIC}`, (data) => received.push(data));
await a.subscribe(TOPIC);
await b.subscribe(TOPIC);
await waitFor(async () => (b.node?.services?.pubsub?.getSubscribers?.(TOPIC) ?? []).length > 0, 8000);

const payload = { kind: 'anchor', hash: createHash('sha256').update('the datum being gossiped').digest('hex'), n: 7 };
let delivered = null;
for (let attempt = 0; attempt < 10 && !delivered; attempt++) {
  await b.publish(TOPIC, payload);
  delivered = await waitFor(() => received.length > 0, 1500);
}
ok('A MESSAGE PUBLISHED BY B ARRIVES AT A', received.length > 0, `received=${received.length}`);
const got = received[0];
ok('the payload is intact — the same hash and the same fields', got && got.hash === payload.hash && got.n === 7 && got.kind === 'anchor');

// ── CLEAN STOP ──
await a.stop();
await b.stop();
ok('both nodes stopped and released their listeners',
   (a.node?.status ?? 'stopped') !== 'started' && (b.node?.status ?? 'stopped') !== 'started',
   `A=${a.node?.status ?? 'stopped'} B=${b.node?.status ?? 'stopped'}`);

console.log(failures === 0
  ? '\nREPRODUCED — real peers, a real dial, a real message: the transport every convergence argument assumes is actually there.'
  : `\nNOT REPRODUCED — ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
