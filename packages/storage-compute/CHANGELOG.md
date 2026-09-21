# @xmbl/storage-compute

## 0.1.14

### Patch Changes

- **Every prebuilt binary was broken; all four causes are fixed.** `gh release list` returned
  nothing for any version of this repo. The release workflow gated its artifacts job on the
  crates.io job, which had no token from the first tag onward, so packaging was SKIPPED on every
  release ever cut — and underneath that, all three packaging jobs would have failed anyway:

  - **desktop** — `packages/desktop-app` is `"type": "module"`, so the CommonJS
    `electron-builder.config.js` threw on load and electron-builder fell back to a `build` key that
    does not exist: appId, targets, output directory and file globs were all dead. Renamed `.cjs`
    and passed explicitly. `electron` was also a runtime dependency (electron-builder refuses to
    package at all) and npm workspaces hoist it out of the project, so the version could not be
    computed. Both fixed, with the author/maintainer fields `deb` and `AppImage` require, both
    target architectures for mac/win/linux, and the `deb` target the workflow always globbed for.
  - **web** — `apps/app-builder/vite.config.js` aliased `buffer` into the app's own
    `node_modules`, which npm workspaces hoist to the root, so `vite build` died with ENOENT. Two
    Vue templates also carried `:id="@xmbl/identity"`, which is not a JavaScript expression.
  - **extension** — `@xmbl/lng`'s exports map had no `browser` condition, so bundlers resolved the
    node entry, which reads its own `package.json` through `node:fs` at module scope. **`@xmbl/lng`
    now declares `browser` -> `dist/lng.browser.js` in `exports`**, which is the one change in this
    release that affects consumers: a bundler targeting the browser now gets the prebuilt bundle
    (same export surface, including `VERSION`) instead of failing on `node:fs`.

## 0.1.13

### Patch Changes

- **SECURITY — the AIR zero-knowledge path leaked the entire secret trace.** Reported against
  0.1.12 and reproduced: the batching challenges `alpha` and `beta` are public and the composition
  `C(x) = alpha*u + beta*v` is an `F_p^4` element over two base-field unknowns, so every FRI opening
  was four equations in two unknowns. Solving two limbs for `v` gives `col'(x)` directly, and the
  `2*nq` layer-0 openings interpolate the blinded trace column — row 0 IS the witness. It returned
  the secret exactly, in about a second. The `(x^T - 1)` blind could not help: it is sized for the
  `2*nc` direct openings and vanishes on the trace domain by construction.

  The composition is now MASKED before FRI sees it: a uniformly random extension-valued polynomial
  `M` of degree `< K` is committed first, `gamma` is drawn from a transcript that includes its root,
  and FRI runs on `C + gamma*M`. Each opening is four equations in six unknowns. The verifier opens
  `M` against its own root at the consistency points. A mask that is not of degree `< K` would pin
  `gamma` to one value out of ~2^124, so masking cannot hide a false statement.

  `setup` now doubles `K` until it exceeds everything the transcript reveals
  (`nq*(log2 K + 1) + nc`, plus margin): `K = 2048`, `N = 16384`. `nc` is raised 16 -> 40, because
  each consistency point is `-log2(K/N) = 3` bits and `nc = 16` was a ~48-bit check behind a
  ~100-bit FRI. Coset evaluation is now an NTT, so proving is faster than 0.1.12 despite the larger
  domain. **PROOFS FROM 0.1.12 DO NOT VERIFY ON 0.1.13** — the proof carries new commitments
  (`rootM`, `rootD`) and the derived parameters moved.

  `xzk` (the cube-curve statement) was attacked the same way and survives: the committed curve is
  fully recoverable from its FRI openings, but `Pt = P + Z_R*B` with `B` uniform of degree 18 over a
  witness quotient of degree 1, so the same proof is carried by a 2-parameter family of witnesses.

  The attack is now a permanent check in `air.test.mjs` and `xzk.test.mjs`.

## 0.1.12

### Patch Changes

