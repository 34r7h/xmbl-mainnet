// REPRODUCTION — A NODE PROVES THE CODE IT RUNS, AND STOPS PRODUCING WHEN IT IS BEHIND (packages/core).
//
// CLAIM (operator, 2026-09-16, verbatim): "any changes you're making now should be rolled out to every node and
// all nodes must prove they are using the latest version or suspended until they're updated. updates should
// happen automatically ota".
//
// A VERSION STRING CAN BE TYPED BY ANYONE. A DIGEST OF THE LOADED CODE CANNOT. Every reading a node signs
// carries `versions` (what the process imported, read from each package's own manifest at import time) and
// `build` — a sha-256 over the bytes of every @xmbl module in memory. An install that lands on disk after boot
// changes the files, not the digest this process reports, which is the point: the claim is about the code that
// is EXECUTING, not the code that happens to be on disk. The broker's suspend-gate reads exactly these fields.
//
// AND A NODE THAT CANNOT PROVE IT IS CURRENT PRODUCES NOTHING: no submits, no validation ticks, no seals,
// while reads and the control socket stay up so a supervisor can see why. The daemon's OTA loop is what puts
// it in that state and takes it out again — it installs the published version and restarts onto it.
//
// Exits non-zero if any claim fails, so it is also a hard-gate test (reproductions.test.mjs).
import net from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMBLCore } from '@xmbl/core';
import { createControlServer } from '@xmbl/core/control-socket.js';
import { codeDigest, compareVersions, otaDecision, updateCommand, OTA_EXIT_CODE } from '@xmbl/core/release.js';

const selfDigest = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
console.log('XMBL reproduction — a node proves the code it runs, and stops producing when it is behind');
console.log(`source sha256: ${selfDigest}\n`);

let failures = 0;
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`); if (!cond) failures++; };

// ── 1. THE PROOF ITSELF ──
const build = codeDigest();
ok('the build digest is a sha-256 over the loaded @xmbl code', /^[0-9a-f]{64}$/.test(build.digest), build.digest.slice(0, 24) + '…');
ok('it names every protocol package it covered', Object.keys(build.packages).length === 8, Object.keys(build.packages).join(' '));
ok('each package carries its own digest and version', Object.values(build.packages).every((p) => /^[0-9a-f]{64}$/.test(p.digest) && typeof p.version === 'string'));
ok('the digest is STABLE — the same loaded code digests the same twice', codeDigest().digest === build.digest);

// ── 2. THE DECISION: behind, current, or unknown ──
ok('0.1.11 is behind 0.1.12', compareVersions('0.1.11', '0.1.12') < 0);
ok('0.1.11 is not behind 0.1.11', compareVersions('0.1.11', '0.1.11') === 0);
ok('0.1.2 is behind 0.1.11 (numeric, not lexical — the trap that makes "0.1.9 > 0.1.11" look true)', compareVersions('0.1.2', '0.1.11') < 0);
const behind = otaDecision({ running: '0.1.11', latest: '0.1.12' });
ok('a node behind the published version is marked behind, and the reason names both versions',
   behind.behind === true && /running 0\.1\.11, latest 0\.1\.12/.test(behind.reason), behind.reason);
const current = otaDecision({ running: '0.1.11', latest: '0.1.11' });
ok('a current node is left alone', current.behind === false && current.reason === 'up to date');
const unknown = otaDecision({ running: '0.1.11', latest: null });
ok('an UNREACHABLE release source never suspends a node — unknown is not behind',
   unknown.behind === false && unknown.reason === 'latest unknown', unknown.reason);
const cmd = updateCommand('0.1.12');
ok('the update is an ordinary npm install of the published package', /npm/.test(cmd.cmd) && cmd.args.join(' ').includes('@xmbl/core@0.1.12'), `${cmd.cmd} ${cmd.args.join(' ')}`);
ok('a supervised restart uses exit code 75', OTA_EXIT_CODE === 75);

// ── 3. A SUSPENDED NODE PRODUCES NOTHING ──
const dir = mkdtempSync(join(tmpdir(), 'xmbl-repro-core-'));
const core = new XMBLCore({ ledger: { dbPath: join(dir, 'l') }, stateMachine: { dbPath: join(dir, 'v') }, storage: { dbPath: join(dir, 's') }, consensus: { dbPath: join(dir, 'c') } });
ok('a fresh node is producing', core.suspended === null);
let e = null; try { await core.submitTransaction({ type: 'utxo' }); } catch (x) { e = x; }
ok('unsuspended, the production path is reached (it is the identity check that refuses)', e && /Identity not initialized/.test(e.message));
core.suspend({ reason: 'version_behind', detail: 'running 0.1.11, latest 0.1.12', running: '0.1.11', latest: '0.1.12' });
e = null; try { await core.submitTransaction({ type: 'utxo' }); } catch (x) { e = x; }
ok('SUSPENDED, a submit is refused before anything else happens', e && e.code === 'SUSPENDED');
ok('the suspension says why, and since when', core.suspended.reason === 'version_behind' && typeof core.suspended.since === 'string');

// ── 4. THE CONTROL SOCKET REPORTS THE PROOF AND THE SUSPENSION ──
const sockPath = join(dir, 'node.sock');
const server = await createControlServer({ core, config: {}, sockPath, statusSnapshot: () => ({ pid: process.pid }) });
const call = (req) => new Promise((res, rej) => { const s = net.connect(sockPath); let b = ''; s.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) { s.end(); res(JSON.parse(b.slice(0, i))); } }); s.on('error', rej); s.on('connect', () => s.write(JSON.stringify(req) + '\n')); });
const status = await call({ op: 'status' });
ok('status carries the build digest — the proof a version string cannot give', status.build === build.digest);
ok('status carries the versions this process LOADED', status.versions && typeof status.versions.core === 'string', `core=${status.versions?.core}`);
ok('status reports the suspension, with running and latest', status.suspended && status.suspended.reason === 'version_behind' && status.suspended.latest === '0.1.12');
const sub = await call({ op: 'submit_tx', tx: { type: 'utxo' } });
ok('submit_tx is refused with ok:false while suspended — never a false success', sub.ok === false && sub.suspended.reason === 'version_behind');
const batch = await call({ op: 'submit_batch', txs: [{ type: 'utxo' }] });
ok('submit_batch is refused the same way', batch.ok === false && batch.suspended.reason === 'version_behind');
const rel = await call({ op: 'release' });
ok('the release op serves the per-package digests a broker can compare', rel.ok === true && Object.keys(rel.build.packages).length === 8);

// ── 5. RESUMING PUTS IT BACK TO WORK ──
core.resume();
const status2 = await call({ op: 'status' });
ok('after resume the node reports itself producing again', status2.suspended === null);
e = null; try { await core.submitTransaction({ type: 'utxo' }); } catch (x) { e = x; }
ok('and the production path is reached again', e && /Identity not initialized/.test(e.message));

server.closeAllConnections?.(); await new Promise((r) => server.close(r));
try { await core.stop?.(); } catch { /* never started */ }
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0
  ? '\nREPRODUCED — the node proves the code it is executing, refuses to produce while behind, says so on every surface, and resumes cleanly.'
  : `\nNOT REPRODUCED — ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
