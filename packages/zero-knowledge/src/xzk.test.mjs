// XZK conformance — hash-based FRI cube-curve zero-knowledge, EXPERIMENTAL / UNAUDITED.
// This suite pins soundness (a forged claim is rejected) and completeness (a genuine proof
// verifies) so a regression is caught; it does NOT promote XZK to consensus-load-bearing — the
// core wiring keeps it additive-only (see readme + MAINNET-GATES). Run: node xzk.test.mjs
import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { setup, blindedCurve, prove, verify } from './xzk.js';
import { EXT_BITS, GRIND_BITS, mod, add, sub, mul, inv, polyEval, interpolate } from './fri.js';

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ok  ', n); pass++; };

const ctx = setup();
const publicPoints = [{ x: 11n, y: 101n }, { x: 12n, y: 205n }, { x: 13n, y: 313n }, { x: 14n, y: 419n }];
const secretPoints = [{ x: 21n, y: 55555n }, { x: 22n, y: 66666n }, { x: 23n, y: 77777n }];
const derivedX = 99n;

// completeness: a genuine proof over secret points verifies
{
  const { Pt, derivedY } = blindedCurve(ctx, { publicPoints, secretPoints, derivedX });
  const proof = prove(ctx, { Pt, publicPoints, derivedX, derivedY });
  ok('genuine proof verifies (completeness)', verify(ctx, { proof, publicPoints, derivedX, derivedY }) === true);
  ok('proof commits to a real curve (rootP present)', typeof proof.rootP === 'string' && proof.rootP.length > 0);

  // soundness: a forged derived value is rejected against the SAME proof
  ok('forged derived y+1 is rejected (soundness)', verify(ctx, { proof, publicPoints, derivedX, derivedY: derivedY + 1n }) === false);
  ok('forged derived y-1 is rejected (soundness)', verify(ctx, { proof, publicPoints, derivedX, derivedY: derivedY - 1n }) === false);

  // binding: verifying at a different public point (not the one committed) is rejected
  ok('verification at a different derivedX is rejected', verify(ctx, { proof, publicPoints, derivedX: derivedX + 1n, derivedY }) === false);
}

