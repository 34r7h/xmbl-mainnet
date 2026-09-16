#!/usr/bin/env bash
# Reproducible build of the vendored MAYO-cube signing artifact (mayo.cjs + mayo.wasm).
#
# Reconstructed (T2.1-b / T11.1) from the committed glue's baked-in configuration after the original
# build-mayo-cube-wasm.sh was lost — see mayo-cube/VENDOR.md. The vendored C (mayo-cube/src + include)
# is upstream PQCMayo/MAYO-C @ 4b7cd94c96b9522864efe40c6ad1fa269584a807 with ONE build-correctness
# divergence (fips202.h shake256 int->void; see MAYO-PROVENANCE.md). This compiles the MAYO_1 "opt"
# (portable, non-SIMD) parameter set to a MODULARIZE'd CommonJS + wasm pair loaded by src/wasm-wrapper.js.
#
# Requires emcc (Emscripten) on PATH. Usage:
#   ./build-mayo-cube-wasm.sh            # build into a temp dir; DOES NOT touch the committed artifact
#   ./build-mayo-cube-wasm.sh --check    # build into a temp dir, then diff sha256 vs the committed artifact
#   ./build-mayo-cube-wasm.sh --install  # build directly into mayo-cube/ (rotates the committed binary)
#   OUT=/path ./build-mayo-cube-wasm.sh  # build into $OUT (explicit destination)
#
# The default is deliberately NON-destructive: the shipped mayo.wasm/mayo.cjs are a committed crypto
# artifact, so a casual "does it still build" must never silently overwrite them. Rotating the binary is
# an explicit --install (or OUT=mayo-cube/) — see MAYO-PROVENANCE.md (T2.1-b) for the operator decision.
#
# Reproducibility: emcc codegen is toolchain-version-specific, so byte-identity needs the toolchain PINNED
# as well as the inputs. Both are pinned here now — EMSDK_PIN below, and the sources/defines/flags/exports
# in this file — and the committed artifact was rebuilt under that pin on 2026-09-17, replacing the one
# whose emsdk version was never recorded and is not recoverable (the wasm `producers` section is stripped).
#
#   RECORDED, under emsdk 6.0.9 (release 4e4223852a0835923411059a3929907d7df1232e):
#     mayo.wasm c972bba439427918b63d9308f368f3f530cf929845b6bae2a586765c5b715393
#     mayo.cjs  27634e618002c35e6d71bb144f1e0916a11cca313dee83aeadead96497ba0c45
#
# `--check` rebuilds and compares against BOTH the committed files and those recorded digests, so editing
# the artifact and the record together still fails. Install the pin with:
#   git clone https://github.com/emscripten-core/emsdk && cd emsdk && ./emsdk install 6.0.9 \
#     && ./emsdk activate 6.0.9 && source ./emsdk_env.sh
# A DIFF under the pinned version is a REAL failure (inputs changed). A DIFF under any other version is
# only evidence that emcc codegen moved: re-pin deliberately, re-record both digests, and say so in
# MAYO-PROVENANCE.md — never just overwrite the numbers.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/mayo-cube"
MODE="build"
case "${1:-}" in
  --check)   MODE="check" ;;
  --install) OUT="$SRC" ;;
  "" )       : ;;
  * ) echo "ERROR: unknown arg '$1' (use --check, --install, or OUT=<dir>)" >&2; exit 2 ;;
esac
# Default (and --check) build into a temp dir so the committed artifact is never clobbered by accident.
OUT="${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/mayo-build.XXXXXX")}"
mkdir -p "$OUT"

# THE TOOLCHAIN PIN. Byte-identity is only claimed under this exact emsdk release.
EMSDK_PIN="6.0.9"
RECORDED_WASM_SHA="c972bba439427918b63d9308f368f3f530cf929845b6bae2a586765c5b715393"
RECORDED_CJS_SHA="27634e618002c35e6d71bb144f1e0916a11cca313dee83aeadead96497ba0c45"

# sha256 of a file, on both hosts this build runs on: macOS ships `shasum`, the Debian-based emsdk
# container ships `sha256sum`. Prints the bare digest, nothing else.
sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else echo "ERROR: neither shasum nor sha256sum on PATH" >&2; exit 1; fi
}

command -v emcc >/dev/null 2>&1 || { echo "ERROR: emcc (Emscripten) not on PATH" >&2; exit 1; }
EMCC_LINE="$(emcc --version | head -1)"
EMCC_VER="$(printf '%s' "$EMCC_LINE" | sed -n 's/.*replacement + linker emulating GNU ld) \([^ ]*\).*/\1/p')"
echo "emcc: $EMCC_LINE"
echo "pin:  emsdk $EMSDK_PIN (this build reports '${EMCC_VER:-unknown}')"
if [ "$EMCC_VER" != "$EMSDK_PIN" ]; then
  echo "WARN: toolchain is NOT the pinned emsdk $EMSDK_PIN — the output is not expected to be byte-identical." >&2
