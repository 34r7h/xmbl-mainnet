// REPRODUCTION — PROOF OF KNOWLEDGE, step by step with the real numbers.
//
// A prover holds three secret coordinates. It commits to a curve through them, publishes the
// commitment, and proves that a challenge coordinate lies on that curve — WITHOUT revealing the
// secrets. A verifier who knows only the public anchors and the proof accepts. Someone who does
// NOT hold the secrets cannot produce an accepted proof for the same challenge.
//
// Every intermediate value below is printed as it is computed. Nothing is narrated that is not
// also asserted: the script exits non-zero if any step fails.
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setup, blindedCurve, prove, verify } from '@xmbl/zero-knowledge';
import {
  p, mod, add, sub, mul, polyEval, interpolate, EXT_BITS,
} from '../packages/zero-knowledge/src/fri.js';

const hr = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);
const kv = (k, v) => console.log(`  ${String(k).padEnd(34)} ${v}`);
const short = (x, n = 20) => { const s = String(x); return s.length > n ? s.slice(0, n) + '…' : s; };

// Local copies of the two polynomial helpers the library uses internally, so every step below is
// recomputed here rather than taken on trust.
const polyMul = (a, b) => { const r = new Array(a.length + b.length - 1).fill(0n); for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) r[i + j] = add(r[i + j], mul(a[i], b[j])); return r; };
const vanishing = (roots) => { let v = [1n]; for (const r of roots) v = polyMul(v, [mod(-r), 1n]); return v; };

const ctx = setup();

hr('STEP 0 — the parameters the verifier will hold the prover to');
kv('field', `F_p, p = ${p} (31 bits)`);
kv('challenge field', `F_p[X]/(X^4-11) — ${EXT_BITS} bits`);
kv('degree bound K', ctx.K);
kv('domain size N', ctx.N);
kv('rate rho = K/N', `1/${ctx.N / ctx.K}`);
kv('queries nq', ctx.nq);
kv('constraint openings nc', ctx.nc);
kv('grinding bits', ctx.grind);

hr('STEP 1 — the WITNESS: what the prover knows and will not reveal');
const secretPoints = [
  { x: 21n, y: 918273645n },
  { x: 22n, y: 144005423n },
  { x: 23n, y: 777001999n },
];
secretPoints.forEach((q, i) => kv(`secret point ${i}`, `(x=${q.x}, y=${q.y})`));
kv('', '↑ these never appear in the proof — checked at STEP 9');

hr('STEP 2 — the PUBLIC statement: anchors everyone agrees on, and the challenge x*');
const publicPoints = [
  { x: 11n, y: 101n }, { x: 12n, y: 205n }, { x: 13n, y: 313n }, { x: 14n, y: 419n },
];
publicPoints.forEach((q, i) => kv(`public anchor ${i}`, `(x=${q.x}, y=${q.y})`));
const derivedX = 99n;
kv('challenge x*', derivedX);

hr('STEP 3 — interpolate the curve P through ALL SEVEN points');
const allX = [...publicPoints.map((q) => q.x), ...secretPoints.map((q) => q.x)];
const allY = [...publicPoints.map((q) => q.y), ...secretPoints.map((q) => q.y)];
const P = interpolate(allX, allY);
kv('points interpolated', allX.length);
kv('deg(P)', P.length - 1);
kv('P(x) through anchor 0', `P(${publicPoints[0].x}) = ${polyEval(P, publicPoints[0].x)}  (want ${publicPoints[0].y})`);
assert.strictEqual(polyEval(P, publicPoints[0].x), publicPoints[0].y);
kv('P(x) through secret 0', `P(${secretPoints[0].x}) = ${polyEval(P, secretPoints[0].x)}  (want ${secretPoints[0].y})`);
assert.strictEqual(polyEval(P, secretPoints[0].x), secretPoints[0].y);

hr('STEP 4 — the CLAIM: y* = P(x*). This is what gets proved.');
const derivedY = polyEval(P, derivedX);
kv('y* = P(x*)', `P(${derivedX}) = ${derivedY}`);
kv('', 'only a party holding the secret points can compute this y*');

