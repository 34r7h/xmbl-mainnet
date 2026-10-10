// ⛔ TWO IDLE NODES DO NOT QUERY EACH OTHER HUNDREDS OF TIMES A SECOND.
//
// Measured 2026-10-11, before the walk was paced: two idle XNNodes, connected and holding no relay reservation, sent
// each other 15,794 FIND_NODE in 30 s — relay discovery's random walk starting each DHT query the moment the last
// one ended. Every query is an inbound stream that kad-dht keeps for its 10 s message timeout, so a fleet node held
// ~5,000 of them (48.5 MB) at any moment and spent CPU on them that the txs did not get. Paced, the same 30 s took 18.
// This counts, on two started nodes, every DHT message either one handled over 10 s once they are connected: 14 paced,
// 600 with libp2p's own startWalk put back.
import { XNNode } from './node.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// kad-dht binds its stream handler when the node starts, so the count goes on the RPC class before A and B start.
const probe = new XNNode({ addresses: ['/ip4/127.0.0.1/tcp/0'], mdns: false });
await probe.start();
const RPC = Object.getPrototypeOf(probe.node.services.dht.rpc);
await probe.stop();
const handled = {};
const handleMessage = RPC.handleMessage;
RPC.handleMessage = function (peer, msg) { handled[msg.type] = (handled[msg.type] || 0) + 1; return handleMessage.call(this, peer, msg); };
const total = () => Object.values(handled).reduce((a, b) => a + b, 0);

const A = new XNNode({ addresses: ['/ip4/127.0.0.1/tcp/0'], mdns: false });
await A.start();
const B = new XNNode({ addresses: ['/ip4/127.0.0.1/tcp/0'], mdns: false, bootstrap: [A.node.getMultiaddrs()[0].toString()] });
await B.start();
for (let i = 0; i < 50 && A.node.getConnections().length === 0; i++) await sleep(100);
check('the two nodes are connected', A.node.getConnections().length > 0);

const before = total();
await sleep(10000);
const n = total() - before;
check('two idle nodes handle at most 40 DHT messages in 10 s (600 with the libp2p walk unpaced)', n <= 40, `${n} handled ${JSON.stringify(handled)}`);
check('the DHT still answers queries (the walk was paced, not stopped)', total() > 0, `${total()} handled since start`);

await A.stop();
await B.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
