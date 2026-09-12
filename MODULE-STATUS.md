# MODULE-STATUS — every XMBL unit: working · tested · reproducible in a miniapp

Standing requirement (operator, 2026-09-12): **no stop until every module in `xmbl-mainnet` is
working, tested, and reproducible in a miniapp.** This file is the durable checklist that defines
"done" for that program and survives context compaction. It is enforced by
`tests/module-status.test.mjs`, which discovers every package/app/crate from the filesystem and
**fails the build if any unit has no row here** — so a unit can never be added or forgotten without
being accounted for (the same filesystem-discovering pattern as `crates/crate-status.test.mjs`).

The three states are **independent** and each is claimed only when true:

- **Working** — the real code path runs and produces correct output (not a stub, not a throw).
- **Tested** — a self-contained `*.test.mjs`/suite asserts the behavior and exits non-zero on
  failure; "✓ (N, gate)" means the suite is in the `npm run test:protocol` hard gate with N files.
- **Reproducible in a miniapp** — a **self-contained, content-addressed reproduction bundle** that
  exercises the module's REAL code and lets an auditor reproduce the claim with one command,
  verified by a harness in the `apps/app-builder/miniapp/verify.mjs` pattern. For modules that are
  **Node-only by construction** (worker-thread isolation + CPU metering; real sockets) the bundle is
  a Node reproduction run with `node`, not a browser-surface bundle — rewriting those to the browser
  surface would delete the very isolation/metering property the module exists to provide. This
  Node-vs-browser split is an operator-reversible interpretation of "miniapp"; flag if wrong.

Legend: ✓ done · ◐ partial · ✗ not yet · n/a not applicable · ⛔ blocked on external audit (see
`MAINNET-GATES.md`).

---

## Protocol packages (JS/WASM reference implementation)

| Unit | Working | Tested | Miniapp reproduction | Notes |
|------|---------|--------|----------------------|-------|
| `packages/core` | ✓ | ✓ (3, gate) | ✗ | boot/profile gate; `AUDIT_GATES_OPEN` refuses mainnet boot until ⛔ gates close |
| `packages/identity` | ✓ | ✓ (5, gate) | ✗ | `CubicCurveSource` is the real construction (`secure:false, audited:false` until ⛔ audit); delegation/seal present |
| `packages/cubic-ledger` | ✓ | ✓ (7, gate) | ✗ | UTXO cube-of-cubes ledger |
| `packages/state-machine` | ✓ | ✓ (3, gate) | ✗ | Verkle state machine |
| `packages/consensus` | ✓ | ✓ (3, gate) | ✗ | |
| `packages/storage-compute` | ✓ | ✓ (3, gate) | ✗ | **Node-only by construction** — worker isolation, `process.threadCpuUsage`, killed-job billing, node:sqlite |
| `packages/zero-knowledge` | ✓ | ✓ (1, gate) | ✗ | FRI experimental/unaudited ⛔; must not gate consensus/ledger/sealing |
| `packages/networking` | ◐ | ✓ (1, gate) | ✗ | **Node-only by construction** — discovery/gossip under NAT is ⛔ integration/audit |
| `packages/lng` | ✓ | ✓ (8, gate) | ✗ | LNG→WASM compiler + XCL compose backend; EVM backend output asserted but not deployed |
| `packages/contracts` | ✓ | ✓ (5, gate) | ✓ | XCL agentic-contract runtime (ContractHost); `reproductions/agentic-contract-e2e.mjs` hosts a gated contract, drives EVERY entrypoint (machine-checked vs WASM exports) through the real root→coordinator→agent chain, and proves state updating at every surface (fields, Verkle root, UTXO ledger) with fail-closed refusals leaving the root unmoved, Verkle-provable changes, conservation, and cross-node determinism; `reproductions/contracts-reentrancy.mjs` covers reentrancy-by-construction |

## Tooling / client packages

| Unit | Working | Tested | Miniapp reproduction | Notes |
|------|---------|--------|----------------------|-------|
| `packages/cli` | ◐ | ✗ (11, NOT in gate) | ✗ | 11 test files exist but are not run by the hard gate — unenforced |
| `packages/browser-extension` | ◐ | ✗ (3, NOT in gate) | ✗ | not run by the hard gate |
| `packages/desktop-app` | ◐ | ✗ (2, NOT in gate) | ✗ | not run by the hard gate |
| `packages/simulator` | ✗ | ✗ (0) | ✗ | **0 tests**; behavior unverified |
| `packages/visualizer` | ✗ | ✗ (0) | ✗ | **0 tests, no `index.js`**; status unknown |

## Apps

| Unit | Working | Tested | Miniapp reproduction | Notes |
|------|---------|--------|----------------------|-------|
| `apps/app-builder` | ✓ | ◐ (2, vitest/playwright, NOT in gate) | ◐ | has the `miniapp/` harness (`verify.mjs` two-surface); `dist-miniapp/` not built in tree |
| `apps/visualizer` | ◐ | ✗ (0) | ✗ | |

## Rust crates (crates.io targets)

All eight are **NON-PRODUCTION pre-mainnet stubs** (labeled in each `src/lib.rs`, guarded by
`crates/crate-status.test.mjs`, 9/9). They have NOT reached parity with the JS reference and are
blocked on that parity work before any crates.io consumer can rely on them.

| Unit | Working | Tested | Miniapp reproduction | Notes |
|------|---------|--------|----------------------|-------|
| `crates/xmbl-core` | ✗ stub | label-guarded | n/a | parity-with-JS pending |
| `crates/xmbl-identity` | ✗ stub | label-guarded | n/a | parity-with-JS pending |
| `crates/xmbl-cubic-ledger` | ✗ stub | label-guarded | n/a | parity-with-JS pending |
| `crates/xmbl-state-machine` | ✗ stub | label-guarded | n/a | parity-with-JS pending |
| `crates/xmbl-consensus` | ✗ stub | label-guarded | n/a | parity-with-JS pending |
| `crates/xmbl-storage-compute` | ✗ stub | label-guarded | n/a | parity-with-JS pending |
| `crates/xmbl-zero-knowledge` | ✗ stub | label-guarded | n/a | parity-with-JS pending |
| `crates/xmbl-networking` | ✗ stub | label-guarded | n/a | parity-with-JS pending |

---

## Open work to close this program (in priority order)

1. **Miniapp reproductions** — no protocol module yet has an auditor-runnable reproduction bundle;
   only `apps/app-builder` has the `miniapp/` harness, and it demonstrates app-render, not protocol.
   Build one reproduction per module in the `verify.mjs` pattern (browser surface where the module
   is browser-capable; Node reproduction for `storage-compute`/`networking`).
2. **`simulator`** — 0 tests; add a suite and put it in the hard gate, or retire the package.
3. **`visualizer` (package)** — 0 tests, no `index.js`; define its contract or retire it.
4. **Enforce `cli`/`browser-extension`/`desktop-app` tests** — they exist but the hard gate never
   runs them, so regressions land silently; add them to `test:protocol`.
5. **`networking`** — NAT discovery / gossip fan-out is a ⛔ integration/audit gate.
6. **Rust crate parity** — eight stubs must reach JS-reference parity (or stay labeled non-production).
