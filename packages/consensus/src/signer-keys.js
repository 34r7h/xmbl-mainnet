// A SIGNED TX ARRIVES WITH ITS SIGNER'S KEY. A node looked a signer's key up only in its peer registry, which
// fills from presence gossip every 4 s; until a peer's presence arrived, every tx that peer signed was pooled,
// validated and sealed here with no signature check at all (the check is skipped when the key does not
// resolve). Measured on 2 real nodes x 504 node-signed datums: the receiving node ran 0.01 MAYO verifies per tx.
// A raw tx now travels with the key it was signed under, and a key is kept only when it hashes to the address
// it is offered for, so a carried key needs no trust in whoever carried it. `max` bounds the map (oldest out
// first); a signer pushed out falls back to the registry.
export class SignerKeys {
  constructor({ derive, max = 4096 } = {}) {
    if (typeof derive !== 'function') throw new Error('SignerKeys needs derive(publicKey) -> address');
    this._derive = derive;
    this._max = max;
    this._keys = new Map();   // address -> publicKey, each one checked to derive to its address
    this.refused = 0;
  }

  /** Keep `publicKey` for `address` if it derives to it. True when the key is held after the call. */
  learn(address, publicKey) {
    if (typeof address !== 'string' || typeof publicKey !== 'string' || !address || !publicKey) return false;
    if (this._keys.get(address) === publicKey) return true;
    let derived = null;
    try { derived = this._derive(publicKey); } catch { derived = null; }
    if (derived !== address) { this.refused++; return false; }
    this._keys.delete(address);
    this._keys.set(address, publicKey);
    if (this._keys.size > this._max) this._keys.delete(this._keys.keys().next().value);
    return true;
  }

  get(address) { return this._keys.get(address) || null; }

  get size() { return this._keys.size; }
}
