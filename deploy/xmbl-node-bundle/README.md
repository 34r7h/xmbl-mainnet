# xmbl-node-bundle — the fleet bundle that RUNS `@xmbl/core`

This replaces `xmbl-slim-node@0.1.8`, the bundle the fleet ran until 2026-09-17, which vendored a
hand-copied `core/` and declared **no `@xmbl/core` dependency at all**. Measured consequences of that
shape, on the live node (pid 32869, `~/.handoff/xmbl-node.old`), are in `docs/MAINNET-CLOSEOUT.md` §A8:
its control socket answers `{"ok":false,"error":"unknown op"}` to `release`, `identity_status` and
`chain` — the three ops that ARE the version proof — and its installed tree was still
networking 0.1.4 / consensus 0.1.3 / cubic-ledger 0.1.9 / state-machine 0.1.5 / identity 0.1.4 /
storage-compute 0.1.2 / zero-knowledge 0.1.1 the day twelve packages went to 0.1.11.

## The two rules this bundle exists to enforce

1. **One `@xmbl` dependency, and it is `@xmbl/core`.** The daemon is `bin/xmbl-node` from that package.
   Nothing here vendors `core/` or ships its own `node.js`; `@xmbl/core` carries the other seven
   protocol packages at `^0.1.11` itself, so they cannot skew against it.
2. **Pin it EXACTLY — never `"latest"`.** `latest` is resolved once, at install time, and then frozen in
   `node_modules`; it is not a self-updating channel. That single word is why publishing 0.1.11 moved
   nothing on the fleet. The exact pin is the version a box STARTS on: the OTA loop inside `@xmbl/core`
   is what moves it afterwards (`npm install @xmbl/core@<latest>` on its own schedule, A7).

## Install

```sh
cp config.example.json config.json     # then edit identity_path + data_dir to absolute paths
npm install
```

`npm install` runs `patch-floodsub.mjs` (see its header: an unhandled rejection in floodsub's cleanup
path took the whole mesh down on 2026-09-13; the patch is idempotent and never fails an install).

**Native prebuilds.** Recent npm refuses dependency install scripts until approved, and the node then
dies at boot with `Cannot find module '../../../build/Release/node_datachannel.node'`. Fix it in place:

```sh
( cd node_modules/node-datachannel && PATH="$PWD/../.bin:$PATH" prebuild-install -r napi )
```

## Run

```sh
npm start                      # xmbl-node start --config ./config.json (FOREGROUND — this IS the node)
```

Run it under a supervisor that **respawns on exit 75** (`OTA_EXIT_CODE`): that exit is how a node
restarts itself onto a newly installed version. Pass `--ppid <supervisor pid>` or set
`XMBL_SUPERVISED=1` so the daemon exits for the supervisor instead of respawning itself.

## Verify by OUTCOME, not by the install log

```sh
node -e 'import("@xmbl/core/package.json",{with:{type:"json"}}).then(m=>console.log(m.default.version))'
handoff xmbl status --json | grep -E '"core"|"build"'
```

The check that matters is the control socket answering `release`. `@xmbl/core@0.1.11` installed from the
registry answers it with all eight packages at `0.1.11` and
`build.digest = ac0f97e0f3861b4353984f50808d1f2fd540c410a8cc77ada1b56bee4d41dc15`. A node that returns
`unknown op` is still the old vendored bundle, whatever its directory is called.

## One node per machine

`xmbl-node start` refuses to boot beside a running node ("another node is ALREADY RUNNING ON THIS
MACHINE"). The swap is therefore stop-then-start on a box whose node may hold `validate`, `storage`,
`relay` and `lead` — not a side-by-side rehearsal.
