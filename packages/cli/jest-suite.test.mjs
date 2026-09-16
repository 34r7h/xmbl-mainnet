// THE CLI SUITE, INSIDE THE HARD GATE (B4). `@xmbl/cli` is a jest suite, so `run-node-tests.mjs` — which runs
// plain-node `*.test.mjs` files — never saw it and 41 passing tests could regress without failing the build.
// This wrapper is the seam: it runs the real jest suite in a child process and exits with its status, so the
// CLI is one more line in `protocol suites: N/N` instead of a thing somebody remembers to run.
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync('npx', ['jest', '--runInBand', '--forceExit'], {
  cwd: here,
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --experimental-vm-modules`.trim() },
});
if (r.error) { console.error(`cli jest suite: ${r.error.message}`); process.exit(1); }
process.exit(r.status === 0 ? 0 : 1);