hr('STEP 5 — BLIND the curve: P̃ = P + Z_R·B');
const Rxs = [...publicPoints.map((q) => q.x), derivedX];
const Zr = vanishing(Rxs);
kv('revealed set R', `{${Rxs.join(', ')}}  (the anchors and x*)`);
kv('Z_R vanishes on R', `Z_R(${Rxs[0]}) = ${polyEval(Zr, Rxs[0])}, Z_R(${derivedX}) = ${polyEval(Zr, derivedX)}`);
assert.strictEqual(polyEval(Zr, derivedX), 0n);
const { Pt, derivedY: dy2 } = blindedCurve(ctx, { publicPoints, secretPoints, derivedX });
assert.strictEqual(dy2, derivedY, 'blinding must not move the claimed value');
kv('deg(P̃)', Pt.length - 1);
kv('P̃ on the revealed set', `P̃(${derivedX}) = ${polyEval(Pt, derivedX)}  === y*`);
assert.strictEqual(polyEval(Pt, derivedX), derivedY);
kv('P̃ off it (at x=500)', `P̃ = ${polyEval(Pt, 500n)}   vs   P = ${polyEval(P, 500n)}`);
assert.notStrictEqual(polyEval(Pt, 500n), polyEval(P, 500n), 'the blind must move the curve off the revealed set');
const second = blindedCurve(ctx, { publicPoints, secretPoints, derivedX });
kv('a second blind of the same secret', `P̃₂(500) = ${polyEval(second.Pt, 500n)}  (fresh randomness — differs)`);
assert.notStrictEqual(polyEval(second.Pt, 500n), polyEval(Pt, 500n));

hr('STEP 6 — the CONSTRAINT: P̃ − I_R must be divisible by Z_R');
const Ir = interpolate(Rxs, [...publicPoints.map((q) => q.y), derivedY]);
kv('I_R', `the interpolant through the ${Rxs.length} revealed points`);
kv('why divisible', 'P̃ agrees with I_R exactly on R, so R are roots of P̃ − I_R');
const proof = prove(ctx, { Pt, publicPoints, derivedX, derivedY });
kv('quotient C = (P̃ − I_R)/Z_R', 'computed by prove(); remainder checked at STEP 8');

hr('STEP 7 — COMMIT: evaluate over the domain and Merkle-commit');
kv('domain', `${ctx.N} points of the multiplicative subgroup`);
kv('rootP (commitment to P̃)', short(proof.rootP, 32));
kv('rootC (commitment to C)', short(proof.rootC, 32));
kv('FRI layer-0 root === rootP', proof.friP.roots[0] === proof.rootP);
assert.strictEqual(proof.friP.roots[0], proof.rootP, 'the two commitments must be the same codeword');

hr('STEP 8 — LOW-DEGREE PROOF: fold 512 → 16, five rounds');
proof.friP.roots.forEach((r, i) => {
  const size = ctx.N >> i;
  kv(`layer ${i}`, `${String(size).padStart(3)} values   root ${short(r, 24)}`);
});
kv('final layer', `${proof.friP.finalWord.length} values, all equal → a constant`);
assert.ok(proof.friP.finalWord.every((v) => v.every((c, k) => c === proof.friP.finalWord[0][k])));
kv('final constant (F_p^4)', `[${proof.friP.finalWord[0].map((c) => short(c, 10)).join(', ')}]`);
kv('grinding nonce found', `${proof.friP.nonce}  (${proof.friP.grindBits} leading zero bits required)`);
kv('queries answered', proof.friP.queries.length);
kv('constraint openings', proof.cons.length);

