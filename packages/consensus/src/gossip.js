import { EventEmitter } from 'events';
let WebTorrent = null;
// WebTorrent is optional - will be loaded lazily if available

/**
 * Consensus Gossip with WebTorrent integration
 * Broadcasts consensus messages via WebTorrent swarms
 */
export class ConsensusGossip extends EventEmitter {
  constructor(options = {}) {
    super();
    this.broadcasts = []; // Store broadcasts for testing
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
    await this._publish({ type: 'presence', ...presence, ts: Date.now() });
  }

  // 2b seal-boundary agreement (ab5932a5): a node's proposed candidate SET for a level — {level:'L1'|'L2',
  // nodeId, setHash, memberIds}. Peers whose own candidate hashes to the same setHash converge; a quorum seals
  // that exact set. memberIds let a minority reconstruct + adopt the agreed set. Only broadcast under CONSENSUS-V2.
  async broadcastSealProposal(proposal) {
    await this._publish({ type: 'seal_proposal', ...proposal, ts: Date.now() });
  }

  // Shared publish path: WebTorrent swarm (if present) + libp2p pubsub (the real transport).
  async _publish(message) {
    this.broadcasts.push(message);
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
        this.emit('presence:received', { address: message.address, publicKey: message.publicKey, roles: message.roles });
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
    for (const swarm of this.swarms.values()) {
      try {
        swarm.destroy();
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    this.swarms.clear();
    this.client.destroy();
  }
}

