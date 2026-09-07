import { MAYOWasm } from './wasm-wrapper.js';
import {
  sign as cubicSigSign,
  verify as cubicSigVerify,
  serializeSignature,
  deserializeSignature,
  deserializePrivateKey,
  deserializePublicKey,
  keyGen as cubicKeyGen,
} from './cubic-sig.js';

/**
 * signer — the ONE seam through which every xmbl signature is constructed and
 * verified. Every callsite that produces or checks an xmbl signature routes
 * through this module; nothing else calls the underlying primitive directly.
 * Group F swaps the signature scheme by editing THIS module (and the primitive
 * it delegates to) without touching any caller.
 *
 * Interface:
 *   sign(bytes, secretKey)        → signature
 *   verify(bytes, signature, pk)  → boolean
 *   SIGNER_SCHEME / Signer.scheme → the scheme tag (default 'mayo')
 *
 * The scheme tag is EXPOSED here, not embedded in the signed payload: the signed
 * message format is unchanged, so existing signatures/verification across the
 * codebase keep working. `signTagged` is a forward hook for callers that want to
 * record which scheme produced a signature.
 *
 * `wasm-wrapper.js` is the MAYO primitive this seam delegates to — the thing
 * group F replaces — not a competing signature-construction site.
 */

/** Current signature scheme tag. Group F changes this when the scheme changes. */
export const SIGNER_SCHEME = 'mayo';

// Normalize accepted message inputs to the Uint8Array the primitive expects.
function toMessageBytes(message) {
  if (message instanceof Uint8Array) return message;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(message)) return new Uint8Array(message);
  if (typeof message === 'string') return new TextEncoder().encode(message);
  throw new Error('signer: message must be a Uint8Array, Buffer, or string');
}

// Normalize a scheme option: accept either a bare string ('mayo') or an options
// object ({scheme}). Undefined → the default scheme. This keeps the pre-F5
// two-arg sign(message, secretKey) / three-arg verify(...) callsites unchanged
// (they pass no scheme, so they route to the default), while letting F-group
// callers select a scheme without any other signature change.
function schemeOf(opts) {
  if (opts === undefined || opts === null) return SIGNER_SCHEME;
  if (typeof opts === 'string') return opts;
  if (typeof opts === 'object' && opts.scheme !== undefined) return opts.scheme;
  return SIGNER_SCHEME;
}

/**
 * Construct a signature over `message` with `secretKey`.
 * @param {Uint8Array|Buffer|string} message
 * @param {string} secretKey - base64 MAYO or Cubic secret key
 * @param {{scheme?:string, cubeContext?:object, pk?:object}|string} [opts] - signature scheme (default 'mayo').
 *   Selecting a scheme loads the matching WASM artifact or geometric primitive BEHIND this seam.
 * @returns {Promise<string>} signature
 */
export async function sign(message, secretKey, opts) {
  const scheme = schemeOf(opts);
  if (scheme === 'cubic') {
    const cubeContext = (typeof opts === 'object' && opts.cubeContext) || {
      cubeAddress: 0,
      coordinates: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 0, z: -1 }, { x: -2, y: 5, z: 2 }],
    };
    const sk = typeof secretKey === 'bigint' ? secretKey : deserializePrivateKey(secretKey);
    let pk = typeof opts === 'object' ? opts.pk : null;
    if (!pk) {
      // Ephemeral derivation or require pk in opts
      const { pk: derivedPk } = cubicKeyGen();
      pk = derivedPk;
    }
    const sigObj = cubicSigSign(toMessageBytes(message), sk, pk, cubeContext);
    return serializeSignature(sigObj);
  }
  const mayo = await MAYOWasm.load(scheme);
  return mayo.sign(toMessageBytes(message), secretKey);
}

/**
 * Verify `signature` over `message` under `publicKey`.
 * @param {Uint8Array|Buffer|string} message
 * @param {string} signature
 * @param {string} publicKey - base64 MAYO or Cubic public key
 * @param {{scheme?:string, cubeContext?:object}|string} [opts] - signature scheme (default 'mayo').
 * @returns {Promise<boolean>}
 */
export async function verify(message, signature, publicKey, opts) {
  const scheme = schemeOf(opts);
  if (scheme === 'cubic') {
    const cubeContext = (typeof opts === 'object' && opts.cubeContext) || {
      cubeAddress: 0,
      coordinates: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 0, z: -1 }, { x: -2, y: 5, z: 2 }],
    };
    const pk = typeof publicKey === 'object' && publicKey.x !== undefined ? publicKey : deserializePublicKey(publicKey);
    const sigObj = typeof signature === 'object' ? signature : deserializeSignature(signature);
    return cubicSigVerify(toMessageBytes(message), sigObj, pk, cubeContext);
  }
  const mayo = await MAYOWasm.load(scheme);
  return mayo.verify(toMessageBytes(message), signature, publicKey);
}

/**
 * Construct a scheme-tagged signature envelope. Forward hook for callers that
 * want to persist which scheme produced the signature; does not change the bytes
 * that are signed. The reported scheme is the one actually used.
 * @param {Uint8Array|Buffer|string} message
 * @param {string} secretKey
 * @param {{scheme?:string}|string} [opts] - signature scheme (default 'mayo')
 * @returns {Promise<{scheme:string, sig:string}>}
 */
export async function signTagged(message, secretKey, opts) {
  const scheme = schemeOf(opts);
  return { scheme, sig: await sign(message, secretKey, scheme) };
}

/** The signer seam as a single object. */
export const Signer = { scheme: SIGNER_SCHEME, sign, verify, signTagged };

export default Signer;
