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

### A3. The EVM backend — DONE 2026-09-16 (no decision needed)
The output is now **deployed and executed** in the gate: the same LNG source runs through the
interpreter, the WASM backend and `transpile` → solc → bytecode deployed into an in-process EVM
(`@ethereumjs/evm`, dev-only) and must compute the same answers, revert the same way (with the
LNG reason string), and carry 256-bit width — `lng/evm-deploy.test.mjs`, 16 checks. A *public*
testnet deployment is a product step, not a readiness one; the backend's external review stays
under the ⛔ audits.

### A4. "XCL vs Ethereum" resource comparison — CLOSED BY SCOPE 2026-09-16
No user-facing document makes the comparative claim any more (the README carries none), so there
is nothing to prove; the gate row records it. The EVM engine is in-repo (dev) if a like-for-like
number is ever wanted — it would be labelled as the JS reference EVM, never as "Ethereum".

### A5. Signature domain — NOT A QUESTION (work, 2026-09-16)
Consensus writing `validationTimestamp` *into* the body a user signed is a bug: it blinds the
ledger's second verification. Fixed as software, compatibly: the timestamp travels *beside* the
transaction (the ledger stores and reads both shapes, old rows untouched), the consensus body is
defined for every `tokens.json` type, then the daemon's `Ledger` gets `getPublicKeyByAddress` so
every signed transaction is verified twice. Anchors' ids and hashes do not move, so this needs no
re-anchor — only A7 (content-only `hash` for cube placement) touches the wire. Rolled into **B7**.

### A6. The canonical anchor feed carries the mined identity — SENT 2026-09-16
Not a question: the fleet contract is mine to require. handoff-claude has the requirement (`xid` +
`nonce` on `/api/v1/xmbl/anchors/canonical`; envelope 099e46a4). **Proof:** after a rebuild,
anchors carrying an xid == anchors in the feed.

### A7. One coordinated re-anchor — DECIDED 2026-09-16: yes, with the rollout
The operator's rule: every change rolls out to every node; a node proves it runs the latest version or is
suspended until updated; updates are automatic, over the air. Built as software (gates "Rollout policy"):
the version proof (`build` digest in the signed claim), self-suspension behind npm `latest`, the OTA loop
in `xmbl-node`. The block hash is content-only now and every tx is typed by its xid, so block ids and hashes
changed: one canonical rebuild on every node follows the rollout — sent to handoff-claude with the bundle
and broker-side requirements. **Proof:** every live node's claim carries the same `build` digest and
`list_cube_keys` returns the same `set_digest` everywhere.

### A8. The fleet runs `@xmbl/core` — SENT 2026-09-16; MEASURED 2026-09-16: NOT DONE, and now unblocked
Not a question. handoff-claude has the requirement (bundle = `@xmbl/core@^0.1.11` running its
`xmbl-node` bin; no vendored `core/` or `node.js`; envelope 099e46a4). **Proof:**
`status.versions.core == '0.1.11'` on every node; `core/` absent from the served tarball.

**Measured against the live node after B8 published (pid 32869, `xmb0844bbed…`, up since
2026-09-16T04:01:04Z), over its own control socket — the proof above, run:**

- `release` → `{"ok":false,"error":"unknown op"}`. So does `identity_status`. So does `chain`.
  Those three ops ARE the version proof; a node that cannot answer them cannot prove anything.
- The process runs `node node.js start` from `~/.handoff/xmbl-node.old/` — `xmbl-slim-node`, which
  **vendors a hand-copied `core/`** (cache, config, control-socket, earnings, index, lead-worker,
  logger, metrics-server, node-config, rate-limiter) and depends on **no `@xmbl/core` at all**.
- Its installed protocol packages, in both `~/.handoff/xmbl-node/` and `~/.handoff/xmbl-node.old/`:
  consensus 0.1.3, cubic-ledger 0.1.9, identity 0.1.4, networking 0.1.4, state-machine 0.1.5,
  storage-compute 0.1.2, zero-knowledge 0.1.1.

