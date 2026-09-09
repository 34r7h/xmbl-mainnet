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
# Reproducibility note: emcc codegen is toolchain-version-specific, so byte-identity requires the SAME
# emsdk version that produced the shipped artifact (its version is NOT recoverable — the wasm `producers`
# section is stripped). This script pins the build INPUTS (sources, defines, flags, exports); pin the emsdk
# version in CI to pin the OUTPUT. The reproducibility gate verifies the rebuilt artifact (a) matches the
# recorded sha256 under the pinned toolchain, and always (b) passes the identity suite — functional
# equivalence — so a toolchain bump is caught as a sha change, reviewed, and re-pinned.
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

command -v emcc >/dev/null 2>&1 || { echo "ERROR: emcc (Emscripten) not on PATH" >&2; exit 1; }
echo "emcc: $(emcc --version | head -1)"
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
if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$OUT/mayo.wasm" "$OUT/mayo.cjs"; fi

if [ "$MODE" = "check" ]; then
  echo "--- reproducibility check vs committed artifact ---"
  rc=0
  for f in mayo.wasm mayo.cjs; do
    got="$(shasum -a 256 "$OUT/$f" | awk '{print $1}')"
    want="$(shasum -a 256 "$SRC/$f" | awk '{print $1}')"
    if [ "$got" = "$want" ]; then echo "OK    $f  $got";
    else echo "DIFF  $f  rebuilt=$got  committed=$want"; rc=1; fi
  done
  [ $rc -eq 0 ] && echo "byte-identical to the committed artifact" \
                || echo "NOT byte-identical (expected under a drifted emsdk — see MAYO-PROVENANCE.md T2.1-b; functional equivalence is checked by the identity suite)"
  exit $rc
fi
