# @xmbl/identity

Identity and signatures for XMBL. MAYO (post-quantum, multivariate) signs every identity and every
transaction; alongside it sits the experimental **cube-curve** seam — a signature scheme, an LWE KEM
and two FHE backends built on the same cubic geometry the ledger uses.

> ⚠ **Pre-mainnet.** The MAYO implementation is a fork that has not been externally audited, and the
> cube-curve constructions are novel. `@xmbl/core` refuses an `XMBL_PROFILE=mainnet` boot while those
> gates are open. See [MAINNET-GATES.md](../../MAINNET-GATES.md).

```sh
npm install @xmbl/identity
```

## What it owns

| Export | What it is |
|---|---|
| `Identity`, `signingMessage` | An identity, and **the one canonical signed-message derivation** — sign and verify share it, so their field strip-lists cannot drift. The signature covers every tx field except `sig` and `publicKey`. |
| `Signer`, `sign`, `verify`, `signTagged`, `SIGNER_SCHEME` | The signing surface. `signTagged` domain-separates by purpose so a signature made for one thing never verifies as another. |
| `MAYOWasm` | The MAYO WASM binding. The committed `mayo.wasm` is reproducible byte-for-byte from the vendored C by `emscripten/emsdk:6.0.9` — digests and the CI job that fails on any difference are in [MAYO-PROVENANCE.md](MAYO-PROVENANCE.md). |
| `KeyManager`, `loadOrCreate…`, `DurableNonceRegistry` | Key storage, and a nonce registry that survives a restart — an in-memory one lets a replay through the moment the process bounces. |
| `batchSign`, `batchVerify` | Batch verification over many signatures. |
| `CurveSource`, `CubicCurveSource`, `CubicField`, `matrixRankModP` | The cube-curve parameter source feeding MAYO's public map. |
| `cubicSigKeyGen` / `cubicSigSign` / `cubicSigVerify` | The cube-curve signature scheme. |
| `cubicLweKeyGen`, `encapsulate`, `decapsulate`, `encryptBit`, `addCiphertexts`, `MAINNET_N` | Cube-curve LWE: a KEM plus additively homomorphic bit ciphertexts. |
| BFV / FHEW (`src/bfv.js`, `src/fhew.js`) | The two FHE backends. |
| `sealSecret`, `openSecret`, `sealKeyPair` | Sealed-box encryption to a public key. |
| `delegation.js`, `agent-keystore.js` | Delegated signing authority and the agent keystore (with its CLI). |

## Use

```js
import { Identity, Signer, verify } from '@xmbl/identity';

const id = await Identity.create();
const tx = { type: 'transfer', from: id.address, to: '…', amount: 1n };
const signed = await new Signer(id).signTransaction(tx);
await verify(signed);            // covers every field but `sig` and `publicKey`
```

## Tests

Plain-node suites, no framework — each asserts and exits non-zero:

```sh
node ../../scripts/run-node-tests.mjs .
```

They cover the sign/verify message symmetry, the signing-status invariant, seal round-trips,
delegation, the durable nonce registry and the cubic crypto.
