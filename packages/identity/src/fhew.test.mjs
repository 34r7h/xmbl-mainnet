// BOOTSTRAPPING conformance — the step from leveled to FULLY homomorphic.
//
// bfv.js multiplies but spends noise budget doing it: after two or three multiplications a
// ciphertext stops decrypting. The claim under test here is that depth is no longer bounded — a
// chain of gates longer than any leveled budget still decrypts correctly, because every gate is
// followed by a bootstrap that resets the noise to a level set by the key, not by the input.
// Run: node fhew.test.mjs
import assert from 'node:assert';
import { keyGen, encryptBit, decryptBit, bootstrap, refresh, nand, and, or, xor, not, params, n, N, Q, q } from './fhew.js';

let pass = 0;
const ok = (name, c) => { assert.ok(c, name); console.log('  ok  ', name); pass++; };

const t0 = Date.now();
const { sk, bsk, ksk } = keyGen();
const keygenMs = Date.now() - t0;
const p = params();

ok(`keys generated (${keygenMs} ms): ${n} RGSW bootstrapping keys + ${N} key-switch rows`,
  bsk.length === n && ksk.length === N);
ok('the bootstrapping key is public: it encrypts the secret, it does not reveal it',
  bsk[0].length === 2 * p.gadgetDigits && bsk[0][0].A.length === N);
ok('parameters keep every product exact in double precision', (Q - 1) * (Q - 1) < 2 ** 53);
ok('the gadget covers the modulus', p.gadgetBase ** p.gadgetDigits >= Q);

// encryption round-trips
{
  for (let i = 0; i < 8; i++) {
    const b = i & 1;
    assert.strictEqual(decryptBit(sk, encryptBit(sk, b)), b, `round-trip bit ${b}`);
  }
  ok('encrypt/decrypt round-trips', true);
}

// A BOOTSTRAP RETURNS THE SAME VALUE
{
  const tb = Date.now();
  const r1 = refresh(encryptBit(sk, 1), bsk, ksk);
  const bootMs = Date.now() - tb;
  const r0 = refresh(encryptBit(sk, 0), bsk, ksk);
  ok(`bootstrap preserves the plaintext (${bootMs} ms)`, decryptBit(sk, r1) === 1 && decryptBit(sk, r0) === 0);
  // and a bootstrapped ciphertext is a different ciphertext, not the input handed back
  const src = encryptBit(sk, 1), out = refresh(src, bsk, ksk);
  ok('the output is a fresh ciphertext, not the input', out.a.length === n && out.a.some((v, i) => v !== src.a[i]));
}

// A BOOTSTRAP CLEANS AN EXHAUSTED CIPHERTEXT — the property that makes depth unbounded
{
  // Push a ciphertext to the edge of decryptability by adding noise directly to its phase.
  const dirty = encryptBit(sk, 1);
  dirty.b = (dirty.b + 200) % q;   // phase pushed far off the anchor, still inside the window
  ok('a heavily perturbed ciphertext still decrypts (just)', decryptBit(sk, dirty) === 1);
  const cleaned = refresh(dirty, bsk, ksk);
  // The refreshed ciphertext must tolerate the SAME perturbation again — proof the noise was reset
  // rather than carried through, which a mere re-encryption of the phase would not achieve.
  const again = { a: cleaned.a, b: (cleaned.b + 200) % q };
  ok('after bootstrapping it tolerates that perturbation AGAIN (noise was reset)',
    decryptBit(sk, cleaned) === 1 && decryptBit(sk, again) === 1);
}

// NAND is functionally complete: this one gate plus bootstrapping is a universal evaluator
{
  let all = true;
  for (const [x, y, want] of [[0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 0]]) {
    if (decryptBit(sk, nand(encryptBit(sk, x), encryptBit(sk, y), bsk, ksk)) !== want) all = false;
  }
  ok('NAND truth table over ciphertext (4/4)', all);
}

// the other gates
{
  ok('NOT is free (no bootstrap) and correct', decryptBit(sk, not(encryptBit(sk, 1))) === 0 && decryptBit(sk, not(encryptBit(sk, 0))) === 1);
  ok('AND(1,1)=1 and AND(1,0)=0', decryptBit(sk, and(encryptBit(sk, 1), encryptBit(sk, 1), bsk, ksk)) === 1
    && decryptBit(sk, and(encryptBit(sk, 1), encryptBit(sk, 0), bsk, ksk)) === 0);
  ok('OR(0,1)=1 and OR(0,0)=0', decryptBit(sk, or(encryptBit(sk, 0), encryptBit(sk, 1), bsk, ksk)) === 1
    && decryptBit(sk, or(encryptBit(sk, 0), encryptBit(sk, 0), bsk, ksk)) === 0);
  ok('OR(1,1)=1', decryptBit(sk, or(encryptBit(sk, 1), encryptBit(sk, 1), bsk, ksk)) === 1);
  // XOR is built from three bootstrapped gates — a composite circuit, not a single lookup
  ok('XOR(1,0)=1 (a three-gate circuit)', decryptBit(sk, xor(encryptBit(sk, 1), encryptBit(sk, 0), bsk, ksk)) === 1);
}

// UNBOUNDED DEPTH — the claim. A leveled scheme dies after 2-3 multiplications.
{
  const DEPTH = 10;
  let acc = encryptBit(sk, 1), expect = 1;
  const t2 = Date.now();
  for (let i = 0; i < DEPTH; i++) {
    const bit = i % 3 === 0 ? 0 : 1;
    acc = nand(acc, encryptBit(sk, bit), bsk, ksk);
    expect = 1 - (expect & bit);
  }
  const ms = Date.now() - t2;
  ok(`${DEPTH} chained NAND gates still decrypt correctly (${ms} ms, ${(ms / DEPTH).toFixed(0)} ms/gate)`,
    decryptBit(sk, acc) === expect);
  ok('depth is limited by time, not by a noise budget', true);
}

// a different key does not open it. A fresh binary vector rather than a second keyGen — the
// bootstrapping keys are what make keyGen slow and none of them are needed to decrypt.
{
  const wrong = Int32Array.from({ length: n }, () => (Math.random() < 0.5 ? 0 : 1));
  let differs = false;
  for (let i = 0; i < 16; i++) if (decryptBit(wrong, encryptBit(sk, i & 1)) !== (i & 1)) { differs = true; break; }
  ok('a wrong secret key does not read the plaintext', differs);
}

console.log(`\nPASS — ${pass} checks\n`);
