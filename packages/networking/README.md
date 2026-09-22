# @xmbl/networking

The P2P layer: libp2p, wrapped as `XNNode`. TCP and WebSockets (including the `wss` + `/http-path`
form that is the only way through a box where just 443 is open), noise + yamux, floodsub, circuit
relay v2 with **self-election**, and **Kademlia DHT peer discovery**.

```sh
npm install @xmbl/networking
```

## Discovery is WAN-capable — that is a gate, not a detail

Until 0.1.17 this package configured `peerDiscovery: [mdns()]` and nothing else. mDNS is LAN
multicast: it cannot cross the internet, so every cross-network peer came from one hardcoded seed
multiaddr while `kadDHT` sat imported and never called. When that seed moved, the whole fleet
partitioned and nothing went red — the boxes stayed up, kept beaconing and kept serving. A star
topology cannot report its own partition.

Now:

```js
services.dht = kadDHT({
  protocol: '/xmbl/kad/1.0.0',        // the mesh's own keyspace, NOT the public IPFS DHT
  clientMode: false,                  // a mesh of DHT clients is as unfindable as no DHT
  peerInfoMapper: passthroughMapper,  // most of this mesh is reachable only at a /p2p-circuit addr
})
```

libp2p registers it as a discovery source through the peer-discovery symbol it exposes. mDNS stays —
LAN discovery was never the bug, being LAN-*only* was. `wan-discovery.test.mjs` asserts this on a
**started** node (a check for the import passes even when nothing is wired) and reads 1/4 against
0.1.16, 4/4 after.

## What it owns

| Export | What it is |
|---|---|
| `XNNode` | The node. Announce addresses, circuit-relay reservations on the seeds, DHT + mDNS discovery, and auto-dial on discovery (discovery emits, it does not connect). |
| `PeerDiscovery` | Bootstrap as a **standing intent**: keeps seeds connected with backoff, says what happened, and never dials itself. |
| `ConnectionManager` | Enforces the connection cap — a flood cannot exceed `maxConnections`. |
| `MessageRouter` | **Deny-by-default**: an unknown or forged message type invokes no handler, it throws. |
| `PubSubManager` | Topic pub/sub over floodsub. |
| `loadOrCreatePeerKey` | A stable peer id across restarts. |
| `GossipManager` | A WebTorrent-swarm gossip path. ⚠ **Not constructed anywhere** — see the open gate in [MAINNET-GATES.md](../../MAINNET-GATES.md#xmblnetworking--libp2p-p2p). |

## Relay self-election

A box that announces or listens on a public address **is** the dialable box, so it elects itself as
the relay server; `XMBL_RELAY_SERVER=1`/`0` forces the two cases this code cannot see. A control
whose default is "off everywhere" is not a control.

## Tests

```sh
node ../../scripts/run-node-tests.mjs .
```
