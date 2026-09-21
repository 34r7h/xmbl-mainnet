# Devnet finding: the consensus→ledger signature-re-verification seams (two FIXED, one open)

Surfaced while reviving the simulator into `LocalDevnet` (the "hardhat for XMBL"). The devnet
opts into ledger-side signature verification — it wires **both** `xid` and
`getPublicKeyByAddress` into the `Ledger` — which is precisely the caller configuration that
exercises defects no production code path currently reaches. Two of the three defects below are
now **FIXED**; the third is a genuine signature-domain decision left for the audit and documented
accurately rather than papered over. All are covered by `src/devnet.test.mjs`.

## Where ledger-side verification runs

`cubic-ledger/src/ledger.js` re-verifies a tx's signature on entry in two methods:

- `addTransaction`: `if (this.xid && tx.sig && tx.from)` → look up the pubkey via
  `this.getPublicKeyByAddress(tx.from)`; if found, `Identity.verifyTransaction(tx, publicKey)`.
- `addSealedBatch`: same guard.

The pubkey lookup is the gate. **`packages/core/index.js` constructs the `Ledger` WITHOUT
`getPublicKeyByAddress`** (it passes only `dbPath`, `xn`, `xid`, `consensusV2`), so in the
production daemon the lookup is `undefined`, `publicKey` resolves `null`, and **neither
verification block is entered**. Ledger-side re-verification is therefore **OFF in production
today** — a deliberate posture (consensus verifies at validation time via
`workflow.js completeValidation`, wired at `core/index.js:304`); the ledger block is a
defense-in-depth layer that is not yet enabled. Enabling it is gated on defect (c) below.

## Defect (a) — FIXED: `finalizeTransaction` no longer overwrites the signed `id`

`consensus/src/workflow.js finalizeTransaction` used to do
`const txDataWithId = { ...processingTx.txData, id: validatedHash }` unconditionally.
`identity`'s `signingMessage` covers every field except `sig`/`publicKey`, so `id` is inside the
signed message; overwriting it made re-verification stringify a different tx and a valid
signature could never match ("Invalid transaction signature or address mismatch" — the exact
error observed in earlier simulator runs).

**Fix:** preserve the originator's signed `id`; only fall back to `validatedHash` when the tx
carried none:

```js
const txDataWithId = processingTx.txData.id != null
  ? processingTx.txData
  : { ...processingTx.txData, id: validatedHash };
```

The consensus hash is already carried to the ledger as the finalized event's `txId`, and the
ledger derives its own content-addressed block id via `Block.fromTransaction` — it never needs
`txData.id` to equal `validatedHash`. `src/devnet.test.mjs` drives `finalizeTransaction` at the
real code site and asserts the emitted `txData.id` is preserved AND the tx still verifies against
the signer key, with a negative control that an `id`-mutated signed tx is rejected (id is inside
the signed domain — the reason it must not be overwritten).

## Defect (b) — FIXED: `addSealedBatch` called a method that does not exist

`cubic-ledger/src/ledger.js addSealedBatch` called **`this.xid.verify(tx, tx.sig, publicKey)`**.
`ledger.xid` is only ever an **`Identity` instance**, which exposes `signTransaction` and the
static `Identity.verifyTransaction` — it has **no `verify` method**. When reached this threw
`TypeError: this.xid.verify is not a function`, so `addSealedBatch`'s signature check had **never
actually verified a signature**, and it used a **different method name** than `addTransaction`.

**Fix:** call the same static `Identity.verifyTransaction(tx, publicKey)` `addTransaction` uses
(importing `Identity` the same way), which also enforces `derivedAddress===from` sig-ownership.
The real lead-role seal path routes through here (`core/lead-worker.js` →
`xclt.addSealedBatch([txData])`), so the two entry points are now consistent. `src/devnet.test.mjs`
asserts a validly signed tx VERIFIES and lands via `addSealedBatch`, with a negative control that
a tampered tx is rejected.

## Defect (c) — OPEN (audit-level): consensus injects `validationTimestamp` into the signed body

`consensus/src/workflow.js moveToProcessing` adds `validationTimestamp` (the quorum-averaged
validator timestamp) **inside** `txData` ("Include in txData for xclt to use"). That field is not
in the originator's signed message, so — exactly like the old `id` overwrite — a tx that has
passed through `moveToProcessing` will **not** re-verify at the ledger against the originator's
signature. Fixes (a)/(b) make the code correct for the **direct** path (an originator-signed tx
handed straight to the ledger, as the devnet does); they do **not** by themselves make the full
`submit → validate → moveToProcessing → finalize → ledger` path re-verifiable, because of this
injection.

This cannot be fixed by simply excluding `validationTimestamp` (or `id`) from the signature,
because **`Block.fromTransaction` derives the block's content-address `id` from the WHOLE tx**
(`sha256(JSON.stringify(tx)).slice(0,16)`). Any field that (i) affects `block.id` but (ii) is not
signed becomes an inflation/double-apply vector: one valid finalized tx re-broadcast with N
different values of that field yields N distinct `block.id`s and applies the same value N times.
So a correct enablement of ledger-side re-verification on the consensus path requires one of two
architectural choices, **which is an audit-level signature-domain / block-identity decision**:

1. **Derive `block.id` from the signed body only** (exclude consensus-assigned fields such as
   `validationTimestamp`), so those fields cannot mint distinct blocks — then they may safely be
   excluded from the signature; or
2. **Carry `validationTimestamp` as a sibling of `txData`, never inside it** (the ledger reads it
   as a second input and dedups on the signed-body hash), so the signed body the ledger verifies
   is byte-identical to what the originator signed.

Both touch `block.js`, ledger dedup, and cross-node determinism, so neither rides in on a tooling
commit. Until one is made and audited, **ledger-side re-verification stays OFF in production**
(the `getPublicKeyByAddress` lookup is deliberately not wired into the `Ledger`), and consensus
remains the single verification point. This is the genuine, current posture — not a silent gap.

## Why the devnet drives the direct path

`LocalDevnet` submits signed txs straight to `ledger.addTransaction` (not through consensus
finalization), because that path verifies the tx as-signed and works. This keeps the devnet a
real, verifiable local network today while defect (c) — the only remaining consensus→ledger
verification seam — is an explicit, documented, audit-scoped decision.