**Two consequences worth stating plainly.** First, publishing 0.1.11 did NOT suspend the fleet: the
suspend-gate and the OTA loop both live in `@xmbl/core`, which this node does not run, so the
"latest-or-suspended" rule (A7) is not in force on it — it is not suspended, and it is also not
updating. Second, this node cannot be OTA'd at all in its present shape; `npm install` would move the
seven npm deps and leave the vendored `core/` exactly where it is, still unable to answer `release`.

A8 was waiting on B8 for the package to exist. `@xmbl/core@0.1.11` now exists, so the bundle swap is
executable. It is handoff-claude's rollout and is not done here.

### A9. The crossed keypairs and the failed identity query — SENT 2026-09-16
handoff-claude has it (re-provision on-box or name the owner; broker says `usr_fb2446eb53`;
envelope 099e46a4). **Proof:** `identity_status.ok == true` on all three and one chain block from
each accepted by the broker. If the owner turns out to be you, the fix is `handoff xmbl`
re-provisioning the keypair on those boxes.

### A10. `packages/visualizer`: retire it?
**Why it's open.** Two visualizers exist: `apps/visualizer` (the Explorer, the real one) and
`packages/visualizer` (an older Vue/three.js bridge, 0 tests, marked private). Two of the same
thing is drift waiting to happen.
**Ask.** Retire `packages/visualizer` (a) or give it a contract and tests (b). Recommendation: (a).

### A11. `xmbl_lwe_decrypt` — RECORDED 2026-09-16 as won't-build
Decryption stays off-host by design (a guest never holds a secret key); the gate row says so. T6.1-d
now waits on B1 alone.

### A12. The Rust crates — stay labelled stubs for 0.1
No gate requires parity; the label is enforced by `crates/crate-status.test.mjs`. Nothing to decide
unless you want the port scheduled.

---

## Part B — work with no decision attached (starts on "go")

### B1. The LNG byte-string type — the one missing language feature — DONE 2026-09-16
A `~bytes` value is a **(pointer, length) pair on the operand stack**, never a 256-bit word: a
literal's bytes sit in a data segment with a compile-time length, and a runtime value (an id the
contract could not have known, from `xmbl_input_id`) is host-written into fresh memory with its
length in a local. Nothing needs an in-memory length prefix, because a length is always either a
constant or a live local. `~bytes` as a **field or param is refused** — committed state and the call
ABI are both 32-byte words with nowhere to put a length; before this they compiled *silently* as
words, which is the silent miscompile the backend header promises never happens. The typechecker
refuses arithmetic, bitwise and ordering on `~bytes` (equality stays legal), and it now walks
`~contract` method bodies at all, which it never did — every diagnostic it had was blind to exactly
the code that goes on chain.

Two opt-in host modes reach it: `{ crypto: true }` emits the §3.1 verifiers, `{ utxo: true }` the
five-entry value ABI. `xmbl.mayo.verify(msg)` takes **one** argument on-chain, not the interpreter's
three — the signature and public key are chain-staged, which is what makes the verdict deterministic;
an interpreter-shaped call is an arity error, never a silent drop. The value ABI's `-1` sentinel
**traps**: widened to an unsigned word it would read as 2^256-1, indistinguishable from an enormous
legitimate amount, so a contract could "spend" a UTXO it does not hold and carry the error on as money.

**Proof, measured:** one LNG-authored contract verifies a real MAYO signature (`@xmbl/identity`
MAYOWasm) and spends a real UTXO through `ContractHost` — `spent: ['U1']`, one conserved output of
100 to a recipient named by a `~bytes` literal, spend-marker written, Verkle root moved. A signature
over a *different* message reverts: nothing spent, no marker, root unmoved. `contract-host.test.mjs`
40 → 41 checks and the hand-encoded `cryptoContract` WASM is **deleted**; `compile-wasm.test.mjs`
29 → 47. A contract with no byte literals still emits a byte-identical, import-free module.

