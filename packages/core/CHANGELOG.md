# @xmbl/core

## 0.1.28

### Patch Changes

- **A node nobody feeds feeds itself.** A node without the lead role moves its chain only when something hands it
  the canonical anchor set (rebuild_ledger / apply_canonical on its control socket). Its coordinator does that
  every 90 s, except for a node it adopted at boot instead of spawning: 831cfb42 sat at 15399 blocks / root
  955850f3 for hours on 2026-10-11 while the three fed nodes moved together. Now, when no set has been handed over
  for XMBL_SELF_FEED_STALE_MS (default 180 s), the node GETs the same URL its coordinator does
  (`$HANDOFF_API/xmbl/anchors/canonical`, `?from_epoch=1` when its ledger refuses untyped anchors), picks the op the
  coordinator would pick from its own `ledger_capabilities`, and runs it through the same in-process dispatch as
  the socket: same one-write-at-a-time lock, same eviction filter, same refusal of a set that would empty the
  chain. It checks every XMBL_SELF_FEED_MS (default 90 s; 0 turns it off), sends the ETag back, skips a set it
  already holds or one older than it holds, and on a node that has been fed gives the feeder one more interval for
  a new set before applying it. A result with untyped or rejected rows is not pinned, as the coordinator does.
  `status.canonical_feed` reports who handed over the last set (`control` or `self`), its digest, and the
  self-feed's last reason and error. The broker is still where the anchor set comes from: its payload and the
  anchor blocks are unsigned, so the node fetches the set over TLS rather than taking it from peers.

## 0.1.27

### Patch Changes

- **A node without the lead role keeps no processing tier.** Core hands the consensus workflow `finalizes` from the
  same role that builds its LeadWorker, so a lead:false node no longer holds every validated tx in a processing map
  nothing ever empties (measured 2026-10-11 on the two lead:false seeds: 831cfb42 processing 66 -> 115 and
  4293b3c6 41 -> 65 within minutes, the lead nodes 0). A lead node is unchanged. See @xmbl/consensus 0.1.27.
- **No room, no npm.** Before an update installs (the over-the-air install and the boot self-heal from a bad
  install), the node reads the free space under its install root and does not run npm below 32 MB
  (XMBL_OTA_MIN_FREE_MB; 0 turns the check off). It stays up and suspended on its version, puts the numbers in
  `ota.last_error` ("not installing 0.1.x: N MB free in <root>, an update needs 32 MB") and looks again in 60 s.
  The memory the box has (MemAvailable, or os.freemem without /proc) is read and reported in `ota.preflight` and
  on the install line, never refused on. 4293b3c6 had 47 MB free on 2026-10-11 and was handed every update; the
  0.1.25 -> 0.1.26 upgrade grew the tree by 0 KB and the npm cache by 8 KB and peaked at 121 MB RSS, and a cold
  install is 122 MB of tree plus 153 MB of cache. On a box with a coordinator the coordinator's converge installs
  first, inside the grace, so this check covers the box without one and the install after the grace.

## 0.1.26

### Patch Changes

- **An update reaches every running node, node to node, and it is not opt-in.** Every presence message now says
  which @xmbl/core the sender runs and, while it is updating, the newer release it has confirmed. A node that hears
  a newer version asks the release source at once instead of on its next poll (PeerReleaseTrigger: one look now,
  then doubling waits from 15 s up to the poll interval while the claim goes unconfirmed). It never installs what a
  peer names, only what the release source says (npm's dist-tags for @xmbl/core, 19 bytes instead of the 43 KB
  packument). Its own poll is every 2 min ±20% (was 10 min), so a node with no peers still updates.
  XMBL_OTA=0 is ignored on an installed node; it applies only to a source checkout, which only suspends.
