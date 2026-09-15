// OUTCOME TEST, not a unit test: start a "public" node and a "NAT'd" node with the shipped XNNode and
// count how many /p2p-circuit addresses the NAT'd node ends up announcing. That count is the exact metric
// that reads 0 across all 73 prod coordinators.
import { XNNode } from './node.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const circuitAddrs = (n) => n.node.getMultiaddrs().map(String).filter((a) => a.includes('p2p-circuit'));

const mode = process.argv[2] || 'after';

// A: announces a PUBLIC address (a dns4 name), so under the fix it must self-elect as the relay server.
// It binds a real local port so B can actually dial it.
const A = new XNNode({ addresses: ['/ip4/127.0.0.1/tcp/47901'], announce: ['/dns4/seed.test.invalid/tcp/47901'] });
if (mode === 'before') process.env.XMBL_RELAY_SERVER = '0';   // simulate the pre-fix world: nobody set the flag
await A.start();
const aRelay = !!A.node.services.relay;
const aId = A.node.peerId.toString();
const aDialable = `/ip4/127.0.0.1/tcp/47901/p2p/${aId}`;
console.log(`A: relay server ${aRelay ? 'ENABLED' : 'disabled'}  peer=${aId.slice(0, 16)}`);

// B: a NAT'd node — binds an ephemeral port on loopback only, exactly like the 44 prod boxes.
const B = new XNNode({ addresses: ['/ip4/127.0.0.1/tcp/0'], bootstrap: [aDialable] });
await B.start();

for (let i = 0; i < 30 && circuitAddrs(B).length === 0; i++) await sleep(500);

const found = circuitAddrs(B);
console.log(`B announced addrs: ${B.node.getMultiaddrs().map(String).join(' , ')}`);
console.log(`RESULT[${mode}] p2p-circuit addresses announced by the NAT'd node: ${found.length}`);
for (const a of found) console.log(`  ${a}`);

await B.stop?.(); await A.stop?.();
process.exit(found.length > 0 ? 0 : 1);
