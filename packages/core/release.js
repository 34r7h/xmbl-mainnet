// release.js — a node's VERSION PROOF, its SUSPENSION rule, and its over-the-air UPDATE decision.
//
// Operator, 2026-09-16: every change rolls out to every node; a node must PROVE it runs the latest version or
// be SUSPENDED until it is updated; updates happen automatically, over the air. The pure parts live here so they
// are testable without a network or a running daemon:
//   codeDigest()        — a sha-256 over the bytes of every @xmbl/* module this process loaded (sorted paths,
//                         tests excluded). Signed into the `chain` claim next to `versions`, it is the proof a
//                         verifier compares against the digest of the published release — a version STRING can
//                         be typed; the digest of the code in memory cannot.
//   compareVersions()   — semver triples, so "0.1.9" < "0.1.11".
//   otaDecision()       — behind or not, and what to do about it.
//   fetchLatestVersion()— the source of truth for "latest": the npm registry's dist-tag (the operator's
//                         rule is "xmbl npm always latest"), or a broker endpoint returning { version }.
//   installRootOf()     — where `npm install @xmbl/core@<latest>` runs: the install that owns THIS core, or
//                         null in a source checkout (a checkout is updated by git, never by the daemon).
//   otaRestartMode()    — after the install: exit 75 to a supervisor that still owns this node, or respawn.
//   onTrack()           — the version line a node follows (0.1.x; XMBL_TRACK moves it): anything off it is unknown.
//   PeerReleaseTrigger  — a peer's gossiped version makes this node look NOW, at most so often (see below).
//   installedVersions() / acquireInstallLock() — what is on disk, and one npm at a time in an install root.
//   installPreflight()  — room on the disk for the install, and the memory the box has, read before npm runs.
// The daemon (bin/xmbl-node.js) wires these: check on an interval or when a peer says it runs a newer version →
// suspend when behind → install → restart.
import { createHash } from 'node:crypto';
import * as fsNs from 'node:fs';
import { closeSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { freemem } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const OTA_EXIT_CODE = 75;   // "updated on disk — restart me": a supervisor sees a non-zero exit and respawns
export const XMBL_PACKAGES = Object.freeze(['@xmbl/core', '@xmbl/identity', '@xmbl/networking', '@xmbl/cubic-ledger',
  '@xmbl/state-machine', '@xmbl/consensus', '@xmbl/storage-compute', '@xmbl/zero-knowledge']);
// The dist-tags document: {"latest":"0.1.25"}, 19 bytes, where the full @xmbl/core packument is 43 KB (measured
// 2026-10-11) — every node asks every couple of minutes, so it asks for the one field it reads.
export const DEFAULT_RELEASE_URL = 'https://registry.npmjs.org/-/package/@xmbl%2fcore/dist-tags';
export const DEFAULT_TRACK = '0.1.';
const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/** A plain x.y.z version string, or null. Gossip is untrusted input: nothing else is a version. */
export function asVersion(v) {
  return typeof v === 'string' && VERSION_RE.test(v) ? v : null;
}

/** On the line this node follows: XMBL_TRACK (default '0.1.') is a prefix, '*' follows whatever the tag says. */
export function onTrack(v, track = process.env.XMBL_TRACK || DEFAULT_TRACK) {
  if (!asVersion(v)) return false;
  return track === '*' || v.startsWith(track);
}

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

/** -1, 0 or 1 for semver strings compared as numeric triples; anything unparseable sorts lowest. */
export function compareVersions(a, b) {
  const parse = (v) => { const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
  const pa = parse(a), pb = parse(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** The directory a package resolves to from THIS module — the code the process actually loads. */
export function packageDirOf(name) {
  if (name === '@xmbl/core') return HERE;
  try { return dirname(require.resolve(name)); } catch { return null; }
}

// Code files only: what runs. Tests, docs, lockfiles and the package's own node_modules are not the code.
const CODE_FILE = /\.(m?js|cjs|json|wasm)$/;
const NOT_CODE = /(^|\/)(node_modules|\.git|dist-node|test-keys[^/]*|data)(\/|$)|\.test\.(m?js|js)$|(^|\/)__tests__(\/|$)/;
function walk(dir, root, out) {
  let entries; try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries.sort()) {
    const p = join(dir, name);
    const rel = relative(root, p).split(sep).join('/');
    if (NOT_CODE.test(rel)) continue;
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, root, out);
    else if (CODE_FILE.test(name)) out.push(rel);
  }
  return out;
}

/** Digest the code of every listed package as loaded by this process: { digest, packages: {name: {version, dir, files, digest}} }. */
export function codeDigest(names = XMBL_PACKAGES) {
  const packages = {};
  const all = createHash('sha256');
  for (const name of names) {
    const dir = packageDirOf(name);
    if (!dir) { packages[name] = null; all.update(`${name}\0missing\0`); continue; }
    let version = null;
    try { version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || null; } catch { /* no manifest */ }
    const h = createHash('sha256');
    const files = walk(dir, dir, []);
    for (const rel of files) { h.update(rel); h.update('\0'); h.update(readFileSync(join(dir, rel))); h.update('\0'); }
    const digest = h.digest('hex');
    packages[name] = { version, dir, files: files.length, digest };
    all.update(`${name}@${version}\0${digest}\0`);
  }
  return { digest: all.digest('hex'), packages };
}

/** Behind or not. `latest` null (registry unreachable) is NOT "behind": a node is never suspended for the network's fault.
 *  A `latest` off the track is unknown too: 0.2.0 is on the registry for good (see release.test.mjs), and a tag that
 *  ever points at it again must not move a single node off the 0.1.x line. */
export function otaDecision({ running, latest, track }) {
  if (!latest) return { behind: false, running, latest: null, reason: 'latest unknown' };
  if (!onTrack(latest, track)) return { behind: false, running, latest: null, reason: `latest ${latest} is off the track — ignored` };
  const behind = compareVersions(running, latest) < 0;
  return { behind, running, latest, reason: behind ? `running ${running}, latest ${latest}` : 'up to date' };
}

/** The latest published version: an npm registry document's dist-tags.latest, or a plain { version } / { latest } body. */
export async function fetchLatestVersion(url = DEFAULT_RELEASE_URL, { timeoutMs = 10_000, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch available');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`release lookup ${url}: HTTP ${r.status}`);
    const doc = await r.json();
    const v = (doc && doc['dist-tags'] && doc['dist-tags'].latest) || (doc && (doc.latest || doc.version)) || null;
    if (typeof v !== 'string' || !/^\d+\.\d+\.\d+/.test(v)) throw new Error(`release lookup ${url}: no version in response`);
    return v;
  } finally { clearTimeout(t); }
}

/** The install root that owns a core at `coreDir` (…/node_modules/@xmbl/core → …), or null for a source checkout. */
export function installRootOf(coreDir = HERE) {
  const parts = coreDir.split(sep);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0 || parts[i + 1] !== '@xmbl' || parts[i + 2] !== 'core') return null;
  return parts.slice(0, i).join(sep) || sep;
}

// The exact command an update runs, so it can be logged, tested and audited. It is THE SAME install the handoff
// coordinator runs (convergeXmblBundle in handoff-lib.mjs): all eight packages, pinned exactly. Installing core
// alone left the other seven on the old version in a coordinator's install root, where they are pinned — so the
// node came back on new core over old consensus (the code that hears a peer's version), and the coordinator,
// finding seven stale, installed and restarted it a second time. With one command, whichever runs first leaves
// the other nothing to do.
export function updateCommand(latest) {
  return { cmd: 'npm', args: ['install', ...XMBL_PACKAGES.map((n) => `${n}@${latest}`), '--omit=dev', '--no-audit', '--no-fund', '--save-exact'] };
}

/** name → version on disk under `root`/node_modules for the eight packages (null where absent). */
export function installedVersions(root, names = XMBL_PACKAGES) {
  const out = {};
  for (const n of names) {
    try { out[n] = JSON.parse(readFileSync(join(root, 'node_modules', ...n.split('/'), 'package.json'), 'utf8')).version || null; }
    catch { out[n] = null; }
  }
  return out;
}

// ONE NPM AT A TIME IN AN INSTALL ROOT. On a handoff box the node and its coordinator both install into ~/.handoff,
// and two npm processes reifying one node_modules can leave it half of each. The node takes this file with O_EXCL
// for the length of its install; the coordinator is asked to do the same. A lock whose pid is gone, or that is
// older than `staleMs`, is a crash's leftover and is taken over.
export const INSTALL_LOCK = '.xmbl-install.lock';
export function acquireInstallLock(root, { version = null, staleMs = 10 * 60_000, pid = process.pid, now = Date.now() } = {}) {
  const file = join(root, INSTALL_LOCK);
  const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o644);
      writeSync(fd, JSON.stringify({ pid, version, at: new Date(now).toISOString(), by: 'xmbl-node' }));
      closeSync(fd);
      return { file, release() { try { if (JSON.parse(readFileSync(file, 'utf8')).pid === pid) unlinkSync(file); } catch { /* gone */ } } };
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      let held = null; try { held = JSON.parse(readFileSync(file, 'utf8')); } catch { /* unreadable: treat as stale */ }
      const at = held && Date.parse(held.at);
      if (held && held.pid && alive(held.pid) && Number.isFinite(at) && now - at < staleMs) return null;
      try { unlinkSync(file); } catch { /* raced */ }
    }
  }
  return null;
}

