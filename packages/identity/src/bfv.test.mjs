// BFV leveled-homomorphic conformance. The claim under test is the one cubic-lwe cannot make:
// ciphertexts ADD **and MULTIPLY** with no secret key, on integers rather than single bits, and
// ENC(1) + ENC(1) decrypts to 2 rather than wrapping to 0. Run: node bfv.test.mjs
import assert from 'node:assert';
import {
  keyGen, encryptInt, decryptInt, encrypt, decrypt, encode, decode,
  addCipher, subCipher, mulCipher, addPlain, mulPlain, relinearize,
  serialize, deserialize, noiseBudget, params, N, T,
  encodeBatch, decodeBatch, encryptVec, decryptVec, SLOTS, decompose, recompose, Q,
} from './bfv.js';
import { keyGen as lweKeyGen, encryptBit, decryptBit, addCiphertexts } from './cubic-lwe.js';

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ok  ', n); pass++; };

const { sk, pk, rlk } = keyGen();
const p = params();

// parameters are the ones claimed
ok('ring is Z_q[X]/(X^4096+1) with log2 q <= 109 (the standard bound for a ternary secret at n=4096)',
  p.n === 4096 && N === 4096 && p.logQ <= 109);
ok('plaintext modulus is 65537 and batching-compatible (t = 1 mod 2n)', T === 65537n && (T - 1n) % BigInt(2 * N) === 0n);

// correctness
{
  for (const v of [0n, 1n, 2n, 42n, 65535n, T - 1n]) {
    assert.strictEqual(decryptInt(sk, encryptInt(pk, v)), v, `decrypt(encrypt(${v}))`);
  }
  ok('decrypt(encrypt(m)) = m across the plaintext range', true);
  ok('a fresh ciphertext has a usable noise budget', noiseBudget(sk, encryptInt(pk, 7n)) > 40);
}

// THE DEFECT THIS REPLACES: cubic-lwe adds one bit and 1+1 wraps to 0.
{
  const lwe = lweKeyGen();
  const one = encryptBit(lwe.pk, 1);
  const wrapped = decryptBit(lwe.sk, addCiphertexts(one, encryptBit(lwe.pk, 1)));
  ok('cubic-lwe: ENC(1) + ENC(1) decrypts to 0 (single-bit wrap)', wrapped === 0);
  const sum = decryptInt(sk, addCipher(encryptInt(pk, 1n), encryptInt(pk, 1n)));
  ok('bfv: ENC(1) + ENC(1) decrypts to 2', sum === 2n);
}

// addition
{
  const a = 31337n, b = 12345n;
  ok('ENC(a) + ENC(b) = ENC(a+b)', decryptInt(sk, addCipher(encryptInt(pk, a), encryptInt(pk, b))) === (a + b) % T);
  ok('ENC(a) - ENC(b) = ENC(a-b)', decryptInt(sk, subCipher(encryptInt(pk, a), encryptInt(pk, b))) === (a - b + T) % T);
  let acc = encryptInt(pk, 0n), want = 0n;
  for (let i = 1; i <= 500; i++) { acc = addCipher(acc, encryptInt(pk, BigInt(i))); want = (want + BigInt(i)) % T; }
  ok('500 homomorphic additions still decrypt correctly', decryptInt(sk, acc) === want);
}

// MULTIPLICATION — the operation the additive scheme does not have
{
  const a = 1234n, b = 5678n;
  const prod = mulCipher(encryptInt(pk, a), encryptInt(pk, b), rlk);
  ok('ENC(a) * ENC(b) = ENC(a*b)', decryptInt(sk, prod) === (a * b) % T);
  ok('a relinearized product is back to 2 components', prod.c.length === 2);
  const raw = mulCipher(encryptInt(pk, a), encryptInt(pk, b));
  ok('an un-relinearized product has 3 components and decrypts the same', raw.c.length === 3 && decryptInt(sk, raw) === (a * b) % T);
  ok('relinearize() on an already-2-component ciphertext is a no-op', relinearize(prod, rlk).c.length === 2);
}

// depth: a product can be multiplied again
{
  const c2 = mulCipher(encryptInt(pk, 3n), encryptInt(pk, 5n), rlk);
  const c3 = mulCipher(c2, encryptInt(pk, 7n), rlk);
  ok('a product multiplies again: 3*5*7 = 105', decryptInt(sk, c3) === 105n);
  ok('the budget shrinks with depth but stays positive', noiseBudget(sk, c3) > 0 && noiseBudget(sk, c3) < noiseBudget(sk, c2));
}

