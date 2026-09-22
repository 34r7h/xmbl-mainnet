# @xmbl/core

The node runtime. It orchestrates every other module and ships the **`xmbl-node` daemon** — the
control socket, the metrics and the OTA decision a supervisor talks to.

```sh
npm install @xmbl/core
npx xmbl-node start --config ./config.json
```

`@xmbl/core` carries the other seven protocol packages as dependencies, so installing it installs a
whole node.

## Mainnet boot is refused while the audits are open

```js
export const AUDIT_GATES_OPEN = true;   // index.js — the single source of truth
```

`start()` throws on `XMBL_PROFILE=mainnet` while this is true. **There is no env override.** The only
way to open mainnet is the reviewed source change that flips it to false once every ⛔ AUDIT gate in
[MAINNET-GATES.md](../../MAINNET-GATES.md) is genuinely closed.

## What it owns

| Export | What it is |
|---|---|
| `XMBLCore` | The runtime: boots identity, networking, ledger, consensus, state and storage-compute, and holds them together. |
| `liveLeadsFrom(peerRegistry, self, leadAllowlist, ttlMs, now)` | **Live means live** — lead addresses that are both permitted and seen within `ttlMs`. `self` is always eligible (a node never gossips presence to itself), and a node alone is still a complete validator set under user-as-validator. `now` is a parameter, so this is testable without clocks. |
| `sealQuorumFrom(configuredLeads)` | The seal threshold over the **fixed configured** lead set — never the presence-live subset, so a partition cannot shrink the bar it has to clear. |
| `AUDIT_GATES_OPEN` | Above. |
| `src/release.js` — `compareVersions`, `codeDigest`, `otaDecision`, `fetchLatestVersion`, `installRootOf`, `updateCommand`, `OTA_EXIT_CODE` | The version proof and the OTA decision. A node reports the digest of the code it actually loaded; it is "behind" only when a real latest is newer, and an unknown latest is never behind — a node is not suspended for the network's fault. Exit 75 asks the supervisor to update. |

## The version line

Every published workspace must sit on the **0.1.x** line, and `release.test.mjs` fails
`npm run test:protocol` — which the release workflow runs *before* it publishes — if any does not.
Raising the line is a deliberate edit to `LINE_MAJOR`/`LINE_MINOR` in that test, by the operator, in
the same commit that raises the versions. This exists because a hand-edited version once shipped
twelve packages at a minor bump nobody had asked for, and npm will not take it back.

## Tests

```sh
node ../../scripts/run-node-tests.mjs .
```
