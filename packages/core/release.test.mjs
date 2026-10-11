// The node's version proof, suspension rule and OTA decision — the pure parts, by count.
import assert from 'node:assert';
import { sep } from 'node:path';
import { compareVersions, codeDigest, otaDecision, fetchLatestVersion, installRootOf, updateCommand, OTA_EXIT_CODE, XMBL_PACKAGES,
  onTrack, asVersion, PeerReleaseTrigger, installedVersions, acquireInstallLock, INSTALL_LOCK, DEFAULT_RELEASE_URL,
  guardFloodsub, FLOODSUB_GUARD } from './release.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };

// compareVersions: numeric triples, not strings
ok('0.1.9 < 0.1.11 (numeric, not lexical)', compareVersions('0.1.9', '0.1.11') < 0);
ok('0.1.11 == v0.1.11', compareVersions('0.1.11', 'v0.1.11') === 0);
ok('0.2.0 > 0.1.99', compareVersions('0.2.0', '0.1.99') > 0);
ok('garbage sorts lowest', compareVersions('nope', '0.0.1') < 0 && compareVersions('0.0.1', undefined) > 0);

// THE VERSION LINE IS 0.1.x AND ONLY THE OPERATOR MOVES IT. On 2026-09-21 `npm run version` computed
// 1.0.0 from the accumulated changesets, that was overridden to 0.2.0 by hand, tagged, and the tag
// published all twelve packages at 0.2.0 to npm — a minor bump nobody had asked for, announcing a
// milestone that had not happened. It cannot be unpublished (npm requires interactive 2FA, which no
// CI token has), so 0.2.0 is on the registry permanently and is the highest version @xmbl/* has.
//
// This check is the thing that was missing: every workspace version must be on the 0.1.x line, so a
// bump past it fails `npm run test:protocol` — which the release workflow runs BEFORE it publishes —
// instead of being discovered on the registry afterwards. Raising the line is a deliberate edit to
// LINE_MAJOR/LINE_MINOR here, by the operator, in the same commit that raises the versions.
{
  const LINE_MAJOR = 0, LINE_MINOR = 1;
  const { readFileSync } = await import('node:fs');
  const { execSync } = await import('node:child_process');
  const root = new URL('../../', import.meta.url).pathname;
  const manifests = execSync('git ls-files "**/package.json" package.json', { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  const offenders = [];
  let checked = 0;
  for (const rel of manifests) {
    let j; try { j = JSON.parse(readFileSync(root + rel, 'utf8')); } catch { continue; }
    if (!j.version || j.private) continue;            // private workspaces are not published
    checked++;
    const [maj, min] = j.version.split('.').map(Number);
    if (maj !== LINE_MAJOR || min !== LINE_MINOR) offenders.push(`${j.name}@${j.version}`);
  }
  ok(`all ${checked} published workspaces are on the ${LINE_MAJOR}.${LINE_MINOR}.x line`
    + (offenders.length ? ' — OFF LINE: ' + offenders.join(', ') : ''), offenders.length === 0);
  // and the crates move with them
  const cargo = readFileSync(root + 'Cargo.toml', 'utf8');
  const cv = (cargo.match(/^version = "([^"]+)"/m) || [])[1];
  const [cmaj, cmin] = String(cv).split('.').map(Number);
  ok(`Cargo workspace version ${cv} is on the same line`, cmaj === LINE_MAJOR && cmin === LINE_MINOR);
}

// otaDecision: behind only when a real latest is newer
ok('behind when latest is newer', otaDecision({ running: '0.1.11', latest: '0.1.12' }).behind === true);
ok('not behind when equal', otaDecision({ running: '0.1.11', latest: '0.1.11' }).behind === false);
ok('not behind when running is newer (a canary)', otaDecision({ running: '0.1.13', latest: '0.1.11' }).behind === false);
ok('unknown latest is NOT behind — never suspended for the network\'s fault', otaDecision({ running: '0.1.11', latest: null }).behind === false);

// codeDigest: the code in memory, stable, covering every module
const d1 = codeDigest(), d2 = codeDigest();
ok('digest is a sha-256 hex', /^[0-9a-f]{64}$/.test(d1.digest));
ok('digest is stable across calls', d1.digest === d2.digest);
ok(`covers all ${XMBL_PACKAGES.length} @xmbl packages this process loads`, XMBL_PACKAGES.every((n) => d1.packages[n] && d1.packages[n].files > 0 && /^[0-9a-f]{64}$/.test(d1.packages[n].digest)));
ok('names each package version', XMBL_PACKAGES.every((n) => typeof d1.packages[n].version === 'string'));
ok('tests are not code (this file is not in the core digest)', codeDigest(['@xmbl/core']).packages['@xmbl/core'].files === d1.packages['@xmbl/core'].files && !Object.keys(d1.packages['@xmbl/core']).includes('release.test.mjs'));
const only = codeDigest(['@xmbl/core']);
ok('a narrower package list yields a different digest (the digest is over what is listed)', only.digest !== d1.digest);

// fetchLatestVersion: npm document, plain document, failures
const stub = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
ok('reads dist-tags.latest from an npm registry document', (await fetchLatestVersion('x', { fetchImpl: stub({ 'dist-tags': { latest: '0.1.12' } }) })) === '0.1.12');
ok('reads { version } from a plain release endpoint', (await fetchLatestVersion('x', { fetchImpl: stub({ version: '0.1.13' }) })) === '0.1.13');
let err = null; try { await fetchLatestVersion('x', { fetchImpl: stub({}, 503) }); } catch (e) { err = e.message; }
ok('an HTTP failure throws (and the caller treats it as latest unknown)', /HTTP 503/.test(err || ''));
err = null; try { await fetchLatestVersion('x', { fetchImpl: stub({ 'dist-tags': {} }) }); } catch (e) { err = e.message; }
ok('a document without a version throws', /no version/.test(err || ''));

// installRootOf: only a real install updates itself
ok('…/node_modules/@xmbl/core → the install root', installRootOf(['', 'srv', 'bundle', 'node_modules', '@xmbl', 'core'].join(sep)) === ['', 'srv', 'bundle'].join(sep));
ok('a source checkout has no install root (git updates it, not the daemon)', installRootOf(['', 'repo', 'packages', 'core'].join(sep)) === null);
ok('this checkout is recognised as a source checkout', installRootOf() === null);

// updateCommand + exit code are fixed, auditable values
const u = updateCommand('0.1.12');
ok('update command is the coordinator\'s: npm install all eight @xmbl/*@<latest>, pinned exactly, prod deps, no audit/fund',
  u.cmd === 'npm' && u.args[0] === 'install' && XMBL_PACKAGES.every((n, i) => u.args[1 + i] === `${n}@0.1.12`)
  && ['--omit=dev', '--no-audit', '--no-fund', '--save-exact'].every((f) => u.args.includes(f)) && !u.args.includes('--no-save'));
ok('OTA exit code is 75', OTA_EXIT_CODE === 75);
ok('the release source is the 19-byte dist-tags document, not the 43 KB packument', DEFAULT_RELEASE_URL === 'https://registry.npmjs.org/-/package/@xmbl%2fcore/dist-tags');
ok('reads { latest } from the dist-tags document', (await fetchLatestVersion('x', { fetchImpl: stub({ latest: '0.1.25' }) })) === '0.1.25');

// the track: 0.1.x, and a tag that points off it is unknown, never behind
ok('0.1.26 is on the 0.1. track', onTrack('0.1.26', '0.1.'));
ok('0.2.0 is off the 0.1. track', !onTrack('0.2.0', '0.1.'));
ok('* follows any x.y.z', onTrack('0.2.0', '*') && !onTrack('nope', '*'));
ok('a prerelease or padded string is not a version', !asVersion('0.1.26-rc.1') && !asVersion(' 0.1.26') && !asVersion(26) && asVersion('0.1.26') === '0.1.26');
const off = otaDecision({ running: '0.1.25', latest: '0.2.0', track: '0.1.' });
ok('latest off the track is NOT behind and is reported as unknown (0.2.0 never moves a node)', off.behind === false && off.latest === null);
ok('latest on the track and newer is behind', otaDecision({ running: '0.1.25', latest: '0.1.26', track: '0.1.' }).behind === true);

// PeerReleaseTrigger: a peer's version makes a node look now; a forged one costs bounded lookups and nothing else
{
  let t = 0; const now = () => t;
  const tr = new PeerReleaseTrigger({ running: '0.1.25', minMs: 15_000, maxMs: 120_000, track: '0.1.', now });
  ok('a peer on the same version is not a reason to look', tr.offer('0.1.25') === false);
  ok('a peer on an older version is not a reason to look', tr.offer('0.1.24') === false);
  ok('a peer off the track is not a reason to look', tr.offer('0.2.0') === false);
  ok('garbage is not a reason to look', tr.offer('9.9.9-x') === false && tr.offer({}) === false);
  ok('a peer on a newer version on the track: look now', tr.offer('0.1.26') === true);
  ok('the same claim 4 s later (the next presence) does not look again', (t += 4000, tr.offer('0.1.26')) === false);
  // A forger repeats a version the release source never confirms, every 4 s for an hour, from 100 addresses.
  let looks = 1;
  for (t = 4000; t <= 3_600_000; t += 4000) { for (let a = 0; a < 100; a++) if (tr.offer('0.1.99')) { looks++; tr.settle('0.1.25'); } }
  ok(`a forged version from 100 peers for an hour costs ${looks} lookups (bounded by the poll cadence, not by the peers)`, looks <= 3_600_000 / 120_000 + 5);
  // The release source confirms a real release: the wait resets, and the confirmed version stops triggering.
  const tr2 = new PeerReleaseTrigger({ running: '0.1.25', minMs: 15_000, maxMs: 120_000, track: '0.1.', now });
  t = 0; tr2.offer('0.1.26'); tr2.settle('0.1.25');            // the registry has not caught up yet
  ok('an unconfirmed claim waits 15 s before the next look', (t = 14_000, tr2.offer('0.1.26')) === false && (t = 15_000, tr2.offer('0.1.26')) === true);
  tr2.settle('0.1.26');
  ok('once the release source confirms it, the same claim no longer triggers (the update is under way)', (t = 60_000, tr2.offer('0.1.26')) === false);
  ok('a newer claim after a confirmation looks at once', tr2.offer('0.1.27') === true);
}

// installedVersions + the install lock: what is on disk, and one npm at a time in an install root
{
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'xmbl-ota-'));
  for (const n of XMBL_PACKAGES.slice(0, 7)) { mkdirSync(join(root, 'node_modules', n), { recursive: true }); writeFileSync(join(root, 'node_modules', n, 'package.json'), JSON.stringify({ name: n, version: '0.1.26' })); }
  const have = installedVersions(root);
  ok('installedVersions reads each package\'s version on disk, null where absent', XMBL_PACKAGES.slice(0, 7).every((n) => have[n] === '0.1.26') && have[XMBL_PACKAGES[7]] === null);
  const l1 = acquireInstallLock(root, { version: '0.1.26' });
  ok('the first install takes the lock', !!l1 && existsSync(join(root, INSTALL_LOCK)) && JSON.parse(readFileSync(join(root, INSTALL_LOCK), 'utf8')).version === '0.1.26');
  ok('a second install while it is held does not', acquireInstallLock(root, { version: '0.1.26' }) === null);
  l1.release();
  ok('released, the file is gone', !existsSync(join(root, INSTALL_LOCK)));
  writeFileSync(join(root, INSTALL_LOCK), JSON.stringify({ pid: 2 ** 22 + 12345, version: '0.1.26', at: new Date().toISOString() }));
  const l2 = acquireInstallLock(root, { version: '0.1.26' });
  ok('a lock whose pid is dead is taken over', !!l2); l2?.release();
  writeFileSync(join(root, INSTALL_LOCK), JSON.stringify({ pid: process.pid, version: '0.1.26', at: new Date(Date.now() - 11 * 60_000).toISOString() }));
  const l3 = acquireInstallLock(root, { version: '0.1.26', pid: process.pid + 1 });
  ok('a lock older than 10 min is taken over', !!l3); l3?.release();
  writeFileSync(join(root, INSTALL_LOCK), 'not json');
  const l4 = acquireInstallLock(root, { version: '0.1.26' });
  ok('an unreadable lock is taken over', !!l4); l4?.release();
  rmSync(root, { recursive: true, force: true });
}

