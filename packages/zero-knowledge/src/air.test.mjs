// AIR conformance — GENERAL-PURPOSE zero knowledge, not one fixed statement.
//
// xzk.js proves that a committed curve passes through given points. This proves that ANY
// computation expressible as "each row follows from the previous one" was carried out correctly,
// without revealing the trace. The suite pins: completeness over three different computations,
// soundness against a wrong claimed output and against a trace that breaks its own rule, that the
// witness does not appear in the proof, and that the verifier's parameters are not the prover's.
// Run: node air.test.mjs
import assert from 'node:assert';
import { setup, prove, verify } from './air.js';
import { add, sub, mul, mod, inv, pw, H, fsExt, EXT_BITS, GRIND_BITS } from './fri.js';
import { createHash } from 'node:crypto';

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ok  ', n); pass++; };

// ── (a) Fibonacci: two columns, two degree-1 transitions ────────────────────────────────────────
const T = 32;
const fibCtx = setup({ traceLen: T, width: 2, constraintDeg: 1 });
const fibTrace = []; { let a = 1n, b = 1n; for (let r = 0; r < T; r++) { fibTrace.push([a, b]); const nb = add(a, b); a = b; b = nb; } }
const fibTransitions = [(c, n) => sub(n[0], c[1]), (c, n) => sub(n[1], add(c[0], c[1]))];
const fibBoundary = [
  { row: 0, col: 0, value: 1n }, { row: 0, col: 1, value: 1n },
  { row: T - 1, col: 0, value: fibTrace[T - 1][0] },
];

ok(`parameters are derived from the computation (K=${fibCtx.K}, N=${fibCtx.N}, blowup ${fibCtx.blowup})`,
  fibCtx.N === fibCtx.K * fibCtx.blowup && fibCtx.N % fibCtx.T === 0);
ok('the evaluation coset is disjoint from the trace domain', fibCtx.coset[0] === fibCtx.shift && fibCtx.shift !== 1n);
ok('batching challenges come from the extension field', fibCtx.extBits === EXT_BITS && EXT_BITS === 124);

const t0 = Date.now();
const fibProof = prove(fibCtx, { trace: fibTrace, transitions: fibTransitions, boundary: fibBoundary });
const proveMs = Date.now() - t0;
const tv = Date.now();
const fibOk = verify(fibCtx, { proof: fibProof, transitions: fibTransitions, boundary: fibBoundary });
const verifyMs = Date.now() - tv;
ok(`a genuine Fibonacci execution verifies (prove ${proveMs} ms, verify ${verifyMs} ms)`, fibOk === true);
ok('the proof commits one root per column, plus the mask and the masked composition',
  fibProof.roots.length === 2 && typeof fibProof.rootM === 'string' && typeof fibProof.rootD === 'string');
ok('the masked-composition commitment IS the FRI codeword', fibProof.friC.roots[0] === fibProof.rootD);

// soundness — a different claimed output
{
  const wrong = fibBoundary.slice();
  wrong[2] = { row: T - 1, col: 0, value: add(fibTrace[T - 1][0], 1n) };
  ok('a wrong claimed output is rejected', verify(fibCtx, { proof: fibProof, transitions: fibTransitions, boundary: wrong }) === false);
}
// soundness — a trace that breaks the recurrence cannot be proved at all
{
  const bad = fibTrace.map((r) => r.slice());
  bad[7][1] = add(bad[7][1], 1n);
  const badProof = prove(fibCtx, { trace: bad, transitions: fibTransitions, boundary: fibBoundary });
  ok('a trace that violates its own transition rule is rejected',
    verify(fibCtx, { proof: badProof, transitions: fibTransitions, boundary: fibBoundary }) === false);
}
// soundness — tampering with what was opened
{
  const t = JSON.parse(JSON.stringify(fibProof, (_k, v) => (typeof v === 'bigint' ? ['#', v.toString()] : v)));
  const revive = (v) => (Array.isArray(v) && v[0] === '#' ? BigInt(v[1]) : Array.isArray(v) ? v.map(revive) : (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)])) : v));
  const tampered = revive(t);
  tampered.opens[0].cur[0] = add(tampered.opens[0].cur[0], 1n);
  ok('a tampered trace opening is rejected', verify(fibCtx, { proof: tampered, transitions: fibTransitions, boundary: fibBoundary }) === false);
  const t2 = revive(JSON.parse(JSON.stringify(fibProof, (_k, v) => (typeof v === 'bigint' ? ['#', v.toString()] : v))));
  t2.opens[1].Dv = t2.opens[1].Dv.map((c, i) => (i === 0 ? add(c, 1n) : c));
  ok('a tampered composition opening is rejected', verify(fibCtx, { proof: t2, transitions: fibTransitions, boundary: fibBoundary }) === false);
  const t4 = revive(JSON.parse(JSON.stringify(fibProof, (_k, v) => (typeof v === 'bigint' ? ['#', v.toString()] : v))));
  t4.opens[2].Mv = t4.opens[2].Mv.map((c, i) => (i === 0 ? add(c, 1n) : c));
  ok('a tampered MASK opening is rejected', verify(fibCtx, { proof: t4, transitions: fibTransitions, boundary: fibBoundary }) === false);
  const t3 = revive(JSON.parse(JSON.stringify(fibProof, (_k, v) => (typeof v === 'bigint' ? ['#', v.toString()] : v))));
  t3.opens = t3.opens.slice(0, 4);
  ok('a thinned opening set is rejected', verify(fibCtx, { proof: t3, transitions: fibTransitions, boundary: fibBoundary }) === false);
}