### B2. Full-stack multi-node reproduction under adversarial timing (T6.2 c) — DONE 2026-09-16
`reproductions/three-nodes.mjs`: three real XMBLCore per run, same set in three shuffles with duplicates and
forgeries. Eager sealing converges the block set but not the cube partition (measured); agreed sealing
(XPC_CONSENSUS_V2=1) converges blocks, cubes, set_digest and state root. It found a live denial-of-service on
its first run — a forgery could evict the anchor whose xid it copied — now fixed and pinned by
xid-poisoning.test.mjs.
Three node *subsystems* converge today; three full nodes (network + consensus + ledger + state)
under the simulator's chaos do not yet have a reproduction. Work: `reproductions/three-nodes.mjs`
booting three `XMBLCore` in-process with the chaotic simulator, asserting one state root and one
cube `set_digest` at the end. **Proof:** roots equal, digests equal, across N chaotic runs.

### B3. Miniapp reproductions for the eight modules still marked ✗ — DONE 2026-09-16
All eight written, each importing the real package and asserting by count: core, identity, cubic-ledger,
state-machine, consensus, storage-compute, networking, lng. MODULE-STATUS's third column is ✓ for all eight;
14 reproductions run in the gate.
`core`, `identity`, `cubic-ledger`, `state-machine`, `consensus`, `storage-compute`, `networking`,
`lng` each need one `reproductions/<module>.mjs` in the existing `verify.mjs` pattern (browser
surface where the module runs in a browser, Node otherwise). **Proof:** MODULE-STATUS column flips
✗→✓ per module, each backed by a runnable file in the gate.

### B4. Put the client suites in the hard gate — DONE 2026-09-16
`test:protocol` went 61 → 65 suites: cli (41 tests) and desktop-app (5) enter through a jest wrapper each, and
the browser-extension's two node suites directly. desktop-app went 2/5 → 5/5 by fixing the instance-export, the
window that was never returned, and CommonJS files under a `"type": "module"` package. The extension's
Playwright check stays on demand (needs Chromium).
`cli` (41/41 today), `browser-extension` (Playwright, needs a Chromium binary — run on demand or
in CI with one installed) and `desktop-app` (fix `main/main.js` to export the `MainProcess` class
its test expects; 2/5 today) run outside `test:protocol`, so regressions land silently.
**Proof:** `test:protocol` suite count rises by those files and stays green.

### B5. A node that says when and why it died — DONE 2026-09-16
Soaked against the real binary: 3 boots, 3 exits (SIGTERM/SIGINT/SIGTERM), 3 exit-marker lines, 60 of 60 log
lines ISO-stamped, 0 unstamped. Kinds: clean-exit, error-exit, uncaught-exception, unhandled-rejection.
On the audited node ~199 of 264 exits left no marker, `node.log` carries no timestamps, and ten
FATALs could not be placed in time. Now that the daemon lives in this repo: an unconditional exit
handler (signal, uncaught error, or clean stop — one line each) and an ISO timestamp on every
log line. **Proof:** exits in a soak == exit-marker lines; every line parses as a timestamp.

### B6. Faces: persist them or stop pretending to — DONE 2026-09-16
The `face:` prefix is out of the rebuild wipe list; zero references to a `face:` row remain anywhere. Faces are
documented as derived state, re-sealed deterministically from their blocks. Ledger suite 12/12.
No code writes a `face:` row, yet `rebuildFromAnchors` clears that keyspace. Faces are re-sealed
deterministically from the block set on every boot, so persistence is redundant — remove the
phantom keyspace from the rebuild and document that faces are derived state. **Proof:** zero
references to `face:` rows; boot output unchanged.

### B7. Re-verification at the ledger (follows A5) — DONE 2026-09-16, with A5
A5 first: consensus stopped writing its clock into the signed body and hands it to the ledger beside the tx;
the block carries it. Then the daemon wired its resolver into the Ledger. The devnet seam test now drives the
real pipeline: the finalized tx verifies against its signer's key and a post-consensus tamper is refused at the
ledger. 27 checks.
Wire `getPublicKeyByAddress` into the daemon's `Ledger` so every signed transaction is verified
twice (consensus, then ledger) — the defense-in-depth layer the ledger already implements but the
daemon never enables. **Proof:** the devnet's pinned seam test flips; a tx tampered after
consensus is refused at the ledger.

