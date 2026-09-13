# XBE — XMBL Browser Extension

A Chromium MV3 extension: the user's XMBL **wallet** and an in-page **contract client**
(create / deploy / find / call contracts), Vue 3 + webpack, reskinned in the miniapp's
impeccable.style.

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

- **Contracts tab** — creates, deploys (to a `browser.storage.local` registry), finds and calls
  contracts entirely in-page. It inlines the REAL `@xmbl/lng` compiler and the miniapp's verified
  in-page executor (`src/contract-runtime.js`) and runs compiled WASM over a local Verkle stand-in.
  The content-addressed id and coordinates are **byte-identical to node `@xmbl/contracts`**, proven
  by `tests/contract-runtime.parity.test.mjs` (`npm test`).
- **Wallet tab** — balance / send / node status, served by a **real node bridge**: `src/background.js`
  proxies the five wallet/node messages over loopback HTTP to a running **XMBL LocalDevnet** RPC
  (`npm run devnet -w packages/simulator`), so balance is the net of applied deltas, a send lands a
  real signed+verified tx, and status reports the real running/peers/height. With no devnet reachable
  it reports a truthful **disconnected** state (balance 0, `connected:false`) and sends error — it
  never fabricates a balance or txId. The devnet URL defaults to `http://127.0.0.1:8646`, overridable
  via the `browser.storage.local` key `xmbl:devnetUrl`. Proven end-to-end against a real devnet RPC by
  `tests/background-bridge.test.mjs` (`npm test`).

## Verify

- `npm test -w packages/browser-extension` — runs `tests/assert-loadable.mjs` (fails if any
  `_`-prefixed file/dir exists in the tree, the Chrome rule that blocks `Load unpacked`) then the node
  parity test: the in-page `contractIdOf`/coordinates are byte-identical to node `@xmbl/contracts`,
  plus real execution and a trapping revert.
- `npm run verify:extension -w packages/browser-extension` — browser-surface: builds, then drives the
  REAL `dist/popup.js` in Playwright chromium through every workflow (create+compile all samples,
  deploy, find/search, call with committed-state changes, a reverting over-withdraw, and the Wallet
  tab) asserting zero page errors. Only `chrome.storage` and the node bridge are shimmed in
  `harness.html` (emulating the bridge's responses when connected to a fresh devnet, so the popup
  workflow runs without spawning one); all popup/compile/execution code runs unmodified. The
  bridge↔devnet path itself is proven against a real devnet RPC by `tests/background-bridge.test.mjs`.

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
