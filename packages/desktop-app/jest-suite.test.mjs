// THE DESKTOP SUITE, INSIDE THE HARD GATE (B4). Same seam as the CLI wrapper: @xmbl/desktop-app is a jest
// suite that `run-node-tests.mjs` could not see. It was 2/5 — main/main.js exported a constructed INSTANCE
// (so `new MainProcess()` threw) and booted the app at import time, `createWindow()` returned nothing, and
// `require('electron')` outside Electron returns the binary's path rather than the API. Fixed, with a
// recording electron double; the suite is 5/5 and now fails the build when it regresses.
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync('npx', ['jest', '--runInBand', '--forceExit'], {
  cwd: here,
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --experimental-vm-modules`.trim() },
});
if (r.error) { console.error(`desktop-app jest suite: ${r.error.message}`); process.exit(1); }
process.exit(r.status === 0 ? 0 : 1);
