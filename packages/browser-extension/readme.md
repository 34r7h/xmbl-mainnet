# XBE — XMBL Console (browser extension)

A Chromium MV3 extension surfacing the **whole xmbl stack** in one popup, Vue 3 + webpack, in the
miniapp's impeccable.style. Five tabs: **Contracts** (the full in-page contract lab — code + visual
builder, deploy, find, call/test), **Crypto** (the zk / HE / signature / seal host-capability
surface, run for real on a node), **Wallet** (balance / send / status over a real node bridge),
**Node** (live status, ledger state root, and the map of every xmbl module and where it runs), and
**Config** (the devnet endpoint).

## Build before loading (required)

`dist/` is **gitignored** and `manifest.json` loads `dist/background.js`, `dist/content.js` and
`dist/popup.js`. A fresh checkout has no `dist/`, so you **must build first** — loading the unpacked
extension without building gives a broken extension (missing service worker / popup / content
script):

```
npm install          # from the repo root (workspaces)
npm run build -w packages/browser-extension
```

Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** →
select `packages/browser-extension/`.

> Chrome refuses to load an unpacked extension if **any** file or directory in the loaded tree has a
> name starting with `_` (reserved, except `_locales`/`_metadata`). That is why the test dir is
> `tests/` (not `__tests__/`) and the Playwright harness is `harness.html` (not `_harness.html`). Do
> not drop a `_`-prefixed file at the package root or `Load unpacked` will fail with
> *"Cannot load extension with file or directory name …"*.

## What works

- **Contracts tab** — the full in-page contract lab. The same 5 samples the miniapp ships
  (Counter / Vault / Calc / Logic / Ledger) are **seeded on first open** so the Find list is
  populated and search works immediately; removing every instance is never a dead end — the empty
  list offers a **Load examples** button that restores the set on demand. A **Code ⇄ Visual** toggle
  edits one LNG source two ways:
  the visual builder (`src/contract-builder.js`'s `parseToModel`/`modelToSource`, rendered by the
  recursive `StmtList`/`ExprEditor`/`OperandInput` components ported from the miniapp Contract Lab)
  edits fields, events **and every method body** as plain-language statement rows — set / local /
  return / emit / if…else / repeat, with nested control flow fully editable — not a read-only body
  preview; the code editor is authoritative and the two stay in sync live. Compile / deploy
  (to a `browser.storage.local` registry) / find+search / call with committed **state tiles** and
  reverting traps all run entirely in-page over the REAL `@xmbl/lng` compiler and the verified
  executor (`src/contract-runtime.js`). The content-addressed id and coordinates are
  **byte-identical to node `@xmbl/contracts`**, proven by `tests/contract-runtime.parity.test.mjs`.
- **Crypto tab** — the opt-in host-capability surface a deployed contract can declare: **Signature
  verify** (cryptoHost · Cubic-SIG / MAYO), **Coordinate/curve proof** (zkHost · XZK FRI, ⛔
  unaudited), **Encrypted add** (heHost · post-quantum cubic-LWE), and **Seal / USDC settlement**
  (zkHost + heHost + seal). These need `node:crypto` and cannot run in an MV3 popup, so each runs for
  REAL in the devnet process (`packages/simulator/src/capabilities.js`) and returns a JSON-safe
  verdict — the honest result **and its negative control** (a tampered coordinate/message rejected),
  never a fabricated pass. With no devnet the cards disable and show "no devnet".
- **Wallet tab** — balance / send / node status, served by a **real node bridge**: `src/background.js`
  proxies the wallet/node messages over loopback HTTP to a running **XMBL LocalDevnet** RPC
  (`npm run devnet -w packages/simulator`), so balance is the net of applied deltas, a send lands a
  real signed+verified tx, and status reports the real running/peers/height. With no devnet reachable
  it reports a truthful **disconnected** state (balance 0, `connected:false`) and sends error — it
  never fabricates a balance or txId. Proven end-to-end against a real devnet RPC by
  `tests/background-bridge.test.mjs`.
- **Node tab** — live status (peers / height / pooled / landed), the ledger **state root**, node
  start/stop, and a **map of every xmbl-mainnet module** and its honest surface (in-page vs devnet vs
  config vs cli). A P2P node or storage market cannot run inside a popup; those are used/configured
  through the node, not faked.
- **Config tab** — the devnet RPC endpoint, saved to `browser.storage.local` key `xmbl:devnetUrl`
  (default `http://127.0.0.1:8646`) via a `setDevnetUrl` bridge message that re-points every tab and
  tests reachability. Stored only on this device, sent only to the endpoint you set.

## Verify

- `npm test -w packages/browser-extension` — runs `tests/assert-loadable.mjs` (fails if any
  `_`-prefixed file/dir exists in the tree, the Chrome rule that blocks `Load unpacked`) then the node
  parity test: the in-page `contractIdOf`/coordinates are byte-identical to node `@xmbl/contracts`,
  plus real execution and a trapping revert.
- `npm run verify:extension -w packages/browser-extension` — browser-surface: builds, then drives the
  REAL `dist/popup.js` in Playwright chromium through every workflow (seed, create+compile all
  samples, remove, restore via Load examples, deploy, find/search, call with committed-state changes,
  a reverting over-withdraw, the statement-level visual builder — including a discriminating check
  that nested if…else arms and repeat bodies actually render through the recursive `StmtList` and are
  not silently empty — and the Wallet tab) asserting zero page errors. Only `chrome.storage` and the
  node bridge are shimmed in `harness.html`; all popup/compile/execution code runs unmodified. It then
  runs `tests/verify-extension-loaded.mjs`, which loads the REAL unpacked extension under the real MV3
  CSP, screenshots all five tabs, asserts the truthful **disconnected** surface (pointing the bridge
  at a dead port), then **stands up a real LocalDevnet on an OS-assigned loopback port** and repoints
  the extension at it through the Config persistence path — so the verify coexists with a devnet the
  operator already has on `:8646` — and asserts the Crypto tab produces REAL green zk/HE verdicts and
  the Wallet/Node tabs read live state — the connected proof, screenshotted (`tests/screenshots/`).

## Boundary

In-page execution is **not** the production path: no worker isolation, no CPU metering, no Verkle
commitment, no delegation gate — stated on screen. The full gated path is the headless
`reproductions/agentic-contract-e2e.mjs` in `@xmbl/contracts`.

## Build

`npm run build -w packages/browser-extension` — webpack bundles `src/` into `dist/`. No babel:
the extension targets modern Chromium and `@xmbl/lng` is BigInt-heavy (`@babel/preset-env`
down-levels its BigInt literals and breaks at load); Vue SFCs are compiled by `vue-loader`.

**MV3 CSP constraints (why the popup was blank):** extension pages forbid `eval`/`new Function`, so
the config sets `devtool:false` (the default dev devtool is `eval`, which would make the whole bundle
die at load), aliases `vue` to the runtime-only build (no template-compiler `new Function`), and the
manifest declares `content_security_policy.extension_pages` with `'wasm-unsafe-eval'` so `@xmbl/lng`'s
WebAssembly runs. `tests/verify-extension-loaded.mjs` (part of `verify:extension`) loads the REAL
unpacked extension under the real CSP and asserts the popup mounts, so a regression here fails loudly.