// The floodsub cleanup guard: the node wraps the same 4 abort sites the coordinator's patch-floodsub.mjs does, with
// the same marker, so a tree patched by either is left alone by the other. Run against the real peer-streams.js.
{
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createRequire } = await import('node:module');
  let real = null;
  try { const req = createRequire(new URL('../networking/package.json', import.meta.url)); real = readFileSync(join(req.resolve('@libp2p/floodsub').replace(/index\.js$/, ''), 'peer-streams.js'), 'utf8'); } catch { /* resolved below */ }
  ok('the real @libp2p/floodsub peer-streams.js is readable here', typeof real === 'string' && real.length > 0);
  const root = mkdtempSync(join(tmpdir(), 'xmbl-floodsub-'));
  const f = join(root, 'node_modules', '@libp2p', 'floodsub', 'dist', 'src', 'peer-streams.js');
  mkdirSync(join(f, '..'), { recursive: true });
  const raw = (real || '').replace(/try \{ \/\*hf-abort-guard\*\/ (.*?) \} catch \(_e\) \{\}/g, '$1');
  writeFileSync(f, raw);
  const sitesIn = (t) => (t.match(/unwrap\(\)\.unwrap\(\)\.abort\(err\);/g) || []).length;
  const g1 = guardFloodsub(root);
  const after = readFileSync(f, 'utf8');
  ok(`an unguarded tree: every abort site is wrapped (${g1.sites} of ${sitesIn(raw)})`, g1.sites > 0 && g1.sites === sitesIn(raw) && after.split(FLOODSUB_GUARD).length - 1 === g1.sites);
  ok('the wrap is the coordinator\'s exact text', after.includes('try { /*hf-abort-guard*/ this.inboundPb?.unwrap().unwrap().abort(err); } catch (_e) {}'));
  const g2 = guardFloodsub(root);
  ok('a second run changes nothing (no double wrap)', g2.sites === 0 && g2.already === 1 && readFileSync(f, 'utf8') === after);
  ok('a tree with no floodsub is skipped, not an error', guardFloodsub(join(root, 'nope')).files === 0);
  writeFileSync(f, 'export class PeerStreams {}');
  const g3 = guardFloodsub(root);
  ok('a drifted floodsub with no abort pattern is found and left untouched', g3.files === 1 && g3.sites === 0 && readFileSync(f, 'utf8') === 'export class PeerStreams {}');
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