// zero-knowledge shape: the proof object carries commitments + query openings, never the secret
// points. Full-width secret values, so neither the exact-value check nor the substring check can be
// satisfied by coincidence (a 5-digit secret WILL appear inside some 600-million-digit-wide blob).
{
  const wide = [0, 1, 2].map((i) => ({ x: BigInt(21 + i), y: BigInt('0x' + randomBytes(8).toString('hex')) % 2013265921n }));
  const { Pt, derivedY } = blindedCurve(ctx, { publicPoints, secretPoints: wide, derivedX });
  const proof = prove(ctx, { Pt, publicPoints, derivedX, derivedY });
  const blob = JSON.stringify(proof, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  ok('proof does not contain the secret point values (zero-knowledge shape)', wide.every((q) => !blob.includes(q.y.toString())));
  // exact-value check: no opened field element anywhere in the proof IS a secret y
  const opened = [];
  const walk = (v) => { if (typeof v === 'bigint') opened.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(proof);
  ok('no opened field element equals a secret y', opened.length > 1000 && wide.every((q) => !opened.includes(q.y)));
}

// the blind is FRESH randomness: two commitments of the same secret points differ everywhere off
// the revealed set, and neither is reproducible without the seed.
{
  const a = blindedCurve(ctx, { publicPoints, secretPoints, derivedX });
  const b = blindedCurve(ctx, { publicPoints, secretPoints, derivedX });
  ok('an unseeded blind is not reproducible (fresh randomness)', a.Pt.some((c, i) => c !== b.Pt[i]));
  ok('the blind cannot move the derived value', a.derivedY === b.derivedY);
  const s1 = blindedCurve(ctx, { publicPoints, secretPoints, derivedX, blindSeed: 5n });
  const s2 = blindedCurve(ctx, { publicPoints, secretPoints, derivedX, blindSeed: 5n });
  ok('a seeded blind IS reproducible (so a test can pin one)', s1.Pt.every((c, i) => c === s2.Pt[i]));
}

// the challenge space is the quartic extension, and the shipped parameters are the ones claimed
{
  ok('folding challenges are drawn from ~124 bits, not 31', ctx.extBits === 124 && EXT_BITS === 124);
  ok('rate is 1/16 and the query count is 88', ctx.K === 32 && ctx.N === 512 && ctx.nq === 88);
  ok('the query transcript carries proof-of-work', ctx.grind === GRIND_BITS && GRIND_BITS >= 20);
  const { Pt, derivedY } = blindedCurve(ctx, { publicPoints, secretPoints, derivedX });
  const proof = prove(ctx, { Pt, publicPoints, derivedX, derivedY });
  ok('every fold layer is committed in the extension', proof.friP.roots.length === 6 && proof.friP.finalWord.every((v) => Array.isArray(v) && v.length === 4));
  // a proof may not thin out its own query set, nor lower its own proof-of-work
  const thin = { ...proof, friP: { ...proof.friP, queries: proof.friP.queries.slice(0, 12) } };
  ok('a thinned query set is rejected', verify(ctx, { proof: thin, publicPoints, derivedX, derivedY }) === false);
  const nopow = { ...proof, friP: { ...proof.friP, grindBits: 0 } };
  ok('a lowered proof-of-work claim is rejected', verify(ctx, { proof: nopow, publicPoints, derivedX, derivedY }) === false);
  // the low-degree test and the constraint openings must be about the SAME codeword
  const split = { ...proof, rootP: 'deadbeef'.repeat(8) };
  ok('an unbound constraint commitment is rejected', verify(ctx, { proof: split, publicPoints, derivedX, derivedY }) === false);
}

// two independent proofs of the same statement both verify (determinism of the verifier)
{
  const a = blindedCurve(ctx, { publicPoints, secretPoints, derivedX, blindSeed: 3n });
  const b = blindedCurve(ctx, { publicPoints, secretPoints, derivedX, blindSeed: 9n });
  const pa = prove(ctx, { Pt: a.Pt, publicPoints, derivedX, derivedY: a.derivedY });
  const pb = prove(ctx, { Pt: b.Pt, publicPoints, derivedX, derivedY: b.derivedY });
  ok('two blinds of the same curve both verify', verify(ctx, { proof: pa, publicPoints, derivedX, derivedY: a.derivedY }) && verify(ctx, { proof: pb, publicPoints, derivedX, derivedY: b.derivedY }));
  ok('the same derived y is recovered regardless of blind (the curve value is fixed)', a.derivedY === b.derivedY);
}

// F4 — the DEGREE BOUND is the verifier's parameter, not the prover's. friVerify used to read K
// from the proof itself, so a prover could fold one extra round, declare K=64, and have a curve
// with far more degrees of freedom than the agreed bound accepted by a verifier set up at K=32.
{
  const cheatCtx = setup({ degreeBound: 64 });   // the prover's OWN inflated bound
  const { Pt, derivedY } = blindedCurve(cheatCtx, { publicPoints, secretPoints, derivedX, blindDegree: 45 });
  const proof = prove(cheatCtx, { Pt, publicPoints, derivedX, derivedY });
  ok('the inflated proof is internally consistent at its own bound', verify(cheatCtx, { proof, publicPoints, derivedX, derivedY }) === true);
  ok('a prover-declared degree bound is rejected by a K=32 verifier (F4)', verify(ctx, { proof, publicPoints, derivedX, derivedY }) === false);
  ok('the inflated curve really exceeds the agreed bound', proof.friP.K === 64 && ctx.K === 32);
}

// THE RECOVERY ATTACK. FRI layer 0 of friP IS the curve codeword in the clear, so ~2*nq openings
// interpolate the committed curve exactly — the curve is public and always was. What must NOT
// follow is the witness. It does not: Pt = P + Zr*B with B uniform of degree 18 and (P - Ir)/Zr of
// degree 1, so the recovered curve is consistent with a whole family of secret point sets. The
// check exhibits one: a different triple, reached by a blind that is still legal.
{
  const secret = [{ x: 21n, y: 555555555n }, { x: 22n, y: 666666666n }, { x: 23n, y: 777777777n }];
  const { Pt, derivedY } = blindedCurve(ctx, { publicPoints, secretPoints: secret, derivedX });
  const proof = prove(ctx, { Pt, publicPoints, derivedX, derivedY });
  const seen = new Map();
  for (const q of proof.friP.queries) {
    const s = q.steps[0], half = ctx.N / 2;
    seen.set(s.i, [ctx.dom[s.i], s.a]); seen.set(s.i + half, [ctx.dom[s.i + half], s.b]);
  }
  const P = [...seen.values()].slice(0, Pt.length);
  const rec = interpolate(P.map((v) => v[0]), P.map((v) => v[1]));
  ok(`the committed curve IS recoverable from the FRI openings (${seen.size} of them)`, Pt.every((c, i) => c === (rec[i] || 0n)));
  ok('but the witness is not readable off it', secret.every((s) => polyEval(Pt, s.x) !== s.y));
  // exhibit a second witness producing the SAME committed curve
  const xs = [...publicPoints.map((q) => q.x), 21n, 22n, 23n];
  const ys = (c) => [...publicPoints.map((q) => q.y), 42n, 43n, c];
  const at = (c) => polyEval(interpolate(xs, ys(c)), derivedX);
  const alt = mul(sub(derivedY, at(0n)), inv(sub(at(1n), at(0n))));
  const Pfake = interpolate(xs, ys(alt));
  ok('a different witness reaches the same public derived value', polyEval(Pfake, derivedX) === derivedY);
  const Zr = [...publicPoints.map((q) => q.x), derivedX].reduce((acc, r) => {
    const out = new Array(acc.length + 1).fill(0n);
    for (let i = 0; i < acc.length; i++) { out[i + 1] = add(out[i + 1], acc[i]); out[i] = sub(out[i], mul(acc[i], r)); }
    return out;
  }, [1n]);
  const num = Pt.map((c, i) => sub(c, Pfake[i] || 0n)), rem = num.slice();
  let qdeg = -1;
  for (let i = rem.length - 1; i >= Zr.length - 1; i--) {
    const c = mul(rem[i], inv(Zr[Zr.length - 1]));
    if (qdeg < 0 && c !== 0n) qdeg = i - (Zr.length - 1);
    for (let j = 0; j < Zr.length; j++) rem[i - (Zr.length - 1) + j] = sub(rem[i - (Zr.length - 1) + j], mul(c, Zr[j]));
  }
  ok('and the SAME proof carries it, under a blind that is still legal', rem.every((c) => c === 0n) && qdeg <= 18);
}

console.log(`\nPASS — ${pass} checks\n`);
