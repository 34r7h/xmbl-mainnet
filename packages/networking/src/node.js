import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { WebSockets as WsMatcher, WebSocketsSecure as WssMatcher } from '@multiformats/multiaddr-matcher';
import { kadDHT } from '@libp2p/kad-dht';
import { floodsub } from '@libp2p/floodsub';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { mdns } from '@libp2p/mdns';
import { identify } from '@libp2p/identify';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { multiaddr } from '@multiformats/multiaddr';
import { EventEmitter } from 'events';
import { PeerDiscovery } from './discovery.js';
import { PubSubManager } from './pubsub.js';
import { ConnectionManager } from './connection.js';

// @libp2p/websockets' built-in dial/listen filter uses `exactMatch`, which REJECTS any wss multiaddr carrying an
// `/http-path/...` component ("no valid addresses for peer"). That blocks the ONLY way a NAT'd/firewalled node can
// reach a peer when just 443 is open: dialing `/dns4/host/tcp/443/tls/ws/http-path/<nginx-loc>/p2p/<id>` so an nginx
// wss→ws reverse proxy on the shared 443 routes it to the node's ws listener (raw p2p ports are firewalled).
// `WebSocketsSecure.matches` (non-exact) DOES accept the http-path form, and multiaddrToUri already renders it to the
// correct `wss://host/<loc>` URL — so we only need to widen the filter. This wrapper reuses the stock transport and
// relaxes just dialFilter/listenFilter to also admit http-path ws/wss addrs. Scoped to ws addrs (tcp still routes via
// the tcp transport). This is what lets geo-distributed coordinators join the sealing mesh over the one open port.
function wssHttpPathWebSockets(init) {
  const factory = webSockets(init);
  return (components) => {
    const t = factory(components);
    const widen = (mas) => mas.filter(ma =>
      WsMatcher.exactMatch(ma) || WssMatcher.exactMatch(ma) || WssMatcher.matches(ma) || WsMatcher.matches(ma));
    t.dialFilter = widen;
    t.listenFilter = widen;
    return t;
  };
}

