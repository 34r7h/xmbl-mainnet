// REGRESSION TEST for the outage of 2026-09-15: the first cut of relay self-election read the SEED's public
// ip out of the node's own `<seed>/p2p-circuit` reservation address and elected a NAT'd laptop as the relay
// server, and putting that reservation in `addresses.listen` made a failed reservation a FATAL listen error,
// so every node in the fleet crash-looped at boot. Both are asserted here by OUTCOME: does a private box
// elect, and does a node whose seed runs no relay still come up?
import { XNNode } from './node.js';

let failures = 0;
const check = (name, ok) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name); if (!ok) failures++; };

// 1. A NAT'd box whose bootstrap seed has a PUBLIC ip must NOT elect itself.
const nat = new XNNode({
  addresses: ['/ip4/127.0.0.1/tcp/0'],
  bootstrap: ['/ip4/173.255.233.69/tcp/4001/p2p/12D3KooWKKZUR5o8BeSGMNu43gWKWgudWsnZHxoJU4ZYuqjC8nRU'],
});
await nat.start();
check('NAT box with a public SEED does not elect itself as relay server', !nat.node.services.relay);
check('NAT box still came up despite an unreachable relay reservation', nat.started === true);

// 2. A box that really does hold a public address still elects.
const pub = new XNNode({ addresses: ['/ip4/127.0.0.1/tcp/0'], announce: ['/dns4/seed.test.invalid/tcp/4001'] });
await pub.start();
check('box announcing its OWN public address does elect', !!pub.node.services.relay);

await nat.stop?.(); await pub.stop?.();
console.log(failures === 0 ? 'relay-regression: all checks passed' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
