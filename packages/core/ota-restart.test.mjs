// AN UPDATE NEVER LEAVES A NODE DEAD — a node nobody owns any more restarts ITSELF onto the update.
//
// MEASURED 2026-10-09 on 831cfb42 (aws-syd1): its coordinator spawned it with --ppid on 10-02, self-updated on
// 10-04 (`detach`, exit, the replacement adopted the still-running node), and at 05:59:00 the 0.1.21 OTA
// installed and the node exited 75 — the "restart me" code for a supervisor that was no longer its parent. Nothing
// restarted it; 8 h later it was still down, and so were five more nodes whose coordinators were online.
//
// Real processes, nothing mocked but the outside world: a launcher spawns xmbl-node with --ppid exactly as a
// coordinator does, a local release source says a newer version exists, and `npm` is a stub that succeeds. Then:
//   1. launcher detaches the node and dies (a coordinator self-update) → the update must land on a NEW node
//      process that is still answering well past the 3 s parent-watch poll, with no --ppid on its command line.
//   2. launcher stays alive and owns the node → the node must hand the restart back with exit 75 and start
//      nothing itself (two nodes on one data_dir is the other way to break a box).
import assert from 'node:assert';
import net from 'node:net';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, openSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { otaRestartMode, respawnArgv, respawnEnv, OTA_EXIT_CODE } from './release.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE_BIN = join(HERE, 'bin', 'xmbl-node.js');
const CORE_VERSION = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };

// ---- the decision, by table ----
ok('launcher still the parent, not detached → exit 75', otaRestartMode({ watchPpid: 10, ppid: 10 }) === 'exit');
ok('launcher gone (reparented) → respawn', otaRestartMode({ watchPpid: 10, ppid: 1 }) === 'respawn');
ok('detached, even with the launcher still the parent → respawn', otaRestartMode({ watchPpid: 10, ppid: 10, detached: true }) === 'respawn');
ok('XMBL_SUPERVISED cannot claim a node whose --ppid launcher is gone', otaRestartMode({ watchPpid: 10, ppid: 1, envSupervised: true }) === 'respawn');
ok('no --ppid, XMBL_SUPERVISED=1 (pm2/systemd) → exit 75', otaRestartMode({ ppid: 1, envSupervised: true }) === 'exit');
ok('no --ppid, no XMBL_SUPERVISED → respawn', otaRestartMode({ ppid: 1 }) === 'respawn');
ok('respawn argv drops --ppid <n> and --ppid=<n>, keeps the rest', JSON.stringify(respawnArgv(['bin.js', 'start', '--ppid', '42', '--config', 'c.json', '--ppid=7'])) === JSON.stringify(['bin.js', 'start', '--config', 'c.json']));
ok('respawn env drops XMBL_SUPERVISED, keeps the rest', (() => { const e = respawnEnv({ XMBL_SUPERVISED: '1', A: 'b' }); return !('XMBL_SUPERVISED' in e) && e.A === 'b'; })());

// ---- harness ----
const dirs = [];
const procs = [];
function box(tag) {
  const dir = mkdtempSync(join(tmpdir(), `xmbl-ota-${tag}-`));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'install'));
  // `npm install @xmbl/core@<latest>` succeeds without touching anything, and says it ran.
  writeFileSync(join(dir, 'bin', 'npm'), `#!/bin/sh\necho "$@" >> "${join(dir, 'npm.log')}"\nexit 0\n`);
  chmodSync(join(dir, 'bin', 'npm'), 0o755);
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({
    identity_path: join(dir, 'id', 'xmbl.json'), data_dir: join(dir, 'data'),
    listen_addrs: ['/ip4/127.0.0.1/tcp/0'], bootstrap_peers: [],
  }));
  return { dir, cfg, sock: join(dir, 'data', 'node.sock'), log: join(dir, 'node.log') };
}

