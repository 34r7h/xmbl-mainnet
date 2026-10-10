import { EventEmitter } from 'events';
let WebTorrent = null;
// WebTorrent is optional - will be loaded lazily if available

// ONE MESSAGE PER FLUSH, NOT ONE PER TX. Every raw tx and every validation report used to be its own pubsub
// message, and each message costs every receiver a noise decrypt, a yamux frame, a floodsub ed25519 signature
// check and a JSON parse — measured on 4 real nodes, 2000 node-signed txs: 1.7 s in floodsub processMessage,
// 1 s in noise decrypt, 0.9 s in yamux send and 0.65 s in ed25519 per node, more than the MAYO checks. Raw txs
// and reports now wait up to XPC_GOSSIP_FLUSH_MS (10 ms) and go out together as {type:'batch', items}, each
// item exactly the message it would have been alone, so a receiver handles it exactly as before.
// A node only batches when every live peer has said in its presence that it reads batches (caps: ['batch']):
// a node still on the previous release ignores a type it does not know, and would lose every tx and report
// in it. Presence itself is never batched.
const BATCHABLE = new Set(['raw_tx', 'validation_report']);
// libp2p reads a frame of at most 4 MiB; a MAYO-signed tx is about 3 KB of JSON, so a flush of 1 MiB carries
// a few hundred and is split before it reaches the limit.
const BATCH_MAX_BYTES = 1 << 20;
const FLUSH_MS = Math.max(1, Number(process.env.XPC_GOSSIP_FLUSH_MS) || 10);
const KEEP_BROADCASTS = 1000;
export const GOSSIP_CAPS = ['batch'];

// True when at least one peer has been heard from inside `ttlMs` and every such peer named `cap` in its presence.
// `registry` is the node's address -> {caps, lastSeen} map; its own entry, if any, is skipped.
export function everyLivePeerHas(registry, self, cap = 'batch', ttlMs = 30000, now = Date.now()) {
  let live = 0;
  for (const [address, p] of registry) {
    if (address === self || now - (p.lastSeen || 0) > ttlMs) continue;
    live++;
    if (!Array.isArray(p.caps) || !p.caps.includes(cap)) return false;
  }
  return live > 0;
}

/**
 * Consensus Gossip with WebTorrent integration
 * Broadcasts consensus messages via WebTorrent swarms
 */
export class ConsensusGossip extends EventEmitter {
  constructor(options = {}) {
    super();
    this.broadcasts = []; // the last KEEP_BROADCASTS published, for tests (it kept every message for the life of the process)
    // Set by the node: true when every live peer reads batches. Until then every message goes out alone.
    this.canBatch = options.canBatch || (() => false);
    this._outbox = []; this._outboxBytes = 0; this._flushTimer = null;
    this.stats = { messages: 0, batches: 0, batchedItems: 0 };
    this.client = null; // Will be initialized lazily if WebTorrent is available
    this.swarms = new Map(); // topic -> swarm
    
    // Integration: xn for network gossip (fallback)
    this.xn = options.xn || null;
    this.topic = options.topic || 'consensus:raw_tx';
    
    // Initialize WebTorrent swarm
    this._initSwarm().catch(() => {});
    
    // Subscribe to topic if network available and started
    if (this.xn && this.xn.started) {
      this.xn.subscribe(this.topic).catch(() => {});
      this.xn.on(`message:${this.topic}`, (data) => {
        this._handleMessage(data);
      });
    }
  }

  /**
   * Initialize WebTorrent swarm
   * @private
   */
  async _initSwarm() {
    // Lazy load WebTorrent if available
    if (!WebTorrent && !this.client) {
      try {
        const webtorrentModule = await import('webtorrent');
        WebTorrent = webtorrentModule.default;
        this.client = new WebTorrent();
        // A WebTorrent client with NO 'error' listener KILLS THE DAEMON. Its conn-pool binds a fixed UTP
        // port, so a second node on the same machine gets EADDRINUSE, WebTorrent emits 'error', nothing is
        // listening, and Node turns that into an unhandled 'error' event — process dead, mid-boot, after
        // "XMBL Core started" has already printed. MEASURED: a 3-node local mesh where node n1 exited with
        // `Error: address already in use ... at UTP.bind`, taking the whole consensus arm with it.
        // WebTorrent is an OPTIONAL gossip accelerator here — the libp2p floodsub path (this.xn) carries
        // consensus either way — so a transport that cannot bind must degrade, never terminate the node.
        this.client.on('error', (e) => {
          console.warn(`[gossip] WebTorrent transport unavailable (${e && e.code ? e.code : e && e.message ? e.message : e}) — consensus continues over libp2p floodsub`);
          try { this.client.destroy(() => {}); } catch { /* nothing to destroy */ }
          this.client = null;
        });
      } catch (error) {
        // WebTorrent not available, skip
        return;
      }
    }
    
    if (!this.client) return;
    try {
      const swarm = this.client.swarm(this.topic);
      this.swarms.set(this.topic, swarm);

      swarm.on('wire', (wire) => {
        wire.on('message', (message) => {
          try {
            const data = JSON.parse(message.toString());
            this._handleMessage(data);
          } catch (error) {
            // Ignore invalid messages
          }
        });
      });
    } catch (error) {
      // WebTorrent may not be available in all environments
    }
  }

