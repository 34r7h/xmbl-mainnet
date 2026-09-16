import { MAYOWasm } from './wasm-wrapper.js';
import { sign as signerSign, verify as signerVerify } from './signer.js';
import { createHash } from 'crypto';

/**
 * The ONE canonical signed-message derivation, used by BOTH signTransaction and
 * verifyTransaction so the two strip-lists can never drift. Two hand-maintained lists were
 * asymmetric — sign excluded `sig` AND `publicKey`, verify excluded only `sig` — so a tx that
 * carried a `publicKey` field was verified against a different message than was signed and
 * failed a valid signature. This is the single source of truth.
 *
 * The signature covers every tx field EXCEPT `sig` (the signature itself) and `publicKey`
 * (a recovery aid, not signed content). `id` and every other field ARE covered — cubic-ledger
 * Block.fromTransaction derives a block's content-address from the WHOLE tx, so an unsigned
 * `id` would be attacker-mutable into a distinct block that re-applies the same value.
 * Consensus therefore MUST NOT overwrite `id` after signing (see finalizeTransaction).
 * @param {Object} tx
 * @returns {string} the exact JSON string the signature is/was computed over
 */
export function signingMessage(tx) {
  const { sig, publicKey, ...signed } = tx;
  return JSON.stringify(signed);
}

/**
 * Identity class for XMBL
 * Manages MAYO post-quantum cryptographic identities
 * @class Identity
 */
export class Identity {
  /**
   * Create a new Identity instance
   * @param {string} publicKey - Base64-encoded MAYO public key
   * @param {string} privateKey - Base64-encoded MAYO private key
   */
  constructor(publicKey, privateKey, scheme = 'mayo') {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.address = this._deriveAddress(publicKey);
    // Signature scheme this identity's keypair belongs to. Threaded into
    // signTransaction so the sign path uses the matching WASM artifact. Default
    // 'mayo' keeps every existing caller unchanged.
    this.scheme = scheme;
  }

  // CAN THIS IDENTITY SIGN A CHAIN CLAIM, AND IF NOT, WHICH FIELD IS MISSING?
  //
  // ⛔ THE FAILURE THIS MAKES VISIBLE. A node attaches its signed statement to the chain claim only when
  // address && publicKey && privateKey are all present, and the broker builds xmbl.chain SOLELY from a
  // verified statement — dropping the whole block when there is none. So a node with a public key and no
  // private key comes up, reports xmbl.up true with full roles, answers `chain` happily, and publishes NO
  // CHAIN BLOCK AT ALL, with nothing anywhere saying why. MEASURED 2026-09-16: of the four live coordinators
  // on the network, three were in exactly this state — two reporting up with no chain block, one failing its
  // identity query outright — and the only way anyone could tell the three apart was to open a shell on each
  // box. This answers it from the node itself: `can_sign` false with `missing` naming the field.
  //
  // Never returns key material. `missing` is a list of field NAMES.
  signingStatus() {
    const missing = [];
    if (!this.publicKey) missing.push('publicKey');
    if (!this.privateKey) missing.push('privateKey');
    if (!this.address) missing.push('address');
    return {
      can_sign: missing.length === 0,
      missing,
      address: this.address || null,
      scheme: this.scheme || null,
      verify_only: !!this.publicKey && !this.privateKey,
    };
  }

  /**
   * Create a new identity with generated keypair
   * @returns {Promise<Identity>} New identity instance
   */
  static async create(opts = {}) {
    // opts.scheme selects the signature scheme (default 'mayo'). Keygen loads the
    // matching WASM artifact; the identity remembers its scheme so signing uses it.
    const scheme = typeof opts === 'string' ? opts : (opts.scheme || 'mayo');
    const mayo = await MAYOWasm.load(scheme);
    const keypair = await mayo.keygen();
    return new Identity(keypair.publicKey, keypair.privateKey, scheme);
  }

  /**
   * Create identity from public key only (verification only)
   * @param {string} publicKey - Base64-encoded MAYO public key
   * @returns {Identity} Identity instance
   */
  static fromPublicKey(publicKey) {
    return new Identity(publicKey, null);
  }

