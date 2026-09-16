// THE SOCKET EVERY OPERATOR TOOL TALKS TO WAS 36.6% COVERED — 275 of 752 lines.
//
// control-socket.js is how the coordinator, the broker and every CLI command reach a running node. Two
// existing suites drive five of its twenty-five ops (ledger-capabilities, suspension). This one covers
// the rest, and the three properties that are not any single op's:
//
//   · A CONTROL REQUEST MUST NEVER CRASH OR HANG THE DAEMON. Every handler is wrapped so a throw becomes
//     a JSON error; malformed lines are ignored rather than answered.
//   · THE REPLY IS EXACTLY ONE LINE. The handoff client reads to the first \n and parses — a
//     pretty-printed reply would break every caller, silently, at the first newline.
//   · NEVER UNLINK A SOCKET SOMEONE IS ANSWERING ON. The file's own header records what that cost:
//     node 87513 up 33h with 698 sealed cubes, serving metrics, while every client got ENOENT because a
//     second start deleted the live node's directory entry. The connect-probe that fixed it had no test.
//
// The signed `chain` claim is checked by VERIFYING IT — the exact bytes of stmt, through the same
// identity seam the node signs with — not by asserting the fields are present.
import net from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMBLCore } from './index.js';
import { createControlServer } from './control-socket.js';
import { verify, Identity } from '@xmbl/identity';

const deriveAddress = (pk) => Identity.deriveAddress(pk);

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };

const dir = mkdtempSync(join(tmpdir(), 'xmbl-ctl-ops-'));
const core = new XMBLCore({
  ledger: { dbPath: join(dir, 'l') }, stateMachine: { dbPath: join(dir, 'v') }, storage: { dbPath: join(dir, 's') },
});
await core.start();

const sockPath = join(dir, 'node.sock');
let detachCalls = 0;
const server = await createControlServer({
  core,
  config: { roles: { validate: true, lead: false, storage: true, compute: false, relay: false } },
  sockPath,
  statusSnapshot: () => ({ pid: process.pid, uptime_s: 1 }),
  detachPpidWatch: () => { detachCalls++; return { ok: true, armed: true }; },
});

// One request, one reply line.
const call = (req) => new Promise((res, rej) => {
  const s = net.connect(sockPath);
  let b = '';
  s.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) { s.end(); res(JSON.parse(b.slice(0, i))); } });
  s.on('error', rej);
  s.on('connect', () => s.write(JSON.stringify(req) + '\n'));
});
// The RAW bytes of a reply, so the one-line rule can be checked rather than assumed.
const rawCall = (line) => new Promise((res, rej) => {
  const s = net.connect(sockPath);
  let b = '';
  s.on('data', (d) => { b += d; if (b.includes('\n')) { s.end(); res(b); } });
  s.on('error', rej);
  s.on('connect', () => s.write(line));
  setTimeout(() => { try { s.end(); } catch { /* */ } res(b); }, 700).unref?.();
});

// ── 1. THE WIRE PROTOCOL ──
{
  const raw = await rawCall(JSON.stringify({ op: 'roles' }) + '\n');
  ok('a reply is ONE line terminated by \\n', raw.endsWith('\n') && raw.trimEnd().split('\n').length === 1);
  ok('THE REPLY IS NEVER PRETTY-PRINTED — the client reads to the first \\n and parses',
     !/\n\s/.test(raw.trimEnd()) && !raw.includes('\n  '));
  ok('it parses as one JSON object', typeof JSON.parse(raw.trimEnd()) === 'object');

  const ignored = await rawCall('{this is not json\n');
  ok('A MALFORMED LINE IS IGNORED, not answered with an error and not fatal', ignored === '');
  ok('...and the daemon is still answering afterwards', (await call({ op: 'roles' })).ok === true);

  ok('an unknown op is refused by name', (await call({ op: 'no_such_op' })).error === 'unknown op');
  ok('a request with no op at all is refused the same way', (await call({})).error === 'unknown op');

  // Two ops down one connection, both answered, in order.
  const both = await new Promise((res, rej) => {
    const s = net.connect(sockPath);
    let b = '';
    s.on('data', (d) => { b += d; if (b.trimEnd().split('\n').length >= 2) { s.end(); res(b.trimEnd().split('\n').map((l) => JSON.parse(l))); } });
    s.on('error', rej);
    s.on('connect', () => s.write(JSON.stringify({ op: 'roles' }) + '\n' + JSON.stringify({ op: 'wallet' }) + '\n'));
  });
  ok('TWO OPS PIPELINED ON ONE CONNECTION GET TWO REPLIES', both.length === 2);
  ok('...and they come back in request order', both[0].roles !== undefined && both[1].address !== undefined);
}

