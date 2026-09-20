export { MAYOWasm } from './src/wasm-wrapper.js';
export { Identity, signingMessage } from './src/identity.js';
export { KeyManager } from './src/key-manager.js';
export { batchSign, batchVerify } from './src/batch.js';
export { Signer, sign, verify, signTagged, SIGNER_SCHEME } from './src/signer.js';
export { CurveSource, CubicCurveSource, CubicField, canonicalizeRequest, matrixRankModP, CURVE_PARAM_BLOCK_SIZE, SECP256K1_P, SECP256K1_N } from './src/curve-source.js';
export { keyGen as cubicSigKeyGen, sign as cubicSigSign, verify as cubicSigVerify, verifyDetail as cubicSigVerifyDetail, planeNormal } from './src/cubic-sig.js';
export { keyGen as cubicLweKeyGen, encapsulate, decapsulate, encryptBit, decryptBit, decryptBitDetail, sampleTernary, addCiphertexts } from './src/cubic-lwe.js';
export {
  ensureAgentIdentity,
  loadAgentIdentity,
  ensureIdentityAtPath,
  loadIdentityAtPath,
  getPublicRecord,
  encryptSecret,
  decryptSecret,
  loadMasterKey,
} from './src/agent-keystore.js';
export {
  mintGrant,
  mintZspToken,
  signAction,
  verifyChain,
  grantHash,
  tokenHash,
  makeAuthorizer,
  RevocationSet,
  NonceRegistry,
  NO_ATTESTATION,
} from './src/delegation.js';
export { DurableNonceRegistry } from './src/durable-nonce-registry.js';
export { sealSecret, openSecret, sealKeyPair } from './src/seal.js';
export { MAINNET_N } from './src/cubic-lwe.js';

// Leveled homomorphic encryption (BFV over Z_q[X]/(X^4096+1)) — ciphertexts ADD and MULTIPLY with
// no secret key, on integers mod 65537 rather than single bits. `cubic-lwe` remains the identity
// KEM and the sealing primitive at the cubic dimensions; this is a separate ring, because
// multiplication needs a power-of-two one. Namespaced `fhe*` so neither scheme shadows the other.
export {
  keyGen as fheKeyGen, encrypt as fheEncrypt, decrypt as fheDecrypt,
  encryptInt as fheEncryptInt, decryptInt as fheDecryptInt, encode as fheEncode, decode as fheDecode,
  addCipher as fheAdd, subCipher as fheSub, mulCipher as fheMul,
  addPlain as fheAddPlain, mulPlain as fheMulPlain, relinearize as fheRelinearize,
  serialize as fheSerialize, deserialize as fheDeserialize,
  noiseBudget as fheNoiseBudget, params as fheParams,
} from './src/bfv.js';

// THE VERSION OF THE CODE THIS PROCESS LOADED. Read once at import time from this package's own manifest, so a
// running node can report what it is actually executing — an install that lands on disk after this module was
// loaded changes the file, not this constant. Consumed by @xmbl/core's control socket (`status`.versions).
import { readFileSync as __readPkg } from 'node:fs';
export const VERSION = JSON.parse(__readPkg(new URL('./package.json', import.meta.url), 'utf8')).version;
