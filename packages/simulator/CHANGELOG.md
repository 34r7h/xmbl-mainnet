# Changelog

## 0.1.11

### Patch Changes

- Return every `@xmbl/*` protocol package to ONE version line (0.1.11) after a night of per-package
  hotfix publishes (cubic-ledger reached 0.1.10 while zero-knowledge sat at 0.1.1, crates at 0.1.0).

  Changes since the last unified line (0.1.0), carried as one PATCH line — 0.1.x stays the pre-mainnet line until the ⛔ AUDIT gates close:

  - cubic-ledger: block ids address CONSENSUS CONTENT (`consensusBody`) instead of the whole tx envelope; an
    anchor's `hash` must be a sha-256 digest; invalid txs are evicted for good (`evict`, `evicted:` keyspace);
    legacy envelope-keyed rows converge to content ids on the next boot; a canonical rebuild preserves every
    non-anchor block and reports what it wiped; `ready()` is the boot join point. `capabilities()` (hardcoded
    flags) is gone; `census.mjs` (an operator one-off) no longer ships in the tarball. A FORGERY CAN NO LONGER
    DELETE THE TRANSACTION IT IMPERSONATES: an invalid typed datum is evicted under a digest of its own bytes,
    never under the xid it claims (a datum fails `validateXid` precisely when that xid is somebody else's), and
    the anchor dedup key claimed before validation is released on every failure. Both doors are closed on BOTH
    entry points — `addTransaction` and `addSealedBatch`, the path a finalized transaction actually takes — and
    one invalid entry in a batch no longer discards the honest transactions behind it.
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
  - PROTOCOL (operator, 2026-09-16): every transaction is typed by its xid (tokens.json type codes; `micromineTx`/
    `validateXid`; untyped rows deleted on boot, skipped by a canonical rebuild; an anchor's wire tx carries `prior`);
    consensus validates in order — can it happen, is the xid correct, is the placement right (`validate.js`,
    `verifyPlacement`); block hashes are content-only so every node seals the same cubes.
  - ROLLOUT (operator, 2026-09-16): a node proves its version (`build` digest of the loaded code, signed into the
    `chain` claim; `release` op), suspends itself when behind the npm `latest` of @xmbl/core (no submits, validations
    or seals), installs the latest over the air and restarts (exit 75 under a supervisor).
  - lng: ships its BROWSER build — `dist/lng.browser.js` (`@xmbl/lng/browser`), one dependency-free ES module
    generated from the same `src/*.js` the node runs and byte-checked by the gate (same surface, same bytes, runs
    with no Node globals); the sources no longer assume `process`/`Buffer`.
  - lng: the `~bytes` BYTE-STRING TYPE reaches the WASM backend — a (pointer, length) pair on the operand
    stack, never a 256-bit word: a literal's bytes live in a data segment with a compile-time length, a runtime
    value (a UTXO id from `xmbl_input_id`) is host-written into fresh memory with its length in a local. A
    `~bytes` FIELD or PARAM is now REFUSED — committed state and the call ABI are both 32-byte words with
    nowhere to put a length, and until now both compiled SILENTLY as words. New opt-in host modes
    `compile(src, { crypto: true })` (`xmbl.mayo.verify` / `xmbl.cubic.verify`) and `{ utxo: true }` (the
    five-entry value ABI), so a contract written in LNG verifies a signature and spends a UTXO the caller
    presented. The value ABI's `-1` sentinel TRAPS instead of widening to 2^256-1. The typechecker refuses
    arithmetic/bitwise/ordering on `~bytes` and now walks `~contract` method bodies at all, which it never did.
    A contract with no byte literals emits a byte-identical, import-free module.

All notable changes to the `xsim` module will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this module adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