// ── (b) PROOF OF KNOWLEDGE of a preimage: a degree-3 hash chain over a SECRET start value ───────
{
  const L = 16, RC = 987654321n;
  const ctx = setup({ traceLen: L, width: 1, constraintDeg: 3 });
  const secret = 1234567n;
  const trace = []; { let x = secret; for (let r = 0; r < L; r++) { trace.push([x]); x = add(mul(mul(x, x), x), RC); } }
  const digest = trace[L - 1][0];
  const transitions = [(c, n) => sub(n[0], add(mul(mul(c[0], c[0]), c[0]), RC))];
  const boundary = [{ row: L - 1, col: 0, value: digest }];
  const proof = prove(ctx, { trace, transitions, boundary });
  ok('knowledge of a 16-round hash-chain preimage verifies', verify(ctx, { proof, transitions, boundary }) === true);
  const blob = JSON.stringify(proof, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  ok('the secret preimage does not appear in the proof', !blob.includes(secret.toString()));
  ok('no intermediate state of the chain appears either', trace.slice(0, -1).every((r) => !blob.includes(r[0].toString())));
  ok('a different digest is rejected', verify(ctx, { proof, transitions, boundary: [{ row: L - 1, col: 0, value: add(digest, 1n) }] }) === false);
  // the blind out-degrees the DIRECT trace openings, so those cannot determine the column
  ok('the blind out-degrees the direct trace openings', ctx.blindDeg >= 2 * ctx.nc);
  // and the mask out-degrees everything the FRI transcript hands out
  ok('the mask out-degrees the whole FRI transcript', ctx.K > ctx.nq * (Math.log2(ctx.K) + 1) + ctx.nc);
  // two proofs of the same statement differ
  const p2 = prove(ctx, { trace, transitions, boundary });
  ok('two proofs of the same statement commit differently', p2.roots[0] !== proof.roots[0]);
  ok('and both verify', verify(ctx, { proof: p2, transitions, boundary }) === true);
}

// ── (c) a state machine with a conditional: a 3-column counter that resets ──────────────────────
{
  const L = 32;
  const ctx = setup({ traceLen: L, width: 2, constraintDeg: 2 });
  // col0 = running value, col1 = a selector in {0,1}; next = sel ? 0 : cur+1
  const trace = []; let v = 0n;
  for (let r = 0; r < L; r++) { const sel = (r % 7 === 6) ? 1n : 0n; trace.push([v, sel]); v = sel === 1n ? 0n : add(v, 1n); }
  const transitions = [
    // selector is boolean: s(s-1) = 0
    (c) => mul(c[1], sub(c[1], 1n)),
    // next value = (1-s)*(v+1) + s*0
    (c, n) => sub(n[0], mul(sub(1n, c[1]), add(c[0], 1n))),
  ];
  const boundary = [{ row: 0, col: 0, value: 0n }, { row: L - 1, col: 0, value: trace[L - 1][0] }];
  const proof = prove(ctx, { trace, transitions, boundary });
  ok('a conditional state machine verifies (boolean selector + branch)', verify(ctx, { proof, transitions, boundary }) === true);
  // break the boolean constraint only
  const bad = trace.map((r) => r.slice()); bad[3][1] = 2n;
  const badProof = prove(ctx, { trace: bad, transitions, boundary });
  ok('a non-boolean selector is rejected', verify(ctx, { proof: badProof, transitions, boundary }) === false);
}

// ── (d) a proof is bound to ITS statement, even one sized identically ───────────────────────────
// Two degree-3, 1-column, 16-row chains differing only in the round constant derive the SAME K and
// N, so the domain-size check in friVerify cannot separate them. The statement itself is absorbed
// into the Fiat-Shamir transcript, so the batching challenges differ and the proof does not carry.
{
  const L = 16;
  const chain = (RC) => ({
    ctx: setup({ traceLen: L, width: 1, constraintDeg: 3 }),
    transitions: [(c, n) => sub(n[0], add(mul(mul(c[0], c[0]), c[0]), RC))],
  });
  const A = chain(987654321n), B = chain(111111111n);
  ok('two statements sized identically share K and N', A.ctx.K === B.ctx.K && A.ctx.N === B.ctx.N);
  const seed = 777777n;
  const traceA = []; { let x = seed; for (let r = 0; r < L; r++) { traceA.push([x]); x = add(mul(mul(x, x), x), 987654321n); } }
  const digestA = traceA[L - 1][0];
  const bdA = [{ row: L - 1, col: 0, value: digestA }];
  const proofA = prove(A.ctx, { trace: traceA, transitions: A.transitions, boundary: bdA });
  ok('the proof verifies for its own statement', verify(A.ctx, { proof: proofA, transitions: A.transitions, boundary: bdA }) === true);
  ok('and is rejected against the same-sized OTHER statement',
    verify(B.ctx, { proof: proofA, transitions: B.transitions, boundary: bdA }) === false);
  // the same constraints but a different boundary must also fail, for the same reason
  ok('and against its own constraints with a different boundary row',
    verify(A.ctx, { proof: proofA, transitions: A.transitions, boundary: [{ row: 0, col: 0, value: digestA }] }) === false);
}

// ── (e) THE RECOVERY ATTACK ────────────────────────────────────────────────────
// "the secret is not a substring of the proof" is not zero knowledge. This is the attack that broke
// the unmasked version: α and β are public, so an unmasked opening D(x) = α·u + β·v is four
// base-field equations in two unknowns — solve any two limbs for v, and col'(x) = v·(x − g^row) + value.
// 2·nq layer-0 openings then interpolate a polynomial of degree 2T−1+blindDeg and row 0 IS the secret.
// It recovered 1234567 exactly. With the mask each opening is four equations in SIX unknowns.
{
  const L = 16, RC = 987654321n;
  const ctx = setup({ traceLen: L, width: 1, constraintDeg: 3 });
  const secret = mod(1234567n);
  const trace = []; { let x = secret; for (let r = 0; r < L; r++) { trace.push([x]); x = add(mul(mul(x, x), x), RC); } }
  const digest = trace[L - 1][0];
  const transitions = [(c, n) => sub(n[0], add(mul(mul(c[0], c[0]), c[0]), RC))];
  const boundary = [{ row: L - 1, col: 0, value: digest }];
  const proof = prove(ctx, { trace, transitions, boundary });
  const colDeg = 2 * L - 1 + ctx.blindDeg;

  // the attacker recomputes the public challenges exactly as the verifier does
  const tag = [ctx.T, ctx.W, ctx.D, ctx.K, ctx.N, ctx.blowup, ctx.nq, ctx.nc, ctx.grind, ctx.blindDeg, 1,
    boundary.map((b) => `${b.row}/${b.col}/${b.value.toString()}`).join(';')].join('|');
  const tr = H(tag) + ':' + proof.roots.join(':') + ':m:' + proof.rootM;
  const alpha = fsExt(tr + ':alpha0'), beta = fsExt(tr + ':beta0');
  const gRow = pw(ctx.g, BigInt(L - 1));
  const pts = [];
  for (const q of proof.friC.queries) {
    const st = q.steps[0], half = ctx.N / 2;
    for (const [idx, Dv] of [[st.i, st.a], [st.i + half, st.b]]) {
      let v = null;
      for (let r1 = 0; r1 < 4 && v === null; r1++) for (let r2 = r1 + 1; r2 < 4 && v === null; r2++) {
        const det = sub(mul(alpha[r1], beta[r2]), mul(alpha[r2], beta[r1]));
        if (det !== 0n) v = mul(sub(mul(alpha[r1], Dv[r2]), mul(alpha[r2], Dv[r1])), inv(det));
      }
      if (v !== null) pts.push([ctx.coset[idx], add(mul(v, sub(ctx.coset[idx], gRow)), digest)]);
    }
  }
  ok(`the attack has more than enough openings to interpolate (${pts.length} ≥ ${colDeg + 1})`, pts.length >= colDeg + 1);
  const P = pts.slice(0, colDeg + 1);
  let recovered = 0n;
  for (let i = 0; i < P.length; i++) {
    let num = 1n, den = 1n;
    for (let j = 0; j < P.length; j++) if (j !== i) { num = mul(num, sub(1n, P[j][0])); den = mul(den, sub(P[i][0], P[j][0])); }
    recovered = add(recovered, mul(P[i][1], mul(num, inv(den))));
  }
  ok('the recovery attack does NOT return the secret', recovered !== secret);
  ok('nor any other row of the trace', !trace.some((r) => r[0] === recovered));
}

// ── (f) THE SIBLING-LEAF ATTACK ───────────────────────────────────────────────
// The mask in (e) closed the LINEAR route and 0.1.15 shipped believing that was the whole break. It
// was not. Every opening hands over its authentication path, and the FIRST element of that path is
// the level-0 SIBLING's leaf hash. Base-field leaves were H('l:' + value) over a 31-bit field, so a
// 2^31 sweep — about 19 minutes, once, reusable against every proof forever — inverts it. That is
// one extra point of col' per opening for free: 80 opened + 80 swept = 160 evaluations of a
// degree-(T+blindDeg) = 104 polynomial that needs 105. Row 0 is the witness, and it came out exact.
//
// The counting test is the one that matters, because it does not depend on guessing the attack: the
// points an adversary can hold must stay BELOW what interpolation needs, whatever the parameters.
{
  const L = 16, RC = 987654321n;
  const ctx = setup({ traceLen: L, width: 1, constraintDeg: 3 });
  const secret = 570682118n;
  const trace = []; { let x = secret; for (let r = 0; r < L; r++) { trace.push([x]); x = add(mul(mul(x, x), x), RC); } }
  const digest = trace[L - 1][0];
  const transitions = [(c, n) => sub(n[0], add(mul(mul(c[0], c[0]), c[0]), RC))];
  const boundary = [{ row: L - 1, col: 0, value: digest }];
  const proof = prove(ctx, { trace, transitions, boundary });

  // every trace opening carries a 128-bit salt, and the leaf is NOT a hash of the bare value
  const salted = proof.opens.every((o) => Array.isArray(o.sCur) && Array.isArray(o.sNxt)
    && o.sCur.every((x) => typeof x === 'string' && x.length >= 32)
    && o.sNxt.every((x) => typeof x === 'string' && x.length >= 32));
  ok('every trace opening carries a 128-bit leaf salt', salted);
  const o0 = proof.opens[0];
  const bare = createHash('sha256').update('l:' + o0.cur[0].toString()).digest('hex');
  ok('an opened leaf is not the unsalted hash of its own value', bare !== o0.pCur[0][0]
    && !proof.opens.some((o) => o.pCur[0][0] === createHash('sha256').update('l:' + o.cur[0].toString()).digest('hex')));

  // the sibling hash must not be invertible: sweeping the whole field must never reproduce it.
  // Full sweep is ~19 min, so pin the MECHANISM instead — the preimage includes a salt the
  // adversary does not hold, so no field value alone can produce the sibling's leaf hash.
  const sibHashes = new Set(proof.opens.flatMap((o) => [o.pCur[0][0], o.pNxt[0][0]]));
  let hit = 0;
  for (const v of [...trace.map((r) => r[0]), ...proof.opens.map((o) => o.cur[0]), ...proof.opens.map((o) => o.nxt[0])]) {
    if (sibHashes.has(createHash('sha256').update('l:' + v.toString()).digest('hex'))) hit++;
  }
  ok('no field value hashes to any sibling leaf (the sweep finds nothing)', hit === 0);

  // THE COUNT. Points the adversary can hold vs points interpolation needs.
  const held = new Set();
  for (const o of proof.opens) { held.add(o.i); held.add((o.i + ctx.step) % ctx.N); }
  const direct = held.size;
  const siblings = 0;                       // salted: a sibling leaf yields nothing
  const colDeg = ctx.T + ctx.blindDeg;      // deg((x^T - 1)*r) dominates deg(base) = T - 1
  ok(`recoverable points stay under the interpolation threshold (${direct} + ${siblings} < ${colDeg + 1})`,
    direct + siblings < colDeg + 1);
  ok('and the blind alone already out-degrees the direct openings', ctx.blindDeg > 2 * ctx.nc);
}

// the field's 2-adicity is the real ceiling and setup() refuses before producing a bad generator
{
  let threw = null;
  try { setup({ traceLen: 65536, width: 4, constraintDeg: 8 }); } catch (e) { threw = e.message; }
  ok('an oversized domain is refused rather than silently mis-generated', threw !== null && /ceiling/.test(threw));
}

console.log(`\nPASS — ${pass} checks\n`);
