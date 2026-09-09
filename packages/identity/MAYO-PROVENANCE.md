# MAYO signing provenance (audit prep — T2.1-a / T2.1-b / T2.1-c)

Reviewer-facing provenance for the vendored MAYO post-quantum signature used by
`@xmbl/identity`. It answers three questions an auditor asks first: **what upstream
is this**, **how does it differ from upstream**, and **can I rebuild the shipped
binary myself**. Every claim below is verifiable from the tree with the commands shown.

The signing path is `index.js` → `src/wasm-wrapper.js` → `mayo-cube/mayo.cjs` +
`mayo-cube/mayo.wasm`. The wasm is a compiled artifact and **is committed to git**
(`git ls-files packages/identity/mayo-cube/mayo.wasm`).

---

## T2.1-a — upstream source and pin

| | |
|---|---|
| Upstream | **PQCMayo / MAYO-C** — <https://github.com/PQCMayo/MAYO-C> |
| Pinned commit | **`4b7cd94c96b9522864efe40c6ad1fa269584a807`** ("Simplify downstream integration (#9)") |
| Vendoring method | source copy (not a git submodule) under `packages/identity/mayo-cube/` |
| Present in this repo since | scaffold commit **`ad7e80d`** (2026-09-07) — `git log --follow -- packages/identity/mayo-cube/mayo.wasm` |
| Parameter set compiled | **MAYO_1**, **`opt`** (portable, non-SIMD) — NIST security level 1 |

The pin was verified against the live upstream remote: the commit resolves on
`github.com/PQCMayo/MAYO-C`, and the vendored C subtree is byte-identical to that
commit except for one line (see T2.1-c).

> **Honesty note for the auditor.** `ad7e80d` (2026-09-07) is when this subtree
> entered *this* repository, not a substantiated *upstream retrieval* date — the
> subtree was carried in from earlier internal work at scaffold time. The pin
> (`4b7cd94…`) is the authoritative statement of "what upstream this is"; treat the
> date as a repo-history fact, not a provenance claim about when the bytes were
> pulled from GitHub.

### Vendored inventory (the C we compile lives under `src/` + `include/`)

Compiled into the MAYO_1 `opt` artifact (see `../build-mayo-cube-wasm.sh`):

```
src/mayo.c  src/arithmetic.c  src/params.c  src/mayo_1/api.c
src/common/{fips202.c, aes_c.c, aes128ctr.c, mem.c, randombytes_system.c}
include/{mayo.h, mem.h, randombytes.h}
```

Also vendored but **not compiled** for this artifact (present so the subtree matches
upstream; the WASM target is portable + system-randombytes only): the SIMD backends
`src/AVX2/*` and `src/neon/*`, the other parameter sets `src/mayo_{2,3,5}/*`, the
CTR-DRBG RNG `src/common/randombytes_ctrdrbg.c`, and upstream's `src/CMakeLists.txt`.

Not vendored at all (upstream's native test/build tooling, unused here): `KAT/`,
`test/`, `apps/`, `scripts/`, top-level `CMakeLists.txt`, `.github/`, `META/`.

Upstream's own README is preserved as `mayo-cube/UPSTREAM-README.md`; its `LICENSE`
and `NOTICE` are vendored verbatim.

---

## T2.1-c — the single fork divergence, explained

Across the 40 files of the compiled `src/`+`include/` subtree, **39 are byte-identical
to upstream `4b7cd94…` and exactly 1 differs** — `src/common/fips202.h`:

```diff
--- upstream  src/common/fips202.h
+++ vendored  src/common/fips202.h
@@ -6,7 +6,7 @@
 #include <stddef.h>

 int shake128(unsigned char *output, size_t outputByteLen, const unsigned char *input, size_t inputByteLen);
-int shake256(unsigned char *output, size_t outputByteLen, const unsigned char *input, size_t inputByteLen);
+void shake256(unsigned char *output, size_t outputByteLen, const unsigned char *input, size_t inputByteLen);
```

**Why this is safe — it is a build-correctness fix, not a crypto change.** The header
in upstream `4b7cd94…` *declares* `int shake256(...)`, but the *definition* in
`fips202.c` is `void shake256(...)` — a stale forward declaration in upstream itself.
Both trees define it as `void`:

```
$ grep -nE '^(void|int) *shake256\(' src/common/fips202.c        # vendored
134:void shake256(uint8_t *output, size_t outlen, ...
890:void shake256(uint8_t *output, size_t outlen, ...
# identical in upstream 4b7cd94 at the same lines
```

Under Emscripten's `wasm-ld` the mismatched declaration/definition types are linked
with only a warning (`function signature mismatch: shake256 … (…)->i32 … vs …->void`),
and the resulting call-site type confusion **traps at runtime** (`RuntimeError:
unreachable` inside `keygen`). It reproduces identically against *untouched* upstream
built with the same toolchain, so it is upstream's latent bug, not something vendoring
introduced. The fork corrects only the forward declaration to match the real
implementation; **the function body is untouched — zero algorithm/behavior change.**

The authoritative diff is committed next to the vendored source as
[`mayo-cube/mayo-fork.diff`](./mayo-cube/mayo-fork.diff).

Reproduce the whole-tree comparison yourself:

```bash
git clone https://github.com/PQCMayo/MAYO-C /tmp/mayo-up
git -C /tmp/mayo-up checkout 4b7cd94c96b9522864efe40c6ad1fa269584a807
diff -rq packages/identity/mayo-cube/src /tmp/mayo-up/src        # only fips202.h differs
diff -rq packages/identity/mayo-cube/include /tmp/mayo-up/include # identical
```

---

## T2.1-b — reproducible build (status: **inputs pinned + functional equivalence proven;
byte-identity NOT yet achieved — see the open decision**)

