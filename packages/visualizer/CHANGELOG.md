# Changelog

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

## 0.1.11

All notable changes to the `xv` module will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this module adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