fi
echo "out:  $OUT"

# MAYO_1 opt (portable) source set — NO AVX2/NEON (WASM target), NO CTR-DRBG (system randombytes uses the
# EM_ASM crypto.randomBytes bridge baked into randombytes_system.c, matching the glue's ASM_CONSTS).
SOURCES=(
  "$SRC/src/mayo.c"
  "$SRC/src/arithmetic.c"
  "$SRC/src/params.c"
  "$SRC/src/mayo_1/api.c"
  "$SRC/src/common/fips202.c"
  "$SRC/src/common/aes_c.c"
  "$SRC/src/common/aes128ctr.c"
  "$SRC/src/common/mem.c"
  "$SRC/src/common/randombytes_system.c"
)

# Namespace: PARAM_JOIN3(MAYO_1, opt, fn) => pqmayo_MAYO_1_opt_<fn> (include/mayo.h). Select MAYO_1 + opt.
# MUST NOT define ENABLE_PARAMS_DYNAMIC: mayo.h tests it with #ifdef (definedness, not value), so even
# =0 would switch on the dynamic MAX-size param path and mismatch the static MAYO_1 buffer sizes (keygen
# then writes out of bounds). Upstream CMake defines it ONLY for the generic `mayo` lib, never for the
# per-variant MAYO_1 target — which is exactly this build.
DEFINES=( -DMAYO_VARIANT=MAYO_1 -DMAYO_BUILD_TYPE_OPT )
INCLUDES=( -I"$SRC/include" -I"$SRC/src" -I"$SRC/src/common" -I"$SRC/src/generic" -I"$SRC/src/mayo_1" )

# Exports the glue resolves (assignWasmExports): the five MAYO_1 opt NIST-API entry points + randombytes +
# the allocator. Runtime methods the wrapper calls: ccall/cwrap/UTF8ToString/stringToUTF8.
EXPORTS='["_pqmayo_MAYO_1_opt_crypto_sign_keypair","_pqmayo_MAYO_1_opt_crypto_sign","_pqmayo_MAYO_1_opt_crypto_sign_signature","_pqmayo_MAYO_1_opt_crypto_sign_open","_pqmayo_MAYO_1_opt_crypto_sign_verify","_randombytes","_malloc","_free"]'
# HEAPU8 is required by src/wasm-wrapper.js (keygen zero-init + _readBytes). Recent emscripten no longer
# attaches the typed-array HEAP views to Module unless they are named here, so list them explicitly.
RT_METHODS='["ccall","cwrap","UTF8ToString","stringToUTF8","HEAPU8","HEAP8","HEAPU32","HEAP32"]'

emcc -O2 "${DEFINES[@]}" "${INCLUDES[@]}" "${SOURCES[@]}" \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=createModule \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MAXIMUM_MEMORY=134217728 \
  -s STACK_SIZE=5242880 \
  -s INITIAL_MEMORY=16777216 \
  -s EXPORTED_FUNCTIONS="$EXPORTS" \
  -s EXPORTED_RUNTIME_METHODS="$RT_METHODS" \
  -s ENVIRONMENT=node,web,worker \
  -s EXPORT_ES6=0 \
  -o "$OUT/mayo.cjs"

echo "built: $OUT/mayo.cjs $OUT/mayo.wasm"
for f in mayo.wasm mayo.cjs; do echo "$(sha256 "$OUT/$f")  $OUT/$f"; done

if [ "$MODE" = "check" ]; then
  echo "--- reproducibility check vs committed artifact AND recorded digest ---"
  rc=0
  for f in mayo.wasm mayo.cjs; do
    case "$f" in mayo.wasm) rec="$RECORDED_WASM_SHA" ;; *) rec="$RECORDED_CJS_SHA" ;; esac
    got="$(sha256 "$OUT/$f")"
    want="$(sha256 "$SRC/$f")"
    if [ "$got" = "$want" ] && [ "$got" = "$rec" ]; then echo "OK    $f  $got"
    elif [ "$got" != "$want" ]; then echo "DIFF  $f  rebuilt=$got  committed=$want"; rc=1
    else echo "DIFF  $f  rebuilt=$got  committed=$want  BUT recorded=$rec — the committed artifact and the record disagree"; rc=1; fi
  done
  if [ $rc -eq 0 ]; then
    echo "byte-identical to the committed artifact and to the recorded digest (emsdk $EMSDK_PIN)"
  elif [ "$EMCC_VER" != "$EMSDK_PIN" ]; then
    echo "NOT byte-identical, and this is NOT the pinned toolchain (have '${EMCC_VER:-unknown}', need emsdk $EMSDK_PIN) — install the pin before reading anything into this."
  else
    echo "NOT byte-identical UNDER THE PINNED TOOLCHAIN — the build inputs changed. This is a real failure: find the change, do not re-record the digest to make it pass."
  fi
  exit $rc
fi
