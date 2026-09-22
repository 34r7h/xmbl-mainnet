// ⛔ THE GATE THAT WAS MISSING. `peerDiscovery: [mdns()]` was the ENTIRE discovery config of this
// package from the first commit until 0.1.17. mDNS is LAN multicast — it cannot cross the internet.
// So WAN discovery was one hardcoded multiaddr in the bundle's config and nothing else, and on
// 2026-09-20 that one seed was re-provisioned onto an ephemeral port under a new peer id. Every box
// in the fleet dialled a port nothing listened on, the seed logged "This node is isolated" 120
// times, and NOTHING else went red: the boxes stayed up, kept beaconing, kept serving `current`. A
// star topology cannot report its own partition. It surfaced only because a deploy gate happens to
// TCP-probe the seed.
//
// kadDHT was imported at node.js:5 and called ZERO times the whole time, so a source-level check for
// the import would have passed every day this was broken. This asserts by OUTCOME, on a node that
// has actually started: what discovery sources does libp2p hold, and can any of them cross a WAN?
//
// A discovery source is WAN-capable when it finds peers by asking peers, over the network, rather
// than by shouting on the local segment. mDNS is the only LAN-only source shipped here, so the test
// is: the started node must expose at least one peer-discovery source that is not mDNS.
import { peerDiscoverySymbol } from '@libp2p/interface';
import { XNNode } from './node.js';

let failures = 0;
const check = (name, ok) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name); if (!ok) failures++; };

const n = new XNNode({ addresses: ['/ip4/127.0.0.1/tcp/0'] });
await n.start();

// Every service exposing the peer-discovery symbol is registered by libp2p as a discovery source
// (libp2p/dist/src/libp2p.js: `if (service[peerDiscoverySymbol] != null)`), alongside whatever is
// listed in `peerDiscovery`. Those services are the ones that can reach off-segment.
const services = n.node.services || {};
const discoveryServices = Object.entries(services).filter(([, s]) => s && s[peerDiscoverySymbol] != null);

check('a WAN peer-discovery source is wired — discovery is NOT mDNS-only'
  + ` (found: ${discoveryServices.map(([k]) => k).join(', ') || 'none — mdns() only'})`,
  discoveryServices.length > 0);

// The DHT specifically: imported since the first commit, so its presence as a live service — not as
// an import — is the thing to hold.
check('the Kademlia DHT is a live service, not an unused import', services.dht != null);

// A DHT left on the default protocol joins the PUBLIC IPFS DHT namespace: the routing table fills
// with strangers, and xmbl nodes are looked up in a keyspace shared with everyone. The mesh must
// have its own protocol.
const protocols = n.node.getProtocols ? n.node.getProtocols().map(String) : [];
const kadProtocols = protocols.filter((p) => p.includes('/kad/'));
check(`the DHT runs on an xmbl protocol, not the public IPFS one (${kadProtocols.join(', ') || 'none'})`,
  kadProtocols.length > 0 && kadProtocols.every((p) => p.startsWith('/xmbl/')));

await n.stop?.();
console.log(`\n${4 - failures}/4 passed`);
process.exit(failures ? 1 : 0);
