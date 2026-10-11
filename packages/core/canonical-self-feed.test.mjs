// A NODE NOBODY FEEDS STILL REACHES THE FED NODES' CHAIN. 831cfb42 (0.1.27) sat at 15399 blocks / root 955850f3 for
// hours while the three fed nodes moved together: its coordinator adopted it at boot and never started the 90 s
// canonical feed, and a non-lead node moves only when something hands it the set. canonical-feed.js makes the node
// fetch the set itself once nobody has handed one over for XMBL_SELF_FEED_STALE_MS.
//
// Real processes, the way ota-preflight.test.mjs runs them: two `xmbl-node start` daemons on loopback with no peers,
// a local release source that says they are current (so no OTA, no suspension), and a local canonical feed with an
// ETag. Node A is fed over its control socket every second, the way a coordinator feeds a node. Node B has no
// feeder. The outcome is read off each node's own `chain` op: B must hold A's chain — same state root, same applied
// count, same persisted blocks and cubes — and A must never have fed itself while its feeder was handing sets over.
import assert from 'node:assert';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { micromineTx } from '@xmbl/cubic-ledger';
import { canonicalDigest } from './canonical-feed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE_BIN = join(HERE, 'bin', 'xmbl-node.js');
const CORE_VERSION = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version;
const EVERY_MS = 1500, STALE_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };

// ---- the sets: typed anchors exactly as the broker's ?from_epoch=1 feed carries them ----
const digest = (s) => createHash('sha256').update(String(s)).digest('hex');
const row = (t) => ({ event: t.event, hash: t.hash, ts: t.ts, xid: t.xid, nonce: t.nonce, prior: t.prior });
const mk = (event, seed, ts) => row(micromineTx({ type: 'anchor', event, hash: digest(seed), ts }));
const SET1 = Array.from({ length: 200 }, (_, i) => mk('task.created', `self-feed-${i}`, 3000));
const SET2 = [...SET1, ...Array.from({ length: 30 }, (_, i) => mk('task.verified', `self-feed-more-${i}`, 4000))];
const SET3 = [...SET2, ...Array.from({ length: 30 }, (_, i) => mk('task.completed', `self-feed-last-${i}`, 5000))];
const UNTYPED = Array.from({ length: 200 }, (_, i) => ({ event: 'task.created', hash: digest(`untyped-${i}`), ts: 6000 }));

// ---- the canonical feed: one URL per node, so every fetch is attributable ----
let current = SET1;
const fetches = { a: [], b: [] };
const feed = http.createServer((req, res) => {
  const m = /^\/(a|b)\/xmbl\/anchors\/canonical(\?.*)?$/.exec(req.url);
  if (!m) { res.writeHead(404).end(); return; }
  const tag = `"${canonicalDigest(current)}"`;
  fetches[m[1]].push({ query: m[2] || '', inm: req.headers['if-none-match'] || null, at: Date.now() });
  if (req.headers['if-none-match'] === tag) { res.writeHead(304, { etag: tag }).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', etag: tag }).end(JSON.stringify({ anchors: current, count: current.length }));
});
await new Promise((r) => feed.listen(0, '127.0.0.1', r));
const FEED = `http://127.0.0.1:${feed.address().port}`;

// The release source says the running version is the latest: no install, no suspension.
const rel = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ 'dist-tags': { latest: CORE_VERSION } })));
await new Promise((r) => rel.listen(0, '127.0.0.1', r));
const RELEASE_URL = `http://127.0.0.1:${rel.address().port}/`;