// ROOM FOR THE UPDATE, READ BEFORE NPM RUNS. 4293b3c6 had 47 MB free on 2026-10-11 (a 479 MB node.log and a
// 2.1 GB npm cache on a 25 GB disk) and was handed every update all the same; npm on a full disk dies part-way and
// leaves a reason no one reads. So the install is refused below a floor, with the free space and the floor in
// `ota.last_error` (the `status` op reports it), and the next look retries on its own once there is room.
// MEASURED for the floor: @xmbl/*@0.1.25 -> 0.1.26 grew the tree by 0 KB and the npm cache by 8 KB (the eight
// packages are 3 MB unpacked); a cold install of the whole tree is 122 MB of node_modules and 153 MB of cache.
// The floor is the patch upgrade with a wide margin, not the cold install: a box that cannot update stays
// suspended, so a floor set too high strands the box it was meant to protect. XMBL_OTA_MIN_FREE_MB moves it
// (0 turns the check off). statfsSync is read off the namespace: a named import of it would fail this module's
// link on a Node without it, and with it the whole daemon, which is the one thing that must still boot to update.
// MEMORY IS REPORTED, NEVER REFUSED ON. npm's peak RSS for that upgrade was 121 MB (164 MB cold), and 4293b3c6
// installed 0.1.26 with 130-145 MB available, swapping. A memory floor near npm's peak would have kept that box
// on 0.1.25 for good.
export const OTA_MIN_FREE_MB = 32;
export function installPreflight(root, { minFreeMb = envMb(process.env.XMBL_OTA_MIN_FREE_MB, OTA_MIN_FREE_MB), statfs = (p) => fsNs.statfsSync(p),
  meminfo = () => readFileSync('/proc/meminfo', 'utf8'), freeBytes = freemem } = {}) {
  let freeMbNow = null;
  try { const s = statfs(root); const mb = Math.floor((Number(s.bavail) * Number(s.bsize)) / 1048576); if (Number.isFinite(mb)) freeMbNow = mb; } catch { /* no statfs here: nothing to refuse on */ }
  let memMb = null;
  try { const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo()); if (m) memMb = Math.floor(Number(m[1]) / 1024); } catch { /* not Linux */ }
  if (memMb === null) { try { const mb = Math.floor(freeBytes() / 1048576); if (Number.isFinite(mb)) memMb = mb; } catch { /* unknown */ } }
  const ok = freeMbNow === null || freeMbNow >= minFreeMb;
  return { ok, free_mb: freeMbNow, min_free_mb: minFreeMb, mem_available_mb: memMb,
    reason: ok ? null : `${freeMbNow} MB free in ${root}, an update needs ${minFreeMb} MB` };
}
function envMb(v, dflt) { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : dflt; }