  /**
   * Broadcast raw transaction via WebTorrent and libp2p
   * @param {string} leaderId - Leader ID
   * @param {Object} tx - Transaction data
   */
  async broadcastRawTransaction(leaderId, tx, leaders = null) {
    // `leaders` (the deterministic validation-leader set for this tx) rides WITH the
    // broadcast so every receiver builds the SAME validation tasks the submitter did,
    // independent of any per-node registry timing. Backward compatible (null → receiver
    // computes its own).
    const message = { type: 'raw_tx', leaderId, tx, leaders, timestamp: Date.now() };
    this.emit('raw_tx:broadcast', message);
    await this._publish(message);
  }

  // A validator's result, gossiped so every node can count it toward the quorum. Carries
  // the validator's OWN timestamp so all nodes average identically → identical sealed hash.
  async broadcastValidationReport(report) {
    await this._publish({ type: 'validation_report', ...report, ts: Date.now() });
  }

  // Node presence: {address, publicKey, roles}. Every node keeps a live registry from these,
  // which is how leaders are chosen + submitter public keys resolved — no central directory.
  async broadcastPresence(presence) {
    await this._publish({ type: 'presence', ...presence, caps: GOSSIP_CAPS, ts: Date.now() });
  }

  // 2b seal-boundary agreement (ab5932a5): a node's proposed candidate SET for a level — {level:'L1'|'L2',
  // nodeId, setHash, memberIds}. Peers whose own candidate hashes to the same setHash converge; a quorum seals
  // that exact set. memberIds let a minority reconstruct + adopt the agreed set. Only broadcast under CONSENSUS-V2.
  async broadcastSealProposal(proposal) {
    await this._publish({ type: 'seal_proposal', ...proposal, ts: Date.now() });
  }

  async _publish(message) {
    this.broadcasts.push(message);
    if (this.broadcasts.length > KEEP_BROADCASTS) this.broadcasts.splice(0, this.broadcasts.length - KEEP_BROADCASTS);
    if (BATCHABLE.has(message.type) && this.canBatch()) { this._enqueue(message); return; }
    await this._send(message);
  }

  _enqueue(message) {
    const size = JSON.stringify(message).length;
    if (this._outbox.length && this._outboxBytes + size > BATCH_MAX_BYTES) this.flush();
    this._outbox.push(message);
    this._outboxBytes += size;
    if (!this._flushTimer) this._flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  /** Send whatever is waiting now (the timer does this on its own). */
  flush() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (!this._outbox.length) return;
    const items = this._outbox;
    this._outbox = []; this._outboxBytes = 0;
    if (items.length > 1) { this.stats.batches++; this.stats.batchedItems += items.length; }
    this._send(items.length === 1 ? items[0] : { type: 'batch', items, ts: Date.now() }).catch(() => {});
  }

  // Shared send path: WebTorrent swarm (if present) + libp2p pubsub (the real transport).
  async _send(message) {
    this.stats.messages++;
    const swarm = this.swarms.get(this.topic);
    if (swarm) {
      try { swarm.broadcast(Buffer.from(JSON.stringify(message))); } catch (error) { /* ignore */ }
    }
    if (this.xn) {
      try { await this.xn.publish(this.topic, message); }
      catch (error) { console.warn('gossip publish failed:', error.message); }
    }
  }

  /**
   * Handle incoming gossip messages
   * @private
   */
  _handleMessage(message) {
    if (!message || !message.type) return;
    switch (message.type) {
      case 'raw_tx':
        this.emit('raw_tx:received', { leaderId: message.leaderId, tx: message.tx, leaders: message.leaders || null });
        break;
      case 'validation_report':
        this.emit('validation_report:received', {
          rawTxId: message.rawTxId, taskId: message.taskId,
          validatorId: message.validatorId, timestamp: message.timestamp,
        });
        break;
      case 'presence':
        this.emit('presence:received', { address: message.address, publicKey: message.publicKey, roles: message.roles,
          caps: Array.isArray(message.caps) ? message.caps : [] });
        break;
      case 'batch':
        // Each item is handled as if it had arrived alone; a batch inside a batch is not a thing a node sends.
        if (Array.isArray(message.items)) for (const item of message.items) if (item && item.type !== 'batch') this._handleMessage(item);
        break;
      case 'seal_proposal':
        this.emit('seal_proposal:received', { level: message.level, nodeId: message.nodeId, setHash: message.setHash, memberIds: message.memberIds || [] });
        break;
    }
  }

  /**
   * Cleanup and destroy swarms
   */
  async destroy() {
    this.flush();
    for (const swarm of this.swarms.values()) {
      try {
        swarm.destroy();
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    this.swarms.clear();
    // The client is null when WebTorrent is not installed or could not bind (see _initSwarm); destroy() threw then.
    if (this.client) { try { this.client.destroy(() => {}); } catch { /* already down */ } this.client = null; }
  }
}