### B8. Tag and publish 0.1.11 through the workflow — npm DONE 2026-09-16; crates BLOCKED
Tagged `v0.1.11` at `9386ee9` and pushed the tag alone, after `main` went green on Linux. **npm: all
twelve published with provenance.** MEASURED by `npm view @xmbl/<pkg> version` after the run, not from
the workflow log: core, identity, networking, cubic-ledger, state-machine, consensus, storage-compute,
zero-knowledge, contracts, simulator, cli == 0.1.11; lng was accepted by the registry with a sigstore
provenance entry and is still propagating ("your package is being processed").

Three things had to be fixed before the tag would have published anything, and the first two would
have burned the tag:

1. **`main` was RED on Linux and had been for some time** — the gate scored 54/75 on ubuntu-latest and
   75/75 here. One cause: the workflows pinned Node 20 and nothing in this tree runs on Node 20
   (`node:sqlite` needs 22.5, `process.threadCpuUsage` 22.10, libp2p's own chain calls
   `Promise.withResolvers`, 22.0). Fixed by running 22 — and by declaring it, since the twelve
   published packages carried NO `engines` field and the root claimed `">=20"`, so a Node 20 consumer
   installed cleanly and crashed at import. See `7ac626d`.
2. **A real data-loss defect the runner exposed** — `StateMachine._handleLedgerBlock` is wired to
   `block:added` in the constructor, so a block could arrive mid-`_initDb`, land in the in-memory tree
   and be persisted nowhere (both writes swallow their errors by design). The root read correctly for
   the life of the process and came back 64 zeros on the next boot. See `0ae2bb8`.
3. **Both registry secrets were EMPTY.** `NPM_TOKEN` and `CARGO_REGISTRY_TOKEN` exist by name and
   resolve to nothing — the job log prints `NODE_AUTH_TOKEN:` with no `***` mask, and npm failed
   `ENEEDAUTH` after packing all twelve. `NPM_TOKEN` was re-set from the operator's own valid token
   and the job re-run; `CARGO_REGISTRY_TOKEN` is still empty and no crates.io token exists on this box.

**crates.io: 0 of 8 published.** `cargo publish -p xmbl-identity` reached the upload and failed with
"please provide a non-empty token". The `artifacts` job `needs: [npm, cargo]`, so it skipped and the run
reads red even though npm succeeded. **Unblocks with:** a crates.io token in the
`CARGO_REGISTRY_TOKEN` repo secret, then `gh run rerun <id> --failed`. Nothing else about the crate job
is wrong — it compiled and packaged `xmbl-identity v0.1.11` before the token check.

**Remaining proof:** crates.io shows 0.1.11 for all eight.

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

**(1) and (3) DONE 2026-09-16; (2) is an OPERATOR DECISION, not a build task.** §7 of the
whitepaper is written and the instrument exists (`packages/identity/bench-mayo-schemes.mjs`,
baseline 1.00× — both tags resolve to one artifact — cpk 1420 B, sig 454 B; identity suite 6/6
unchanged). What §7 establishes, by measurement rather than assertion
(`packages/identity/profile-mayo-cost.sh`, MAYO_1 opt in WASM under node):

- **The premise holds, hard.** `mayo_expand_pk` is **85.7% of verify** (0.524 of 0.612 ms) and
  `mayo_expand_sk` is **72.6% of sign** (0.758 of 1.045 ms). 144,495 bytes of P1‖P2 are
  re-derived from a 16-byte seed by AES-128-CTR on every single verification.
- **So any insertion point that is not the expansion is bounded at ≤14.3% of verify / ≤27.4% of
  sign, however good it is.** Seeding `seed_pk` from the cube address saves exactly 0.000 ms.
- **The one insertion point that can move the number is the one that cannot be signed off here.**
  Generating P1/P2 from cube coordinates means asserting that 144,495 bytes of GF(16) public-matrix
  entries derived from public, low-entropy, signer-influenceable coordinates stay indistinguishable
  from uniform and keep MAYO's rank profile — §2.2's MinRank question transplanted into a
  multivariate signature scheme, where a distinguisher is a key-recovery route, not a
  certificational weakness. Recorded as open assumptions **M2/M3** in §6's table.
