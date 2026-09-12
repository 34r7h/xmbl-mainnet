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

## What works

- **Contracts tab** — creates, deploys (to a `browser.storage.local` registry), finds and calls
  contracts entirely in-page. It inlines the REAL `@xmbl/lng` compiler and the miniapp's verified
  in-page executor (`src/contract-runtime.js`) and runs compiled WASM over a local Verkle stand-in.
  The content-addressed id and coordinates are **byte-identical to node `@xmbl/contracts`**, proven
  by `__tests__/contract-runtime.parity.test.mjs` (`npm test`).
- **Wallet tab** — balance / send / node status. The node bridge is a **labeled stub**.

## Verify

- `npm test -w packages/browser-extension` — node parity: the in-page `contractIdOf`/coordinates are
  byte-identical to node `@xmbl/contracts`, plus real execution and a trapping revert.
- `npm run verify:extension -w packages/browser-extension` — browser-surface: builds, then drives the
  REAL `dist/popup.js` in Playwright chromium through every workflow (create+compile all samples,
  deploy, find/search, call with committed-state changes, a reverting over-withdraw, and the Wallet
  tab) asserting zero page errors. Only `chrome.storage` and the stub node bridge are shimmed
  (`_harness.html`, mirroring `src/background.js`); all popup/compile/execution code runs unmodified.

## Boundary

In-page execution is **not** the production path: no worker isolation, no CPU metering, no Verkle
commitment, no delegation gate — stated on screen. The full gated path is the headless
`reproductions/agentic-contract-e2e.mjs` in `@xmbl/contracts`.

## Build

`npm run build -w packages/browser-extension` — webpack bundles `src/` into `dist/`. No babel:
the extension targets modern Chromium and `@xmbl/lng` is BigInt-heavy (`@babel/preset-env`
down-levels its BigInt literals and breaks at load); Vue SFCs are compiled by `vue-loader`.