// The release source: holds every lookup until armed, answers the newer version ONCE, then the running one —
// so the respawned node (same code on disk) is up to date and does not update again.
async function releaseSource() {
  let armed = false, served = 0;
  const waiting = [];
  const answer = (res) => {
    const latest = served++ === 0 ? '9.9.9' : CORE_VERSION;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ 'dist-tags': { latest } }));
  };
  const srv = http.createServer((req, res) => { if (armed) answer(res); else waiting.push(res); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${srv.address().port}/`,
    arm() { armed = true; while (waiting.length) answer(waiting.shift()); },
    close() { srv.closeAllConnections?.(); srv.close(); },
  };
}

// A coordinator, reduced to what matters here: spawn the node with --ppid <me> (detached:false), record its exit.
function launcher(b, env) {
  const src = `
    const { spawn } = require('node:child_process'); const fs = require('node:fs');
    const out = fs.openSync(${JSON.stringify(b.log)}, 'a');
    const c = spawn(process.execPath, [${JSON.stringify(NODE_BIN)}, 'start', '--config', ${JSON.stringify(b.cfg)}, '--ppid', String(process.pid)],
      { stdio: ['ignore', out, out], detached: false, env: process.env });
    c.on('exit', (code) => fs.writeFileSync(${JSON.stringify(join(b.dir, 'child-exit'))}, String(code)));
    setInterval(() => {}, 1 << 30);`;
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
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const argsOf = (pid) => { try { return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const ppidOf = (pid) => { try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); } catch { return 0; } };
const tail = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => /xmbl-node|EXIT/.test(l)).slice(-6).join('\n') : '(no log)');

function envFor(b, rel) {
  return {
    ...process.env,
    PATH: `${join(b.dir, 'bin')}:${process.env.PATH}`,
    XMBL_RELEASE_URL: rel.url,
    XMBL_INSTALL_DIR: join(b.dir, 'install'),
    XMBL_MACHINE_LOCK: join(b.dir, 'machine.lock'),   // never this machine's real node's lock
    XMBL_SUPERVISED: '1',                             // a coordinator may set both; --ppid must still decide
  };
}

// ---- 1. adopted node: launcher detached it and is gone ----
{
  const b = box('adopted');
  const rel = await releaseSource();
  const L = launcher(b, envFor(b, rel));
  const st = await until(() => call(b.sock, { op: 'status' }), 60_000);
  ok('setup: the launched node answers status', !!st?.ok);
  const first = st?.pid;
  ok(`setup: the node's parent is the launcher (${ppidOf(first)} = ${L.pid})`, ppidOf(first) === L.pid);
  const det = await call(b.sock, { op: 'detach' });
  ok('setup: detach cancels the parent watch', det?.ok === true && det?.armed === true);
  process.kill(L.pid, 'SIGKILL');
  ok('setup: the launcher is gone and the node was reparented', !!(await until(() => !alive(L.pid) && ppidOf(first) !== L.pid, 5000)));
  rel.arm();
  const respawned = await until(async () => { const s = await call(b.sock, { op: 'status' }); return s?.ok && s.pid !== first ? s : null; }, 60_000);
  ok(`the update ran (npm ${existsSync(join(b.dir, 'npm.log')) ? readFileSync(join(b.dir, 'npm.log'), 'utf8').trim() : 'never called'})`,
    existsSync(join(b.dir, 'npm.log')) && /install @xmbl\/core@9\.9\.9/.test(readFileSync(join(b.dir, 'npm.log'), 'utf8')));
  const t0 = Date.now();
  const gone = await until(() => !alive(first), 15_000, 100);
  ok(`the old node exited (pid ${first}, ${Date.now() - t0}ms after its replacement answered)`, !!gone);
  ok(`OUTCOME: a new node process answers after the update (pid ${respawned?.pid})`, !!respawned);
  if (respawned) procs.push(respawned.pid);
  const args = respawned ? argsOf(respawned.pid) : '';
  await sleep(10_000);                                                    // well past the 3 s parent-watch poll
  const later = await call(b.sock, { op: 'status' });
  ok('OUTCOME: it is still answering 10 s later — it did not shut itself down as an orphan', later?.ok === true && later.pid === respawned?.pid);
  ok(`its command line names no launcher ("${args.replace(/.*xmbl-node\.js/, 'xmbl-node.js')}")`, /xmbl-node\.js start/.test(args) && !/--ppid/.test(args));
  if (!later?.ok) console.log(tail(b.log));
  if (later?.pid) { process.kill(later.pid, 'SIGTERM'); await until(() => !alive(later.pid), 15_000); }
  rel.close();
}

// ---- 2. owned node: the launcher is alive and still its parent ----
{
  const b = box('owned');
  const rel = await releaseSource();
  const L = launcher(b, envFor(b, rel));
  const st = await until(() => call(b.sock, { op: 'status' }), 60_000);
  ok('setup: the launched node answers status', !!st?.ok);
  rel.arm();
  const code = await until(() => (existsSync(join(b.dir, 'child-exit')) ? readFileSync(join(b.dir, 'child-exit'), 'utf8') : null), 60_000);
  ok(`OUTCOME: the owned node handed the restart to its launcher with exit ${OTA_EXIT_CODE} (got ${code})`, code === String(OTA_EXIT_CODE));
  await sleep(4000);
  ok('OUTCOME: and started no node of its own (nothing answers on its socket)', (await call(b.sock, { op: 'status' })) === null);
  process.kill(L.pid, 'SIGKILL');
  rel.close();
}

for (const pid of procs) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
process.exit(0);
