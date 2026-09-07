# Mainnet readiness gates

Per-module, **verifiable** definition-of-done. A module is mainnet-ready only when every
gate in its row is checked. `[x]` gates are closed **in code, with a test that fails if the
property regresses**. `[ ]` gates are open; the note says what closes them. Gates that
require an **external audit** cannot be closed by this repo — they are marked ⛔ AUDIT and
block mainnet regardless of code state.

Run the hard gate locally: `npm run test:protocol` (also runs in CI with **no**
continue-on-error, and in the release workflow before any publish).

---

## `@xmbl/identity` — signatures & keys

- [x] MAYO signing path present and exercised (`identity.js` → `wasm-wrapper.js` → `mayo.wasm`).
- [x] Insecure `PlaceholderCurveSource` **DELETED** from the shipped package (class, export,
      and its domain constant removed). A zero-security curve source no longer exists in a
      package that publishes to npm; the abstract seam + `CubicCurveSource` are what remain.
      — *curve-source.js; identity/index.js*
- [x] No module asserts its own security: `CubicCurveSource.describe()` reports
      `secure:false, audited:false` until an audit closes the gate below. A `secure:true`
      self-claim was **removed**. — *curve-source.js*
- [ ] ⛔ AUDIT — MAYO is an **unaudited fork**. Pin the exact upstream commit, get the WASM
      build reproducible, and obtain third-party review of the port before value depends on it.
- [ ] ⛔ AUDIT — the **cubic-curve construction** (Cubic-SIG / Cubic-KEM, curves derived from
      the cube-of-cubes ledger) is novel and has **no external cryptanalysis**. No mainnet
      value may bind to it until audited. Until then it is classical-only (Shor-vulnerable) or
      experimental PQ; neither is a mainnet signer on its own.

## `@xmbl/storage-compute` — P2P storage + compute market

- [x] Untrusted WASM runs **off the host thread** on a terminable Worker; a synchronous
      infinite-loop guest is **killed by the deadline** (the old same-thread `Promise.race`
      timer could never fire). — *compute.js; compute.test.mjs*
- [x] **Deny-by-default imports**: a guest importing anything not on an explicit allow-list is
      rejected before instantiation. — *compute.test.mjs*
- [x] **Bounded memory**: a guest declaring unbounded or over-cap memory is rejected; imported
      memory is created with a hard maximum; V8 heap capped via `resourceLimits`. — *compute.test.mjs*
- [ ] Availability-proof soundness (`availability.js`) needs an adversarial test: a node that
      does **not** hold a shard must fail the probe. (Currently happy-path only.)
- [ ] ⛔ AUDIT — the compute market is a paid execution surface; the isolation model needs a
      security review (side-channels, resource accounting, worker escape) before untrusted pay.

## `@xmbl/zero-knowledge` — cube-curve state commitment (FRI)

- [ ] Currently additive/opt-in only (`core` `_setupZkCommit`, `XZK_COMMIT=1`) and **never
      consensus-load-bearing**. That guard is correct and must **stay** until the gate below.
- [ ] No conformance suite in the package (0 test files). Port the FRI soundness/completeness
      vectors and make them part of `test:protocol`.
- [ ] ⛔ AUDIT — experimental, unaudited FRI. Must not gate consensus, ledger, or sealing until
      audited. The `core` wiring already enforces "additive only" — do not remove that.

## `@xmbl/consensus` — user-as-validator, five-stage mempool, sealing

- [x] Ingress guard + invalid-eviction covered by node tests. — *ingress-guard, invalid-eviction*
- [ ] Byzantine test matrix: equivocating leader, withheld coverage, network partition →
      convergence or safe stall (no fork). Simulator has the pieces; wire as protocol tests.

## `@xmbl/state-machine` — Verkle virtual state machine

- [x] Every tx type reaches the tree; root is a cross-node commitment; **survives restart via
      diff replay**; cube-complete writes the root. — *apply-path, verkle-integration*
- [ ] Verkle proof verification against an **independent** verifier (not the same code that
      produced the proof).

## `@xmbl/cubic-ledger` — blocks → faces → cubes

- [x] Deterministic placement, cross-node cube-sync convergence, membership persistence, golden
      micromine vector — all covered. — *6 suites*
- [ ] Adversarial sync: a peer feeding an inconsistent block set must be rejected, not merged.

## `@xmbl/networking` — libp2p P2P

- [ ] No test files in-package. Needs: discovery under NAT, gossip fan-out, routing-table
      poisoning resistance. Exercised indirectly by the simulator only today.

## `@xmbl/core` — node runtime

- [x] Orchestrates the modules; ZK kept strictly additive.
- [x] **Mainnet boot is refused while audits are open.** `start()` throws on
      `XMBL_PROFILE=mainnet` whenever `AUDIT_GATES_OPEN` is true (its default). There is NO
      env override — the only way to open mainnet is the reviewed source change that flips
      `AUDIT_GATES_OPEN` to false once the ⛔ AUDIT gates below are closed. — *core/index.js;
      boot-gate.test.mjs*

---

## Cross-cutting (all modules)

- [ ] ⛔ AUDIT — one external security review of the protocol as a whole before mainnet.
- [ ] Reproducible builds for the WASM artifacts (`mayo.wasm`) pinned to source commits.
- [ ] The eight Rust crates are primitive stubs (11 unit tests); they must reach parity with the
      JS reference or be labeled non-production in their crate docs before crates.io consumers
      rely on them.
- [ ] Version `0.x` communicates pre-mainnet. Do **not** cut `1.0.0` until every ⛔ AUDIT gate
      above is closed.