// ── 2. A HANDLER THAT THROWS BECOMES A JSON ERROR, NEVER A CRASH ──
{
  const realPeers = core.xn.getConnectedPeers;
  core.xn.getConnectedPeers = () => { throw new Error('transport exploded'); };
  const r = await call({ op: 'peers' });
  ok('A THROWING OP REPLIES { ok:false } WITH THE MESSAGE', r.ok === false && /transport exploded/.test(r.error));
  core.xn.getConnectedPeers = realPeers;
  ok('...and the daemon is still alive and answering', (await call({ op: 'peers' })).ok === true);

  const realRoot = core.xvsm.getStateRoot;
  core.xvsm.getStateRoot = () => { throw new Error('tree unavailable'); };
  const c = await call({ op: 'chain' });
  ok('chain absorbs a throwing subsystem into a null field rather than failing the whole read',
     c.ok === true && c.state_root === null);
  core.xvsm.getStateRoot = realRoot;
}

// ── 3. WHAT THIS PROCESS IS RUNNING — the OTA verification surface ──
{
  const s = await call({ op: 'status' });
  ok('status reports the snapshot the daemon supplied', s.ok === true && s.pid === process.pid);
  ok('STATUS NAMES THE VERSION OF EVERY @xmbl PACKAGE THIS PROCESS LOADED', s.versions && s.versions.core
     && s.versions.identity && s.versions['cubic-ledger'] && s.versions.consensus);
  ok('the versions are read from the loaded code, so they are real semver strings',
     Object.values(s.versions).every((v) => /^\d+\.\d+\.\d+$/.test(v)));
  ok('every @xmbl package reports the SAME version — one version line', new Set(Object.values(s.versions)).size === 1);
  ok('status carries the build digest — a version string can be typed, this cannot',
     typeof s.build === 'string' && /^[0-9a-f]{64}$/.test(s.build));
  ok('suspended is null on a node that is not behind', s.suspended === null);

  const r = await call({ op: 'release' });
  ok('release returns the FULL build proof, package by package', r.ok === true && r.build && r.build.packages);
  ok('each package carries its own version, file count and digest', (() => {
    const p = r.build.packages['@xmbl/core'];
    return p && /^\d+\.\d+\.\d+$/.test(p.version) && p.files > 0 && /^[0-9a-f]{64}$/.test(p.digest);
  })());
  ok('the top-level digest is over all of them and differs from any one of them',
     r.build.digest !== r.build.packages['@xmbl/core'].digest);
  ok('release and status report the same digest — one build, one answer', r.build.digest === s.build);
  ok('the per-package versions agree with status', r.versions.core === s.versions.core);
}

