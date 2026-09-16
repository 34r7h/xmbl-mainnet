# Closing 0.1 for mainnet — everything except the external reviews

Plain English. Written 2026-09-16 against `MAINNET-GATES.md` (14 of 62 gates open, 7 of them
external ⛔ audits that are out of scope here), `MODULE-STATUS.md`, `DEVNET-SEAM-FINDING.md`,
`docs/audits/2026-09-16-block-store-audit.md`, and the live fleet inventory handoff-claude gave.

Two lists. **Part A** is the questions only the operator can answer — each is a fork where either
answer is buildable, but building the wrong one is wasted work. **Part B** is the work that needs
no decision — it can start now, and each item says how it is proved closed (a count, never a log).

Nothing here closes an ⛔ AUDIT gate. `AUDIT_GATES_OPEN` in `packages/core/index.js` stays `true`,
and a node keeps refusing `XMBL_PROFILE=mainnet`, until the seven external reviews come back.

---

## Part A — decisions (answer yes/no or pick a letter)

### A1. The MAYO signing binary — DECIDED 2026-09-16
**Decision.** Neither (a) locate-and-pin the lost Emscripten nor (b) rebuild-and-adopt fresh
bytes. MAYO is to be **adapted to the XMBL curve's crypto coordinate system** — the cubic
geometry behind `CubicCurveSource` (block coordinates, plane normals, the derived parameter
block) — **to reduce its computation requirements**. That is the `'mayo-cube'` scheme slot in
`packages/identity/src/wasm-schemes.js`, which today still resolves to the baseline artifact
("seams now, MAYO math later").
**What follows.** The shipped `mayo.wasm` (`e20b15f0…`) is not rotated; it stays the baseline
`'mayo'` scheme until the adapted build lands. The byte-reproducibility requirement (T2.1-b)
transfers to the adapted build, which pins its Emscripten version in its first commit, so "can you
rebuild the bytes you ship?" is answered yes from day one. The adapted scheme is a new construction
and joins the cubic-curve ⛔ external review — it cannot become a mainnet signer on the existing
MAYO review alone. Work item: **B9**.

### A2. The browser copies of the LNG compiler — DECIDED 2026-09-16
**Decision.** Not a question: LNG is a module, every user of it imports the module and gets the same
thing. **Done:** `@xmbl/lng` ships its browser build — `dist/lng.browser.js`, one dependency-free ES
module generated from the same `src/*.js` the node runs — as `@xmbl/lng/browser`; the gate rebuilds
it and fails on a byte of drift, and proves the same programs give the same bytes on both sides
(34 checks). The four hand copies in the handoff repo (`lng-{interp,evm,wasm,typecheck}.js`) are the
consumer's to delete for one import line — sent to handoff-claude as a requirement. **Proof:** the
handoff repo counts 0 `lng-*.js` ports and 1 `import … from '@xmbl/lng/browser'`.

### A3. Is the EVM backend a supported deployment target, or an export?
**Why it's open.** LNG can transpile a contract to Solidity that `solc` compiles, but we have
never deployed the output to an EVM chain or had it reviewed.
**Options.** (a) Deploy the sample contracts to a public EVM testnet (needs a funded testnet key
and an RPC URL from you) and record the addresses + a call round-trip as the reproduction. (b)
Declare the EVM backend an *export format* (for reading/porting), not a supported runtime, and
close the gate as out of scope in the README.
**Recommendation.** (b) for the 0.1 line; (a) is a product decision, not a readiness one.

### A4. Do we want a real "XCL vs Ethereum" resource comparison?
**Why it's open.** The README's "≥ Ethereum at a fraction of the resources" claim has a measured
XCL side (real CPU-ms and peak memory per job) but no EVM side to compare against — that needs an
EVM execution engine in this repo (dev-dependency only, e.g. `@ethereumjs/evm`) to run the same
computation and measure it.
**Options.** (a) Add the engine as a dev-only benchmark dependency and publish the numbers. (b)
Drop the comparative wording; keep "measured, priced from real CPU time."
**Recommendation.** (b) now, (a) when marketing needs the number. Closes T6.2 remainder (d).

