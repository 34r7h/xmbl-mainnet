// NO ROOM, NO NPM — AND THE REASON IS ON THE NODE, NOT LOST IN NPM'S OUTPUT. 4293b3c6 had 47 MB free on 2026-10-11
// and was handed every update all the same. installPreflight reads the free space under the install root before
// npm runs and refuses below the floor; memory is read and reported, never refused on (npm peaked at 121 MB for
// the 0.1.25 -> 0.1.26 upgrade, and that box installed with 130-145 MB available).
//
// The rule by table, then real processes the way ota-restart.test.mjs runs them: a launcher spawns xmbl-node with
// --ppid, a local release source says a newer version exists, and `npm` is a stub that writes the eight
// package.json files. A floor above the free space must leave npm uncalled, the node up and the numbers in
// ota.last_error; the same box started again without the floor must install and hand back exit 75.
import assert from 'node:assert';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPreflight, OTA_MIN_FREE_MB, OTA_EXIT_CODE, XMBL_PACKAGES } from './release.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE_BIN = join(HERE, 'bin', 'xmbl-node.js');
const CORE_VERSION = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version;
const NEXT = CORE_VERSION.replace(/\d+$/, (p) => String(Number(p) + 1000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };

// ---- the rule, by table ----
const MB = 1048576;
const disk = (mb) => () => ({ bavail: mb, bsize: MB });
const mem = (kb) => () => `MemTotal:  999999 kB\nMemFree:  1 kB\nMemAvailable:   ${kb} kB\n`;
{
  const r = installPreflight('/x', { minFreeMb: 32, statfs: disk(31), meminfo: mem(512 * 1024) });
  ok(`31 MB free under a 32 MB floor is refused, with both numbers ("${r.reason}")`, r.ok === false && r.free_mb === 31 && /31 MB free in \/x, an update needs 32 MB/.test(r.reason));
}
ok('32 MB free under a 32 MB floor installs', installPreflight('/x', { minFreeMb: 32, statfs: disk(32), meminfo: mem(1) }).ok === true);
{
  const r = installPreflight('/x', { minFreeMb: 32, statfs: disk(9000), meminfo: mem(1024) });
  ok(`memory is reported, never refused on: 1 MB available still installs (mem_available_mb ${r.mem_available_mb})`, r.ok === true && r.mem_available_mb === 1);
}
{
  const r = installPreflight('/x', { statfs: () => { throw new Error('ENOSYS'); }, meminfo: mem(2048) });
  ok('a box that cannot report its disk is not refused (free_mb null)', r.ok === true && r.free_mb === null);
}
{
  const r = installPreflight('/x', { statfs: disk(100), meminfo: () => { throw new Error('ENOENT'); }, freeBytes: () => 300 * MB });
  ok(`no /proc/meminfo (macOS): os.freemem is reported instead (${r.mem_available_mb} MB)`, r.mem_available_mb === 300);
}
{
  const saved = process.env.XMBL_OTA_MIN_FREE_MB;
  process.env.XMBL_OTA_MIN_FREE_MB = '0';
  const off = installPreflight('/x', { statfs: disk(0), meminfo: mem(1) });
  process.env.XMBL_OTA_MIN_FREE_MB = 'lots';
  const junk = installPreflight('/x', { statfs: disk(0), meminfo: mem(1) });
  process.env.XMBL_OTA_MIN_FREE_MB = '500';
  const raised = installPreflight('/x', { statfs: disk(499), meminfo: mem(1) });
  if (saved === undefined) delete process.env.XMBL_OTA_MIN_FREE_MB; else process.env.XMBL_OTA_MIN_FREE_MB = saved;
  ok('XMBL_OTA_MIN_FREE_MB=0 turns the check off', off.ok === true && off.min_free_mb === 0);
  ok(`an unreadable XMBL_OTA_MIN_FREE_MB keeps the ${OTA_MIN_FREE_MB} MB default`, junk.min_free_mb === OTA_MIN_FREE_MB && junk.ok === false);
  ok('XMBL_OTA_MIN_FREE_MB=500 raises the floor', raised.ok === false && raised.min_free_mb === 500);
}
ok('the real disk under this test is read (statfs works here)', Number.isFinite(installPreflight(tmpdir()).free_mb));

// ---- real processes ----
const dirs = [];
const procs = [];
const b = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'xmbl-ota-room-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'install'));
  writeFileSync(join(dir, 'bin', 'npm'), `#!/bin/sh
echo "$@" >> "${join(dir, 'npm.log')}"
for a in "$@"; do case "$a" in @xmbl/*@*) n="\${a%@*}"; v="\${a##*@}"; mkdir -p "node_modules/$n"; printf '{"name":"%s","version":"%s"}\\n' "$n" "$v" > "node_modules/$n/package.json";; esac; done
exit 0
`);
  chmodSync(join(dir, 'bin', 'npm'), 0o755);
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({
    identity_path: join(dir, 'id', 'xmbl.json'), data_dir: join(dir, 'data'),
    listen_addrs: ['/ip4/127.0.0.1/tcp/0'], bootstrap_peers: [],
  }));
  return { dir, cfg, sock: join(dir, 'data', 'node.sock'), log: join(dir, 'node.log'), exit: join(dir, 'child-exit'), npm: join(dir, 'npm.log') };
})();

