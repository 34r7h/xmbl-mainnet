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
// The daemon (bin/xmbl-node.js) wires these: check on an interval → suspend when behind → install → restart.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const OTA_EXIT_CODE = 75;   // "updated on disk — restart me": a supervisor sees a non-zero exit and respawns
export const XMBL_PACKAGES = Object.freeze(['@xmbl/core', '@xmbl/identity', '@xmbl/networking', '@xmbl/cubic-ledger',
  '@xmbl/state-machine', '@xmbl/consensus', '@xmbl/storage-compute', '@xmbl/zero-knowledge']);
export const DEFAULT_RELEASE_URL = 'https://registry.npmjs.org/@xmbl/core';

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

/** Behind or not. `latest` null (registry unreachable) is NOT "behind": a node is never suspended for the network's fault. */
export function otaDecision({ running, latest }) {
  if (!latest) return { behind: false, running, latest: null, reason: 'latest unknown' };
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

/** The exact command an update runs, so it can be logged, tested and audited. */
export function updateCommand(latest) {
  return { cmd: 'npm', args: ['install', `@xmbl/core@${latest}`, '--no-audit', '--no-fund', '--omit=dev', '--no-save'] };
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