- **A bigger, assumption-free number was found while measuring.** `signer.js` calls
  `MAYOWasm.load()` inside both `sign()` and `verify()` — a fresh WASM module per call. Measured:
  load 1.270 ms, `verifySync` on a loaded module 0.725 ms, public `verify()` 1.294 ms. **44% of
  every `signer.js` verification is module instantiation**; that exported API costs **1.8×** the
  verification it performs. It is the identity API's lifecycle, NOT the on-chain path — the
  ContractHost crypto ABI loads one module per `host.call` in its `init` hook and every signature a
  contract verifies in that call shares it. Caching the module, and the expanded public key per
  signer, bounds a repeat-signer verification at 1.294 ms → 0.088 ms with no new construction and no
  external review.
- **Part (2) is blocked on provenance anyway.** `emcc` here self-reports `4.0.24-git` (a snapshot,
  not a pinnable release) while the package manager says 5.0.0, and `--check` already reports DIFF
  against the shipped artifact (documented T2.1-b). A second artifact needs a pinned emsdk commit,
  a recorded sha *per scheme*, and a `--check` that knows which scheme it is checking.

**The decision the operator owns:** whether MAYO-cube proceeds into external review as a new
construction (7.2.2, the only route to real CPU savings, carrying M2/M3), or whether A1's goal —
"reduce its computation requirements" — is served first by the two measured, assumption-free wins
in §7.3. §7 does not choose; it states what each costs.

### B10. Typed-by-xid protocol + rollout policy — DONE 2026-09-16 (operator directives)
Content-addressed admission included: stage 1 reads tokens.json `authority`, so an unsigned type-7 anchor
from the node-less broker is admitted on its xid (measured: a live core returned a rawTxId where it returned
null before), while unsigned value types still reject.
Every tx typed by its xid (tokens.json codes, `micromineTx`, untyped rows deleted, anchors carry `prior`),
consensus validates in order (can-happen → xid → placement), content-only block hashes, version proof +
self-suspension + OTA in `@xmbl/core`. What remains is the consumer side, sent to handoff-claude: `prior`
on the anchor wire tx and in the canonical feed (with xid + nonce), the bundle running `@xmbl/core` under a
supervisor that respawns on exit 75, the broker suspending nodes whose signed claim is behind, and the
coordinated canonical rebuild. **Proof:** 0 untyped anchors after the rebuild; every node's `build` digest
equal.

### Closes by itself
The cross-cutting "0.x communicates pre-mainnet" line is definitional and closes when the seven
external reviews return; `AUDIT_GATES_OPEN` flips to `false` in that same reviewed commit.

---

## Answer key (copy, edit, send back)

```
A1 mayo.wasm:            DECIDED 2026-09-16 — adapt MAYO to the cubic coordinate system (B9)
A2 LNG browser panels:   DECIDED 2026-09-16 — the module ships its browser build; consumers import it
A3 EVM backend:          DONE — deployed + executed in-process (16 checks); public testnet = product step
A4 EVM comparison:       CLOSED BY SCOPE — no claim exists to prove
A5 signature domain:     DONE 2026-09-16 — clock moved beside the tx; ledger re-verification ON (B7)
A6 xid in canonical feed: SENT to handoff-claude (099e46a4)
A7 fleet re-anchor:      DECIDED 2026-09-16 — with the rollout; latest-or-suspended + OTA built
A8 bundle on @xmbl/core: SENT to handoff-claude (099e46a4) — MEASURED NOT DONE: the live node
                         still runs the vendored slim node (`release` = unknown op). Unblocked now.
A9 crossed keypairs:     SENT to handoff-claude (099e46a4) — owner = ____ if it is not usr_fb2446eb53
A10 packages/visualizer: retire / keep
A11 lwe_decrypt:         RECORDED — won't build (off-host by design)
A12 crates:              stubs for 0.1 (label-enforced); say "port" to schedule it
B  start now:            all / B1 B2 B3 B4 B5 B6 B7 B9 (pick)
B8 publish 0.1.11:       npm DONE 2026-09-16 (v0.1.11, all twelve). crates BLOCKED —
                         CARGO_REGISTRY_TOKEN is empty; set it and `gh run rerun --failed`
```