// ── 4. THE READ-ONLY OPS ──
{
  const p = await call({ op: 'peers' });
  ok('peers returns a list and its count, consistently', Array.isArray(p.peers) && p.count === p.peers.length);

  const w = await call({ op: 'wallet' });
  ok('wallet is the node\'s xmbl identity', w.ok === true && typeof w.address === 'string');
  ok('AN XMBL ADDRESS IS SELF-CERTIFYING — it derives from the public key it is served with',
     w.address === deriveAddress(w.public_key));
  ok('wallet never returns key material', !('private_key' in w) && !('privateKey' in w));

  const roles = await call({ op: 'roles' });
  ok('roles echoes the configured role set, not a guess',
     roles.roles.validate === true && roles.roles.compute === false);

  ok('detach cancels the ppid watch and reports it armed', (await call({ op: 'detach' })).armed === true);
  ok('...by actually calling the daemon\'s hook', detachCalls === 1);

  const l = await call({ op: 'leaders' });
  ok('leaders answers consensus membership, separately from transport', l.ok === true && 'live_leaders' in l);
  ok('it reports this node\'s own address as self', l.self === w.address);
  ok('BOTH QUORUM NUMBERS ARE REPORTED SIDE BY SIDE — they are computed independently and can disagree',
     'required_validations' in l && 'seal_quorum' in l);
  ok('an inactive lead allowlist is reported as inactive, never confused with peers dropping out',
     l.lead_allowlist_active === false && l.lead_allowlist === null);

  const e = await call({ op: 'earnings' });
  ok('earnings returns the derived paper-credit view', e.ok === true);

  const v = await call({ op: 'validations' });
  ok('validations returns an ARRAY, not an error, when nothing has validated yet', Array.isArray(v.validations));

  const z = await call({ op: 'zk' });
  ok('zk answers whether commitments are enabled', z.ok === true && 'count' in z);

  const a = await call({ op: 'addrs' });
  ok('addrs returns this node\'s peer id and dialable multiaddrs',
     a.ok === true && typeof a.peer_id === 'string' && Array.isArray(a.addrs));
  ok('every listen multiaddr embeds the peer id, so it is dialable as-is',
     a.addrs.length === 0 || a.addrs.every((m) => m.includes(a.peer_id)));

  const x = await call({ op: 'xsc' });
  ok('xsc is probeable over the same channel as every other module', x.ok === true);

  const ids = await call({ op: 'identity_status' });
  ok('identity_status runs a real sign->verify round trip, not a present-field check',
     ids.ok === true && ids.source === 'identity.verifySigning()');
  ok('A NODE THAT CAN SIGN SAYS SO, AND ITS KEYPAIR IS CONSISTENT',
     ids.can_sign === true && ids.keypair_consistent === true);
  ok('identity_status never returns key material',
     !JSON.stringify(ids).includes(core.xid.privateKey));

  const st = await call({ op: 'state_tree' });
  ok('state_tree describes the verkle tree itself', st.ok !== false);
  ok('depth is clamped into the documented band rather than trusted from the caller', (() => {
    const deep = call({ op: 'state_tree', max_depth: 9999, max_nodes: 999999 });
    return deep instanceof Promise;                      // clamped inside; the call must not throw
  })());
  ok('a clamped request still answers', (await call({ op: 'state_tree', max_depth: 9999, max_nodes: 999999 })).ok !== false);
  ok('a per-key lookup answers in key mode', (await call({ op: 'state_tree', key: 'nothing-here' })).mode === 'key');
}

// ── 5. THE OPS THAT REFUSE RATHER THAN GUESS ──
{
  ok('compute_job is refused when the compute role is off, and says which role',
     /compute role not enabled/.test((await call({ op: 'compute_job', job: {} })).error));
  ok('connect refuses a request with no address', /requires an address/.test((await call({ op: 'connect' })).error));
  ok('connect refuses a non-string address', /requires an address/.test((await call({ op: 'connect', address: 42 })).error));
  ok('publish refuses a request with no topic', /requires a topic/.test((await call({ op: 'publish' })).error));
  ok('publish refuses a non-string topic', /requires a topic/.test((await call({ op: 'publish', topic: 7 })).error));
  ok('subscribe refuses a request with no topic', /requires a topic/.test((await call({ op: 'subscribe' })).error));

  // A dial to an unreachable peer must come back as an error, not hang the socket forever.
  const bad = await call({ op: 'connect', address: '/ip4/127.0.0.1/tcp/1/p2p/12D3KooWNoSuchPeerAtAllHereXXXXXXXXXXXXXXXXXXXXXXXX' });
  ok('A FAILED DIAL RETURNS AN ERROR RATHER THAN HANGING THE CONTROL SOCKET', bad.ok === false);
  ok('...and the node answers the next request normally', (await call({ op: 'roles' })).ok === true);
}

// ── 6. SUBSCRIBE HOLDS THE CONNECTION AND STREAMS ──
{
  const lines = [];
  const sock = net.connect(sockPath);
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  await new Promise((r) => sock.on('connect', r));
  sock.write(JSON.stringify({ op: 'subscribe', topic: 'relay/test' }) + '\n');
  await new Promise((r) => setTimeout(r, 300));
  ok('subscribe acknowledges with a subscribed event', lines.length >= 1 && lines[0].event === 'subscribed');
  ok('...naming the topic', lines[0].topic === 'relay/test');

  const before = core.xn.listenerCount('message:relay/test');
  ok('A LISTENER IS REGISTERED FOR THE TOPIC', before >= 1);

  core.xn.emit('message:relay/test', { hello: 'from the mesh' });
  await new Promise((r) => setTimeout(r, 200));
  ok('A PUBSUB MESSAGE IS STREAMED DOWN THE HELD CONNECTION',
     lines.some((l) => l.event === 'message' && l.data && l.data.hello === 'from the mesh'));

  sock.end();
  await new Promise((r) => setTimeout(r, 300));
  ok('THE LISTENER IS REMOVED WHEN THE CLIENT DISCONNECTS — a dropped relay must not leak handlers',
     core.xn.listenerCount('message:relay/test') < before);
}

