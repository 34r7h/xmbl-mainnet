#!/usr/bin/env bash
# Build an INSTRUMENTED MAYO_1 artifact (the five NIST entry points plus mayo_expand_pk / mayo_expand_sk)
# into a temp directory and time where MAYO actually spends its cycles. See profile-mayo-cost.cjs.
#
# The committed artifact in mayo-cube/ is NEVER touched — this always builds into a fresh temp dir. The
# sources, defines and includes are the SAME ones build-mayo-cube-wasm.sh uses; only EXPORTED_FUNCTIONS
# differs (it adds the two expand_* symbols), so the timings describe the shipped code.
#
# Usage:  ./profile-mayo-cost.sh [iterations]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/mayo-cube"
N="${1:-300}"
command -v emcc >/dev/null 2>&1 || { echo "ERROR: emcc (Emscripten) not on PATH" >&2; exit 1; }
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mayo-profile.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
echo "emcc: $(emcc --version | head -1)"

emcc -O2 -DMAYO_VARIANT=MAYO_1 -DMAYO_BUILD_TYPE_OPT \
  -I"$SRC/include" -I"$SRC/src" -I"$SRC/src/common" -I"$SRC/src/generic" -I"$SRC/src/mayo_1" \
  "$SRC/src/mayo.c" "$SRC/src/arithmetic.c" "$SRC/src/params.c" "$SRC/src/mayo_1/api.c" \
  "$SRC/src/common/fips202.c" "$SRC/src/common/aes_c.c" "$SRC/src/common/aes128ctr.c" \
  "$SRC/src/common/mem.c" "$SRC/src/common/randombytes_system.c" \
  -s MODULARIZE=1 -s EXPORT_NAME=createModule -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=134217728 \
  -s STACK_SIZE=5242880 -s INITIAL_MEMORY=16777216 \
  -s EXPORTED_FUNCTIONS='["_pqmayo_MAYO_1_opt_crypto_sign_keypair","_pqmayo_MAYO_1_opt_crypto_sign_signature","_pqmayo_MAYO_1_opt_crypto_sign_verify","_pqmayo_MAYO_1_opt_mayo_expand_pk","_pqmayo_MAYO_1_opt_mayo_expand_sk","_randombytes","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["cwrap","HEAPU8"]' \
  -s ENVIRONMENT=node -s EXPORT_ES6=0 -o "$OUT/prof.cjs"

node "$HERE/profile-mayo-cost.cjs" "$OUT/prof.cjs" "$N"