### A5. Signature domain: may consensus stop editing the body a user signed?
**Why it's open.** When consensus validates a transaction it writes `validationTimestamp` *into*
the transaction object the user signed, so the ledger can never re-verify that signature later
(the bytes changed). Ledger-side re-verification is therefore OFF in production; consensus is
the only place a signature is checked. `DEVNET-SEAM-FINDING.md` defect (c).
**What closes it.** Carry `validationTimestamp` *beside* the transaction (ledger reads it as a
second input), and define the consensus body for every transaction type in `tokens.json` (today
only anchors and type-6 have one), so a block's identity never depends on fields the user did not
sign. Then wire `getPublicKeyByAddress` into the daemon's `Ledger` so the ledger re-verifies every
signed transaction as a second, independent check.
**Ask.** Approve this change to the block format (it changes how blocks are identified, so it
ships with A7's re-anchor, not on its own). **Proof:** the devnet test that today *pins* the seam
as broken flips to asserting the full consensus→ledger path re-verifies; a tampered tx is refused
at the ledger.

### A6. Should the broker's canonical anchor feed carry the anchors' mined identity?
**Why it's open.** Every node can rebuild its ledger from the broker's canonical anchor list, but
that list carries no `xid`/`nonce`, so every rebuilt anchor comes back untyped (16,313 of 17,628
on the audited node). The receiving code is correct; its input is empty. That feed is
handoff-claude's.
**Ask.** Authorize me to make it a requirement of the fleet contract (handoff-claude adds `xid` +
`nonce` to `/api/v1/xmbl/anchors/canonical`). **Proof:** after a rebuild, anchors with an xid ==
anchors in the feed.

### A7. One coordinated re-anchor so every node builds the same cubes?
**Why it's open.** Nodes agree on *blocks* now (content ids), but faces and cubes are placed by
`hash`, which still covers the envelope (who relayed it, their signature), so two honest nodes
holding identical anchors still seal different cubes. Making `hash` content-only is a wire-format
change: old and new nodes cannot verify each other's cubes, so it needs the whole fleet to rebuild
from canonical at the same moment (every node runs `rebuild_ledger` once on the new version).
**Ask.** Schedule it with the 0.1.11 bundle rollout (a) or defer (b). Coupled with A5.
**Proof:** `list_cube_keys` returns the same `set_digest` on every live node.

### A8. Should the fleet run `@xmbl/core` instead of a copy of it?
**Why it's open.** The coordinators run `xmbl-slim-node`, which vendors a copy of `core/` and a
copy of `node.js`; both had drifted from this repo in both directions. As of today `@xmbl/core`
ships the daemon (`xmbl-node`) and the coordinator's full control-socket contract, so the bundle
can depend on the package. That is handoff-claude's repo.
**Ask.** Authorize me to send that as a requirement (bundle = `@xmbl/core@^0.1.11` + config, no
vendored core). **Proof:** `status.versions.core` reported by every node; `core/` absent from the
served tarball.

### A9. The two coordinators with crossed keypairs, and the one that fails its identity query.
**Why it's open.** `xmb7be5670…` and `xmba330f396…` hold a public key and a private key from
different keypairs: they run, look healthy, and publish no chain block (the broker refuses their
signature). `413e090aee97` fails its identity query at boot. Nothing in code fixes key files on
someone else's disk; the new `identity_status` op names the fault from the node itself.
**Ask.** Who owns those three boxes — you, or another handoff user? (`usr_fb2446eb53` owns the two
crossed ones per the broker.) The fix is `handoff xmbl` re-provisioning the keypair on-box.

### A10. `packages/visualizer`: retire it?
**Why it's open.** Two visualizers exist: `apps/visualizer` (the Explorer, the real one) and
`packages/visualizer` (an older Vue/three.js bridge, 0 tests, marked private). Two of the same
thing is drift waiting to happen.
**Ask.** Retire `packages/visualizer` (a) or give it a contract and tests (b). Recommendation: (a).

### A11. `xmbl_lwe_decrypt`: mark it "won't build"?
**Why it's open.** Contracts can *add* encrypted values homomorphically but cannot decrypt —
decryption needs a secret key that no contract may hold. Half of gate T6.1-d is that host call.
**Ask.** Confirm it is closed as *won't build* (decryption stays off-host, by design). Then T6.1-d
closes with B1 alone.

### A12. Do the Rust crates need to be real for 0.1?
**Why it's here.** The eight `xmbl-*` crates are labeled NON-PRODUCTION stubs (the gate accepts the
label). Porting the JS reference to Rust is months of work and not required by any gate.
**Ask.** Confirm crates stay labeled stubs for 0.1 (recommended), so nobody waits on them.

---

## Part B — work with no decision attached (starts on "go")

### B1. The LNG byte-string type — the one missing language feature
The WASM backend's only value is a 32-byte word, so LNG source cannot pass a *message* or a *UTXO
id* (both are byte strings) to the host. That single gap keeps three things hand-encoded: calling
the signature verifiers from contract source (T6.1-d), calling `xmbl_utxo_*` from source (T6.2 a),
and it forces `~u256` amounts to i64 in the UTXO proof contracts. Work: surface syntax + typechecker
+ a memory layout both backends lower. **Proof:** a contract written in LNG (not by hand) verifies
a MAYO signature and spends a UTXO on the real host; `compile-wasm` and `contract-host` suites gain
those cases.

