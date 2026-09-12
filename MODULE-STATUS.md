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
| `packages/identity` | ✓ | ✓ (5, gate) | ✗ | `CubicCurveSource` is the real construction (`secure:false, audited:false` until ⛔ audit); delegation/seal present. Cubic-LWE is additively HOMOMORPHIC (`addCiphertexts`, gate-tested over 50 trials) and **now CONTRACT-WIRED**: `@xmbl/contracts`' `heHost` exposes it as `env.xmbl_he_add`, so a contract can combine ciphertexts it cannot read — DECRYPTION stays off-host (needs the secret key), reproduced by `reproductions/contract-he.mjs` |
| `packages/cubic-ledger` | ✓ | ✓ (7, gate) | ✗ | UTXO cube-of-cubes ledger |
| `packages/state-machine` | ✓ | ✓ (3, gate) | ✗ | Verkle state machine |
| `packages/consensus` | ✓ | ✓ (3, gate) | ✗ | |
| `packages/storage-compute` | ✓ | ✓ (3, gate) | ✗ | **Node-only by construction** — worker isolation, `process.threadCpuUsage`, killed-job billing, node:sqlite |
| `packages/zero-knowledge` | ✓ | ✓ (1, gate) | ✓ | FRI experimental/unaudited ⛔. **Now CONTRACT-WIRED** as an opt-in host call: `@xmbl/contracts`' `zkHost` deploy flag exposes `verify` to a deployed contract as a synchronous `env.xmbl_zk_verify(x_ptr, y_ptr)` (proof + public points chain-staged for a deterministic verdict; the guest supplies the asserted coordinate from its own memory, so the verdict binds to the contract's state, not a host flag — `src/xcl/abi.js` `HOST_ABI_ZK_INIT_SOURCE`). Reproduced by `reproductions/contract-zk.mjs` (hard gate): a contract gates a Verkle write on a real coordinate/curve proof — the root MOVES on a verified coordinate, is UNMOVED on a tampered one, a malformed proof refuses without trapping, the unflagged import is denied, and two nodes converge to one root. Also covered by 4 `contract-host.test.mjs` cases (gate). **OPT-IN per contract and MUST NOT gate consensus/ledger/sealing** — a contract that does not opt in never touches it |
| `packages/networking` | ◐ | ✓ (1, gate) | ✗ | **Node-only by construction** — discovery/gossip under NAT is ⛔ integration/audit |
| `packages/lng` | ✓ | ✓ (8, gate) | ✗ | LNG→WASM compiler + XCL compose backend; EVM backend output asserted but not deployed |
| `packages/contracts` | ✓ | ✓ (5, gate) | ✓ | XCL agentic-contract runtime (ContractHost); `reproductions/agentic-contract-e2e.mjs` hosts a gated contract, drives EVERY entrypoint (machine-checked vs WASM exports) through the real root→coordinator→agent chain, and proves state updating at every surface (fields, Verkle root, UTXO ledger) with fail-closed refusals leaving the root unmoved, Verkle-provable changes, conservation, and cross-node determinism; `reproductions/contracts-reentrancy.mjs` covers reentrancy-by-construction; `reproductions/contract-zk.mjs` proves a contract USES xmbl's coordinate/curve zero-knowledge (`@xmbl/zero-knowledge`) to gate a Verkle write (opt-in `zkHost`, still ⛔ unaudited); `reproductions/contract-he.mjs` proves a contract homomorphically ADDS post-quantum cubic-LWE ciphertexts it cannot read and persists the encrypted aggregate (opt-in `heHost` → `env.xmbl_he_add`; decryption is exposed to no contract). **Executes guest bytecode via `storage-compute`, whose worker isolation is a ⛔ external-audit gate** — contracts' own logic is clean/reproduced but transitively rests on that audit |

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
| `apps/app-builder` | ✓ | ◐ (2, vitest/playwright, NOT in gate) | ✓ | `miniapp/contract-lab.{js,html}` + `samples.js` is the **XMBL Contract Lab** handoff miniapp (live at `handoff.lol/app/xmbl/contract-lab`, v2.2): a full contract **builder** — a **Visual builder** and a **Code** editor over ONE model (`parseToModel`/`modelToSource`, AST-round-tripped), a **Test** panel whose committed-state tiles flash as each call writes them (with per-call return value + `__events()` count), and a **Deploy** button that commits a live content-addressed instance and switches Test onto it. The v2.2 redesign adopts the **impeccable.style** system (Albert Sans + JetBrains Mono, oklch "paper" neutrals, KINPAKU gold spent sparingly as an LED on only the primary action / focus / live-and-flash indicators, PATINA teal for structure, a dark **instrument** Test console with LED readout tiles and key-cap Run buttons, physical cap-lift buttons and track-recessed inputs, hairline rules, no nested cards / icon tiles / soft-radius cards) and makes the builder intuitive: each statement reads as a plain-language sentence row (Set · field · to · expr / Return · the value / Emit · event / If · condition / Repeat · counter · from · to), operand boxes suggest every name in scope, statements are added by labeled **Set/Local/Return/Emit/If/Repeat** actions (no create-then-reclassify), and a live **Generated LNG** preview updates as you build. It inlines the REAL `@xmbl/lng` compiler and runs the compiled WASM in-page via `WebAssembly.instantiate` over a faithful copy of the XCL byte-pointer state ABI + word marshal (`abi.js`). Five worked examples (`samples.js`) cover **every call type the host-state backend compiles**: state writes, no-/single-/multi-arg calls, getters, every arithmetic (`+ - * / %` — over/underflow & div0 REVERT) / bitwise (`b& b| b^`) / shift (`b< b>`) op, comparisons (`== !== !< !>`), a ternary branch, an `~event`+`~emit`, a `~private` field, and a counted `~for` loop. `verify-contract-lab.mjs` proves it in three phases: (1) **functionality** — every entrypoint of every sample EXECUTED and asserted (38 assertions across 25 entrypoints, incl. revert cases), (2) source→visual-model→source **round-trip** (5/5), (3) **both handoff surfaces** (opaque-origin iframe + shadow-DOM `renderApp`) build→test (a call updates a state tile)→deploy (live instance) with the in-browser id byte-identical to `@xmbl/contracts` `contractId` in node. **Test mode ≠ production execution** (no worker isolation / metering / Verkle commitment / delegation gate — stated on screen); the full gated path is the headless `reproductions/agentic-contract-e2e.mjs`. Build+verify: `npm run build:contract-lab && npm run verify:contract-lab -w apps/app-builder`. **`verify-contract-lab.mjs` is NOT in the `npm run test:protocol` hard gate** — it needs a built `dist-contract-lab/` bundle and a chromium binary (Playwright), so it is run on demand; a regression in `contract-lab.js`/`samples.js` is caught only when the build+verify command above is re-run. The older `verify.mjs` two-surface harness (visual app builder) also remains, likewise out of the gate. |
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
