// LocalDevnet — a light local XMBL network you can run and verify against "in reality".
//
// This is the "hardhat for XMBL": a SCRIPTED, BOUNDED driver over the REAL protocol modules
// (@xmbl/identity + @xmbl/cubic-ledger), with the ledger's signature verification turned ON
// (it wires BOTH `xid` and `getPublicKeyByAddress`, the combination that activates
// Identity.verifyTransaction on every tx). Every operation is an awaited, discrete step — no
// setInterval, no Math.random in control flow — so counts and block/face formation are
// repeatable run to run. That repeatability, not byte-identical faker output, is what makes a
// gate test possible (see devnet.test.mjs).
//
// WHY THE DIRECT LEDGER PATH (ledger.addTransaction), NOT CONSENSUS:
//   A signed node-authored tx, submitted directly, is verified by the ledger as-signed and
//   lands — proven here with real MAYO keys + real verification. The consensus finalize route
//   is DELIBERATELY not driven, because it is currently broken on the very ledger-entry points
//   that verify signatures — both pinned by devnet.test.mjs and documented in
//   ../DEVNET-SEAM-FINDING.md:
//     (a) ConsensusWorkflow.finalizeTransaction OVERWRITES the signed `id` with `validatedHash`
//         (consensus/src/workflow.js:781-784); the legacy finalize path then hands that mutated
//         tx to ledger.addTransaction, whose re-verification JSON.stringifies the changed `id`
//         and the signature can no longer match → "Invalid transaction signature or address
//         mismatch" (the exact error seen in prior simulator runs).
//     (b) ledger.addSealedBatch (the real lead-role seal path) calls `this.xid.verify(...)`,
//         a method that does not exist on an Identity instance (the only thing ever assigned to
//         ledger.xid) → TypeError. Its signature check has therefore never verified anything.
//   Both blocks are UNREACHABLE in the production daemon (core/index.js constructs the Ledger
//   without getPublicKeyByAddress, so the lookup returns null and verification is skipped), so
//   these are latent/dead-defensive-code defects, not a live mainnet break — but a devnet that
//   opts into verification is exactly the caller that trips them, which is why it pins them.
import { EventEmitter } from 'node:events';
import { Identity } from '../../identity/index.js';
import { Ledger } from '../../cubic-ledger/index.js';

export class LocalDevnet extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      identities: options.identities ?? 4,
      scheme: options.scheme ?? 'mayo',
      dbPath: options.dbPath ?? null, // null → in-memory ledger
      ...options,
    };
    this.identities = [];            // real Identity instances (hold private keys)
    this.byAddress = new Map();       // address → Identity
    this.ledger = null;
    this._applied = [];               // every utxo tx the REAL ledger accepted (post-verification)
    this._seq = 0;
    this.running = false;
    this.metrics = {
      identities: 0,
      submitted: 0,
      landed: 0,
      rejected: 0,
      facesCompleted: 0,
      cubesCompleted: 0,
    };
  }

  /** Boot: mint real identities and a real ledger with signature verification ON. */
  async start() {
    if (this.running) return this;
    this.ledger = new Ledger({
      dbPath: this.options.dbPath,
      // Wiring this lookup is what activates ledger-side signature verification.
      getPublicKeyByAddress: (address) => {
        const id = this.byAddress.get(address);
        return id ? id.publicKey : null;
      },
    });
    this.ledger.on('face:complete', () => { this.metrics.facesCompleted++; this.emit('face:complete'); });
    this.ledger.on('cube:complete', () => { this.metrics.cubesCompleted++; this.emit('cube:complete'); });

    for (let i = 0; i < this.options.identities; i++) {
      const id = await Identity.create(this.options.scheme);
      this.identities.push(id);
      this.byAddress.set(id.address, id);
      this.metrics.identities++;
      this.emit('identity:created', { index: i, address: id.address });
    }
    // ledger.xid must be truthy for the verification branch to run; the static
    // Identity.verifyTransaction does the actual work, so any identity instance serves.
    this.ledger.xid = this.identities[0] || Identity;
    this.running = true;
    this.emit('started', { identities: this.identities.length });
    return this;
  }

  /** Address of a devnet participant by index (0 is the default "wallet"). */
  addressOf(index = 0) {
    const id = this.identities[index];
    return id ? id.address : null;
  }

  /**
   * Submit a SIGNED utxo transfer through the direct ledger path. Returns
   * { ok, id, result?|error? }. Signature is verified by the ledger before it lands.
   */
  async submitTransfer(fromIndex, toIndex, amount) {
    if (!this.running) throw new Error('devnet not started');
    const from = this.identities[fromIndex];
    const to = this.identities[toIndex];
    if (!from || !to) throw new Error(`bad participant index (have ${this.identities.length})`);
    const tx = {
      id: `dtx_${++this._seq}`,
      type: 'utxo',
      from: from.address,
      to: to.address,
      amount,
      timestamp: Date.now(),
    };
    const signed = await from.signTransaction(tx); // sets from=from.address, adds MAYO sig
    this.metrics.submitted++;
    try {
      const result = await this.ledger.addTransaction(signed);
      this.metrics.landed++;
      this._applied.push({ from: signed.from, to: signed.to, amount: Number(amount) });
      this.emit('tx:landed', { id: signed.id, from: signed.from, to: signed.to, amount: Number(amount) });
      return { ok: true, id: signed.id, result };
    } catch (error) {
      this.metrics.rejected++;
      this.emit('tx:rejected', { id: signed.id, error: error.message });
      return { ok: false, id: signed.id, error: error.message };
    }
  }

  /**
   * REAL balance of an address: the net of every utxo tx the ledger actually accepted
   * (each passed signature verification). Not a fabricated figure — it is the sum of applied
   * deltas, so a fresh devnet reports 0 and only submitted+landed transfers move it.
   */
  balanceOf(address) {
    let bal = 0;
    for (const tx of this._applied) {
      if (tx.to === address) bal += tx.amount;
      if (tx.from === address) bal -= tx.amount;
    }
    return bal;
  }

  /** Current height: number of blocks the ledger is holding/has sealed this session. */
  height() {
    return this.metrics.landed;
  }

  async getMetrics() {
    let root = null;
    try { root = await this.ledger?.getStateRoot?.(); } catch { /* root optional */ }
    return { ...this.metrics, pooled: this.ledger?.getMembershipPool?.().length ?? 0, root };
  }

  isRunning() { return this.running; }

  async stop() {
    if (!this.running) return;
    this.running = false;
    try { await this.ledger?.close?.(); } catch { /* in-memory has no close */ }
    this.emit('stopped', { ...this.metrics });
  }
}