  /**
   * Derive XMBL address from public key
   * @param {string} publicKey - Base64-encoded public key
   * @returns {string} XMBL address (xmb prefix + 40 hex chars)
   */
  static deriveAddress(publicKey) {
    if (!publicKey) {
      throw new Error('Public key is required to derive address');
    }
    // Hash public key to get address
    const pkBytes = Identity._base64ToBytesStatic(publicKey);
    const hash = createHash('sha256').update(pkBytes).digest('hex');
    return 'xmb' + hash.substring(0, 40); // XMBL address prefix
  }

  /**
   * Derive XMBL address from public key (instance method)
   * @private
   * @param {string} publicKey - Base64-encoded public key
   * @returns {string} XMBL address (xmb prefix + 40 hex chars)
   */
  _deriveAddress(publicKey) {
    return Identity.deriveAddress(publicKey);
  }

  /**
   * Static helper to convert base64 to bytes
   * @private
   */
  static _base64ToBytesStatic(base64) {
    if (!base64) {
      throw new Error('Base64 string is required');
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(base64, 'base64');
    }
    // Browser fallback
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Sign a transaction with MAYO signature
   * @param {Object} tx - Transaction object (must have from field set to this.address)
   * @returns {Promise<Object>} Transaction with signature added (NO publicKey field)
   */
  async signTransaction(tx) {
    // Ensure from address is set to this identity's address. NOTE (e49408b7): this from-overwrite is CORRECT for
    // NODE-AUTHORED txs (from == the signer, so verifyTransaction's derivedAddress===from sig-ownership fires) and
    // is DELIBERATELY kept. A CONTENT-ADDRESSED type-6 (whose `from`=[payer] is a mined body field) must NOT reach
    // here — core.submitTransaction skips signing it (type-scoped), because overwriting `from` would break its
    // content-address. Keeping this path unconditional preserves the node-authored sig-ownership invariant.
    // Strip any inbound publicKey/sig here so the RETURNED tx has the exact shape the
    // signature was computed over (signingMessage excludes both). Otherwise a caller that
    // passed a publicKey field would get it back on the signed tx, and verifyTransaction —
    // which also excludes it — would be verifying a different shape than the object carries.
    const { publicKey: _pk, sig: _sig, ...body } = { ...tx, from: this.address };
    // Message to sign — the ONE canonical derivation (excludes sig + publicKey).
    const message = signingMessage(body);
    const messageBytes = new TextEncoder().encode(message);
    // Route through the ONE signer seam (xid/src/signer.js) — do not call the
    // signature primitive directly here. Sign under this identity's scheme.
    const signature = await signerSign(messageBytes, this.privateKey, this.scheme);
    // Return transaction with signature, but NO publicKey
    return { ...body, sig: signature };
  }

  /**
   * Verify a signed transaction and check that signer owns the from address
   * @param {Object} signedTx - Signed transaction object (must have sig and from fields)
   * @param {string} publicKey - Base64-encoded public key to verify signature
   * @param {{scheme?:string}|string} [opts] - signature scheme (default 'mayo'); must
   *   match the scheme the signature was produced under. Omitted → default, so
   *   every existing caller is unchanged.
   * @returns {Promise<boolean>} True if signature is valid AND public key derives to from address
   */
  static async verifyTransaction(signedTx, publicKey, opts) {
    if (!signedTx.sig || !signedTx.from) {
      return false;
    }

    // Message to verify — the SAME canonical derivation the signer used (excludes sig +
    // publicKey), so a tx carrying a publicKey field verifies against what was actually signed.
    const message = signingMessage(signedTx);
    const messageBytes = new TextEncoder().encode(message);

    // Verify signature through the ONE signer seam (xid/src/signer.js).
    const isValidSig = await signerVerify(messageBytes, signedTx.sig, publicKey, opts);
    if (!isValidSig) {
      return false;
    }
    
    // Verify that public key derives to the from address
    const derivedAddress = Identity.deriveAddress(publicKey);
    return derivedAddress === signedTx.from;
  }

  _base64ToBytes(base64) {
    if (!base64) {
      throw new Error('Base64 string is required');
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(base64, 'base64');
    }
    // Browser fallback
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}

