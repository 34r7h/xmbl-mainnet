// THE VERSION CANNOT MOVE BY ACCIDENT.
//
// On 2026-09-21 `npm run version` computed 1.0.0 from accumulated changesets, that was overridden to
// 0.2.0 by hand, tagged, and the tag published twelve packages at a minor bump nobody had asked for —
// announcing a milestone that had not happened. npm will not take it back: 0.2.0 is permanently
// semver-max on eight of them, so every resolver that reads a version list rather than a dist-tag
// still picks up code that was never released. Nothing in the repo objected, because nothing in the
// repo had an opinion about what the NEXT version was allowed to be.
//
// This is that opinion, and it is a HARD GATE (packages/core/version-guard.test.mjs runs it inside
// `npm run test:protocol`, which release.yml runs BEFORE it publishes).
//
// THE RULE. Against the highest existing release tag:
//
//   PREV -> PREV                  ok    (a commit after the tag; nothing moved)
//   PREV -> patch + 1             ok    0.1.17 -> 0.1.18
//   PREV -> minor + 1, patch 0    needs `minor <version>` in VERSION-BUMP     0.1.17 -> 0.2.0
//   PREV -> major + 1, 0, 0       needs `major <version>` in VERSION-BUMP     0.1.17 -> 1.0.0
//   anything else                 REJECTED — a skipped patch (0.1.17 -> 0.1.19), a skipped minor,
//                                 a decrease, a minor bump landing on a non-zero patch, a version
//                                 the published workspaces do not agree on.
//
// THE FLAG NAMES THE VERSION IT AUTHORIZES. `VERSION-BUMP` holds one line — `minor 0.2.0` — and
// authorizes exactly that version and nothing else, so a file left behind from an earlier release
// can never wave a later bump through. Writing it is the deliberate act; there is no env override,
// for the same reason AUDIT_GATES_OPEN has none.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const BUMP_FILE = 'VERSION-BUMP';

/** "v0.1.17" | "0.1.17" -> [0,1,17], or null when it is not a plain three-part semver. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** The highest of a list of tags, by number and not by string ("0.1.9" < "0.1.11"). */
export function highestVersion(list) {
  let best = null;
  for (const t of list) {
    if (!parseVersion(t)) continue;
    if (best === null || compareVersions(t, best) > 0) best = t;
  }
  return best === null ? null : String(best).replace(/^v/, '');
}

/**
 * THE DECISION, as a pure function so it can be tested without a repo.
 *
 * @param {string} prev     the highest existing release tag, e.g. "0.1.17"
 * @param {string} next     the version the tree carries
 * @param {string|null} bump  the contents of VERSION-BUMP, or null when absent
 * @returns {{ok: boolean, kind: string, reason: string}}
 */
export function decide(prev, next, bump) {
  const p = parseVersion(prev), n = parseVersion(next);
  if (!n) return { ok: false, kind: 'invalid', reason: `"${next}" is not a three-part semver` };
  if (!p) return { ok: false, kind: 'no-baseline', reason: `no release tag to count from — refusing to guess. A repo with no tags cannot prove a version is sequential, and a guard that passes when it cannot tell is not a guard (in CI: actions/checkout needs fetch-depth: 0 and fetch-tags: true).` };

  const cmp = compareVersions(next, prev);
  if (cmp === 0) return { ok: true, kind: 'unchanged', reason: `${next} is the released version — nothing moved` };
  if (cmp < 0) return { ok: false, kind: 'decrease', reason: `${next} is BELOW the released ${prev}. A version never goes backwards: the registry already holds ${prev} and would keep serving it as latest.` };

  const want = (kind) => {
    const line = String(bump ?? '').trim();
    const expect = `${kind} ${next}`;
    if (!line) {
      return { ok: false, kind: `${kind}-unauthorized`, reason: `${prev} -> ${next} is a ${kind.toUpperCase()} bump and nothing authorized it. If that is genuinely intended, write "${expect}" into ${BUMP_FILE} in the same commit that raises the versions. That file names the exact version it authorizes, so it can only ever wave through this one.` };
    }
    if (line !== expect) {
      return { ok: false, kind: `${kind}-mismatch`, reason: `${BUMP_FILE} says "${line}" but this tree is a ${kind} bump to ${next}, which needs exactly "${expect}". A flag that does not name the version it authorizes is how the wrong bump ships.` };
    }
    return { ok: true, kind, reason: `${prev} -> ${next}: ${kind} bump, authorized by ${BUMP_FILE}` };
  };

  // patch: same major.minor, exactly one higher
  if (n[0] === p[0] && n[1] === p[1]) {
    if (n[2] === p[2] + 1) return { ok: true, kind: 'patch', reason: `${prev} -> ${next}: the next patch` };
    return { ok: false, kind: 'patch-skip', reason: `${prev} -> ${next} SKIPS ${p[0]}.${p[1]}.${p[2] + 1}. Versions are counted, not chosen — a gap is a version nobody can install and a changelog nobody can follow.` };
  }
  // minor: same major, exactly one higher, patch back to 0
  if (n[0] === p[0] && n[1] === p[1] + 1 && n[2] === 0) return want('minor');
  if (n[0] === p[0] && n[1] === p[1] + 1) {
    return { ok: false, kind: 'minor-nonzero-patch', reason: `${next} opens the ${n[0]}.${n[1]} line, so it must be ${n[0]}.${n[1]}.0 — a new line does not start mid-count.` };
  }
  // major: exactly one higher, everything else back to 0
  if (n[0] === p[0] + 1 && n[1] === 0 && n[2] === 0) return want('major');
  if (n[0] === p[0] + 1) {
    return { ok: false, kind: 'major-nonzero', reason: `${next} opens the ${n[0]}.x line, so it must be ${n[0]}.0.0.` };
  }
  return { ok: false, kind: 'skip', reason: `${prev} -> ${next} skips whole lines. The next version is ${p[0]}.${p[1]}.${p[2] + 1}, ${p[0]}.${p[1] + 1}.0 with a minor flag, or ${p[0] + 1}.0.0 with a major flag — nothing else.` };
}

