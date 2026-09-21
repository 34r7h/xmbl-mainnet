import { createHash } from 'crypto';
import { calculateDigitalRoot, calculateDigitalRootFromHash } from './digital-root.js';
import { validateTransaction, XID_RE } from './transaction-validator.js';
import { calculateAbsoluteCoords, calculateVector, calculateFractalAddress } from './geometry.js';
import { anchorTimestampNanos } from './timestamps.js';

// THE CONSENSUS CONTENT OF A TRANSACTION — the part two correct nodes must agree on, and nothing else.
// Everything a node adds on the way past is ENVELOPE: who relayed it (`from`, `agent`,
// `agent_xmbl_address`), their signature (`sig`), when their own validator saw it (`validationTimestamp`)
// and whatever id their submitter happened to mint (`id`). The block id used to be sha256 of the WHOLE tx,
// envelope included, and JSON.stringify is key-order sensitive on top of that — so the same anchor got a
// different id on every node and on every resubmission. MEASURED on this node's ledger 2026-09-16: 17,904
// block rows over 13,783 distinct (event:hash) pairs, 13,665 of them with node-local fields baked into the
// id, 1,273 keys duplicated across 3,849 redundant rows whose ONLY difference was the envelope.
//
// `hash` is deliberately NOT changed: peers verify an adopted cube with `txHash(b.tx) === b.hash`
// (cube-sync.js verifyCube), so it is a wire contract. `id` is local — nothing puts it on the wire —
// so it is free to become the content address it always claimed to be.
//
// Returns null for a tx with no defined content address; such a block keeps the whole-tx hash as before.
export function consensusBody(tx) {
  // EVERY TRANSACTION IS TYPED BY ITS XID (transaction-validator.js): the xid is the mined content address of the
  // type's canonical body, so it is the consensus body of every type. No xid, no identity — the validator has
  // already refused it; here it simply has no body.
  if (!tx || typeof tx !== 'object') return null;
  if (typeof tx.xid !== 'string' || !XID_RE.test(tx.xid)) return null;
  if (tx.type === 'anchor') {
    // The broker's type-7 pointer body commits to {prior, hash} only, while `event` and `ts` steer this chain's
    // dedup key, state keys and placement time — so the CHAIN's content body binds them too, with a fixed key
    // order and `ts` normalised (an ISO string and the same instant as a number agree). Still envelope-free:
    // relayer, signature, validator clock and submitter id never enter it.
    return JSON.stringify({ type: 'anchor', event: tx.event ?? null, hash: tx.hash ?? null, ts: anchorTimestampNanos(tx.ts).toString(), xid: tx.xid });
  }
  // Every other type's canonical body is fully covered by its xid (micromineBody), so the xid is the body.
  return 'xid:' + tx.xid;
}

// The block id a consensus body addresses — spelled once, used by Block.fromTransaction and by the ledger's
// boot scan that decides whether a stored row is keyed by its content id or by a pre-content envelope hash.
export function contentIdOf(body) {
  return createHash('sha256').update(body).digest('hex').substring(0, 16);
}

// The dedup key for a transaction: what "the same tx" means on disk and in the pool.
export function contentKey(tx) {
  if (tx && tx.type === 'anchor' && tx.event && tx.hash) return `${tx.event}:${tx.hash}`;   // one anchor event:hash = one block, forever
  if (tx && typeof tx.xid === 'string' && XID_RE.test(tx.xid)) return `xid:${tx.xid}`;      // every other typed tx: its xid IS its identity
  return null;
}

export class Block {
  constructor(id, tx, hash, digitalRoot, timestamp = null, location = null, validationTimestamp = null) {
    this.id = id;
    this.tx = tx;
    // A5 — THE CONSENSUS CLOCK LIVES ON THE BLOCK, NOT INSIDE THE SIGNED TX. Consensus used to write its
    // averaged validator timestamp into txData, inside the signed domain, so a finalized tx could never
    // re-verify against its signer's key. It is an envelope value (the ledger's own ENVELOPE list has always
    // said so) and it belongs here, beside the tx, where it changes no signature and no hash — the block hash
    // is content-only. `tx.validationTimestamp` is still read as a fallback so blocks persisted before this
    // change, and any peer still running the old code, keep their time.
    this.validationTimestamp = validationTimestamp ?? (tx && tx.validationTimestamp !== undefined ? tx.validationTimestamp : null);
    this.txId = tx?.id || null; // Extract id from transaction object
    this.hash = hash;
    this.digitalRoot = digitalRoot;
    this.timestamp = timestamp || Date.now();
    this.location = location; // { faceIndex, position, cubeIndex, level }
    this.coordinates = null; // { x, y, z }
    this.vector = null; // { x, y, z, magnitude, direction }
    this.fractalAddress = null; // Array of hierarchical path
    
    // Calculate coordinates if location is provided
    if (location) {
      this.updateCoordinates();
    }
  }
  