### B2. Full-stack multi-node reproduction under adversarial timing (T6.2 c)
Three node *subsystems* converge today; three full nodes (network + consensus + ledger + state)
under the simulator's chaos do not yet have a reproduction. Work: `reproductions/three-nodes.mjs`
booting three `XMBLCore` in-process with the chaotic simulator, asserting one state root and one
cube `set_digest` at the end. **Proof:** roots equal, digests equal, across N chaotic runs.

### B3. Miniapp reproductions for the eight modules still marked ✗
`core`, `identity`, `cubic-ledger`, `state-machine`, `consensus`, `storage-compute`, `networking`,
`lng` each need one `reproductions/<module>.mjs` in the existing `verify.mjs` pattern (browser
surface where the module runs in a browser, Node otherwise). **Proof:** MODULE-STATUS column flips
✗→✓ per module, each backed by a runnable file in the gate.

### B4. Put the client suites in the hard gate
`cli` (41/41 today), `browser-extension` (Playwright, needs a Chromium binary — run on demand or
in CI with one installed) and `desktop-app` (fix `main/main.js` to export the `MainProcess` class
its test expects; 2/5 today) run outside `test:protocol`, so regressions land silently.
**Proof:** `test:protocol` suite count rises by those files and stays green.

### B5. A node that says when and why it died
On the audited node ~199 of 264 exits left no marker, `node.log` carries no timestamps, and ten
FATALs could not be placed in time. Now that the daemon lives in this repo: an unconditional exit
handler (signal, uncaught error, or clean stop — one line each) and an ISO timestamp on every
log line. **Proof:** exits in a soak == exit-marker lines; every line parses as a timestamp.

### B6. Faces: persist them or stop pretending to
No code writes a `face:` row, yet `rebuildFromAnchors` clears that keyspace. Faces are re-sealed
deterministically from the block set on every boot, so persistence is redundant — remove the
phantom keyspace from the rebuild and document that faces are derived state. **Proof:** zero
references to `face:` rows; boot output unchanged.

### B7. Re-verification at the ledger (follows A5)
Wire `getPublicKeyByAddress` into the daemon's `Ledger` so every signed transaction is verified
twice (consensus, then ledger) — the defense-in-depth layer the ledger already implements but the
daemon never enables. **Proof:** the devnet's pinned seam test flips; a tx tampered after
consensus is refused at the ledger.

### B8. Tag and publish 0.1.11 through the workflow
Every package and crate sits on 0.1.11 locally (HEAD `d54ab69`, unpushed). `git push origin main
--tags` with `v0.1.11` runs the gate, publishes npm with provenance, then the crates. Not done
without your say-so — it is outward-facing. **Proof:** `npm view @xmbl/<pkg> version` == 0.1.11
for all twelve; crates.io shows 0.1.11 for all eight.

### B9. MAYO-cube — MAYO on the cubic coordinate system (from A1)
Spec first, then code. (1) A new whitepaper section (§7 of
`docs/xmbl-cubic-cryptography-whitepaper.md`) that names which MAYO step the cube coordinates
enter — MAYO's cost sits in expanding the public matrices from the key seed and in evaluating the
whipped quadratic map — what the coordinates replace or seed, and what that saves, stated as
reviewer assumptions the way §2–§5 do. (2) The C under `packages/identity/mayo-cube/` becomes the
fork its directory name already promises, built by `build-mayo-cube-wasm.sh` under an Emscripten
version pinned in the script and in CI, into its own artifact; `wasm-schemes.js` repoints
`'mayo-cube'` to it (one line) while `'mayo'` keeps the baseline. (3) An in-repo benchmark.
**Proof:** sign and verify CPU-ms per operation for `'mayo-cube'` divided by the same for
`'mayo'`, plus signature and public-key bytes — that ratio is the deliverable;
`build-mayo-cube-wasm.sh --check` matches the recorded sha; the identity suite count is unchanged
with both schemes loaded.

### Closes by itself
The cross-cutting "0.x communicates pre-mainnet" line is definitional and closes when the seven
external reviews return; `AUDIT_GATES_OPEN` flips to `false` in that same reviewed commit.

---

## Answer key (copy, edit, send back)

```
A1 mayo.wasm:            DECIDED 2026-09-16 — adapt MAYO to the cubic coordinate system (B9)
A2 LNG browser panels:   DECIDED 2026-09-16 — the module ships its browser build; consumers import it
A3 EVM backend:          b  (export only)          / a — testnet key + RPC: ____
A4 EVM comparison:       b  (drop claim)           / a
A5 signature domain:     approve / defer
A6 xid in canonical feed: authorize / no
A7 fleet re-anchor:      with 0.1.11 / defer
A8 bundle on @xmbl/core: authorize / no
A9 crossed keypairs:     owner = ____
A10 packages/visualizer: retire / keep
A11 lwe_decrypt:         won't build / build
A12 crates:              stubs for 0.1 / port
B  start now:            all / B1 B2 B3 B4 B5 B6 B7 B9 (pick)
B8 publish 0.1.11:       go / hold
```
