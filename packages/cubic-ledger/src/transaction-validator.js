import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { micromine, verifyMicromine, typePrefix, type6TxBody, type7PointerBody } from './micromine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let tokenTypes = null;

function loadTokenTypes() {
  if (!tokenTypes) {
    try {
      const tokensPath = join(__dirname, '..', 'tokens.json');
      const tokensData = readFileSync(tokensPath, 'utf-8');
      tokenTypes = JSON.parse(tokensData).transactionTypes;
    } catch (error) {
      throw new Error(`Failed to load tokens.json: ${error.message}`);
    }
  }
  return tokenTypes;
}

// ═══ EVERY TRANSACTION HAS AN XMBL TYPE, SIGNIFIED BY ITS XID (operator, 2026-09-16) ═══
//
// The xid is the micromining function's output over the type's canonical body — SHA256(oid + nonce) whose first
// two hex chars are '0' + the type code (tokens.json `code`). It is the datum's identity AND its type: a block id
// derives from it, cube placement hashes it, and a holder re-mines it from {body, nonce} without asking anyone.
// A transaction that carries no verifiable xid is UNTYPED and is refused at every door. MEASURED before this
// rule: 16,313 of 17,628 anchors on the audited node carried no xid at all.
export const XID_RE = /^0[0-9][0-9a-f]{62}$/;

/** The numeric xmbl type code of a tokens.json transaction type (its xid prefix is '0' + code). */
export function typeCodeOf(type) {
  const t = loadTokenTypes()[type];
  if (!t || !Number.isInteger(t.code)) throw new Error(`no xmbl type code for transaction type ${type}`);
  return t.code;
}

/** How a tokens.json type is authorized: 'signed' (sig + sender) or 'content-addressed' (its xid IS its authority). */
export function authorityOf(type) {
  const t = loadTokenTypes()[type];
  return (t && t.authority) || 'signed';   // an unknown type is never content-addressed
}

/** Every tokens.json type whose authority is its xid rather than a signature. */
export function contentAddressedTypes() {
  const types = loadTokenTypes();
  return Object.keys(types).filter((k) => types[k].authority === 'content-addressed').sort();
}

/** The tokens.json type an xid's prefix signifies, or null (not an xid, or a datum kind that is not a chain tx). */
export function typeOfXid(xid) {
  if (typeof xid !== 'string' || !XID_RE.test(xid)) return null;
  const code = Number(xid[1]);
  for (const [name, t] of Object.entries(loadTokenTypes())) if (t.code === code) return name;
  return null;
}

// What a signer or a validator adds AROUND a datum and what the network stamps on it in flight — never part of
// the body the xid commits to, so the identity survives signing, relaying and consensus timing.
const ENVELOPE = new Set(['sig', 'publicKey', 'xid', 'nonce', 'id', 'validationTimestamp', 'validationTimestamps']);
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === 'bigint') return v.toString();
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = canonical(v[k]);
    return o;
  }
  return v;
}

/** The canonical body the xid of `tx` micromines. Type-6 and the anchor pointer keep their golden-pinned shapes
 *  (byte-identical to the app and the broker); every other type is its own fields minus the envelope, keys sorted. */
export function micromineBody(tx) {
  if (!tx || typeof tx !== 'object') throw new Error('Transaction must be an object');
  if (tx.type === 'tx') return type6TxBody(tx);
  if (tx.type === 'anchor') return type7PointerBody({ from: tx.prior ? [tx.prior] : [], to: [tx.hash], how: 'anchor' });
  const body = {};
  for (const k of Object.keys(tx)) if (!ENVELOPE.has(k)) body[k] = tx[k];
  return canonical(body);
}

/** Mine the xmbl type identity onto a transaction: returns a copy carrying `xid` + `nonce` (and, for an anchor
 *  with no chain head, prior ""). Mine AFTER `from` is final and BEFORE signing — the signature then covers the
 *  xid, and the xid covers everything but the envelope. */
export function micromineTx(tx) {
  if (!tx || typeof tx !== 'object' || !tx.type) throw new Error('micromineTx: transaction with a type required');
  const t = tx.type === 'anchor' && tx.prior === undefined ? { ...tx, prior: '' } : { ...tx };
  const { xid, nonce } = micromine(micromineBody(t), typeCodeOf(t.type));
  return { ...t, xid, nonce };
}

// An UNTYPED refusal is distinguishable from a forgery: the same anchor may still arrive typed later, so a caller
// must not evict its content key over it. (`err.code === 'UNTYPED'`)
function untyped(msg) { const e = new Error(msg); e.code = 'UNTYPED'; return e; }

/** STAGE 1 of consensus validation — can this transaction happen at all: a known type with its required fields,
 *  and an anchor's hash a real digest. Says nothing about the xid (stage 2) or placement (stage 3). */
