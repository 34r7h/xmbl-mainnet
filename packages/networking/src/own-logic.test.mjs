// @xmbl/networking own-logic coverage (MAINNET-GATES §@xmbl/networking, T10.1 re-scoped).
//
// SCOPE NOTE. The transport-level properties originally listed on this gate — NAT traversal, gossip
// fan-out rounds, Kademlia routing-table poisoning — are behaviour of libp2p / WebTorrent, reached
// through thin wrappers here (PubSubManager, GossipManager); this package has NO peer routing table
// to poison (MessageRouter is message-TYPE dispatch). Asserting those against a hand-written mesh
// would test the mock, so they are refiled to the simulator/integration + whole-protocol audit.
// This suite covers what the package ITSELF owns and had zero tests for, adversarially:
//   • ConnectionManager — the connection CAP (a flood cannot exceed maxConnections)
//   • MessageRouter     — DENY-BY-DEFAULT (an unknown/forged message type invokes no handler)
//   • PeerDiscovery     — the self-dial guard + loop-arming safety (a node never dials itself)
// Run: node own-logic.test.mjs
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { ConnectionManager } from './connection.js';
import { MessageRouter } from './routing.js';
import { PeerDiscovery } from './discovery.js';

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };

// ---- ConnectionManager: the cap is a hard resource bound -------------------------------------------
await check('ConnectionManager enforces maxConnections — the cap+1 connection is refused', () => {
  const cm = new ConnectionManager({ maxConnections: 3 });
  cm.addConnection('p1', {}); cm.addConnection('p2', {}); cm.addConnection('p3', {});
  assert.strictEqual(cm.getConnectionCount(), 3);
  assert.throws(() => cm.addConnection('p4', {}), /Max connections reached/, 'a flood exceeded the cap');
  assert.strictEqual(cm.getConnectionCount(), 3, 'a refused connection still landed');
});
await check('ConnectionManager: removing frees a slot; the default cap is 50', () => {
  const cm = new ConnectionManager({ maxConnections: 2 });
  cm.addConnection('a', {}); cm.addConnection('b', {});
  assert.throws(() => cm.addConnection('c', {}), /Max connections reached/);
  cm.removeConnection('a');
  cm.addConnection('c', { note: 'now fits' });
  assert.deepStrictEqual(cm.getConnection('c'), { note: 'now fits' });
  assert.strictEqual(new ConnectionManager().getMaxConnections(), 50);
});

// ---- MessageRouter: deny-by-default ----------------------------------------------------------------
await check('MessageRouter routes a known type to its handler and returns the result', async () => {
  const r = new MessageRouter();
  r.register('ping', async (data) => ({ echo: data }));
  assert.strictEqual(r.hasHandler('ping'), true);
  assert.deepStrictEqual(await r.route({ type: 'ping', data: 42 }), { echo: 42 });
});
await check('MessageRouter DENIES an unknown/forged message type (no handler is invoked)', async () => {
  const r = new MessageRouter();
  let sideEffect = false;
  r.register('known', () => { sideEffect = true; });
  await assert.rejects(() => r.route({ type: 'forged', data: {} }), /No handler for message type: forged/,
    'an unregistered type was silently accepted');
  assert.strictEqual(sideEffect, false, 'a forged type reached a registered handler');
  assert.strictEqual(r.hasHandler('forged'), false);
});
await check('MessageRouter does not cross-wire: a handler for one type is never called for another', async () => {
  const r = new MessageRouter();
  const calls = [];
  r.register('a', () => { calls.push('a'); return 'A'; });
  r.register('b', () => { calls.push('b'); return 'B'; });
  await r.route({ type: 'b', data: {} });
  assert.deepStrictEqual(calls, ['b'], 'the wrong handler ran');
});

// ---- PeerDiscovery: the self-dial guard + loop safety ----------------------------------------------
class FakeLibp2p {
  constructor(peerId) { this.peerId = { toString: () => peerId }; this.dialed = []; }
  async dial(addr) { this.dialed.push(addr); }
}
class FakeNode extends EventEmitter {
  constructor(peerId) { super(); this.node = new FakeLibp2p(peerId); this.connectionManager = new ConnectionManager(); }
}

await check('PeerDiscovery tracks discovered peers (deduped) and stop() is safe when never armed', () => {
  const node = new FakeNode('ME');
  const d = new PeerDiscovery(node);
  const peer = { id: { toString: () => '12D3KooWABC' } };
  node.emit('peer:discovered', peer);
  node.emit('peer:discovered', peer);   // same peer twice
  assert.deepStrictEqual(d.getDiscoveredPeers(), ['12D3KooWABC'], 'discovered peers not deduped');
  assert.doesNotThrow(() => d.stop(), 'stop() threw before the loop was ever armed');
});

await check('NEVER DIAL YOURSELF: a seed list of only this node dials nothing and arms no loop', async () => {
  const node = new FakeNode('SELFID');
  const d = new PeerDiscovery(node);
  await d.bootstrap(['/ip4/127.0.0.1/tcp/4001/p2p/SELFID']);   // the only seed IS this node
  assert.deepStrictEqual(node.node.dialed, [], 'the node dialed itself');
  assert.strictEqual(d._seedTimer, null, 'the retry loop was armed for a self-only seed list');
  d.stop();
});

await check('self is skipped but a real peer is still dialed', async () => {
  const node = new FakeNode('SELFID');
  const d = new PeerDiscovery(node);
  const peerSeed = { marker: 'a-real-peer' };                   // a pre-parsed (non-string) multiaddr
  await d.bootstrap(['/ip4/127.0.0.1/tcp/4001/p2p/SELFID', peerSeed]);
  assert.strictEqual(node.node.dialed.length, 1, 'expected exactly one dial (the real peer)');
  assert.strictEqual(node.node.dialed[0], peerSeed, 'the real peer was not dialed');
  assert.ok(!node.node.dialed.some((a) => String(a).includes('SELFID')), 'the node dialed itself despite the guard');
  d.stop();
});

await check('an already-connected seed is not re-dialed', async () => {
  const node = new FakeNode('ME');
  node.connectionManager.addConnection('PEER1', { live: true });  // already connected
  const d = new PeerDiscovery(node);
  await d.bootstrap(['/ip4/10.0.0.9/tcp/4001/p2p/PEER1']);
  assert.deepStrictEqual(node.node.dialed, [], 're-dialed a seed that was already connected');
  d.stop();
});

await check('an empty seed list is a no-op (no dial, no loop)', async () => {
  const node = new FakeNode('ME');
  const d = new PeerDiscovery(node);
  await d.bootstrap([]);
  await d.bootstrap(undefined);
  assert.deepStrictEqual(node.node.dialed, []);
  assert.strictEqual(d._seedTimer, null);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
