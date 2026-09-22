#!/usr/bin/env bash
# Remove 0.2.0 from all twelve published @xmbl npm packages.
#
# WHY THIS IS A LOCAL SCRIPT AND NOT A CI JOB: npm restricts granular access tokens that bypass
# two-factor auth from account changes and direct publish/unpublish. The CI NPM_TOKEN is exactly
# such a token — it authenticates (whoami: 34r7h) but every `npm unpublish` returns E403.
# Measured in run 35684131799: removed=0 stuck=12. No automation credential can satisfy an
# interactive 2FA challenge, so the request has to come from a real logged-in session.
#
# DEADLINE: npm only permits unpublishing a specific version within 72h of its publish.
#   0.2.0 published 2026-09-21T03:06:14Z  ->  window closes 2026-09-24T03:06:14Z.
# After that the version is permanent (barring npm support) and the deprecation tombstone written
# by .github/workflows/tombstone-020.yml is the only remaining lever.
#
# crates.io is NOT affected: all eight xmbl-* crates carry only 0.1.15/0.1.16 (checked 2026-09-22).
#
set -uo pipefail

# No OTP argument, and none is possible. npm killed TOTP enrolment — `npm profile enable-2fa
# auth-only` answers "404 Adding a new TOTP 2FA is no longer supported ... add a security key
# instead" — so this account's 2FA is a passkey, and a passkey cannot emit six digits.
#
# With 2FA left at auth-and-writes, npm answers EOTP on every single unpublish and hands back a
# browser URL to authenticate: twelve packages, twelve Touch ID taps. Setting the mode to
# auth-only keeps 2FA enrolled (which the registry requires before it will unpublish at all) while
# letting the session token carry the writes, so the twelve run unattended.
#
# SETUP, once:
#   1. passkey enrolled at https://npmjs.com/settings/34r7h/tfa   (Touch ID qualifies)
#   2. npm profile enable-2fa auth-only     <- INTERACTIVE, prompts for the npm password
#   3. bash scripts/purge-020.sh
#
PKGS="cli consensus contracts core cubic-ledger identity lng networking simulator state-machine storage-compute zero-knowledge"

# The repo root holds a .npmrc with a CI-style _authToken, and a project .npmrc OUTRANKS the
# ~/.npmrc that `npm login` writes. Running from the repo would silently reuse the exact token
# that already returned E403 twelve times. Every npm call below runs from a scratch dir instead.
RUNDIR=$(mktemp -d)
trap 'rm -rf "$RUNDIR"' EXIT
cd "$RUNDIR"

WHO=$(npm whoami 2>&1) || {
  echo "NOT AUTHENTICATED as a 2FA-satisfied user: $WHO"
  echo "Run 'npm login --auth-type=web' first, with a passkey enrolled on the account."
  exit 1
}
echo "whoami: $WHO"
echo

gone=0; stuck=0
for p in $PKGS; do
  out=$(npm unpublish "@xmbl/$p@0.2.0" 2>&1)
  if [ $? -eq 0 ]; then
    echo "REMOVED  @xmbl/$p@0.2.0"; gone=$((gone+1))
  else
    # Record the REASON, not just the code. The CI purge grepped 'npm error code' first and
    # threw away the line that said why, which is how the cause stayed a guess for a day.
    reason=$(printf '%s\n' "$out" | grep -m1 -iE 'may not perform|two-factor|2fa|granular|cannot be unpublished|otp|one-time' | head -1)
    [ -n "$reason" ] || reason=$(printf '%s\n' "$out" | grep -m1 -E 'npm error (403|404|E[0-9]{3})' | head -1)
    echo "STUCK    @xmbl/$p@0.2.0 :: ${reason:-$(printf '%s' "$out" | head -1)}"
    stuck=$((stuck+1))
  fi
done
echo "---- attempted: removed=$gone stuck=$stuck ----"
echo

# COUNT AFTER — read the registry back, cache-busted, and count what is actually there.
# A zero exit from unpublish is not proof; the version list is.
echo "COUNT AFTER (reading the registry, not trusting the commands above):"
present=12
for attempt in 1 2 3 4 5; do
  present=0; still=""
  for p in $PKGS; do
    has=$(curl -s "https://registry.npmjs.org/@xmbl/$p?cb=$RANDOM$attempt" \
      | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(j.versions&&j.versions['0.2.0']?'1':'0')}catch(e){process.stdout.write('1')}})")
    if [ "$has" = "1" ]; then present=$((present+1)); still="$still @xmbl/$p"; fi
  done
  echo "attempt $attempt: 0.2.0 still present on $present/12${still:+ —$still}"
  [ "$present" = 0 ] && break
  sleep 20
done

echo
echo "latest dist-tag per package:"
for p in $PKGS; do echo "  @xmbl/$p -> $(npm view "@xmbl/$p" dist-tags.latest 2>/dev/null)"; done

echo
if [ "$present" = 0 ]; then
  echo "0.2.0 is GONE from all twelve packages."
else
  echo "0.2.0 NOT removed — $present/12 still carry it."
  exit 1
fi
