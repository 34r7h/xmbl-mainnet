# Releasing XMBL

Every `@xmbl/*` protocol package and every `xmbl-*` crate moves on **one version line**
(changesets `fixed` group + a shared Cargo `workspace.version`). Apps (`@xmbl/explorer`,
`browser-extension`, `desktop-app`, the `xmbl` app builder) are versioned but not published to
a registry — they ship as GitHub Release artifacts.

## Cutting a release

1. **Record intent** during development:
   ```bash
   npm run changeset        # pick bump level + write a summary
   ```
2. **Apply the version bump** (updates every package.json in the fixed group + changelogs):
   ```bash
   npm run version
   ```
   Then bump `workspace.package.version` in `Cargo.toml` to the same number so npm and crates
   stay in lockstep.
3. **Tag and push** — this is the only trigger:
   ```bash
   git commit -am "release: vX.Y.Z"
   git tag vX.Y.Z
   git push origin main --tags
   ```

## What the tag does (`.github/workflows/release.yml`)

- **npm**: `npm publish --workspaces --access public --provenance` publishes every non-private
  package at the tag version, with signed provenance.
- **crates.io**: publishes the eight crates in dependency order (`identity → networking →
  cubic-ledger → state-machine → consensus → storage-compute → zero-knowledge → core`), pausing
  for the index between dependents.
- **artifacts** (`package.yml`): builds and attaches to the GitHub Release —
  - desktop app for **macOS** (`.dmg`), **Linux** (`.AppImage`/`.deb`), **Windows** (`.exe`)
    via electron-builder;
  - **web** bundles for the Explorer and app builder (`.tgz`);
  - the **browser extension** (`.zip`).

## Required repository secrets

| secret | used by |
|---|---|
| `NPM_TOKEN` | npm publish (automation token, publish scope) |
| `CARGO_REGISTRY_TOKEN` | crates.io publish |

`GITHUB_TOKEN` (built in) covers the Release upload.

## Never publish by hand

`npm publish` from a laptop (an `.npmrc` token, a per-package bump to get one fix out) is how the
line fractured on 2026-09-15/16: cubic-ledger reached 0.1.10 while zero-knowledge sat at 0.1.1 and
the crates never left 0.1.0, one publish was reverted as unauthorized, two versions wedged as
"staged" on npm, and the last one shipped with the protocol gate red. The tag is the only trigger:
it runs `npm run test:protocol` first, publishes every package at ONE version with provenance, and
publishes the crates at the same number. A fix that must reach a deployment before the next tag
goes in as a commit and a tag, not as a hand-published patch.

## Versioning policy

- **patch** — fixes, no API change.
- **minor** — additive, backward-compatible API.
- **major** — breaking protocol or API change. Because the protocol modules interoperate on the
  wire, a wire-format change is always **major** across the whole line.
