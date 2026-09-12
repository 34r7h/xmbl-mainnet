# Devnet finding: two broken signature-re-verification seams in the consensus→ledger path

Surfaced while reviving the simulator into `LocalDevnet` (the "hardhat for XMBL"). The devnet
opts into ledger-side signature verification — it wires **both** `xid` and
`getPublicKeyByAddress` into the `Ledger` — which is precisely the caller configuration that
exercises two defects no production code path currently reaches. Both are **pinned by
`src/devnet.test.mjs`** (cases PIN(a)/PIN(b)); a protocol fix makes those assertions flip, so
the bugs cannot silently return.

## The ledger verifies a signature only when it holds BOTH `xid` and `getPublicKeyByAddress`

`cubic-ledger/src/ledger.js` re-verifies a tx's signature on entry in two methods:

- `addTransaction` (line ~174): `if (this.xid && tx.sig && tx.from)` → look up the pubkey via
  `this.getPublicKeyByAddress(tx.from)`; if found, `Identity.verifyTransaction(tx, publicKey)`.
- `addSealedBatch` (line ~242): same guard → but calls **`this.xid.verify(tx, tx.sig, publicKey)`**.

The pubkey lookup is the gate. **`packages/core/index.js` constructs the `Ledger` WITHOUT
`getPublicKeyByAddress`** (it passes only `dbPath`, `xn`, `xid`, `consensusV2`), so in the
production daemon the lookup is `undefined`, `publicKey` resolves `null`, and **neither
verification block is ever entered**. Both defects below are therefore **latent / dead
defensive code in production**, not a live mainnet break. They become reachable the moment a
caller (the devnet, a future node that wires the lookup) turns verification on.

## Defect (a): `finalizeTransaction` overwrites the signed `id`, breaking re-verification

`consensus/src/workflow.js:781-784`:

```js
const txDataWithId = { ...processingTx.txData, id: validatedHash };
```

Finalization replaces the originator's `id` with the consensus `validatedHash`, then the legacy
finalize path (`workflow.js:81`) hands that mutated object to `ledger.addTransaction`.
`Identity.signTransaction` signs over `JSON.stringify` of the whole tx minus `sig`/`publicKey`,
so `id` is inside the signed message; `Identity.verifyTransaction` re-stringifies the tx with the
**changed** `id`, the messages differ, and verification fails with
`"Invalid transaction signature or address mismatch"` — the exact error observed in earlier
simulator runs.

Root tension: the originator cannot sign a consensus-assigned identifier it does not yet know.
Either `id` must be excluded from the signed message (signing-domain separation) or the ledger
must verify against the originator's signed form. **That is an audit-level decision about the
signature domain and is deliberately NOT made here** — widening a signature check is exactly the
change that must not ride in on a tooling commit.

## Defect (b): `addSealedBatch` calls a method that does not exist

`cubic-ledger/src/ledger.js:249`:

```js
const isValid = await this.xid.verify(tx, tx.sig, publicKey);
```

`ledger.xid` is only ever assigned an **`Identity` instance** (`core/index.js:181`:
`this.xid = await Identity.create()`). The `Identity` class exposes `signTransaction` and the
static `Identity.verifyTransaction` — it has **no `verify` method**, on the instance or the class.
So when reached, this line throws `TypeError: this.xid.verify is not a function`, which is caught
at line ~255 but **re-thrown** (the guard only swallows `ERR_MODULE_NOT_FOUND` / Base64 errors).

Two consequences: (1) `addSealedBatch`'s signature check has **never actually verified a
signature** — it is wrong dead code; and (2) it uses a **different verification method name** than
`addTransaction`'s `Identity.verifyTransaction`, so the two entry points were never consistent.
The real lead-role seal path routes through here (`core/lead-worker.js:73` →
`xclt.addSealedBatch([txData])` via `ConsensusWorkflow`'s `batchSealer`), so this must be made
correct — and consistent with `addTransaction` — before ledger-side verification is ever enabled
in production.

## Empirical proof

`src/devnet.test.mjs` asserts all three outcomes against the real modules (no stubs):
- a valid signed `utxo` tx submitted via `addTransaction` with verification ON **lands**, and a
  tx tampered after signing is **rejected** (verification is live, not a no-op);
- PIN(a): the same tx with its `id` overwritten **throws** `/Invalid transaction signature/`;
- PIN(b): `addSealedBatch([signed])` **throws** `/TypeError.*verify is not a function/`.

## Why the devnet drives the direct path

`LocalDevnet` submits signed txs straight to `ledger.addTransaction` (not through consensus
finalization), because that path verifies the tx as-signed and works. This lets the devnet be a
real, verifiable local network today while the consensus→ledger seam above is an open, pinned
finding rather than a silently-skipped one.