// THE FLOODSUB CLEANUP GUARD, on every tree this node installs. @libp2p/floodsub's peer-stream error handlers call
// abort() on a Yamux stream that may already be closed; that throws StreamStateError out of a .catch as an
// unhandled rejection and ends the process (2026-09-13: it took the whole mesh down). The handoff coordinator wraps
// each call in try/catch after its own install (~/.handoff/bin/patch-floodsub.mjs); a tree the node installs itself
// comes from the registry unpatched, so the node applies the same edit with the same marker — whichever of the two
// runs second finds it done, and a call is never wrapped twice. Returns what it found and how many sites it wrapped.
export const FLOODSUB_GUARD = '/*hf-abort-guard*/';
const FLOODSUB_ABORTS = ['this.inboundPb?.unwrap().unwrap().abort(err);', 'this.outboundPb?.unwrap().unwrap().abort(err);'];
export function guardFloodsub(root) {
  const out = { files: 0, already: 0, sites: 0 };
  for (const f of [join(root, 'node_modules', '@libp2p', 'floodsub', 'dist', 'src', 'peer-streams.js'),
    join(root, 'node_modules', '@xmbl', 'networking', 'node_modules', '@libp2p', 'floodsub', 'dist', 'src', 'peer-streams.js')]) {
    let s; try { s = readFileSync(f, 'utf8'); } catch { continue; }
    out.files++;
    if (s.includes(FLOODSUB_GUARD)) { out.already++; continue; }
    let n = 0;
    for (const p of FLOODSUB_ABORTS) { const parts = s.split(p); n += parts.length - 1; s = parts.join(`try { ${FLOODSUB_GUARD} ${p} } catch (_e) {}`); }
    if (n) { writeFileSync(f, s); out.sites += n; }
  }
  return out;
}

