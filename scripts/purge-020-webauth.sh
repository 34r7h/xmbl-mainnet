#!/usr/bin/env bash
# Remove 0.2.0 from the twelve @xmbl packages WITHOUT changing the account's 2FA mode.
#
# At auth-and-writes npm answers every unpublish with EOTP and a browser URL. Given a real
# terminal it opens that URL itself and waits; `script -q /dev/null` supplies the pty that a
# background shell does not have. So: twelve unpublishes, twelve browser prompts, one Touch ID
# tap each. No password, no settings change.
#
# Window closes 2026-09-24T03:06:14Z.
set -uo pipefail
PKGS="cli consensus contracts core cubic-ledger identity lng networking simulator state-machine storage-compute zero-knowledge"
RUNDIR=$(mktemp -d); trap 'rm -rf "$RUNDIR"' EXIT; cd "$RUNDIR"

echo "whoami: $(npm whoami 2>&1)"
echo ">>> A BROWSER TAB WILL OPEN TWELVE TIMES. Approve each with Touch ID. <<<"
echo

# npm prints the auth URL to stderr and redacts it from its own debug log, so it must be caught
# here or it is unrecoverable. Piping straight to tail also buffers it out of sight, which is how
# the first run ended up waiting on a browser tab that had never opened. Capture, then open it.
for p in $PKGS; do
  echo "--- @xmbl/$p@0.2.0 ---"
  ( script -q /dev/null npm unpublish "@xmbl/$p@0.2.0" > "$RUNDIR/$p.out" 2>&1 ) &
  job=$!
  for _ in $(seq 1 40); do
    url=$(grep -ahoE 'https://www\.npmjs\.com/auth/cli/[A-Za-z0-9-]+' "$RUNDIR/$p.out" 2>/dev/null | head -1)
    [ -n "$url" ] && { open "$url"; echo "    browser opened — approve with Touch ID"; break; }
    kill -0 "$job" 2>/dev/null || break
    sleep 1
  done
  wait "$job"
  tail -3 "$RUNDIR/$p.out"
done

# COUNT AFTER — the registry's version list is the only thing that settles this.
echo
present=0; still=""
for p in $PKGS; do
  has=$(curl -s "https://registry.npmjs.org/@xmbl/$p?cb=$RANDOM" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(j.versions&&j.versions['0.2.0']?'1':'0')}catch(e){process.stdout.write('1')}})")
  [ "$has" = "1" ] && { present=$((present+1)); still="$still @xmbl/$p"; }
done
echo "0.2.0 still present on $present/12${still:+ —$still}"
[ "$present" = 0 ] && echo "0.2.0 GONE from all twelve." || exit 1
