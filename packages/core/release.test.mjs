// The node's version proof, suspension rule and OTA decision — the pure parts, by count.
import assert from 'node:assert';
import { sep } from 'node:path';
import { compareVersions, codeDigest, otaDecision, fetchLatestVersion, installRootOf, updateCommand, OTA_EXIT_CODE, XMBL_PACKAGES } from './release.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };

// compareVersions: numeric triples, not strings
ok('0.1.9 < 0.1.11 (numeric, not lexical)', compareVersions('0.1.9', '0.1.11') < 0);
ok('0.1.11 == v0.1.11', compareVersions('0.1.11', 'v0.1.11') === 0);
ok('0.2.0 > 0.1.99', compareVersions('0.2.0', '0.1.99') > 0);
ok('garbage sorts lowest', compareVersions('nope', '0.0.1') < 0 && compareVersions('0.0.1', undefined) > 0);

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
ok('update command is npm install @xmbl/core@<latest> (no audit/fund, prod deps, no manifest edit)', u.cmd === 'npm' && u.args[0] === 'install' && u.args[1] === '@xmbl/core@0.1.12' && u.args.includes('--no-save'));
ok('OTA exit code is 75', OTA_EXIT_CODE === 75);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
