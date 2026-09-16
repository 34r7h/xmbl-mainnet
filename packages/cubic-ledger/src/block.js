import { createHash } from 'crypto';
import { calculateDigitalRoot, calculateDigitalRootFromHash } from './digital-root.js';
import { validateTransaction } from './transaction-validator.js';
import { calculateAbsoluteCoords, calculateVector, calculateFractalAddress } from './geometry.js';
import { anchorTimestampNanos } from './timestamps.js';

// THE CONSENSUS CONTENT OF A TRANSACTION — the part two honest nodes must agree on, and nothing else.
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
  if (!tx || typeof tx !== 'object') return null;
  if (tx.type === 'anchor') {
    // fixed key order, and `ts` normalised so an ISO string and the same instant as a number agree
    return JSON.stringify({
      type: 'anchor',
      event: tx.event ?? null,
      hash: tx.hash ?? null,
      ts: anchorTimestampNanos(tx.ts).toString()
    });
  }
  // A type-6 value tx is already content-addressed: xid micromines the canonical body and
  // validateTransaction has just verified it. Re-hashing the envelope around it would only undo that.
  if (tx.type === 'tx' && typeof tx.xid === 'string' && tx.xid) return 'xid:' + tx.xid;
  return null;
}

// The dedup key for a transaction: what "the same tx" means on disk and in the pool.
export function contentKey(tx) {
  if (tx && tx.type === 'anchor' && tx.event && tx.hash) return `${tx.event}:${tx.hash}`;
  if (tx && tx.type === 'tx' && tx.xid) return `xid:${tx.xid}`;
  return null;
}

export class Block {
  constructor(id, tx, hash, digitalRoot, timestamp = null, location = null) {
    this.id = id;
    this.tx = tx;
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

  static fromTransaction(tx) {
    // Validate transaction type
    validateTransaction(tx);

    // Serialize BigInt values before stringifying
    const serialized = Block._serializeBigInts(tx);
    const txStr = JSON.stringify(serialized);
    const hash = createHash('sha256').update(txStr).digest('hex');
    // The id addresses the CONSENSUS CONTENT, not the envelope the whole-tx hash covers (see
    // consensusBody above). A tx with no defined content body keeps the old derivation.
    const body = consensusBody(tx);
    const id = body === null
      ? hash.substring(0, 16)
      : createHash('sha256').update(body).digest('hex').substring(0, 16);
    
    // Digital root is no longer used for placement (hash-based sorting instead)
    // Keep for backward compatibility only
    const digitalRoot = tx.digitalRoot || 0;
    
    // Use validator average timestamp if available (from xpc, nanoseconds), otherwise use tx timestamp or current time
    const timestamp = tx.validationTimestamp || tx.timestamp || process.hrtime.bigint();
    
    return new Block(id, tx, hash, digitalRoot, timestamp);
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
    const block = new Block(obj.id, obj.tx, obj.hash, obj.digitalRoot, obj.timestamp, obj.location);
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