// ---- the two daemons ----
const dirs = [];
const procs = [];
function daemon(tag) {
  const dir = mkdtempSync(join(tmpdir(), `xmbl-self-feed-${tag}-`));
  dirs.push(dir);
  mkdirSync(join(dir, 'install'));
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({
    identity_path: join(dir, 'id', 'xmbl.json'), data_dir: join(dir, 'data'),
    listen_addrs: ['/ip4/127.0.0.1/tcp/0'], bootstrap_peers: [],
  }));
  const log = join(dir, 'node.log');
  const out = (() => { writeFileSync(log, ''); return log; })();
  const env = {
    ...process.env, XMBL_OTA_GRACE_MS: '0', XMBL_RELEASE_URL: RELEASE_URL,
    XMBL_INSTALL_DIR: join(dir, 'install'), XMBL_MACHINE_LOCK: join(dir, 'machine.lock'),
    XMBL_SELF_FEED_MS: String(EVERY_MS), XMBL_SELF_FEED_STALE_MS: String(STALE_MS),
    XMBL_CANONICAL_URL: `${FEED}/${tag}/xmbl/anchors/canonical`,
  };
  // --ppid: the node exits when this test does, however it ends.
  const p = spawn(process.execPath, [NODE_BIN, 'start', '--config', cfg, '--ppid', String(process.pid)], { stdio: ['ignore', 'pipe', 'pipe'], env });
  p.stdout.on('data', (d) => { try { writeFileSync(out, d, { flag: 'a' }); } catch { /* gone */ } });
  p.stderr.on('data', (d) => { try { writeFileSync(out, d, { flag: 'a' }); } catch { /* gone */ } });
  procs.push(p);
  return { tag, dir, sock: join(dir, 'data', 'node.sock'), log, proc: p };
}
function call(sockPath, req, timeoutMs = 20_000) {
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

// The chain as a node reports it: what every comparison below is made on.
async function chainOf(n) {
  const c = await call(n.sock, { op: 'chain' });
  if (!c || !c.ok) return null;
  return { root: c.state_root, applied: c.applied_tx_count, blocks: c.cube_curve?.blocks_persisted ?? null, cubes: c.cube_curve?.cubes_persisted ?? null };
}
const same = (x, y) => !!x && !!y && x.root === y.root && x.applied === y.applied && x.blocks === y.blocks && x.cubes === y.cubes;
const fmt = (s) => (s ? `root ${String(s.root).slice(0, 12)} / applied ${s.applied} / blocks ${s.blocks} / cubes ${s.cubes}` : 'no answer');
const feedOf = async (n) => (await call(n.sock, { op: 'status' }))?.canonical_feed ?? null;

const A = daemon('a');
const B = daemon('b');
const stA = await until(() => call(A.sock, { op: 'status' }), 60_000);
const capsA = await call(A.sock, { op: 'ledger_capabilities' });
const wantOp = capsA?.capabilities?.rescues_non_anchor_blocks === true ? 'rebuild_ledger' : 'apply_canonical';

// A's feeder, from the moment A answers: the set the feed holds now, handed over the socket every second — a
// coordinator, run fast.
let feeding = true;
const feeder = (async () => {
  while (feeding) {
    await call(A.sock, { op: wantOp, anchors: current });
    await sleep(1000);
  }
})();

const stB = await until(() => call(B.sock, { op: 'status' }), 60_000);
ok('setup: both daemons answer status', !!stA?.ok && !!stB?.ok);
const enabled = await until(async () => {
  const both = await Promise.all([feedOf(A), feedOf(B)]);
  return both.every((f) => f?.self?.enabled === true) ? both : null;
}, 10_000);
ok(`setup: both run the self-feed at ${EVERY_MS} ms, stale after ${STALE_MS} ms`,
  !!enabled && enabled.every((f) => f.self.every_ms === EVERY_MS && f.self.stale_ms === STALE_MS));
ok('setup: neither is suspended (the release source says they are current)', !stA?.suspended && !stB?.suspended);
const caps = await call(B.sock, { op: 'ledger_capabilities' });
const typed = caps?.capabilities?.requires_typed_anchors === true;
ok(`setup: A and B name the same op (${wantOp})`, (caps?.capabilities?.rescues_non_anchor_blocks === true ? 'rebuild_ledger' : 'apply_canonical') === wantOp);
const empty = await chainOf(B);
ok(`setup: B starts empty (${fmt(empty)})`, !!empty && (empty.blocks | 0) === 0);

// ---- 1. B, with no feeder, feeds itself and lands on A's chain ----
const b1 = await until(async () => { const f = await feedOf(B); return f?.self?.applied >= 1 ? f : null; }, STALE_MS + 6 * EVERY_MS + 10_000);
ok(`OUTCOME: B fed itself (applied ${b1?.self?.applied}, last "${b1?.self?.last_reason}")`, b1?.self?.applied === 1 && b1.self.last_reason === 'applied');
ok(`B ran the op its own ledger_capabilities names (${wantOp}) and holds set ${String(b1?.last?.digest).slice(0, 12)}`,
  b1?.last?.op === wantOp && b1.last.digest === canonicalDigest(SET1) && b1.last.by === 'self' && b1.last.anchors === SET1.length);
ok(`B asked for the feed its ledger takes (${typed ? 'typed, ?from_epoch=1' : 'the default feed'})`,
  fetches.b.length > 0 && fetches.b.every((f) => /from_epoch=1/.test(f.query) === typed));
const cA1 = await chainOf(A), cB1 = await chainOf(B);
ok(`OUTCOME: B holds A's chain after one self-feed — A ${fmt(cA1)}, B ${fmt(cB1)}`, same(cA1, cB1) && cB1.blocks > 0 && cB1.applied > 0);

// ---- 2. the same set again is not rebuilt again ----
await sleep(3 * EVERY_MS);
const b2 = await feedOf(B);
ok(`B does not rebuild an unchanged set (applied still ${b2?.self?.applied}, last "${b2?.self?.last_reason}")`, b2?.self?.applied === 1 && ['unchanged', 'held'].includes(b2.self.last_reason));
ok('B sends the ETag back once it holds the set', fetches.b.some((f) => f.inm === `"${canonicalDigest(SET1)}"`));
const a2 = await feedOf(A);
ok(`OUTCOME: A, fed every second, never fetched and never fed itself (fetches ${fetches.a.length}, applied ${a2?.self?.applied}, last "${a2?.self?.last_reason}")`,
  fetches.a.length === 0 && a2?.self?.applied === 0 && a2.self.last_reason === 'fed' && a2.last?.by === 'control');

// ---- 3. the set grows: A's feeder hands it over, B fetches it, both land on the same chain ----
current = SET2;
const b3 = await until(async () => { const f = await feedOf(B); return f?.self?.applied >= 2 ? f : null; }, 4 * EVERY_MS + 10_000);
ok(`OUTCOME: B applies the grown set itself (applied ${b3?.self?.applied})`, b3?.self?.applied === 2 && b3.last?.digest === canonicalDigest(SET2));
const aHas2 = await until(async () => { const f = await feedOf(A); return f?.last?.digest === canonicalDigest(SET2) ? f : null; }, 10_000);
const cA3 = await chainOf(A), cB3 = await chainOf(B);
ok(`OUTCOME: both hold the grown chain — A ${fmt(cA3)}, B ${fmt(cB3)}`, !!aHas2 && same(cA3, cB3) && cB3.blocks > cB1.blocks);
ok(`OUTCOME: the set changed and A still never fed itself (fetches ${fetches.a.length}, applied ${aHas2?.self?.applied})`, fetches.a.length === 0 && aHas2?.self?.applied === 0);

// ---- 4. a feed of untyped rows touches neither chain ----
feeding = false;
await feeder;
current = UNTYPED;
const b4 = await until(async () => { const f = await feedOf(B); return f?.self?.last_reason === 'not applied' ? f : null; }, 4 * EVERY_MS + 10_000);
ok(`B refuses to hold an untyped feed ("${b4?.self?.last_error}")`, !!b4 && b4.self.applied === 2 && b4.last?.digest === canonicalDigest(SET2));
const cB4 = await chainOf(B);
ok(`OUTCOME: B's chain is untouched by it — ${fmt(cB4)}`, same(cB4, cB3));

// ---- 5. A's feeder is gone: after STALE_MS and one more interval A feeds itself, and the two agree again ----
current = SET3;
const a5 = await until(async () => { const f = await feedOf(A); return f?.self?.applied >= 1 ? f : null; }, STALE_MS + 8 * EVERY_MS + 10_000);
ok(`OUTCOME: with its feeder stopped, A feeds itself (applied ${a5?.self?.applied}, fetches ${fetches.a.length})`, a5?.self?.applied === 1 && a5.last?.digest === canonicalDigest(SET3) && fetches.a.length > 0);
const b5 = await until(async () => { const f = await feedOf(B); return f?.last?.digest === canonicalDigest(SET3) ? f : null; }, 4 * EVERY_MS + 10_000);
const cA5 = await chainOf(A), cB5 = await chainOf(B);
ok(`OUTCOME: both hold the newest chain — A ${fmt(cA5)}, B ${fmt(cB5)}`, !!b5 && same(cA5, cB5) && cB5.blocks > cB3.blocks);
ok('both logged the self-feed applying', /canonical self-feed — applied/.test(read(A.log)) && /canonical self-feed — applied/.test(read(B.log)));

// ---- teardown ----
for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
await sleep(1500);
for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
feed.closeAllConnections?.(); feed.close();
rel.closeAllConnections?.(); rel.close();
for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
process.exit(0);
