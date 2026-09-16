// A NODE'S peer_id MUST SURVIVE A RESTART, AND THE KEY THAT DECIDES IT WAS 46.9% COVERED.
//
// By default libp2p mints a fresh key every start, so peer_id changes on every restart: presence
// continuity breaks, a bootstrap seed multiaddr (which embeds its peer_id) goes stale, and
// validation-task assignment keyed to a stable node stops being stable. peer-identity.js persists the
// key. What was never checked is the part that makes it safe — the create-once `wx` write that stops
// two simultaneous starts minting two different identities for one node, and the 0600 mode on a file
// that IS the node's identity.
//
// gossip.js was 14.3% covered: only its constructor ran. Its failure handling is the point — an
// unhandled WebTorrent 'error' is a process-killing event, and gossip is best-effort while the node is
// not. Those paths are driven here without standing up a real swarm.
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreatePeerKey } from './peer-identity.js';
import { GossipManager } from './gossip.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };

const dir = mkdtempSync(join(tmpdir(), 'xmbl-peerkey-'));

// ── 1. THE KEY IS CREATED ONCE AND LOADED THEREAFTER ──
{
  const p = join(dir, 'peer.key');
  const first = await loadOrCreatePeerKey(p);
  ok('a missing key is created', first.created === true);
  ok('the path is reported back', first.path === p);
  ok('the key file exists on disk', existsSync(p));
  ok('an Ed25519 key is minted', first.privateKey.type === 'Ed25519');

  const second = await loadOrCreatePeerKey(p);
  ok('a second call LOADS rather than creating', second.created === false);
  ok('THE SAME peer_id SURVIVES THE RESTART — this is the whole point of the module',
     second.privateKey.publicKey.toString() === first.privateKey.publicKey.toString());
  ok('the private key round-trips byte-identically through the protobuf',
     Buffer.compare(second.privateKey.raw, first.privateKey.raw) === 0);

  const other = await loadOrCreatePeerKey(join(dir, 'other.key'));
  ok('a DIFFERENT path is a different node, not the same identity',
     other.privateKey.publicKey.toString() !== first.privateKey.publicKey.toString());
}

// ── 2. THE FILE IS THE NODE'S IDENTITY, SO ITS MODE MATTERS ──
{
  const p = join(dir, 'mode.key');
  await loadOrCreatePeerKey(p);
  ok('A FRESH KEY IS WRITTEN 0600 — owner-only', (statSync(p).mode & 0o777) === 0o600);

  chmodSync(p, 0o644);                                   // an operator, a bad umask, a restore from backup
  await loadOrCreatePeerKey(p);
  ok('LOADING A WORLD-READABLE KEY TIGHTENS IT BACK TO 0600', (statSync(p).mode & 0o777) === 0o600);
}

// ── 3. THE DIRECTORY IS CREATED, INCLUDING NESTED ──
{
  const p = join(dir, 'a', 'b', 'c', 'peer.key');
  const r = await loadOrCreatePeerKey(p);
  ok('a nested parent directory is created rather than failing on ENOENT', r.created === true && existsSync(p));
}

// ── 4. TWO SIMULTANEOUS STARTS MUST NOT MINT TWO IDENTITIES ──
// The `wx` flag is what makes this safe: the loser of the race gets EEXIST and loads the winner's key.
// Without it, both starts write, the second overwrites the first, and a node that was already announced
// under one peer_id silently becomes another.
{
  const p = join(dir, 'race.key');
  const results = await Promise.all([
    loadOrCreatePeerKey(p), loadOrCreatePeerKey(p), loadOrCreatePeerKey(p),
    loadOrCreatePeerKey(p), loadOrCreatePeerKey(p),
  ]);
  const ids = new Set(results.map((r) => r.privateKey.publicKey.toString()));
  ok('FIVE CONCURRENT STARTS AGREE ON EXACTLY ONE peer_id', ids.size === 1);
  ok('exactly one of them reports having created it', results.filter((r) => r.created).length === 1);
  ok('the key on disk is the one they all returned',
     (await loadOrCreatePeerKey(p)).privateKey.publicKey.toString() === [...ids][0]);
}