// mixed arithmetic, and plaintext operands
{
  const x = encryptInt(pk, 11n), y = encryptInt(pk, 13n), z = encryptInt(pk, 17n);
  ok('(a+b)*c = 408', decryptInt(sk, mulCipher(addCipher(x, y), z, rlk)) === 408n);
  ok('ENC(a) * plaintext b = ENC(a*b)', decryptInt(sk, mulPlain(x, encode(9n))) === 99n);
  ok('ENC(a) + plaintext b = ENC(a+b)', decryptInt(sk, addPlain(x, encode(9n))) === 20n);
}

// the homomorphic operations take NO secret key, which is why a contract may run them
{
  ok('addCipher/mulCipher take no secret key', addCipher.length === 2 && mulCipher.length === 3);
  const evaluated = mulCipher(addCipher(encryptInt(pk, 2n), encryptInt(pk, 3n)), encryptInt(pk, 4n), rlk);
  ok('an evaluator holding only pk + rlk produces a correct result', decryptInt(sk, evaluated) === 20n);
}

// determinism — every validator re-executing must land on identical bytes
{
  const a = encryptInt(pk, 111n), b = encryptInt(pk, 222n);
  const hex = (ct) => serialize(ct).data.map((v) => v.toString(16)).join(',');
  ok('the same ciphertexts add to identical bytes on any node', hex(addCipher(a, b)) === hex(addCipher(a, b)));
  ok('the same ciphertexts multiply to identical bytes on any node', hex(mulCipher(a, b, rlk)) === hex(mulCipher(a, b, rlk)));
  ok('serialize -> deserialize round-trips', decryptInt(sk, deserialize(serialize(mulCipher(a, b, rlk)))) === (111n * 222n) % T);
}

// a different key does not open it
{
  const other = keyGen();
  ok('a wrong secret key does not recover the plaintext', decryptInt(other.sk, encryptInt(pk, 4242n)) !== 4242n);
}

// polynomial-level encode/decode
{
  const m = encode(777n);
  ok('encode/decode round-trip', decode(m) === 777n && m.length === N);
  ok('a polynomial plaintext encrypts and decrypts', decode(decrypt(sk, encrypt(pk, m))) === 777n);
}

// the digit decomposition inside relinearize is the one step of the multiply path with no
// observable output of its own: a silent truncation at the top digit would show as worse noise,
// never as a wrong answer. Assert the reconstruction identity directly.
{
  const poly = Array.from({ length: N }, (_, i) => (BigInt(i) * 918273645n + 7n) % Q);
  const d = decompose(poly);
  ok('relinearization digits reconstruct exactly (no truncation)', recompose(d).every((v, i) => v === poly[i]));
  ok('every digit is within the decomposition base', d.every((dg) => dg.every((x) => x >= 0n && x < (1n << 32n))));
}

// SIMD batching — one ciphertext carries SLOTS values and ONE multiply multiplies all of them
{
  const u = Array.from({ length: SLOTS }, (_, i) => BigInt(i % 1000));
  const v = Array.from({ length: SLOTS }, (_, i) => BigInt((i * 7) % 1000));
  ok('encodeBatch/decodeBatch round-trips across every slot', decodeBatch(encodeBatch(u)).every((x, i) => x === u[i]));
  const cu = encryptVec(pk, u), cv = encryptVec(pk, v);
  const t0 = Date.now();
  const prod = mulCipher(cu, cv, rlk);
  const ms = Date.now() - t0;
  const got = decryptVec(sk, prod);
  ok(`one multiply produces all ${SLOTS} products (${ms} ms, ${(ms / SLOTS).toFixed(4)} ms each)`,
    got.every((x, i) => x === (u[i] * v[i]) % T));
  ok('one addition produces all slot sums', decryptVec(sk, addCipher(cu, cv)).every((x, i) => x === (u[i] + v[i]) % T));
  ok('a batched product still relinearizes to 2 components', prod.c.length === 2);
  ok('slots are independent: changing one slot changes only that product', (() => {
    const w = v.slice(); w[5] = (w[5] + 1n) % T;
    const other = decryptVec(sk, mulCipher(cu, encryptVec(pk, w), rlk));
    return other[5] !== got[5] && other.every((x, i) => i === 5 || x === got[i]);
  })());
  ok('params report the slot count', params().slots === SLOTS && SLOTS === N);
}

console.log(`\nPASS — ${pass} checks\n`);