export function validateShape(tx) {
  if (!tx || typeof tx !== 'object') {
    throw new Error('Transaction must be an object');
  }

  if (!tx.type) {
    throw new Error('Transaction must have a type field');
  }

  const types = loadTokenTypes();
  const txType = types[tx.type];

  if (!txType) {
    throw new Error(`Unknown transaction type: ${tx.type}`);
  }

  // Validate required fields
  for (const field of txType.required) {
    if (!(field in tx)) {
      throw new Error(`Missing required field: ${field} for transaction type ${tx.type}`);
    }
  }

  // AN ANCHOR'S hash MUST BE A DIGEST. tokens.json requires the FIELD to be present and never checked what
  // was in it, so a literal label passed straight through. MEASURED on this node's ledger 2026-09-16: one row
  // carried hash "proofofmined-1789450900844" under event "proof.mined" — signed by this node's own key. An
  // anchor is a hashes-only digest of an off-chain event and nothing anywhere can resolve it back to a source
  // record (every anchor lookup on the broker is a 404), so the digest shape is the ONLY thing about an anchor
  // this node can actually check. Refusing it here means a fabricated anchor is rejected at the door and, via
  // Ledger.addTransaction, recorded as evicted — never examined again.
  if (tx.type === 'anchor' && !/^[0-9a-f]{64}$/.test(String(tx.hash))) {
    throw new Error(`anchor hash is not a sha-256 digest: ${JSON.stringify(tx.hash)}`);
  }

  if (tx.type === 'state_diff') {
    const w = stateDiffWrites(tx);
    if (!w.ok) throw new Error(w.reason);
  }

  return true;
}

// ═══ A STATE_DIFF WRITES XMBL DATUMS, EACH UNDER ITS MICROMINED KEY ═══
//
// The state machine applied a state_diff's args AS the changes, keys and all, and nothing checked which keys.
// MEASURED 2026-10-09 against the published 0.1.20 bytes: a state_diff signed by a fresh identity with args
// {'utxo:forged0000': {to: <itself>, amount: '1000000000'}} passed validateForConsensus, went through
// Ledger.addTransaction into the Verkle tree, and a deployed TRANSFER contract spent it.
//
// A state_diff now writes only xmbl datums, under the key the micromining protocol gives each one: `${xid}_${nonce}`,
// the key micromine() returns and the app's set() stores db.data under. The datum's type is its xid's prefix
// ('0' + code, app-types.json: datum 0 … type 9), and the key must be the one micromine(data, type) yields — the
// LOWEST nonce — so one content of one type has exactly one key and a second write of it writes the same bytes.
// Typed data (1-9) carries exactly its type's fields with the app's runtime types, in any order — what the app's set()
// admits (it sorts both key lists before comparing). The key is mined from the data's own bytes, so the same bytes are
// the same key; the same fields in another order are other bytes and another key, as they are in the app. No chain-native
// key (identity:, utxo:, spend:, tx:, token:, contract:, anchor:, xcl/…) has this shape, so no state_diff reaches one.
// Value and its spending are not written this way: a type-6 unit enters as chain type `tx`, and a type-7 pointer may
// not say how 'spend' or 'anchor', the two pointer meanings the chain mints itself. A contract's own receipts
// (contract_call, settlement_seal — control-socket.js) keep their exact arg shapes and nothing else.
const APP_TYPES = JSON.parse(readFileSync(join(__dirname, '..', 'app-types.json'), 'utf-8'));
export const APP_LEXICON = Object.freeze([...APP_TYPES.lexicon]);
const DATUM_KEY_RE = /^0([0-9])[0-9a-f]{62}_(0|[1-9][0-9]*)$/;
const NOT_BY_STATE_DIFF = { 6: 'a value unit enters as chain type tx, not by state_diff' };
const CHAIN_POINTER_HOWS = ['spend', 'anchor'];
const RECEIPT_ARGS = { settlement_seal: ['chain', 'address', 'authorization'], call: ['params', 'writes'] };

/** The app's runtime type of a value (xmbl src/stores/api.js utils type()): 'array', 'object' (null included), else typeof. */
export function appTypeOf(v) {
  return typeof v == 'object' && !Array.isArray(v) ? 'object' : Array.isArray(v) ? 'array' : typeof v;
}

/** Why `data` is not a datum of xmbl type `code`, or null. Type 0 is any datum the app's set() takes. */
function datumShapeError(data, code) {
  if (!data) return 'a datum carries its data';
  if (code === 0) return null;
  const schema = APP_TYPES.types[String(code)];
  if (appTypeOf(data) !== 'object' || data === null) return `a ${APP_LEXICON[code]} (type ${code}) is an object`;
  const want = Object.keys(schema).sort(), got = Object.keys(data).sort();
  if (got.join(',') !== want.join(',')) return `a ${APP_LEXICON[code]} (type ${code}) carries exactly ${want.join(',')}, not ${got.join(',').slice(0, 120)}`;
  const bad = want.find((f) => appTypeOf(data[f]) !== schema[f]);
  if (bad !== undefined) return `a ${APP_LEXICON[code]} (type ${code}) has ${bad} as ${schema[bad]}, not ${appTypeOf(data[bad])}`;
  return null;
}

/** The state_diff write for one datum of xmbl type `code`: { [`${xid}_${nonce}`]: { oid, nonce, data } }. */
export function datumWrite(data, code) {
  const { oid, nonce, key } = micromine(data, code);
  return { [key]: { oid, nonce, data } };
}

