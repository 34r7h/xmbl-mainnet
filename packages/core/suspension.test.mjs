// SUSPENSION + VERSION PROOF (operator, 2026-09-16): a node behind the latest published version produces nothing
// until updated, and every reading it signs carries the digest of the code it runs. Asserted by count against
// the real XMBLCore and the real control socket — no daemon, no network.
import assert from 'node:assert';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMBLCore } from './index.js';
import { createControlServer } from './control-socket.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };

// ── the core: suspension gates production before anything else ──
const dir = mkdtempSync(join(tmpdir(), 'xmbl-suspend-'));
const core = new XMBLCore({ ledger: { dbPath: join(dir, 'ledger') }, stateMachine: { dbPath: join(dir, 'vsm') }, storage: { dbPath: join(dir, 'xsc') } });
ok('a fresh core is producing (suspended === null)', core.suspended === null);
let e = null; try { await core.submitTransaction({ type: 'utxo' }); } catch (x) { e = x; }
ok('unsuspended: the identity check is what refuses (production path reached)', e && /Identity not initialized/.test(e.message));
const s = core.suspend({ reason: 'version_behind', detail: 'running 0.1.11, latest 0.1.12', running: '0.1.11', latest: '0.1.12' });
ok('suspend() records reason + since', s.reason === 'version_behind' && typeof s.since === 'string' && core.suspended === s);
e = null; try { await core.submitTransaction({ type: 'utxo' }); } catch (x) { e = x; }
ok('suspended: submitTransaction refuses with code SUSPENDED before touching identity', e && e.code === 'SUSPENDED' && /version_behind/.test(e.message));
const since = s.since;
core.suspend({ reason: 'version_behind', detail: 'again' });
ok('re-suspending keeps the original since', core.suspended.since === since);
const lifted = core.resume();
ok('resume() lifts it and returns what was lifted', core.suspended === null && lifted && lifted.reason === 'version_behind');
e = null; try { await core.submitTransaction({ type: 'utxo' }); } catch (x) { e = x; }
ok('after resume the production path is reached again', e && /Identity not initialized/.test(e.message));

// ── the control socket: status/release carry the proof; producing ops refuse while suspended ──
const sockPath = join(dir, 'node.sock');
const fake = { suspended: null, ota: { enabled: true, running: '0.1.11', latest: null }, xn: { getConnectedPeers: () => [] }, xid: null, xclt: null, xvsm: null, xpc: null,
               submitTransaction: async () => 'should-not-be-called' };
const server = await createControlServer({ core: fake, config: {}, sockPath, statusSnapshot: () => ({ pid: process.pid }) });
const call = (req) => new Promise((resolve, reject) => {
  const sock = net.connect(sockPath);
  let buf = '';
  sock.on('data', (d) => { buf += d.toString(); const i = buf.indexOf('\n'); if (i >= 0) { sock.end(); resolve(JSON.parse(buf.slice(0, i))); } });
  sock.on('error', reject);
  sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
});
const st = await call({ op: 'status' });
ok('status carries the version proof (build = 64-hex digest of the loaded @xmbl code)', st.ok === true && /^[0-9a-f]{64}$/.test(st.build));
ok('status says not suspended', st.suspended === null && st.versions && typeof st.versions.core === 'string');
const rel = await call({ op: 'release' });
ok('release lists every package with its own digest', rel.ok === true && rel.build && Object.keys(rel.build.packages).length === 8 && Object.values(rel.build.packages).every((p) => p && /^[0-9a-f]{64}$/.test(p.digest)));
fake.suspended = { reason: 'version_behind', detail: 'running 0.1.11, latest 0.1.12', since: new Date().toISOString(), running: '0.1.11', latest: '0.1.12' };
const sub = await call({ op: 'submit_tx', tx: { type: 'utxo' } });
ok('submit_tx while suspended: ok:false with the suspension, and the core is never asked', sub.ok === false && sub.suspended && sub.suspended.reason === 'version_behind' && /suspended/.test(sub.error));
const batch = await call({ op: 'submit_batch', txs: [{ type: 'utxo' }] });
ok('submit_batch while suspended: ok:false with the suspension', batch.ok === false && batch.suspended && batch.suspended.reason === 'version_behind');
const st2 = await call({ op: 'status' });
ok('status now says suspended (reason + running + latest)', st2.suspended && st2.suspended.reason === 'version_behind' && st2.suspended.latest === '0.1.12');
server.closeAllConnections?.();
await new Promise((r) => server.close(r));
try { await core.stop?.(); } catch { /* never started */ }
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