- Updated dependencies
  - @xmbl/identity@1.0.0

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
    one invalid entry in a batch no longer discards the genuine transactions behind it.
  - consensus: a content-addressed type-6 value tx is admitted on its content address (it carries no in-body
    signature by design); a malformed anchor is refused at the door by the ledger's own `validateTransaction`;
    `finalizeTransaction` preserves the signed `id`.
  - identity: one canonical `signingMessage`; `signingStatus()` / `verifySigning()`; `Identity.fromPrivateKey`
    (a stub that only threw) is removed.
  - state-machine: the verkle trie is rebuilt on load; diffs are keyed by content identity; `ready()`.
  - networking: self-elected circuit-relay server; NO_FATAL transport tolerance; throttled bootstrap warnings.
  - storage-compute: `CoordinateDelivery` (broken: `require` in ESM, keyed on the public key) is removed.
  - core: ships the node daemon as the `xmbl-node` bin; the control socket implements the coordinator
    contract (`xsc`, `submit_batch`, `ledger_capabilities`, `identity_status`, a signed `chain` claim, genuine
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
  - storage-compute: THE ERASURE CODER RETURNED CORRUPTED DATA WITHOUT SAYING SO. `StorageShard.decode`
    recovers a lost data shard by XOR-ing its parity group, and XOR parity recovers AT MOST ONE loss per
    group — but when two members of one group were missing it filled the hole with zeros and returned the
    buffer as if decoding had succeeded, with no error, no flag and no short read. MEASURED on k=4, m=2:
    losing data shards 0 and 2 handed back a buffer that differed from the original and nothing downstream
    could tell. Two independent causes are fixed: the group is now checked for completeness before the XOR
    is trusted, and `m` — the encoding's PARITY DEGREE — is carried on every shard as the new optional
    `parityCount` field instead of being inferred from however many parity shards happened to survive (that
    inference was wrong exactly when a parity shard was among the losses: given data 0,1,2 and parity 4 only,
    the inferred m was 1, the recovery group became {0,1,2,3} instead of {0,2}, and decode returned wrong
    bytes). An unrecoverable decode now THROWS and names every missing shard. Proven exhaustively over all
    63 non-empty subsets of a k=4/m=2 encoding: every subset either decodes to the exact original or throws,
    and none returns wrong bytes. COMPAT: `parityCount` is additive and optional, so a shard written by an
    older node reads back fine — a new node treats it as legacy and REFUSES parity recovery rather than
    guessing, which fails loudly where the old code failed silently. Shard metadata persists as JSON
    (`meta:<id>`), so an old reader ignores the extra field.
  - core: a boot crash. `Config._applyEnvOverrides()` assigned into `config.network` / `config.logging`
    without creating them, so a node started with `XN_PORT` or `LOG_LEVEL` set against a config that omitted
    those sections died on `undefined.port` before it could log why. The sections are created on demand.
  - the protocol gate is 75 suites (was 67), and line coverage across the twelve protocol packages is 85.5%
    (was 80.6%). `scripts/coverage-report.mjs` is the instrument: `NODE_V8_COVERAGE` + a V8-range reducer,
    since nothing in the tree measured coverage at all. Ten protocol files that no suite had ever loaded now
    have one; four remain, all process entry points.
  - NODE 22 IS NOW DECLARED, because it was already REQUIRED. Every published package gains
    `engines: { node: ">=22" }`; the workspace root's `">=20"` was simply false. `@xmbl/identity` imports
    `node:sqlite` (Node 22.5+) for the durable nonce registry, `@xmbl/storage-compute` meters jobs with
    `process.threadCpuUsage` (22.10+), and libp2p's own dependency chain calls `Promise.withResolvers`
    (22.0). On Node 20 a consumer installed cleanly and crashed at import instead of being told at install
    time. MEASURED: the protocol gate scores 54/75 on Node 20.20.2 and 75/75 on Node 22 — the twenty-one
    failures were the runtime, not the code. CI and the release workflow now run Node 22 as well.

### Patch Changes

- Updated dependencies
  - @xmbl/identity@0.1.11
