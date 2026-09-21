// DevnetRpc — serves the browser-extension's background message contract over loopback HTTP,
// backed by a real LocalDevnet. This is the drop-in replacement for the extension's stub
// BackgroundNode (packages/browser-extension/src/background.js): POST JSON `{type, ...}` and get
// back a response IDENTICAL in shape to what that stub returns — but computed from REAL devnet
// state, not mocked.
//
//   getBalance      {type, address?}  → { balance, address }   // net of APPLIED utxo deltas
//   sendTransaction {type, tx:{to,amount}} → { txId } | { error } // a real signed+verified tx lands
//   getNodeStatus   {type}            → { running, peers, height }
//   startNode       {type}            → { success }
//   stopNode        {type}            → { success }
//
// Contract deploy/call are intentionally NOT served here — the in-page contract path is already
// node-parity-proven in the extension, and a deploy route pulls in the delegation gate + worker
// isolation questions, which are a separate piece.
//
// It ALSO serves the node-side capability surface the extension cannot run in-page — each a REAL
// primitive run end-to-end in this node process, verdict returned JSON-safe (see capabilities.js):
//   getStateRoot    {type}                  → { root, pooled, landed }   // live ledger state root
//   zkProof         {type, derivedX?}       → { ok, derivedX, derivedY, genuineVerifies, tamperedRejected, … }
//   heAdd           {type, a?, b?}          → { ok, a, b, sum, expected, … }  // homomorphic add
//   sigVerify       {type, message?}        → { ok, signedVerifies, tamperedRejected, … }  // Cubic-SIG
//   seal            {type, secret?}         → { ok, roundTrip, … }             // PQ KEM seal
import { createServer } from 'node:http';
import { CAPABILITIES } from './capabilities.js';

export class DevnetRpc {
  constructor(devnet, options = {}) {
    this.net = devnet;
    this.walletIndex = options.walletIndex ?? 0; // identity[0] is the "wallet" the extension speaks for
    this.server = null;
    this.port = null;
    this.host = options.host ?? '127.0.0.1';
  }

  /** Map one extension message to a real devnet response. */
  async handle(message) {
    switch (message && message.type) {
      case 'getBalance': {
        const address = message.address || this.net.addressOf(this.walletIndex);
        return { balance: this.net.balanceOf(address), address };
      }
      case 'sendTransaction': {
        const tx = message.tx || {};
        const amount = Number(tx.amount);
        if (!tx.to || !Number.isFinite(amount)) return { error: 'sendTransaction needs tx.to and a numeric tx.amount' };
        // Resolve a known participant by address, else send to the raw external address.
        const toIndex = this.net.identities.findIndex((i) => i.address === tx.to);
        const r = toIndex >= 0
          ? await this.net.submitTransfer(this.walletIndex, toIndex, amount)
          : await this.net.submitTransferToAddress(this.walletIndex, tx.to, amount);
        return r.ok ? { txId: r.id } : { error: r.error };
      }
      case 'getNodeStatus':
        return {
          running: this.net.isRunning(),
          peers: Math.max(0, this.net.identities.length - 1),
          height: this.net.height(),
        };
      case 'startNode':
        if (!this.net.isRunning()) await this.net.start();
        return { success: true };
      case 'stopNode':
        if (this.net.isRunning()) await this.net.stop();
        return { success: true };
      case 'getStateRoot': {
        const m = await this.net.getMetrics();
        return { root: m.root ?? null, pooled: m.pooled ?? 0, landed: m.landed ?? this.net.height() };
      }
      default: {
        // Node-side capability surface (zk / HE / signature / seal): a real primitive run to a
        // verdict in this process. Unknown types still fall through to a genuine error.
        const cap = CAPABILITIES[message && message.type];
        if (cap) return cap(message || {});
        return { error: `Unknown message type: ${message && message.type}` };
      }
    }
  }

  /** Start listening on loopback. port 0 → an OS-assigned port (returned). */
  async listen(port = 0) {
    this.server = createServer((req, res) => {
      // CORS preflight / permissive origin so a page or service worker on any origin can call it.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(405); res.end('POST JSON only'); return; }
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(); });
      req.on('end', async () => {
        let message;
        try { message = JSON.parse(body || '{}'); } catch { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid json"}'); return; }
        try {
          const response = await this.handle(message);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(response));
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    });
    await new Promise((resolve) => this.server.listen(port, this.host, resolve));
    this.port = this.server.address().port;
    return this.port;
  }

  url() { return this.port ? `http://${this.host}:${this.port}` : null; }

  async close() {
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }
}