- **The node installs what the coordinator installs.** All eight node packages, pinned exactly (`--save-exact`),
  the same command as the handoff coordinator's converge; 0.1.25 installed @xmbl/core alone, leaving the other
  seven on the old version in a coordinator's install root. After npm exits the tree is checked package by package
  (npm exits 0 on an install that nested a package instead of replacing it). The floodsub cleanup guard is applied
  to the installed tree with the coordinator's exact edit and marker (the 4 `abort(err)` calls in
  @libp2p/floodsub's peer-streams.js that throw on a closed stream and end the process). An O_EXCL lock
  (`.xmbl-install.lock` in the install root) keeps two installs out of one node_modules.
- **A coordinator-owned node** (launched with --ppid and supervised) leaves the install to its coordinator for
  XMBL_OTA_GRACE_MS (default 2 min) from when it knew; a tree already on the release means restart only (exit 75);
  after the grace it installs itself, so a dead coordinator or broker delays an update by the grace and never
  stops it.
- **One version line.** A release off 0.1.x (XMBL_TRACK) is unknown, never behind: 0.2.0 stays on the registry and a
  tag that points at it again moves no node.
- Rollout: 0.1.25 nodes ignore the two new presence fields and update to this release as before (their own poll and
  the coordinator's converge); this release's gossip-driven update first acts when 0.1.27 is published.

## 0.1.25

### Patch Changes

- **Throughput, counted on real nodes.** scripts/fleet-load.mjs boots real nodes on loopback, submits node-signed
  datum state_diffs over their control sockets and times until every node holds every tx. 0.1.24: 4 nodes x 500
  sealed 0 in the signing node's ledger and split the state root 2 ways. 0.1.25: 2 nodes x 504 at 154-168 tx/s end
  to end, every tx sealed on both nodes, one state root, 1.00 signature checks per tx on each node.
  - @xmbl/consensus 0.1.25: a node-signed tx reaches the ledger (finalize no longer adds an `id` the signer never
    signed); raw txs and validation reports go out batched, one gossip message per 10 ms; a relaying node is
    throttled per second (XPC_FLOOD_MAX 20000 per XPC_FLOOD_WINDOW_MS 1000) instead of banned for life; a tx's
    validation tasks leave with it; a signed tx is checked against the key it carries, so no pooled tx goes
    unverified while the signer's presence is on its way.
  - @xmbl/identity 0.1.25: one MAYO module per scheme and one verify per signature per process.
  - @xmbl/cubic-ledger 0.1.25: a datum's nonce search runs once per (content, type) per process.
  - @xmbl/networking 0.1.25: the relay-discovery walk is paced; two idle nodes sent each other about 500 DHT
    queries a second (15,794 in 30 s), now 18 in 30 s; CPU per tx down about 40%.
  - This package: the chain op reports cpu_ms, heap_mb (after a full GC with params.gc under --expose-gc),
    verify, micromine, gossip and key-miss counters, and the size of every per-tx structure; a node batches only
    while every peer it hears says caps ['batch'], so a 0.1.24 peer is never sent a message type it would drop.

## 0.1.24

### Patch Changes

- **A node fits a small box.** hermes-agentic reported xmbl-node at 50-60% of RAM on a box with under 1 GiB,
  then OOM. Three causes, all fixed in this release; measured 2026-10-10 on a real node doing the
  coordinator's `rebuild_ledger` over the 14,134-anchor canonical set (a coordinator sends it every 90 s):
  rebuild 26.1 s -> 5.2 s, heap after it 262 MB -> 72 MB, RSS peak 468 MB -> 259 MB, RSS after an unchanged
  repeat 672 MB -> 247 MB, state_root a0aa77ab… on both.
  - @xmbl/state-machine 0.1.24: the state tree held one object per trie level per key (436,927 objects for
    14,134 keys); it now holds about one per key, with the same commitment to the bit.
  - @xmbl/consensus 0.1.24: the stranded-pool sweep ran every 1 ms on any node without
    `XPC_RECOVERY_SWEEP_MS` set; it runs every 15 s.
  - This package: the control socket copied a long request once per chunk it arrived in. A rebuild_ledger
    request is about 4 MB; a 16 MB line in 1,025 chunks took 3,681-4,007 ms and now takes 33-92 ms.
    control-socket-lines.test.mjs: 7/7; the old reader fails the 16 MB check.
- **Rehearsed before release, with real processes:** a 0.1.23 node installed from npm rebuilt the 14,134-anchor
  set and then a 14,122-anchor set, updated itself to 0.1.24 from a local registry in 76 s and came back with the
  same state_root, then rebuilt both sets again. 0.1.23: 20.8 s and 26.4 s, RSS peak 516 MB and 844 MB. 0.1.24:
  5.3 s and 5.8 s, RSS peak 279 MB and 305 MB. Both roots (a0aa77ab…, 41d74e74…) are the same on both versions.

## 0.1.23

### Patch Changes

- **A node signs only a chain it holds.** `chain` counted block rows once and then added one on every
  'block:added'; `rebuild_ledger` wipes every row and reseals the whole set, so inside a rebuild the signed
  height climbed toward twice the chain. The broker kept that as the node's high-water mark and refused every
  honest reading after it as a replay. Measured on the broker's /xmbl/status, 30 samples 2026-10-09
  23:38–23:43Z: 4293b3c6a6 had 10 of 30 readings refused (mark 22590 = 2 × 11295), 831cfb42ed 9 of 30
  (mark 21384 = 2 × 10692). Now a `chain` read while a ledger write runs answers with the last reading taken
  with no write in flight, its signature and ts unchanged, marked `during_write`; with none it answers
  unsigned. Every write ends by taking a fresh reading while it still holds the write lock, so a box that
  rebuilds back to back never hands out one reading until the broker refuses it as stale.
  chain-during-write.test.mjs: 19/19; against 0.1.22's control socket 8 fail, with only the first change 2 fail.
- **Rehearsed before release, with real processes:** a 0.1.22 node updated itself to 0.1.23 from a local
  registry and respawned in 35 s, and the broker's own verifier (coordinator-chain-claim.ts) read `chain`
  while a driver rebuilt a growing set. A rebuild every ~3 s with a reading every 2 s: 0.1.22 had 79 of 120
  refused and 36 heights above the chain; 0.1.23 had 120 of 120 verified, none above the chain, the oldest
  14 s. Rebuilds back to back with a reading every 30 s: without the second change 7 of 11 were refused as
  stale (one reading signed for 300 s); 0.1.23 had 11 of 11 verified, the oldest 8 s.

## 0.1.22

### Patch Changes

- **An update never leaves a node dead.** A node decided at boot whether a supervisor owned it and never
  looked again, so a node whose launcher had detached it and gone exited 75 after its own update and nothing
  restarted it (831cfb42, 2026-10-09 05:59Z). The node now asks at the moment of the restart: with `--ppid`,
  it exits 75 only while it is not detached and that launcher is still its parent; otherwise it restarts
  itself, without `--ppid` or `XMBL_SUPERVISED`. ota-restart.test.mjs: 20/20; 3 fail without the change.
- **One ledger write at a time on the control socket.** `rebuild_ledger`, `apply_canonical`, `apply_backfill`
  and `evict` no longer run on top of each other; a repeat of the running call joins it, any other write is
  answered `busy` at once, and a repeat of the last applied set with nothing changed is not rebuilt again.
  ledger-op-lock.test.mjs: 21/21; 14 fail without the change.

## 0.1.21

### Patch Changes

- **The node daemon passes `<data_dir>/known-peers.json` to @xmbl/networking**, so a node dials the peers
  it has met before any seed on boot. `deploy/xmbl-node-bundle/config.example.json` lists both public
  nodes instead of one.

## 0.1.20

### Patch Changes

- **A node that cannot boot now updates itself out of it.** The OTA loop (`startOta`) ran at the END
  of `cmdStart`, after config, `XMBLCore.start()` and the control-socket bind — so the one failure it
  could not cover was a bad install that stops the node from starting: the supervisor crash-looped
  and the box stayed on the broken version forever. `control-socket.js` and `metrics-server.js` are
  now imported lazily inside `cmdStart`, so a link error is an ordinary rejected promise, and a boot
  failure asks the release source for a newer version, installs it and restarts onto it. With no
  newer version the failure is real and is re-thrown unchanged — a genuine crash is never hidden
  and never reinstalls itself in a loop.
- `settlement_seal` with `chain: "evm"` now returns an address its key controls — the fix is in
  `@xmbl/identity` 0.1.20, and the line floor makes core resolve it.

## 0.1.19

### Patch Changes

- **⛔ Fixed a broken resolve that 0.1.18 shipped: a node could install a pair that cannot boot.**
  `@xmbl/core@0.1.18` imports `sealChainKey` and `SUPPORTED_CHAINS` from `@xmbl/identity` — symbols
  that exist only from 0.1.18 — while declaring `"@xmbl/identity": "^0.1.12"`. MEASURED against the
  published packages: `npm i @xmbl/core@0.1.18 @xmbl/identity@0.1.17` then importing
  `@xmbl/core/control-socket.js` fails with *"does not provide an export named 'SUPPORTED_CHAINS'"*,
  and the control socket is what the daemon binds at startup — so that resolve is a node that does
  not start. It did not bite only because npm happened to pick the newest satisfying version; a
  lockfile, a stale cache, an offline mirror or a deliberate pin all produce the failing pair from
  the range as written, and the node bundle pins `@xmbl/core` exactly while its transitive ranges float.

  Every `@xmbl/*` range across the workspace now floors at the line version. These packages are ONE
  version line released in lockstep — no package ever depends on an older sibling's behaviour — so
  the floor must BE the line. `packages/core/workspace-ranges.test.mjs` fails the hard gate if any
  workspace dependency floor ever drops below it again.

## 0.1.18

### Patch Changes

- **Contracts execute on a node.** `ComputeNode` has taken a `contractHost` option since it was
  written and `runContract()` uses it — `XMBLCore` never passed one, so every deployed node answered
  "contract execution is not enabled" while @xmbl/contracts' own suite passed throughout (it wires
  the host itself). XMBLCore now composes a `ContractHost` from the compute role's sandboxed
  `ComputeRuntime` and the state machine's REAL `VerkleStateTree`, under a new `roles.contracts`.
  `contracts: true` without `compute: true` now REFUSES to start rather than booting half-on.

  New ops: `contract_deploy` (LNG compiled in the daemon, so the bytes anchored are the bytes
  executed), `contract_call` (a revert is a result with the root unchanged, not a crash), read-only
  `contracts` (which carries the capability gate and names each host's reachability), plus
  `settlement_seal` and `settlement_chains`. Deploys anchor as type-4 `contract` blocks carrying the
  bytecode; calls anchor as type-5 `state_diff` receipts; a restart replays both from the block store.

- **`evict`** — `ledger_capabilities.evicts_invalid_for_good` had advertised `xclt.evict()` since
  0.1.9 with nothing on the socket able to call it, so the only way to drop a named anchor was
  `rebuild_ledger`, which wipes the block store — the one operation a node answering
  `rescues_non_anchor_blocks:false` must never be given. `evict {keys:[…]}` removes named anchors
  from the ledger, the verkle tree and the durable `diff:` row, reporting `was_present` read BEFORE
  the delete. Gated by `ledger_capabilities.capabilities.evict_op`.

- **Fixed: a replayed contract read back zero for every field.** A deploy entry's `slots`/`byteKeys`
  ARE the state footprint the host stages a read-set from, and they start empty — measured, a counter
  committed at 7 answered `bump(1)` with 1 after a restart while its values sat correct in the tree.
  `replayContracts` now re-registers the footprint from the `state_diff` receipts.

- **Fixed: a zk/he/fhe contract was not drivable over the control socket at all.** The staged material
  is full of 256-bit BigInts and the protocol is one JSON line, which `JSON.stringify` throws on.
  Tagged `{"__bigint__":"123"}` is revived on every staged surface, reusing Block.serialize's convention.

- **Refused: `lng_source` with `zk_host`/`he_host`/`fhe_host`/`air_host`.** XCL binds those imports,
  but the LNG backend takes only hostState/compose/crypto/utxo and has no such builtin — a `~contract`
  cannot call them. Deploying the flag anyway would declare a capability the bytes never use.

## 0.1.16

### Patch Changes

- **SECURITY — 0.1.15 still leaked the AIR trace, by a second route.** The mask added in 0.1.13
  closed the linear attack; it did not close this one, and the published 0.1.15 bytes return the
  exact secret.

  Base-field Merkle leaves were `H('l:' + value)` and the field is 31 bits. Every opening hands the
  verifier its authentication path, whose FIRST element is the level-0 SIBLING's leaf hash —
  inverting it is a sweep of 2^31 SHA-256, measured at **450 seconds** for the whole field, once,
  reusable against every proof ever made. So each of the `2*nc` trace openings donated one more
  evaluation of `col'` for nothing: **80 opened + 80 swept = 160** points against a polynomial of
  degree `T + blindDeg = 104` that needs **105**. Interpolate, evaluate at `g^0`, read row 0.
  Measured against published 0.1.15: `RECOVERED 570682118` / `ACTUAL 570682118`. The blind cannot
  see this — `blindDeg = 2*nc + 8` is sized against what is opened DIRECTLY.

  **Fix**: `@xmbl/zero-knowledge` exports `merkleSalted`, `mverifySalted` and `randomSalts`; a
  base-field leaf is now `H('ls:' + value + ':' + salt)` with a fresh 128-bit salt per leaf, carried
  in the opening as `sCur`/`sNxt`. A missing or short salt is refused, so a salt-stripped proof does
  not verify. Extension-field leaves are ~124 bits and stay unsalted.

  **BREAKING for AIR proofs**: the statement tag is versioned `zk3` and the opening shape gained the
  salts, so **no proof made by 0.1.13–0.1.15 verifies on 0.1.16**. Re-prove. `airSetup`/`airProve`/
  `airVerify`/`AIR_STATEMENTS` signatures are unchanged.

  `xzk` (the cube-curve statement) is unaffected and deliberately not salted: its FRI layer 0 IS the
  curve codeword in the clear, `Pt` is public by construction, and its hiding is the witness family
  (`Pt = P + Z_R*B`, a 2-parameter family per proof) rather than leaf secrecy.

  The standing regression check is no longer a guess at the next attack. It is a COUNT: the points
  an adversary can hold must stay strictly below `T + blindDeg + 1`. At the shipped parameters that
  is `80 + 0 < 105`; un-salting the leaves makes it `160 < 105` and fails.

## 0.1.15

### Patch Changes

- **The Linux and Windows desktop builds still failed at v0.1.14; both are fixed.** v0.1.14 attached
  the macOS dmg (x64 + arm64), both web bundles and the extension zip — the first downloadable
  builds this repo has ever produced — but two targets were still missing:

  - **Linux** — the default deb/AppImage artifact name is `${name}_${version}_${arch}`, and `name`
    is the SCOPED package name `@xmbl/desktop-app`, so fpm tried to write into `dist/@xmbl/` and
    died with "Parent directory does not exist". Artifacts are now named explicitly.
  - **Windows** — electron-builder rebuilt every native dependency in the hoisted workspace tree
    for the electron ABI, and `classic-level`'s node-gyp build fails on Windows, so the `.exe` was
    never produced. Nothing in the desktop app loads a native module (`main.js` and
    `src/core/xmbl-core.js` require only `electron` and `path`), so the rebuild is skipped.

  No change to any published package's code in this release.

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
  - @xmbl/zero-knowledge@1.0.0
  - @xmbl/identity@1.0.0
  - @xmbl/consensus@1.0.0
  - @xmbl/cubic-ledger@1.0.0
  - @xmbl/storage-compute@1.0.0
  - @xmbl/networking@1.0.0
  - @xmbl/state-machine@1.0.0

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
  - @xmbl/networking@0.1.11
  - @xmbl/cubic-ledger@0.1.11
  - @xmbl/state-machine@0.1.11
  - @xmbl/consensus@0.1.11
  - @xmbl/storage-compute@0.1.11
  - @xmbl/zero-knowledge@0.1.11
