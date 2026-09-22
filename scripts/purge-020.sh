#!/usr/bin/env bash
# Remove 0.2.0 from all twelve published @xmbl npm packages, in ONE run, from YOUR terminal.
#
# Run it as:   bash scripts/purge-020.sh
# It asks for your npm password ONCE, then does everything else unattended.
#
# WHY IT HAS TO BE YOU AND NOT THE AGENT: npm gates unpublish behind real 2FA. With the account
# at auth-and-writes, every single unpublish returns EOTP and a browser URL — twelve packages,
# twelve Touch ID taps. Dropping to auth-only keeps 2FA enrolled (the registry will not unpublish
# without it) while letting the session token carry the writes. That switch prompts for the
# account password on a TTY, which a background agent has no way to answer.
#
# DEADLINE: npm allows unpublishing a single version only within 72h of its publish.
#   0.2.0 published 2026-09-21T03:06:14Z  ->  window closes 2026-09-24T03:06:14Z.
#
# crates.io is unaffected: all eight xmbl-* crates carry only 0.1.15/0.1.16.
set -uo pipefail

PKGS="cli consensus contracts core cubic-ledger identity lng networking simulator state-machine storage-compute zero-knowledge"

# The repo's own .npmrc carries an _authToken, and a project .npmrc OUTRANKS the ~/.npmrc that
# `npm login` writes — running from the repo root would silently reuse a token that cannot do this.
RUNDIR=$(mktemp -d); trap 'rm -rf "$RUNDIR"' EXIT; cd "$RUNDIR"

WHO=$(npm whoami 2>&1) || { echo "not logged in: $WHO"; echo "run: npm login --auth-type=web"; exit 1; }
echo "whoami: $WHO"

mode() { npm profile get 2>/dev/null | sed -n 's/^two-factor auth: *//p'; }
echo "2FA mode: $(mode)"

if [ "$(mode)" != "auth-only" ]; then
  echo
  echo ">>> Switching 2FA to auth-only. Enter your npm password at the prompt. <<<"
  npm profile enable-2fa auth-only
  echo "2FA mode now: $(mode)"
  [ "$(mode)" = "auth-only" ] || { echo "STILL $(mode) — the switch did not take, so unpublish will keep returning EOTP."; exit 1; }
fi

echo
gone=0; stuck=0
for p in $PKGS; do
  out=$(npm unpublish "@xmbl/$p@0.2.0" 2>&1)
  if [ $? -eq 0 ]; then echo "REMOVED  @xmbl/$p@0.2.0"; gone=$((gone+1))
  else
    reason=$(printf '%s\n' "$out" | grep -m1 -iE 'may not perform|two-factor|2fa|one-time|otp|cannot be unpublished|granular' | head -1)
    [ -n "$reason" ] || reason=$(printf '%s\n' "$out" | grep -m1 -E 'npm error' | head -1)
    echo "STUCK    @xmbl/$p@0.2.0 :: $reason"; stuck=$((stuck+1))
  fi
done
echo "---- attempted: removed=$gone stuck=$stuck ----"

# COUNT AFTER. Only the registry's own version list decides this — a zero exit proves nothing.
echo
present=12
for attempt in 1 2 3 4 5; do
  present=0; still=""
  for p in $PKGS; do
    has=$(curl -s "https://registry.npmjs.org/@xmbl/$p?cb=$RANDOM$attempt" \
      | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(j.versions&&j.versions['0.2.0']?'1':'0')}catch(e){process.stdout.write('1')}})")
    [ "$has" = "1" ] && { present=$((present+1)); still="$still @xmbl/$p"; }
  done
  echo "0.2.0 still present on $present/12${still:+ —$still}"
  [ "$present" = 0 ] && break
  sleep 15
done

echo
for p in $PKGS; do echo "  @xmbl/$p latest -> $(npm view "@xmbl/$p" dist-tags.latest 2>/dev/null)"; done
echo
[ "$present" = 0 ] && echo "0.2.0 GONE from all twelve." || { echo "0.2.0 NOT removed — $present/12 remain."; exit 1; }