The build is `packages/identity/build-mayo-cube-wasm.sh`. It pins every build **input**:
the exact source set, the defines (`-DMAYO_VARIANT=MAYO_1 -DMAYO_BUILD_TYPE_OPT`, and
critically *not* `ENABLE_PARAMS_DYNAMIC` — `mayo.h` tests it with `#ifdef`, so even
`=0` would switch on the dynamic MAX-size path and mismatch the static MAYO_1 buffers),
the include paths, the emcc flags, and the exported symbols + runtime methods the glue
resolves.

**Recorded shipped artifact sha256** (the committed bytes this doc describes):

```
mayo.wasm  e20b15f0178db35ac21522bba065d17696c0d65e0f3b9ad3faf8f8cdd24dc3a6
mayo.cjs   b8783ff8ba98c5c965f0ad3296a138d41d886b6d3652dfb21be0a9d122471d5c
```

Verify: `shasum -a 256 packages/identity/mayo-cube/mayo.{wasm,cjs}`.

### What is proven

- **Functional equivalence.** Rebuilding with the script and loading the fresh artifact
  passes the full identity suite (`node ../../scripts/run-node-tests.mjs .` → 5/5
  protocol suites), i.e. keygen/sign/verify behave identically.

### What is NOT yet proven, and why

- **Byte-identity.** A rebuild under the current Homebrew Emscripten produces a
  *functionally* equivalent but *not* byte-identical wasm (rebuild sha
  `0024210180bada8b35a908b71c5069266dc867c146eb7117cb037d39eaa111f7` ≠ shipped
  `e20b15f0…`). Emscripten codegen is toolchain-version-specific; the glue diff shows
  the drift directly — the shipped `mayo.cjs` uses minified single-letter wasm export
  names (`f`, `g`, `h`, …) while the current toolchain emits full names
  (`__wasm_call_ctors`, `randombytes`, …).
- **The original emsdk version is not recoverable from the binary.** Both the shipped
  and the rebuilt wasm have their `producers` and `target_features` custom sections
  **stripped** (`WebAssembly.Module.customSections(m, "producers")` → empty for both),
  so the exact clang/LLVM/emsdk that emitted the shipped bytes cannot be read back out.

### Open decision for the operator (this is what keeps T2.1-b `[ ]`)

Byte-reproducibility requires pinning the emsdk that produced the shipped artifact, but
that version is not recorded and not recoverable from the stripped binary. To close
T2.1-b as *byte-identical* one of the following must be chosen:

1. **Locate + pin** the original emsdk version (from build-machine history / CI logs),
   add it to CI, and confirm the rebuild matches `e20b15f0…`; or
2. **Adopt a freshly built artifact as canonical** under a newly pinned emsdk, record
   its sha256 here, and commit that artifact — a deliberate rotation of the signing
   binary, requiring operator sign-off.

Until then this doc pins the shipped bytes and the build **inputs**, and the CI gate can
already enforce the always-true half: the rebuild must pass the identity suite
(functional equivalence), so a toolchain bump surfaces as a sha change to be reviewed
and re-pinned rather than a silent divergence.
