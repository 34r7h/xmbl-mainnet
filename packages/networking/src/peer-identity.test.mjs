// A NODE'S peer_id MUST SURVIVE A RESTART, AND THE KEY THAT DECIDES IT WAS 46.9% COVERED.
//
// By default libp2p mints a fresh key every start, so peer_id changes on every restart: presence
// continuity breaks, a bootstrap seed multiaddr (which embeds its peer_id) goes stale, and
// validation-task assignment keyed to a stable node stops being stable. peer-identity.js persists the
// key. What was never checked is the part that makes it safe — the create-once `wx` write that stops
// two simultaneous starts minting two different identities for one node, and the 0600 mode on a file
// that IS the node's identity.
//
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreatePeerKey } from './peer-identity.js';

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

// ── 6. (was: the GossipManager error paths) ──
// packages/networking/src/gossip.js is GONE as of 0.1.17. It was a second, EAGER WebTorrent client
// that nothing ever constructed — `grep -rn 'new GossipManager' packages | grep -v '.test.'` was
// empty from the first commit — while the swarm path that actually runs is ConsensusGossip in
// @xmbl/consensus, built by @xmbl/core at index.js:181 and lazily loading webtorrent. Keeping a
// duplicate alive only in its own test is the same defect as the imported-and-never-called DHT it
// sat beside: it reads like a capability. The error-handling behaviour those checks covered lives
// on in @xmbl/consensus/src/gossip.js, where it is reached by running code.

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
