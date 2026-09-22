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

**An empty secret is invisible except as a MISSING mask.** Actions replaces every non-empty secret
with `***` in the log, so an env line reading bare `NODE_AUTH_TOKEN:` or `CARGO_REGISTRY_TOKEN:`
means the value is genuinely empty — the job then compiles, tests and packs everything and dies at
the upload (`ENEEDAUTH` on npm, "please provide a non-empty token" on cargo). Check the mask first.
Both secrets existed by name and were empty on 2026-09-16. `NPM_TOKEN` was set that day from the
token in this box's `.env` (validated with `npm whoami`, never used to publish by hand), which means
**CI currently publishes with the laptop's own token**: rotate it locally and the next tag fails.
`CARGO_REGISTRY_TOKEN` was set on 2026-09-21 and all eight crates are live at 0.1.15.

## Resuming an interrupted release

`release.yml` also takes a `workflow_dispatch` with a `version` input. It runs the **cargo job
alone** — npm and packaging are guarded to tag pushes — and the cargo job skips any crate already
on the registry at that version. Use it when crates.io stops mid-run; never re-tag to retry.

Two things make a first cargo release impossible in one run, and both are handled in the job:

- **A verified email is required.** Without it every publish returns
  `400 A verified email address is required to publish crates to crates.io`, which looks like a bad
  token and is not. Verify at <https://crates.io/settings/profile>.
- **New crates are rate-limited**: a burst of 5, then one per hour. Eight new crates therefore
  cannot publish in a single run — the sixth returns `429`. The job retries across the refill and
  reports every crate still missing rather than stopping at the first.

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