/** The writes a state_diff may make: { ok: true, changes } or { ok: false, reason }. The validator and the state
 *  machine both ask this, so what the door admits and what the tree applies cannot drift apart. */
export function stateDiffWrites(tx) {
  const args = tx && tx.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, reason: 'state_diff args must be an object of writes' };
  const keys = Object.keys(args);
  if (!keys.length) return { ok: false, reason: 'state_diff writes nothing' };
  if (tx.contractAddress) {
    const allowed = RECEIPT_ARGS[tx.function === 'settlement_seal' ? 'settlement_seal' : 'call'];
    const bad = keys.find((k) => !allowed.includes(k));
    if (bad !== undefined) return { ok: false, reason: `a contract receipt state_diff may not write ${JSON.stringify(bad.slice(0, 80))}` };
    return { ok: true, changes: { ...args } };
  }
  const changes = {};
  for (const k of keys) {
    const m = DATUM_KEY_RE.exec(k);
    if (!m) return { ok: false, reason: `a state_diff writes only xmbl datums under their micromined key <xid>_<nonce>, not ${JSON.stringify(k.slice(0, 80))}` };
    const code = Number(m[1]);
    if (NOT_BY_STATE_DIFF[code]) return { ok: false, reason: `${k}: ${NOT_BY_STATE_DIFF[code]}` };
    const v = args[k];
    if (!v || appTypeOf(v) !== 'object' || Object.keys(v).sort().join(',') !== 'data,nonce,oid') return { ok: false, reason: `${k}: the value is the datum {oid, nonce, data} and nothing else` };
    const shape = datumShapeError(v.data, code);
    if (shape) return { ok: false, reason: `${k}: ${shape}` };
    if (code === 7 && CHAIN_POINTER_HOWS.includes(v.data.how)) return { ok: false, reason: `${k}: a pointer saying how '${v.data.how}' is minted by the chain, not by state_diff` };
    let mined;
    try { mined = micromine(v.data, code); } catch (e) { return { ok: false, reason: `${k}: ${e.message}` }; }
    if (mined.key !== k) return { ok: false, reason: `${k}: this data mines to ${mined.key} as a ${APP_LEXICON[code]} (type ${code}) — a datum has one key, at its lowest nonce` };
    if (v.oid !== mined.oid || v.nonce !== mined.nonce) return { ok: false, reason: `${k}: oid and nonce must be the ones its data mines to (${mined.oid.slice(0, 12)}…, ${mined.nonce})` };
    changes[k] = { oid: mined.oid, nonce: mined.nonce, data: v.data };
  }
  return { ok: true, changes };
}

/** STAGE 2 — is the xid correct: present, well-formed, carrying this type's prefix, and micromining the type's
 *  canonical body at the carried nonce. Runs AFTER the shape rules so a fabricated anchor (a label for a hash) is
 *  refused — and evicted — as a forgery rather than merely as untyped. */
export function validateXid(tx) {
  if (!tx || typeof tx !== 'object' || !tx.type) throw new Error('Transaction must be an object with a type');
  if (typeof tx.xid !== 'string' || !XID_RE.test(tx.xid)) throw untyped(`untyped ${tx.type}: no micromined xid`);
  if (!Number.isInteger(tx.nonce) || tx.nonce < 0) throw untyped(`untyped ${tx.type}: nonce is not a non-negative integer`);
  const code = typeCodeOf(tx.type);
  if (!tx.xid.startsWith(typePrefix(code))) {
    const e = new Error(`xid ${tx.xid.slice(0, 10)}… carries type prefix ${tx.xid.slice(0, 2)} (${typeOfXid(tx.xid) || 'not a chain tx type'}) but tx.type is ${tx.type} (prefix ${typePrefix(code)})`);
    e.code = 'XID_MISMATCH';   // the claimed xid is not proven to be this datum's — never evict by it
    throw e;
  }
  if (tx.type === 'anchor' && typeof tx.prior !== 'string') {
    throw untyped('untyped anchor: no `prior` (the previous anchor xid, or "" for the first) — the type-7 pointer body cannot be re-mined without it');
  }
  if (!verifyMicromine(micromineBody(tx), tx.nonce, tx.xid, code)) {
    // TAGGED, because the caller must NOT treat the claimed xid as this datum's identity: the body does not
    // hash to it, so the xid names somebody else's datum — see the eviction rule in Ledger.addTransaction.
    const e = new Error(`${tx.type} failed micromine verification: xid ${tx.xid} does not content-address the body at nonce ${tx.nonce}`);
    e.code = 'XID_MISMATCH';
    throw e;
  }
  return true;
}

/** The ledger's rule for a transaction, in consensus order: 1. can it happen (shape), 2. is the xid correct.
 *  (3., the geometric placement, is a property of a sealed face/cube — verifyPlacement.) */
export function validateTransaction(tx) {
  validateShape(tx);
  validateXid(tx);
  return true;
}

export function getTransactionType(tx) {
  if (!tx || !tx.type) {
    return null;
  }
  const types = loadTokenTypes();
  return types[tx.type] || null;
}