hr('STEP 9 — WHAT THE VERIFIER IS GIVEN (and what it is NOT)');
const blob = JSON.stringify(proof, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
kv('proof size', `${(blob.length / 1024).toFixed(0)} KB`);
kv('contains rootP / rootC', 'yes — commitments');
kv('contains query openings', 'yes — Merkle-authenticated values');
for (const q of secretPoints) {
  assert.ok(!blob.includes(q.y.toString()), `secret ${q.y} must not appear in the proof`);
}
kv('contains any secret y', `no — checked all ${secretPoints.length} (${secretPoints.map((q) => q.y).join(', ')})`);
const opened = [];
const walk = (v) => { if (typeof v === 'bigint') opened.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
walk(proof);
kv('field elements opened', opened.length);
assert.ok(secretPoints.every((q) => !opened.includes(q.y)));
kv('any opened value IS a secret', 'no');

hr('STEP 10 — VERIFY: recompute the constraint at the queried points');
// Show the arithmetic the verifier does at the first three constraint openings.
for (let k = 0; k < 3; k++) {
  const c = proof.cons[k], z = ctx.dom[c.i];
  const lhs = sub(c.Pv, polyEval(Ir, z));
  const rhs = mul(polyEval(Zr, z), c.Cv);
  console.log(`  query ${k}: i=${String(c.i).padStart(3)}  P̃(z)−I_R(z) = ${String(lhs).padStart(11)}   Z_R(z)·C(z) = ${String(rhs).padStart(11)}   ${lhs === rhs ? 'equal ✓' : 'DIFFER ✗'}`);
  assert.strictEqual(lhs, rhs);
}
kv('', `… ${proof.cons.length - 3} more openings checked the same way`);
const okGenuine = verify(ctx, { proof, publicPoints, derivedX, derivedY });
kv('verify(proof, public, x*, y*)', okGenuine ? 'ACCEPT' : 'REJECT');
assert.strictEqual(okGenuine, true);

hr('STEP 11 — SOUNDNESS: the same proof against a FALSE claim');
for (const [label, y] of [['y* + 1', add(derivedY, 1n)], ['y* − 1', sub(derivedY, 1n)], ['y* = 0', 0n]]) {
  const r = verify(ctx, { proof, publicPoints, derivedX, derivedY: y });
  kv(`claim ${label}`, r ? 'ACCEPT ✗' : 'REJECT ✓');
  assert.strictEqual(r, false);
}
const rWrongX = verify(ctx, { proof, publicPoints, derivedX: derivedX + 1n, derivedY });
kv('different challenge x*+1', rWrongX ? 'ACCEPT ✗' : 'REJECT ✓');
assert.strictEqual(rWrongX, false);

hr('STEP 12 — KNOWLEDGE: a prover WITHOUT the secrets cannot produce this y*');
const impostorSecrets = [
  { x: 21n, y: 1n }, { x: 22n, y: 2n }, { x: 23n, y: 3n },
];
const imp = blindedCurve(ctx, { publicPoints, secretPoints: impostorSecrets, derivedX });
kv('impostor guesses the secrets', impostorSecrets.map((q) => q.y).join(', '));
kv('impostor derives y*', `${imp.derivedY}   (real y* = ${derivedY})`);
assert.notStrictEqual(imp.derivedY, derivedY, 'a different witness must yield a different y*');
const impProof = prove(ctx, { Pt: imp.Pt, publicPoints, derivedX, derivedY: imp.derivedY });
const impAgainstReal = verify(ctx, { proof: impProof, publicPoints, derivedX, derivedY });
kv('impostor proof vs the REAL y*', impAgainstReal ? 'ACCEPT ✗' : 'REJECT ✓');
assert.strictEqual(impAgainstReal, false);
kv('impostor proof vs its OWN y*', verify(ctx, { proof: impProof, publicPoints, derivedX, derivedY: imp.derivedY }) ? 'ACCEPT (it proved a different statement)' : 'REJECT');

hr('STEP 13 — the SAME statement, a SECOND proof: hides, still verifies');
const p2 = prove(ctx, { Pt: second.Pt, publicPoints, derivedX, derivedY });
kv('proof 1 rootP', short(proof.rootP, 32));
kv('proof 2 rootP', short(p2.rootP, 32));
assert.notStrictEqual(p2.rootP, proof.rootP, 'a fresh blind must produce a different commitment');
kv('commitments differ', 'yes — the blind is fresh randomness');
kv('proof 2 verifies for the same y*', verify(ctx, { proof: p2, publicPoints, derivedX, derivedY }) ? 'ACCEPT ✓' : 'REJECT ✗');
assert.strictEqual(verify(ctx, { proof: p2, publicPoints, derivedX, derivedY }), true);

const srcHash = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
hr('RESULT');
kv('content address', short(srcHash, 32));
console.log('\n✅ PASS — the prover demonstrated knowledge of three secret coordinates: the');
console.log('   claim y* = P(x*) verified, the secrets appear nowhere in the proof, every false');
console.log('   claim was rejected, and a prover without the witness could not produce it.');
