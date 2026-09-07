import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { verifyMicromine, type6TxBody } from './micromine.js';

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

export function validateTransaction(tx) {
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

  // e49408b7 CONTENT-ADDRESS ENFORCEMENT: a type-6 value-tx ('tx') is trusted only if its xid actually
  // micromines the canonical body — recompute oid + verify xid=SHA256(oid+nonce) carries the '06' prefix.
  // This is what makes the chain accept the emitter's xid: a tampered body, a wrong nonce, or a mistyped key
  // FAILS here at validate time (byte-identical to the app + broker via micromine.js). Sig-verify is a
  // separate type-7 pointer, deferred to layer-b — a type-6 with NO sig-pointer is a valid sealable record.
  if (tx.type === 'tx') {
    const body = type6TxBody(tx);
    if (!verifyMicromine(body, tx.nonce, tx.xid, 6)) {
      throw new Error(`type-6 tx failed micromine verification: xid ${tx.xid} does not content-address the body at nonce ${tx.nonce}`);
    }
  }

  return true;
}

export function getTransactionType(tx) {
  if (!tx || !tx.type) {
    return null;
  }
  const types = loadTokenTypes();
  return types[tx.type] || null;
}

