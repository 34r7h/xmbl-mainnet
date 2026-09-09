// XZK conformance — hash-based FRI cube-curve zero-knowledge, EXPERIMENTAL / UNAUDITED.
// This suite pins soundness (a forged claim is rejected) and completeness (an honest proof
// verifies) so a regression is caught; it does NOT promote XZK to consensus-load-bearing — the
// core wiring keeps it additive-only (see readme + MAINNET-GATES). Run: node xzk.test.mjs
import assert from 'node:assert';
import { setup, blindedCurve, prove, verify } from './xzk.js';

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ok  ', n); pass++; };

const ctx = setup();
const publicPoints = [{ x: 11n, y: 101n }, { x: 12n, y: 205n }, { x: 13n, y: 313n }, { x: 14n, y: 419n }];
const secretPoints = [{ x: 21n, y: 55555n }, { x: 22n, y: 66666n }, { x: 23n, y: 77777n }];
const derivedX = 99n;

// completeness: an honest proof over secret points verifies
{
  const { Pt, derivedY } = blindedCurve(ctx, { publicPoints, secretPoints, derivedX });
  const proof = prove(ctx, { Pt, publicPoints, derivedX, derivedY });
  ok('honest proof verifies (completeness)', verify(ctx, { proof, publicPoints, derivedX, derivedY }) === true);
  ok('proof commits to a real curve (rootP present)', typeof proof.rootP === 'string' && proof.rootP.length > 0);

  // soundness: a forged derived value is rejected against the SAME proof
  ok('forged derived y+1 is rejected (soundness)', verify(ctx, { proof, publicPoints, derivedX, derivedY: derivedY + 1n }) === false);
  ok('forged derived y-1 is rejected (soundness)', verify(ctx, { proof, publicPoints, derivedX, derivedY: derivedY - 1n }) === false);

  // binding: verifying at a different public point (not the one committed) is rejected
  ok('verification at a different derivedX is rejected', verify(ctx, { proof, publicPoints, derivedX: derivedX + 1n, derivedY }) === false);
}

// zero-knowledge shape: the proof object carries commitments + query openings, never the secret points
{
  const { Pt, derivedY } = blindedCurve(ctx, { publicPoints, secretPoints, derivedX });
  const proof = prove(ctx, { Pt, publicPoints, derivedX, derivedY });
  const blob = JSON.stringify(proof, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const leaks = secretPoints.some((p) => blob.includes(p.y.toString()));
  ok('proof does not contain the secret point values (zero-knowledge shape)', leaks === false);
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

console.log(`\nPASS — ${pass} checks\n`);
