#!/usr/bin/env bash
# Remove 0.2.0 from the @xmbl packages that still carry it.
#
# TWO things block this, and both are handled here.
#
# 1. OTP. The account sits at auth-and-writes, so npm answers every unpublish with EOTP and a
#    browser URL. Given a pty it opens that URL itself; `script -q /dev/null` supplies the pty a
#    background shell lacks. npm redacts the URL from its own debug log (authId=***) and piping
#    stderr to tail buffers it out of sight, so it is captured to a file and opened explicitly.
#
# 2. ORDER. npm refuses with
#      405 You can no longer unpublish this package. Failed criteria: has dependent packages
#    while anything still published depends on the target. The @xmbl 0.2.0 versions depend on each
#    other, so a flat alphabetical loop strands most of them — the first pass removed only
#    cli/contracts/core/lng for exactly this reason. At 0.2.0 the edges are:
#      consensus      -> identity, cubic-ledger
#      cubic-ledger   -> identity
#      storage-compute-> identity
#      identity, networking, simulator, state-machine, zero-knowledge -> nothing
#    so dependents must go before their dependencies: consensus, then cubic-ledger and
#    storage-compute, then identity, with the independents anywhere.
#
# Window closes 2026-09-24T03:06:14Z.
set -uo pipefail

ORDER="consensus storage-compute cubic-ledger identity networking simulator state-machine zero-knowledge"

RUNDIR=$(mktemp -d); trap 'rm -rf "$RUNDIR"' EXIT; cd "$RUNDIR"
echo "whoami: $(npm whoami 2>&1)"
echo ">>> A BROWSER TAB OPENS PER PACKAGE. Approve each with Touch ID. <<<"
echo

for p in $ORDER; do
  # Skip anything already gone, so a re-run is safe.
  has=$(curl -s "https://registry.npmjs.org/@xmbl/$p?cb=$RANDOM" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(j.versions&&j.versions['0.2.0']?'1':'0')}catch(e){process.stdout.write('1')}})")
  [ "$has" = "1" ] || { echo "--- @xmbl/$p@0.2.0 already gone ---"; continue; }

  echo "--- @xmbl/$p@0.2.0 ---"
  ( script -q /dev/null npm unpublish "@xmbl/$p@0.2.0" > "$RUNDIR/$p.out" 2>&1 ) &
  job=$!
  for _ in $(seq 1 40); do
    url=$(grep -ahoE 'https://www\.npmjs\.com/auth/cli/[A-Za-z0-9-]+' "$RUNDIR/$p.out" 2>/dev/null | head -1)
    [ -n "$url" ] && { open "$url"; echo "    approve in browser"; break; }
    kill -0 "$job" 2>/dev/null || break
    sleep 1
  done
  wait "$job"
  grep -ahoE 'You can no longer unpublish|has dependent packages|E[0-9]{3}' "$RUNDIR/$p.out" | head -2 | sed 's/^/    /'
done

# COUNT AFTER — the registry's version list decides this, not exit codes.
echo
present=0; still=""
for p in cli consensus contracts core cubic-ledger identity lng networking simulator state-machine storage-compute zero-knowledge; do
  has=$(curl -s "https://registry.npmjs.org/@xmbl/$p?cb=$RANDOM" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(j.versions&&j.versions['0.2.0']?'1':'0')}catch(e){process.stdout.write('1')}})")
  [ "$has" = "1" ] && { present=$((present+1)); still="$still $p"; }
done
echo "0.2.0 still present on $present/12${still:+ —$still}"
[ "$present" = 0 ] && echo "0.2.0 GONE from all twelve." || exit 1