  updateCoordinates() {
    if (!this.location) return;
    
    this.coordinates = calculateAbsoluteCoords(this.location);
    this.vector = calculateVector(this.coordinates);
    this.fractalAddress = calculateFractalAddress(this.location);
  }
  
  setLocation(location) {
    this.location = location;
    this.updateCoordinates();
  }
  
  getCoordinates() {
    // Always return valid coordinates (geometry functions handle invalid positions)
    return this.coordinates || { x: 0, y: 0, z: 0 };
  }
  
  getVector() {
    return this.vector || { x: 0, y: 0, z: 0, magnitude: 0, direction: { x: 0, y: 0, z: 0 } };
  }
  
  getFractalAddress() {
    return this.fractalAddress || [];
  }

  static fromTransaction(tx, opts = {}) {
    // Validate transaction type
    validateTransaction(tx);

    // CONTENT-ONLY HASH (operator, 2026-09-16 — rolled out to every node with a canonical rebuild). The hash
    // used to cover the whole envelope (relayer, signature, validator clock), so two correct nodes holding the
    // identical typed set still sorted their nine-block faces differently and sealed different cubes. Now the
    // hash is a pure function of the consensus body — the xid — and so is the id (its first 16 hex chars).
    // cube-sync's verifyCube recomputes exactly this from a block's tx.
    const body = consensusBody(tx);
    if (body === null) throw new Error(`untyped ${tx.type}: no consensus body`);   // unreachable after validateTransaction
    const hash = createHash('sha256').update(body).digest('hex');
    const id = hash.substring(0, 16);
    
    // Digital root is no longer used for placement (hash-based sorting instead)
    // Keep for backward compatibility only
    const digitalRoot = tx.digitalRoot || 0;
    
    // Use the validator average timestamp if one was supplied BESIDE the tx (A5: consensus hands it to the
    // ledger as an argument), else one still carried inside an older tx, else the tx's own time, else now.
    const vt = opts && opts.validationTimestamp != null ? opts.validationTimestamp : (tx.validationTimestamp ?? null);
    const timestamp = vt || tx.timestamp || process.hrtime.bigint();

    return new Block(id, tx, hash, digitalRoot, timestamp, null, vt);
  }

  serialize() {
    // Block timestamps (and BigInts nested in tx) are nanosecond BigInts, which
    // JSON.stringify throws on. Tag each BigInt as {__bigint__:"<digits>"} so the
    // value survives round-trip and deserialize can revive it to a real BigInt
    // (a plain .toString() would silently change the type and break equality).
    return JSON.stringify({
      id: this.id,
      tx: this.tx,
      hash: this.hash,
      digitalRoot: this.digitalRoot,
      timestamp: this.timestamp,
      validationTimestamp: this.validationTimestamp,   // A5: the consensus clock, an envelope value on the block
      location: this.location,
      coordinates: this.coordinates,
      vector: this.vector,
      fractalAddress: this.fractalAddress
    }, (key, value) => (typeof value === 'bigint' ? { __bigint__: value.toString() } : value));
  }

  static deserialize(data) {
    const obj = JSON.parse(data, (key, value) =>
      (value && typeof value === 'object' && typeof value.__bigint__ === 'string')
        ? BigInt(value.__bigint__)
        : value);
    const block = new Block(obj.id, obj.tx, obj.hash, obj.digitalRoot, obj.timestamp, obj.location, obj.validationTimestamp ?? null);
    // Restore calculated values if present
    if (obj.coordinates) block.coordinates = obj.coordinates;
    if (obj.vector) block.vector = obj.vector;
    if (obj.fractalAddress) block.fractalAddress = obj.fractalAddress;
    return block;
  }

  static _serializeBigInts(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'bigint') return obj.toString();
    if (Array.isArray(obj)) return obj.map(item => Block._serializeBigInts(item));
    if (typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = Block._serializeBigInts(value);
      }
      return result;
    }
    return obj;
  }
}