export class XNNode extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      port: options.port || 3000,
      addresses: options.addresses || [],
      ...options
    };
    this.node = null;
    this.started = false;
    this.discovery = null;
    this.pubsub = null;
    this.connectionManager = new ConnectionManager(options.connectionManager || {});
  }

  async start() {
    if (this.started) return;

    // ANNOUNCE, NOT JUST LISTEN. A node behind NAT — every cloud box, every laptop — binds 0.0.0.0 and
    // libp2p then advertises the interface addresses it finds: 127.0.0.1 and a private 10./172./192.168.
    // range. Those are the addresses that reach its peerstore and its presence gossip, so every peer in
    // the mesh learns an address it can never dial. Measured on prod 2026-08-21: 0 of 3 live nodes
    // published a single dialable multiaddr, while the ONE peer that connected did so from a bootstrap
    // entry someone had hand-written. Discovery cannot propagate what a node will not say about itself.
    // announce_addrs is that missing sentence — the multiaddr the operator knows is reachable (for this
    // deployment, /dns4/<host>/tcp/443/tls/ws/http-path/xmbl-p2p, since raw p2p ports are firewalled).
    const announce = Array.isArray(this.options.announce) ? this.options.announce.filter(Boolean) : [];
    // CIRCUIT RELAY — the fix for a mesh whose validators sit on separate private networks. Presence gossip
    // reached them (they knew OF each other) but the validation-report gossip did not (no node could DIAL a
    // peer behind another NAT), so every tx stalled at 1/3 and NOTHING SEALED. With relay-v2 every node
    // reserves a slot on the public relay and advertises /…/p2p/<relay>/p2p-circuit/p2p/<self>, which any peer
    // can dial; dcutr then tries to upgrade each relayed link to a direct one (hole punch). The public box
    // runs the relay SERVER (XMBL_RELAY_SERVER=1); everyone runs the client transport + dcutr and listens on
    // /p2p-circuit. This is what carries the validation reports across boxes so quorum forms and cubes seal.
    const listen = this.options.addresses.length > 0
      ? this.options.addresses.slice()
      : [`/ip4/0.0.0.0/tcp/${this.options.port}`];
    if (!listen.includes('/p2p-circuit')) listen.push('/p2p-circuit');   // accept relayed inbound
    const services = {
      identify: identify(),
      pubsub: floodsub(),
      dcutr: dcutr(),
    };
    if (process.env.XMBL_RELAY_SERVER === '1') {
      // The public, dialable box hops traffic for the NAT'd ones. Generous reservation limits — this is a
      // trusted first-party mesh, not an open relay, and starving reservations is what leaves a node undialable.
      services.relay = circuitRelayServer({ reservations: { maxReservations: Infinity, defaultDurationLimit: 10 * 60 * 1000 } });
    }
    const libp2pOptions = {
      addresses: {
        listen,
        ...(announce.length ? { announce } : {}),
      },
      transports: [tcp(), wssHttpPathWebSockets(), circuitRelayTransport({ discoverRelays: 1 })],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: [mdns()],
      services,
    };
    // A5f: use the persisted node key when provided so peer_id is STABLE across
    // restarts; absent → libp2p mints a fresh key (unchanged default behavior, so
    // existing XNNode callers that pass no privateKey are unaffected).
    if (this.options.privateKey) libp2pOptions.privateKey = this.options.privateKey;
    this.node = await createLibp2p(libp2pOptions);

    // Initialize managers
    this.discovery = new PeerDiscovery(this);
    this.pubsub = new PubSubManager(this);

    // Event handlers
    // AUTO-DIAL ON DISCOVERY. peerDiscovery (mdns, and kad-dht when enabled) only EMITS peer:discovery — it
    // never dials, so a discovered peer stayed unconnected forever and the mesh only formed via an explicit
    // `connect` op. That is not "discoverable AND connected". Dial every freshly discovered peer once, guarded:
    // skip self, skip peers we already hold a connection to, and de-dupe in-flight dials so a discovery storm
    // cannot open N² dials. A dial failure is normal (peer went away) and must never throw out of the handler.
    this._autoDialing = new Set();
    this.node.addEventListener('peer:discovery', (evt) => {
      this.emit('peer:discovered', evt.detail);
      const id = evt.detail?.id;
      const idStr = id?.toString();
      if (!idStr || idStr === this.node.peerId.toString()) return;
      if (this._autoDialing.has(idStr)) return;
      if (this.connectionManager.getConnection(idStr)) return;
      this._autoDialing.add(idStr);
      const target = (evt.detail.multiaddrs && evt.detail.multiaddrs.length) ? evt.detail.multiaddrs : id;
      Promise.resolve(this.node.dial(target))
        .catch(() => { /* peer unreachable/gone — mdns will re-announce; nothing to do */ })
        .finally(() => this._autoDialing.delete(idStr));
    });

    this.node.addEventListener('peer:connect', (evt) => {
      const peerId = evt.detail.toString();
      this.connectionManager.addConnection(peerId, evt.detail);
      this.emit('peer:connected', evt.detail);
    });

    this.node.addEventListener('peer:disconnect', (evt) => {
      const peerId = evt.detail.toString();
      this.connectionManager.removeConnection(peerId);
      this.emit('peer:disconnected', evt.detail);
    });

    await this.node.start();
    this.started = true;

    if (this.options.bootstrap && this.options.bootstrap.length > 0) {
      await this.discovery.bootstrap(this.options.bootstrap);
    }

    this.emit('started');
  }

  async stop() {
    if (!this.started) return;
    // The bootstrap retry loop outlives a single dial by design; it must not outlive the node.
    this.discovery?.stop?.();
    await this.node.stop();
    this.started = false;
    this.emit('stopped');
  }

  isStarted() {
    return this.started;
  }

  getPeerId() {
    return this.node?.peerId;
  }

  getAddresses() {
    return this.node?.getMultiaddrs() || [];
  }

  async connect(address) {
    if (!this.started) {
      throw new Error('Node must be started before connecting');
    }
    const addr = typeof address === 'string' ? multiaddr(address) : address;
    try {
      const connection = await this.node.dial(addr);
      // Wait a bit for connection to fully establish
      await new Promise(resolve => setTimeout(resolve, 100));
      const peerId = connection.remotePeer.toString();
      this.connectionManager.addConnection(peerId, connection);
      return connection;
    } catch (error) {
      // If connection fails, still try to track it via peer:connect event
      throw error;
    }
  }

  getConnectedPeers() {
    if (!this.node) return [];
    return Array.from(this.node.getPeers());
  }

  async subscribe(topic) {
    if (!this.started) {
      throw new Error('Node must be started before subscribing');
    }
    return await this.pubsub.subscribe(topic);
  }

  async unsubscribe(topic) {
    if (!this.started) return;
    return await this.pubsub.unsubscribe(topic);
  }

  async publish(topic, data) {
    if (!this.started) {
      throw new Error('Node must be started before publishing');
    }
    return await this.pubsub.publish(topic, data);
  }

  isSubscribed(topic) {
    return this.pubsub ? this.pubsub.isSubscribed(topic) : false;
  }
}