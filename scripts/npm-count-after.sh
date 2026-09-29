#!/usr/bin/env bash
# COUNT A RELEASE OFF THE REGISTRY, not off the publish log. Exits 0 only when EVERY public workspace
# package lists version $1 in its document AND its tarball answers 200 — polled, because the registry is
# eventually consistent and a fresh publish can take minutes to appear.
#
# v0.1.20 printed `+ @xmbl/networking@0.1.20` at 09:11:45 and went green; the registry listed the version
# at 09:18:12 and 404'd its tarball after that, while the other eleven were live. A publish log is the
# publisher's account of itself; this is the registry's.
set -uo pipefail
V="${1:?usage: npm-count-after.sh <version> [attempts] [sleep-seconds]}"
ATTEMPTS="${2:-40}"; GAP="${3:-30}"   # npm commits a publish MINUTES after the CLI says so (0.1.19: ~12 min)
names=()
for dir in packages/*/; do
  read -r name private < <(node -e "const p=require('./${dir}package.json');console.log(p.name,!!p.private)")
  [ "$private" = "true" ] || names+=("$name")
done
for attempt in $(seq 1 "$ATTEMPTS"); do
  missing=()
  for name in "${names[@]}"; do
    base="${name#*/}"
    doc=$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/$name/$V?cb=$RANDOM$RANDOM")
    tgz=$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/$name/-/$base-$V.tgz")
    [ "$doc" = "200" ] && [ "$tgz" = "200" ] || missing+=("$name(doc $doc, tgz $tgz)")
  done
  echo "attempt $attempt: $(( ${#names[@]} - ${#missing[@]} ))/${#names[@]} on the registry at $V${missing:+ — missing: ${missing[*]}}"
  [ ${#missing[@]} -eq 0 ] && exit 0
  sleep "$GAP"
done
echo "::error::not on the registry at $V after $ATTEMPTS attempts: ${missing[*]}"
exit 1