// ---- the repo half: read the tree, read the tags, decide ----

export function publishedVersions(root) {
  const out = execFileSync('git', ['ls-files', '**/package.json', 'package.json'], { cwd: root, encoding: 'utf8' });
  const found = [];
  for (const rel of out.trim().split('\n').filter(Boolean)) {
    let j;
    try { j = JSON.parse(readFileSync(join(root, rel), 'utf8')); } catch { continue; }
    if (!j.version || j.private) continue;              // private workspaces are not published
    found.push({ name: j.name, version: j.version });
  }
  return found;
}

export function releaseTags(root) {
  try {
    return execFileSync('git', ['tag', '--list', 'v*.*.*'], { cwd: root, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch { return []; }
}

export function readBump(root) {
  const p = join(root, BUMP_FILE);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

/** The whole check against a working tree. Returns {ok, reason, prev, next, kind}. */
export function checkRepo(root) {
  const pkgs = publishedVersions(root);
  if (pkgs.length === 0) return { ok: false, kind: 'no-packages', reason: 'no published workspaces found' };

  // ONE LINE MEANS ONE VERSION. Twelve packages that disagree are twelve releases, and the one that
  // was missed is the one a consumer installs.
  const distinct = [...new Set(pkgs.map((p) => p.version))];
  if (distinct.length > 1) {
    const by = distinct.map((v) => `${v} (${pkgs.filter((p) => p.version === v).map((p) => p.name).join(', ')})`).join(' | ');
    return { ok: false, kind: 'disagree', reason: `the published workspaces do not carry the SAME version: ${by}` };
  }

  const next = distinct[0];
  const prev = highestVersion(releaseTags(root));
  const d = decide(prev, next, readBump(root));
  return { ...d, prev, next, packages: pkgs.length };
}

// ---- CLI: `node scripts/version-guard.mjs [--tag vX.Y.Z]` ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('../', import.meta.url).pathname;
  const r = checkRepo(root);
  const eq = process.argv.find((a) => a.startsWith('--tag='));
  const ix = process.argv.indexOf('--tag');
  const tagArg = eq ? eq.slice('--tag='.length) : (ix > 0 ? (process.argv[ix + 1] ?? '') : '');

  // A TAG IS THE RELEASE TRIGGER, so the tag and the tree must be the same version. `git tag v0.1.19`
  // on a tree carrying 0.1.17 would otherwise publish 0.1.17 under a name nobody can find it by.
  if (tagArg) {
    const t = String(tagArg).replace(/^v/, '');
    if (!parseVersion(t)) { console.error(`✗ --tag "${tagArg}" is not a version`); process.exit(1); }
    if (compareVersions(t, r.next) !== 0) {
      console.error(`✗ TAG/TREE MISMATCH: tag ${tagArg} against a tree carrying ${r.next}. Publishing would ship ${r.next} under the name ${tagArg}.`);
      process.exit(1);
    }
    console.log(`ok   tag ${tagArg} matches the tree`);
  }

  console.log(`${r.ok ? 'ok  ' : '✗   '} ${r.prev ?? '(no tag)'} -> ${r.next} [${r.kind}] — ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
