// @xmbl/browser-extension — the XMBL wallet & contract client (Chromium MV3).
//
// This package is not consumed as a library; it is built with webpack (`npm run build`) into
// dist/{background,popup,content}.js, which manifest.json loads. The real sources live in src/:
//   src/background.js         — MV3 service worker (message bridge; node bridge is a stub)
//   src/content.js            — injects window.xmbl into pages
//   src/popup/                — Vue 3 popup: Contracts + Wallet tabs (impeccable.style)
//   src/contract-runtime.js   — in-page @xmbl/lng compile + node-parity content-addressed id
//   src/contract-samples.js   — starter LNG contracts
//
// The Contracts tab creates, deploys (to a local browser.storage registry), finds and calls
// contracts entirely in-page — the REAL compiled bytecode, id byte-identical to a node
// (tests/contract-runtime.parity.test.mjs). It is NOT the production execution path; see the
// on-screen boundary note and MODULE-STATUS.md.

export const manifest = { name: 'XMBL Wallet', surface: 'chromium-mv3' }