// A PEER'S VERSION IS A REASON TO LOOK, NEVER THE ANSWER. Every node says which version it runs in its presence
// (every 4 s), so the first node to update tells the whole mesh within seconds instead of each node finding out
// on its own poll. Presence is not authenticated, so a claim only makes this node ask the release source NOW;
// what it installs is what the release source says, exactly as on the timer. A forged claim therefore costs
// lookups and nothing else, and those are bounded: the first look comes at once, and each look that does not
// confirm the claim doubles the wait before the next one (minMs, 2·minMs, … up to maxMs, the poll interval). A
// confirmed claim resets the wait. One trigger per node, not one per peer: a hundred peers saying the same thing
// are one reason to look.
export class PeerReleaseTrigger {
  constructor({ running, minMs = 15_000, maxMs = 120_000, track, now = () => Date.now() } = {}) {
    this.running = running; this.minMs = minMs; this.maxMs = Math.max(minMs, maxMs); this.track = track; this.now = now;
    this.wait = this.minMs; this.nextAt = 0; this.highest = null; this.known = null;
  }
  /** A peer said it runs (or has seen) `v`. True when the caller should look now. */
  offer(v) {
    v = asVersion(v);
    if (!v || !onTrack(v, this.track) || compareVersions(v, this.running) <= 0) return false;
    if (this.known && compareVersions(v, this.known) <= 0) return false;   // already confirmed; the update is under way
    if (!this.highest || compareVersions(v, this.highest) > 0) this.highest = v;
    const t = this.now();
    if (t < this.nextAt) return false;
    this.nextAt = t + this.wait;
    this.wait = Math.min(this.wait * 2, this.maxMs);
    return true;
  }
  /** The release source answered `latest` (null when it could not be reached). */
  settle(latest) {
    latest = asVersion(latest);
    if (latest && onTrack(latest, this.track) && compareVersions(latest, this.running) > 0) this.known = latest;
    if (latest && this.highest && compareVersions(latest, this.highest) >= 0) { this.wait = this.minMs; this.nextAt = 0; this.highest = null; }
  }
}

// WHO RESTARTS THIS NODE once an update is installed. Exit 75 hands the restart to a supervisor, so it is right only
// while one still owns this process; with nobody left to see it, it is a node that stops and stays stopped.
// MEASURED 2026-10-09 on 831cfb42 (aws-syd1): its coordinator spawned it with --ppid on 10-02, self-updated on 10-04
// (`detach`, exit, the replacement ADOPTED the running node — it is nobody's child after that), and at 05:59:00 the
// 0.1.21 OTA installed and the node exited 75 into nothing; it was still down 8 h later. Five more nodes showed
// the same "control socket unreachable" with their coordinators online.
//   --ppid given: owned only while that launcher is still this process's parent and the watch was never detached —
//                 XMBL_SUPERVISED cannot override that, because a coordinator sets both.
//   no --ppid:    XMBL_SUPERVISED=1 means pm2/systemd owns it; otherwise nobody does.
export function otaRestartMode({ watchPpid = 0, ppid = 0, detached = false, envSupervised = false } = {}) {
  if (watchPpid) return !detached && ppid === watchPpid ? 'exit' : 'respawn';
  return envSupervised ? 'exit' : 'respawn';
}

// The command line and environment a node that restarts ITSELF boots with. Neither may claim a supervisor: a
// respawn that kept `--ppid <launcher>` would arm the parent watch against a pid that is not its parent and shut
// itself down within 3 s, and one that kept XMBL_SUPERVISED=1 would exit 75 into nothing on the next update.
export function respawnArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ppid') { if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++; continue; }
    if (String(argv[i]).startsWith('--ppid=')) continue;
    out.push(argv[i]);
  }
  return out;
}
export function respawnEnv(env) {
  const { XMBL_SUPERVISED, ...rest } = env;
  return rest;
}
