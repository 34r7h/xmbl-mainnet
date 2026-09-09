# Vendored source

Copied (not a git submodule) from https://github.com/PQCMayo/MAYO-C, pinned at
commit `4b7cd94c96b9522864efe40c6ad1fa269584a807` ("Simplify downstream
integration (#9)") — the same commit the now-removed `xid/mayo-c-source` was
originally pinned to (see "A6" section below).

> **Full reviewer-facing provenance lives in [`../MAYO-PROVENANCE.md`](../MAYO-PROVENANCE.md)**
> (audit prep T2.1-a/b/c): the pin, the verified 39/40 byte-identical inventory,
> the single fork divergence with rationale, and the reproducible-build status.
> This file is the vendoring/history log; that file is the authoritative summary.

## Building + testing

The compiled artifact (`mayo.cjs` + `mayo.wasm`) **is committed to git**, so a
fresh clone runs the identity suite with no build step:

```bash
node scripts/run-node-tests.mjs packages/identity   # or: npm -w @xmbl/identity test
```

To rebuild the artifact from the vendored C (requires `emcc`/Emscripten on
`PATH`), run `../build-mayo-cube-wasm.sh` — see the "Build" section below and
`../MAYO-PROVENANCE.md` (T2.1-b) for the reproducibility status.

Vendored: `src/`, `include/`, `LICENSE`, `NOTICE`, `README.md` (renamed
`UPSTREAM-README.md` here to avoid shadowing this file).

**One intentional divergence from upstream** (F1a, see "KNOWN ISSUE" below,
now RESOLVED): `src/common/fips202.h`'s `shake256` declaration was `int`,
changed to `void` to match its actual implementation in `fips202.c`. This
fork is *ours* and is allowed to diverge from upstream for build-correctness
fixes like this one; it is otherwise byte-identical, and this is the only
line that differs. No crypto/algorithm change — the function body is
untouched.

Not vendored (upstream's own native CMake build/test tooling, not used by
the emscripten/WASM build in this repo): `KAT/` (known-answer test vectors,
~7.3MB), `test/`, `apps/`, `scripts/`, `.cmake/`, `.github/`, `META/`,
`.astylerc`, `CMakeLists.txt`.

## A6: `xid/mayo-c-source` removed, this fork is now the only copy

`xid/mayo-c-source` was committed as a git submodule gitlink (mode `160000`)
with no corresponding `.gitmodules` entry anywhere in this repo's history —
on a fresh clone it resolved to an empty directory, so `build-mayo-wasm.sh`
(which targeted it) and every xid suite touching `wasm-wrapper.js`
(`wasm-wrapper`, `identity`, `signer`, `agent-keystore`) only ever passed on
a machine that had separately, manually built the artifact there — never
from a genuine fresh clone (confirmed while verifying A1, and again by the
advisor's A6 finding).

**Resolution:** `xid/mayo-c-source` and the now-pointless `build-mayo-wasm.sh`
(its only source target) have been deleted. `wasm-wrapper.js`'s default
load path now points at this fork's `mayo.cjs`+`mayo.wasm` (today at
`packages/identity/mayo-cube/`), so there is exactly one vendored copy and it
works from a fresh clone. No more silent machine-dependence.

## Build

`../build-mayo-cube-wasm.sh` rebuilds `mayo.cjs` + `mayo.wasm` from the
vendored C. The artifact is **committed to git** (`git ls-files mayo.wasm
mayo.cjs`), so the identity suite runs from a fresh clone with no build step;
the script is for reproducibility checks and toolchain bumps. By default it
builds into a temp dir and does **not** touch the committed binary — pass
`--install` (or `OUT=<dir>`) to write elsewhere; `--check` builds and diffs
the sha256 against the committed artifact.

Recorded shipped sha256 (see `../MAYO-PROVENANCE.md` T2.1-b for the full
reproducibility status, including the emsdk-pin caveat for byte-identity):

```
mayo.wasm  e20b15f0178db35ac21522bba065d17696c0d65e0f3b9ad3faf8f8cdd24dc3a6
mayo.cjs   b8783ff8ba98c5c965f0ad3296a138d41d886b6d3652dfb21be0a9d122471d5c
```

Confirmed locally: `emcc` (Homebrew) compiles this cleanly and the resulting
artifact loads via `wasm-wrapper.js` and passes the identity suite (functional
equivalence); it is not byte-identical to the shipped bytes under a drifted
toolchain (T2.1-b).

## KNOWN ISSUE (RESOLVED in F1a): keygen crashed under today's toolchain

Both this fork's WASM build **and a from-scratch rebuild of unmodified
upstream** (verified locally at the time, not committed — the now-deleted
`xid/mayo-c-source` populated temporarily with the same 4b7cd94 source to
get an apples-to-apples control) crashed identically:

```
RuntimeError: unreachable
    at MAYOWasm.keygen (src/wasm-wrapper.js:84:27)
```

`wasm-ld` warns during both builds:

```
wasm-ld: warning: function signature mismatch: shake256
>>> defined as (i32, i32, i32, i32) -> i32 in mayo.o
>>> defined as (i32, i32, i32, i32) -> void in fips202.o
```

Root cause, confirmed by direct C-level test (not guessed): `src/common/
fips202.h` declares `int shake256(...)`, but `src/common/fips202.c` *defines*
`void shake256(...)` — a real prototype/implementation return-type mismatch
in upstream MAYO-C@4b7cd94 itself. Under this machine's Emscripten build,
wasm-ld links the mismatched types with only a warning instead of an error,
and the resulting call-site type confusion traps at runtime. This is **not**
a regression introduced by vendoring the fork — it reproduces identically
against untouched upstream source with the same toolchain.

**F1a applied the fix to this fork** (see divergence note above): changed
the declaration in `fips202.h` to match the real implementation —

```diff
- int shake256(unsigned char *output, size_t outputByteLen, const unsigned char *input, size_t inputByteLen);
+ void shake256(unsigned char *output, size_t outputByteLen, const unsigned char *input, size_t inputByteLen);
```

Verified: with the fork rebuilt and its artifact loaded (at the time, via
the now-superseded `xid/mayo-c-source` path; A6 made `mayo-cube` the direct
default), `npm -w xid test` passed 69/69 (the task's "35" estimate predates
other merged work that added more suites), stable across 3 consecutive
runs. Zero behavior/algorithm change — the function body is untouched, only
a stale forward declaration is corrected.

`xid/mayo-c-source` has since been deleted entirely (A6, see above) — this
fork is the only vendored copy now, and it's the one that actually works
from a fresh clone.