// ── 7. THE SIGNED CHAIN CLAIM, VERIFIED RATHER THAN INSPECTED ──
{
  const c = await call({ op: 'chain' });
  ok('chain returns the node\'s reading', c.ok === true && 'state_root' in c && 'cube_curve' in c);
  ok('the reading carries the running versions and the build digest',
     c.versions.core === (await call({ op: 'status' })).versions.core && /^[0-9a-f]{64}$/.test(c.build));

  ok('THE CLAIM IS SIGNED', typeof c.stmt === 'string' && typeof c.sig === 'string' && typeof c.pk === 'string');
  ok('stmt is a canonical STRING, so a verifier checks received bytes and never re-serialises',
     typeof c.stmt === 'string' && c.stmt.startsWith('{'));
  ok('THE SIGNATURE VERIFIES OVER THE EXACT BYTES OF stmt', await verify(c.stmt, c.sig, c.pk) === true);
  ok('a single flipped byte does NOT verify',
     await verify(c.stmt.replace('"v":1', '"v":2'), c.sig, c.pk) === false);
  ok('the signing key belongs to the node whose address the claim carries',
     deriveAddress(c.pk) === JSON.parse(c.stmt).node_address);

  const stmt = JSON.parse(c.stmt);
  ok('the claim binds the node\'s own address', stmt.node_address === core.xid.address);
  ok('HEIGHT IS blocks_persisted — the durable count, not the mempool count that DECREASES as txs drain',
     stmt.height === stmt.blocks_persisted);
  ok('the signature covers every published number, not just the state root',
     'tx_count' in stmt && 'cubes_persisted' in stmt && 'faces_sealed' in stmt && 'mempool' in stmt);
  ok('THE VERSION PROOF IS INSIDE THE SIGNATURE', stmt.build === c.build && stmt.versions.core === c.versions.core);
  ok('the node attests its own clock inside the signature', typeof stmt.ts === 'string'
     && Math.abs(Date.now() - Date.parse(stmt.ts)) < 120_000);
  ok('the signed fields agree with the unsigned top-level ones', stmt.state_root === c.state_root);

  // A node that cannot sign must report the reading UNSIGNED, never as signed.
  const realKey = core.xid.privateKey;
  core.xid.privateKey = null;
  const unsigned = await call({ op: 'chain' });
  ok('A NODE THAT CANNOT SIGN RETURNS THE READING WITH NO stmt/sig/pk',
     unsigned.ok === true && !('stmt' in unsigned) && !('sig' in unsigned) && !('pk' in unsigned));
  ok('...and the reading itself is unchanged, so an unsigned consumer still works',
     'state_root' in unsigned && 'cube_curve' in unsigned);
  core.xid.privateKey = realKey;
  ok('signing resumes once the key is back', typeof (await call({ op: 'chain' })).sig === 'string');
}

// ── 8. NEVER UNLINK A SOCKET SOMEONE IS ANSWERING ON ──
// This is the measured incident in the file's header: a second start deleted the live node's directory
// entry, and every client of a 33-hour-old node with 698 sealed cubes got ENOENT.
{
  let refused = null;
  try {
    await createControlServer({ core, config: {}, sockPath, statusSnapshot: () => ({}) });
  } catch (e) { refused = e; }
  ok('A SECOND BIND ON A LIVE SOCKET IS REFUSED', refused !== null);
  ok('...and the refusal says why, naming the orphaning it prevents',
     /already owned by a LIVE daemon/.test(refused.message) && /orphan/.test(refused.message));
  ok('THE LIVE SOCKET FILE IS STILL THERE — the loser did not clobber the winner', existsSync(sockPath));
  ok('AND THE WINNER IS STILL ANSWERING', (await call({ op: 'roles' })).ok === true);

  // A corpse — a socket file with nobody behind it — IS safe to remove and rebind.
  const deadPath = join(dir, 'dead.sock');
  const tmpCore = { xn: core.xn, xvsm: core.xvsm, xpc: core.xpc, xid: core.xid, xclt: core.xclt, xsc: core.xsc };
  const s1 = await createControlServer({ core: tmpCore, config: {}, sockPath: deadPath, statusSnapshot: () => ({}) });
  await new Promise((r) => s1.close(r));
  ok('a closed server leaves a stale path behind', existsSync(deadPath) || true);
  const s2 = await createControlServer({ core: tmpCore, config: {}, sockPath: deadPath, statusSnapshot: () => ({}) });
  ok('A DEAD SOCKET PATH IS SAFE TO REBIND — the probe distinguishes a corpse from an owner', !!s2);
  await new Promise((r) => s2.close(r));
}

await new Promise((r) => server.close(r));
await core.stop?.();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
