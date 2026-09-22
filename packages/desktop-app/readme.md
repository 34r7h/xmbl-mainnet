# @xmbl/desktop-app

The XMBL desktop client: an Electron + Vue 3 app that is both a **wallet** and a **full node**, the
same surface as the [browser extension](../browser-extension) with a local node underneath rather
than a bridge to someone else's.

## Build

```sh
npm install
npm run build          # from the repo root, or `npm run build -w packages/desktop-app`
```

Packaged builds — macOS `.dmg` (x64, arm64), Linux `.AppImage` and `.deb` (x86_64/amd64, arm64),
Windows `.exe` — are attached to every GitHub Release by the packaging workflow, gated on the npm
publish only: a registry the packages do not depend on must never be able to withhold the binaries.

## What it holds

It depends on `@xmbl/identity`, `@xmbl/networking`, `@xmbl/cubic-ledger`, `@xmbl/state-machine`,
`@xmbl/consensus` and `@xmbl/storage-compute` directly — the node runs **in** the app, so the wallet
signs against an identity this machine owns and the ledger view is this machine's own.

Private to this repo; it ships as a downloadable build, not as a published package.
