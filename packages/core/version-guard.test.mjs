// THE GUARD THAT MAKES A BAD BUMP IMPOSSIBLE, not merely regrettable.
//
// `release.test.mjs` beside this holds every published workspace on the CURRENT line — it catches a
// bump that leaves 0.1.x. It cannot catch 0.1.19 when the repo is on 0.1.17, because that is still
// the 0.1 line, and it cannot catch a 0.2.0 that somebody genuinely meant to authorize from one
// nobody did. `scripts/version-guard.mjs` counts instead: the next version is the next patch, or a
// minor/major that a committed flag names by version, and nothing else.
//
// This suite drives the pure decision over the cases that actually happened or nearly did, and then
// runs the real check against this working tree. Both halves matter: the table proves the rule, the
// live check proves it is wired to THIS repo. `npm run test:protocol` is what release.yml runs
// before it publishes, so a rejected version cannot reach npm.
import assert from 'node:assert';
import { decide, highestVersion, parseVersion, checkRepo, BUMP_FILE } from '../../scripts/version-guard.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };

// ── the three the operator named ──
ok('0.1.17 -> 0.1.18 is allowed (the next patch)', decide('0.1.17', '0.1.18', null).ok === true);
ok('0.1.17 -> 0.1.19 is REJECTED — it skips 0.1.18', decide('0.1.17', '0.1.19', null).ok === false);
ok('0.1.17 -> 0.2.0 is REJECTED without a flag', decide('0.1.17', '0.2.0', null).ok === false);
ok('0.1.17 -> 0.2.0 is allowed with "minor 0.2.0"', decide('0.1.17', '0.2.0', 'minor 0.2.0').ok === true);
ok('0.1.17 -> 1.0.0 is REJECTED without a flag', decide('0.1.17', '1.0.0', null).ok === false);
ok('0.1.17 -> 1.0.0 is allowed with "major 1.0.0"', decide('0.1.17', '1.0.0', 'major 1.0.0').ok === true);

// ── THE FLAG NAMES THE VERSION, so a leftover file authorizes nothing else ──
ok('a minor flag does NOT authorize a different minor', decide('0.1.17', '0.2.0', 'minor 0.3.0').ok === false);
ok('a minor flag does NOT authorize a major', decide('0.1.17', '1.0.0', 'minor 0.2.0').ok === false);
ok('a major flag does NOT authorize a minor', decide('0.1.17', '0.2.0', 'major 1.0.0').ok === false);
ok('a stale flag from the last release is inert (0.2.0 released, now bumping patch)',
  decide('0.2.0', '0.2.1', 'minor 0.2.0').ok === true && decide('0.2.0', '0.3.0', 'minor 0.2.0').ok === false);
ok('the word alone, with no version, authorizes nothing', decide('0.1.17', '0.2.0', 'minor').ok === false);
ok('surrounding whitespace in the flag file does not matter', decide('0.1.17', '0.2.0', '\n  minor 0.2.0  \n').ok === true);

// ── what 2026-09-21 actually did: changesets computed 1.0.0, a hand edit made it 0.2.0 ──
ok('THE INCIDENT: an unauthorized 0.2.0 on top of 0.1.11 is refused',
  decide('0.1.11', '0.2.0', null).ok === false);
ok('THE INCIDENT: the 1.0.0 the changesets wanted is refused too',
  decide('0.1.11', '1.0.0', null).ok === false);
ok('...and the refusal says which file would authorize it',
  new RegExp(BUMP_FILE).test(decide('0.1.11', '0.2.0', null).reason));

// ── counting, not choosing ──
ok('an unchanged version is fine (a commit after the tag)', decide('0.1.17', '0.1.17', null).ok === true);
ok('going BACKWARDS is refused', decide('0.1.17', '0.1.16', null).ok === false);
ok('skipping two minors is refused even with a flag', decide('0.1.17', '0.3.0', 'minor 0.3.0').ok === false);
ok('skipping two majors is refused even with a flag', decide('0.1.17', '2.0.0', 'major 2.0.0').ok === false);
ok('a new minor line must start at .0', decide('0.1.17', '0.2.3', 'minor 0.2.3').ok === false);
ok('a new major line must start at .0.0', decide('0.1.17', '1.0.1', 'major 1.0.1').ok === false);
ok('a new major line must start at 1.0.0, not 1.2.0', decide('0.1.17', '1.2.0', 'major 1.2.0').ok === false);

// ── no baseline is a FAILURE, not a pass. A guard that waves everything through when it cannot
//    tell is the shape of the check that was missing in the first place. ──
ok('with no tag to count from, the guard REFUSES rather than guessing', decide(null, '0.1.18', null).ok === false);
ok('a non-semver version is refused', decide('0.1.17', '0.1.18-beta.1', null).ok === false);

// ── the tag list is compared by NUMBER, not as strings ──
ok('0.1.11 outranks 0.1.9 (string order would say otherwise)',
  highestVersion(['v0.1.9', 'v0.1.11', 'v0.1.2']) === '0.1.11');
ok('a stray non-version tag is ignored', highestVersion(['nightly', 'v0.1.17', 'release']) === '0.1.17');
ok('parseVersion takes the v prefix or not', String(parseVersion('v1.2.3')) === String(parseVersion('1.2.3')));

// ── AND IT IS WIRED TO THIS REPO. The table above proves the rule; this proves the rule is applied
//    to the versions actually on disk, against the tags actually in this clone. ──
{
  const root = new URL('../../', import.meta.url).pathname;
  const r = checkRepo(root);
  console.log(`     repo: ${r.prev ?? '(no tag)'} -> ${r.next} [${r.kind}] over ${r.packages} published workspaces`);
  ok(`the version this tree carries is a legal next version (${r.prev} -> ${r.next})`, r.ok === true);
  ok('every published workspace carries the SAME version', r.kind !== 'disagree');
}

assert(pass + fail > 0);
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
