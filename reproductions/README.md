# XMBL reproductions — auditor-runnable proofs of each module's headline claim

Each file here is a **self-contained reproduction**: it imports the module's REAL code (the same
`@xmbl/*` workspace packages that ship), exercises it to reproduce one headline claim, prints a
transcript an auditor reads, and **exits non-zero if the claim fails** — so every reproduction is
also a regression test in the `npm run test:protocol` hard gate.

This is what "reproducible in a miniapp" means for a protocol module (see `MODULE-STATUS.md`): a
content-addressed, one-command reproduction of the claim. Protocol claims (reentrancy, conservation,
metering, soundness) are reproduced under `node` — the faithful environment for worker-thread
isolation and CPU metering, which cannot exist in a browser sandbox. App-render claims are
reproduced on the handoff browser surface instead (`apps/app-builder/miniapp/verify.mjs`).

Run one:

```
node reproductions/contracts-reentrancy.mjs
```

Run all (and everything else in the gate):

```
npm run test:protocol
```

Each reproduction prints a **content address** — a SHA-256 over its own source plus the contract
sources it compiles — so a reviewer can confirm the exact bytes that produced the transcript.

| Reproduction | Module | Claim reproduced |
|--------------|--------|------------------|
| `agentic-contract-e2e.mjs` | `packages/contracts` + `identity` + `state-machine` | A gated agentic contract is hosted and USED with every function (machine-checked against the compiler's WASM exports) through the real root→coordinator→agent delegation chain; XMBL state is observed updating at every surface (contract fields, the Verkle root, the UTXO ledger), every unauthorized/out-of-scope/replayed/revoked/value-violating call leaves the root unmoved, each committed change is Verkle-provable, and the transition is deterministic across independent nodes. |
| `three-nodes.mjs` | `core` + `consensus` + `cubic-ledger` + `state-machine` | Three full nodes given the same typed set in different orders, with duplicates and forgeries, converge: the block set always, and under agreed seal boundaries the cubes, the cube `set_digest` and the state root too |
| `core.mjs` | `core` | A node proves the code it is executing (a digest of the loaded @xmbl modules, signed into every reading), refuses to produce while behind the published version, and resumes cleanly |
| `identity.mjs` | `identity` | An address certifies itself from its public key; a signature binds every field but `sig`/`publicKey` — including a slipped-in extra; a crossed keypair is detectable locally |
| `cubic-ledger.mjs` | `cubic-ledger` | Same anchor set → same chain in any order; a rebuild preserves what the set does not describe; a rebuild that would empty the chain is refused; a forgery cannot evict the datum it impersonates |
| `state-machine.mjs` | `state-machine` | The verkle root is a pure function of the applied set, a divergent node converges on adopting it, and the root plus the applied count survive a restart |
| `consensus.mjs` | `consensus` | The operator's order — can it happen, is the xid correct, is the placement right — with the first failing stage named in every refusal |
| `storage-compute.mjs` | `storage-compute` | A guest that loops forever is killed at the operator's deadline and still billed at the maximum; an genuine job is metered; custody is proved from the shard's bytes |
| `networking.mjs` | `networking` | Two real libp2p nodes dial by peer id and a published message arrives intact — the transport every convergence argument assumes |
| `lng.mjs` | `lng` | One source: the interpreter and the WASM backend agree call for call, the Solidity output is real, and non-determinism is a compile-time refusal |
| `contracts-reentrancy.mjs` | `packages/contracts` | A called contract never runs nested inside its caller's frame, so classic reentrancy is inexpressible by construction. |

## Browser-surface reproduction (app render, not a Node protocol run)

The contract **builder + lifecycle** — build a contract visually or in code → run every
entrypoint in a test mode → derive its content-addressed identity and deploy a live instance —
is reproduced not under `node` but on the handoff browser surface, because that IS the claim (a
usable miniapp), and the reproduction is the artifact a publish uploads (live at
`handoff.lol/app/xmbl/contract-lab`). It lives at `apps/app-builder/miniapp/contract-lab.{js,html}`
plus `samples.js` (the **XMBL Contract Lab** miniapp — a Visual builder and a Code editor over one
AST-round-tripped model, a Test panel whose state tiles flash per write, and a Deploy button that
commits a live content-addressed instance). Its five worked examples cover **every call type the
host-state backend compiles** (state writes, getters, every arithmetic/bitwise/shift op,
comparisons, a branch, an `~event`+`~emit`, a `~private` field, a counted `~for` loop).
`apps/app-builder/miniapp/verify-contract-lab.mjs` proves it in three phases: (1) functionality —
every entrypoint of every sample EXECUTED and asserted (38 assertions across 25 entrypoints,
including the revert cases); (2) source→visual-model→source round-trip (5/5); (3) both handoff
surfaces (opaque-origin iframe + shadow-DOM `renderApp`) build→test (a call updates a state
tile)→deploy, with the id the page derives in-browser byte-identical to `@xmbl/contracts`'
node-side `contractId`. Test mode runs the REAL compiled WASM in-page (`WebAssembly.instantiate`
over a faithful copy of the XCL byte-pointer ABI), but is NOT the production execution path — the
worker-isolated, metered, Verkle-committed, delegation-gated path is the headless
`agentic-contract-e2e.mjs` above. Build + verify:

```
npm run build:contract-lab -w apps/app-builder && npm run verify:contract-lab -w apps/app-builder
```

Unlike the Node reproductions above, this one is **not** in the `npm run test:protocol` hard
gate: it needs a built `dist-contract-lab/` bundle and a chromium binary (Playwright), so it is
run on demand by the command above rather than on every gate run. A regression in
`contract-lab.{js,html}` is therefore caught only when that command is re-run — re-run it after
any edit to those files.
