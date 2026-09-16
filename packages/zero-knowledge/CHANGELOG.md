# @xmbl/zero-knowledge

## 0.1.11

### Patch Changes

- Return every `@xmbl/*` protocol package to ONE version line (0.1.11) after a night of per-package
  hotfix publishes (cubic-ledger reached 0.1.10 while zero-knowledge sat at 0.1.1, crates at 0.1.0).

  Changes since the last unified line (0.1.0), carried as one PATCH line — 0.1.x stays the pre-mainnet line until the ⛔ AUDIT gates close:

  - cubic-ledger: block ids address CONSENSUS CONTENT (`consensusBody`) instead of the whole tx envelope; an
    anchor's `hash` must be a sha-256 digest; invalid txs are evicted for good (`evict`, `evicted:` keyspace);
    legacy envelope-keyed rows converge to content ids on the next boot; a canonical rebuild preserves every
    non-anchor block and reports what it wiped; `ready()` is the boot join point. `capabilities()` (hardcoded
    flags) is gone; `census.mjs` (an operator one-off) no longer ships in the tarball.
  - consensus: a content-addressed type-6 value tx is admitted on its content address (it carries no in-body
    signature by design); a malformed anchor is refused at the door by the ledger's own `validateTransaction`;
    `finalizeTransaction` preserves the signed `id`.
  - identity: one canonical `signingMessage`; `signingStatus()` / `verifySigning()`; `Identity.fromPrivateKey`
    (a stub that only threw) is removed.
  - state-machine: the verkle trie is rebuilt on load; diffs are keyed by content identity; `ready()`.
  - networking: self-elected circuit-relay server; NO_FATAL transport tolerance; throttled bootstrap warnings.
  - storage-compute: `CoordinateDelivery` (broken: `require` in ESM, keyed on the public key) is removed.
  - core: ships the node daemon as the `xmbl-node` bin; the control socket implements the coordinator
    contract (`xsc`, `submit_batch`, `ledger_capabilities`, `identity_status`, a signed `chain` claim, honest
    `submit_tx` rejections) and reports the RUNNING versions; boot waits for the stores.
  - every package exports a load-time `VERSION`.
  - lng: ships its BROWSER build — `dist/lng.browser.js` (`@xmbl/lng/browser`), one dependency-free ES module
    generated from the same `src/*.js` the node runs and byte-checked by the gate (same surface, same bytes, runs
    with no Node globals); the sources no longer assume `process`/`Buffer`.
