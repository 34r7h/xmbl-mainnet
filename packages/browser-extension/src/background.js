import browser from 'webextension-polyfill';

// The node bridge. The five wallet/node messages are proxied over loopback HTTP to a running
// XMBL LocalDevnet RPC (packages/simulator: `npm run devnet -w packages/simulator`), so the
// Wallet tab reads and writes REAL devnet state — a real signed+verified tx lands, balances are
// the net of applied deltas, status reports the real running/peers/height. When no devnet is
// reachable the bridge reports a truthful DISCONNECTED state (running:false, balance:0,
// connected:false) and sends return an error — it never fabricates a balance or a txId. The
// devnet URL defaults to http://127.0.0.1:8646 and is overridable via the browser.storage.local
// key `xmbl:devnetUrl`.
const DEFAULT_DEVNET_URL = 'http://127.0.0.1:8646';

export class BackgroundNode {
  constructor(options = {}) {
    this.initialized = false;
    this.nodeRunning = false;
    this.connected = false;
    this.devnetUrl = options.devnetUrl || DEFAULT_DEVNET_URL;
  }

  async init() {
    if (this.initialized) return;
    // Let a stored setting override the default devnet URL.
    try {
      const s = await browser.storage.local.get('xmbl:devnetUrl');
      if (s && s['xmbl:devnetUrl']) this.devnetUrl = s['xmbl:devnetUrl'];
    } catch { /* storage may be unavailable in some contexts */ }
    this.initialized = true;

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message).then(sendResponse).catch((err) => {
        console.error('Error handling message:', err);
        sendResponse({ error: err.message });
      });
      return true; // async response
    });
  }

  /** POST one message to the devnet RPC; throws if it is unreachable or errors. */
  async _rpc(body) {
    const res = await fetch(this.devnetUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`devnet RPC HTTP ${res.status}`);
    return res.json();
  }

  async handleMessage(message) {
    switch (message.type) {
      case 'getBalance':
        return await this.getBalance(message.address);
      case 'sendTransaction':
        return await this.sendTransaction(message.tx);
      case 'getNodeStatus':
        return await this.getNodeStatus();
      case 'startNode':
        return await this.startNode();
      case 'stopNode':
        return await this.stopNode();
      // Node-side capability surface (ledger state root + zk / HE / signature / seal). Each is a
      // real primitive run in the devnet process; the popup's Crypto/Node tabs drive these.
      case 'getStateRoot':
      case 'zkProof':
      case 'heAdd':
      case 'sigVerify':
      case 'seal':
        return await this.capability(message);
      case 'getDevnetUrl':
        return { url: this.devnetUrl };
      case 'setDevnetUrl':
        return await this.setDevnetUrl(message.url);
      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  }

  /** Point the bridge at a new devnet URL, persist it, and report current reachability. */
  async setDevnetUrl(url) {
    const next = (url || '').trim() || DEFAULT_DEVNET_URL;
    this.devnetUrl = next;
    try { await browser.storage.local.set({ 'xmbl:devnetUrl': next }); } catch { /* storage may be unavailable */ }
    const status = await this.getNodeStatus(); // probes the new URL
    return { url: next, connected: this.connected, running: status.running };
  }

  /** Proxy a node-side capability message to the devnet; truthful disconnected state on failure. */
  async capability(message) {
    try {
      const r = await this._rpc(message);
      this.connected = true;
      return { ...r, connected: true };
    } catch (e) {
      this.connected = false;
      return { connected: false, error: `devnet unreachable (${e.message})` };
    }
  }

  async getBalance(address) {
    const body = { type: 'getBalance' };
    // The popup sends address:'current' to mean "my wallet"; let the devnet resolve its wallet.
    if (address && address !== 'current') body.address = address;
    try {
      const r = await this._rpc(body);
      this.connected = true;
      return { balance: r.balance ?? 0, address: r.address, connected: true };
    } catch {
      this.connected = false;
      return { balance: 0, connected: false }; // no node → nothing real to report
    }
  }

  async sendTransaction(tx) {
    try {
      const r = await this._rpc({ type: 'sendTransaction', tx });
      this.connected = true;
      if (r.error) return { error: r.error };
      return { txId: r.txId, connected: true };
    } catch (e) {
      this.connected = false;
      return { error: `devnet unreachable (${e.message})` };
    }
  }

  async getNodeStatus() {
    try {
      const r = await this._rpc({ type: 'getNodeStatus' });
      this.connected = true;
      this.nodeRunning = !!r.running;
      return { running: !!r.running, peers: r.peers ?? 0, height: r.height ?? 0, connected: true };
    } catch {
      this.connected = false;
      this.nodeRunning = false;
      return { running: false, peers: 0, height: 0, connected: false };
    }
  }

  async startNode() {
    try {
      const r = await this._rpc({ type: 'startNode' });
      this.connected = true;
      this.nodeRunning = r.success !== false;
      return { success: r.success !== false, connected: true };
    } catch (e) {
      this.connected = false;
      return { success: false, error: `devnet unreachable (${e.message})` };
    }
  }

  async stopNode() {
    try {
      const r = await this._rpc({ type: 'stopNode' });
      this.connected = true;
      if (r.success !== false) this.nodeRunning = false;
      return { success: r.success !== false, connected: true };
    } catch (e) {
      this.connected = false;
      return { success: false, error: `devnet unreachable (${e.message})` };
    }
  }

  isInitialized() { return this.initialized; }
  isNodeRunning() { return this.nodeRunning; }
  isConnected() { return this.connected; }
}

// Auto-init only inside the extension service worker. Guarded on onInstalled so importing this
// module in a Node test (with a chrome shim that omits onInstalled) does not self-start — the
// test constructs its own BackgroundNode pointed at a real devnet RPC.
if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.onInstalled) {
  browser.runtime.onInstalled.addListener(() => {
    console.log('XMBL Extension installed');
    new BackgroundNode().init();
  });
  new BackgroundNode().init();
}