const srv = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ 'dist-tags': { latest: NEXT } })));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const RELEASE_URL = `http://127.0.0.1:${srv.address().port}/`;

function launcher(extra) {
  const src = `
    const { spawn } = require('node:child_process'); const fs = require('node:fs');
    const out = fs.openSync(${JSON.stringify(b.log)}, 'a');
    const c = spawn(process.execPath, [${JSON.stringify(NODE_BIN)}, 'start', '--config', ${JSON.stringify(b.cfg)}, '--ppid', String(process.pid)],
      { stdio: ['ignore', out, out], detached: false, env: process.env });
    c.on('exit', (code) => fs.writeFileSync(${JSON.stringify(b.exit)}, String(code)));
    setInterval(() => {}, 1 << 30);`;
  const env = {
    ...process.env, XMBL_OTA_GRACE_MS: '0', PATH: `${join(b.dir, 'bin')}:${process.env.PATH}`, XMBL_RELEASE_URL: RELEASE_URL,
    XMBL_INSTALL_DIR: join(b.dir, 'install'), XMBL_MACHINE_LOCK: join(b.dir, 'machine.lock'), ...extra,
  };
  if (extra.XMBL_OTA_MIN_FREE_MB === undefined) delete env.XMBL_OTA_MIN_FREE_MB;
  const p = spawn(process.execPath, ['-e', src], { stdio: 'ignore', env, detached: true });
  procs.push(p.pid);
  return p;
}
function call(sockPath, req, timeoutMs = 2000) {
  return new Promise((res) => {
    const s = net.connect(sockPath); let buf = '';
    const t = setTimeout(() => { s.destroy(); res(null); }, timeoutMs);
    s.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(t); s.end(); try { res(JSON.parse(buf.slice(0, i))); } catch { res(null); } } });
    s.on('error', () => { clearTimeout(t); res(null); });
    s.on('connect', () => s.write(JSON.stringify(req) + '\n'));
  });
}
async function until(fn, ms, step = 250) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; }
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

// ---- 1. the floor is above the free space ----
{
  const L = launcher({ XMBL_OTA_MIN_FREE_MB: String(1e12) });
  const st = await until(() => call(b.sock, { op: 'status' }), 60_000);
  ok('setup: the launched node answers status', !!st?.ok);
  const ota = await until(async () => { const r = await call(b.sock, { op: 'release' }); return /not installing/.test(r?.ota?.last_error || '') ? r.ota : null; }, 30_000);
  ok(`OUTCOME: the refusal is on the node, with the numbers ("${ota?.last_error}")`, /^not installing \d+\.\d+\.\d+: \d+ MB free in .+, an update needs 1000000000000 MB$/.test(ota?.last_error || ''));
  ok(`OUTCOME: and the memory the box has is reported beside it (${ota?.preflight?.mem_available_mb} MB)`, Number.isFinite(ota?.preflight?.mem_available_mb));
  await sleep(3000);
  ok('OUTCOME: npm never ran', !existsSync(b.npm));
  const still = await call(b.sock, { op: 'status' });
  ok('OUTCOME: the node is still up, suspended on its version, not exited', still?.ok === true && still.pid === st?.pid && !existsSync(b.exit) && still.suspended?.reason === 'version_behind');
  process.kill(L.pid, 'SIGKILL');
  ok('setup: with its launcher gone the node shuts down', !!(await until(async () => (await call(b.sock, { op: 'status' })) === null, 20_000)));
}

// ---- 2. the same box, started again with room ----
{
  const L = launcher({});
  const code = await until(() => (existsSync(b.exit) ? read(b.exit) : null), 60_000);
  ok(`OUTCOME: with room, the same box installs and hands back exit ${OTA_EXIT_CODE} (got ${code})`, code === String(OTA_EXIT_CODE));
  ok('OUTCOME: npm installed all eight packages, pinned', XMBL_PACKAGES.every((n) => read(b.npm).includes(`${n}@${NEXT}`)));
  ok('OUTCOME: the tree it left is the release',
    XMBL_PACKAGES.every((n) => { try { return JSON.parse(readFileSync(join(b.dir, 'install', 'node_modules', n, 'package.json'), 'utf8')).version === NEXT; } catch { return false; } }));
  ok('the install line logs the free disk and the available memory', /\(in .+; \d+ MB free, \d+ MB memory available\)/.test(read(b.log)));
  process.kill(L.pid, 'SIGKILL');
}

srv.closeAllConnections?.(); srv.close();
for (const pid of procs) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
process.exit(0);