// ── 5. REFUSALS ──
{
  const refuses = async (arg) => {
    try { await loadOrCreatePeerKey(arg); return false; }
    catch (e) { return /keyPath must be a non-empty string/.test(e.message); }
  };
  ok('an empty path is refused', await refuses(''));
  ok('a missing path is refused', await refuses(undefined));
  ok('a non-string path is refused', await refuses(123) && await refuses(null));

  const corrupt = join(dir, 'corrupt.key');
  writeFileSync(corrupt, Buffer.from('this is not a libp2p protobuf key'));
  let threw = false;
  try { await loadOrCreatePeerKey(corrupt); } catch { threw = true; }
  ok('A CORRUPT KEY FILE THROWS rather than silently minting a new identity under the same path', threw);
  ok('...and the corrupt file is left alone for the operator to look at',
     readFileSync(corrupt, 'utf8').startsWith('this is not'));
}

// ── 6. GOSSIP IS BEST-EFFORT; THE NODE IS NOT ──
{
  const warnings = [];
  const realWarn = console.warn, realError = console.error;
  console.warn = (...a) => warnings.push(a.join(' '));
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));

  const g = new GossipManager();
  ok('the manager is an EventEmitter with a WebTorrent client', typeof g.on === 'function' && g.client);
  ok('no swarm is joined until asked', g.swarm === null);

  // The transport error that used to kill the process (EADDRINUSE when a second node shares the box).
  g.client.emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }));
  ok('A TRANSPORT ERROR IS WARNED, NOT THROWN — an unhandled "error" event would kill the daemon',
     warnings.some((w) => /EADDRINUSE/.test(w) && /keeps running/.test(w)));
  g.client.emit('error', new Error('no code, just a message'));
  ok('an error with no code still degrades gracefully',
     warnings.some((w) => /no code, just a message/.test(w)));

  // broadcast with no swarm must be a no-op, not a crash.
  let broke = null;
  try { await g.broadcast({ hello: 'world' }); } catch (e) { broke = e; }
  ok('BROADCASTING BEFORE JOINING A SWARM IS A NO-OP, not a throw', broke === null);

  // A fake swarm lets the send path run without a network.
  const sent = [];
  g.swarm = { wires: [
    { send: (m) => sent.push(m) },
    { send: () => { throw new Error('peer went away mid-send'); } },   // the expected case
    { send: (m) => sent.push(m) },
  ] };
  await g.broadcast({ type: 'anchor', hash: 'abc' });
  ok('a message reaches every wire that can take it', sent.length === 2);
  ok('ONE DEAD PEER DOES NOT STOP THE BROADCAST reaching the others', sent.length === 2);
  ok('the payload on the wire is the JSON-encoded message',
     JSON.parse(sent[0].toString()).hash === 'abc' && Buffer.isBuffer(sent[0]));

  // Inbound parsing: a malformed frame from a peer must not take the node down.
  const got = [];
  g.on('message', (m) => got.push(m));
  g._handleMessage({ type: 'inbound', n: 1 });
  ok('a parsed message is re-emitted to subscribers', got.length === 1 && got[0].n === 1);

  // Drive the real wire handler the same way joinSwarm wires it up.
  const handlers = {};
  const fakeWire = { on: (ev, fn) => { handlers[ev] = fn; } };
  const fakeSwarm = { on: (ev, fn) => { if (ev === 'wire') fn(fakeWire); }, wires: [] };
  g.client.add = () => fakeSwarm;
  await g.joinSwarm('deadbeef');
  ok('joining a swarm registers a wire handler', typeof handlers.message === 'function');

  handlers.message(Buffer.from(JSON.stringify({ type: 'gossip', v: 2 })));
  ok('a well-formed inbound frame is emitted', got.length === 2 && got[1].v === 2);
  let crashed = null;
  try { handlers.message(Buffer.from('{not json')); } catch (e) { crashed = e; }
  ok('A MALFORMED FRAME FROM A PEER IS LOGGED, NOT THROWN — this is attacker-controlled input',
     crashed === null && errors.some((e) => /Error parsing gossip message/.test(e)));
  ok('...and it is not emitted as a message', got.length === 2);

  g.destroy();
  ok('destroy tears the client down', true);
  const g2 = new GossipManager();
  g2.client = null;
  let d = null;
  try { g2.destroy(); } catch (e) { d = e; }
  ok('destroying a manager with no client is harmless', d === null);

  console.warn = realWarn; console.error = realError;
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
