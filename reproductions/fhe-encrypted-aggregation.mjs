// REPRODUCTION — AGGREGATING ENCRYPTED DATA, step by step with the real numbers.
//
// Twelve parties each hold a private number. An aggregator computes the COUNT, the SUM, the SUM OF
// SQUARES, the MEAN and the VARIANCE over those numbers — while holding no secret key and seeing
// nothing but ciphertext. Only the key holder opens the result, and it matches the statistics
// computed directly on the plaintext.
//
// The sum of squares is the point: it needs MULTIPLICATION of two ciphertexts, which the additive
// scheme in cubic-lwe.js cannot do. Everything below runs on the real BFV implementation, and the
// last section runs the same aggregation INSIDE A DEPLOYED CONTRACT through the host ABI.
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ComputeRuntime } from '@xmbl/storage-compute';
import { VerkleStateTree } from '@xmbl/state-machine';
import { ContractHost } from '@xmbl/contracts';
import {
  fheKeyGen, fheEncryptInt, fheDecryptInt, fheAdd, fheMul, fheMulPlain, fheAddPlain,
  fheEncode, fheEncryptVec, fheDecryptVec, fheSerialize, fheParams, fheNoiseBudget, FHE_SLOTS,
} from '@xmbl/identity';

const hr = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);
const kv = (k, v) => console.log(`  ${String(k).padEnd(34)} ${v}`);
const short = (x, n = 24) => { const s = String(x); return s.length > n ? s.slice(0, n) + '…' : s; };
// The same content hash the host computes for `xmbl_fhe_digest` — component count then every
// coefficient in hex — recomputed here so STEP 11's comparison is between two independent values.
const ctHex = (ct) => {
  const flat = fheSerialize(ct);
  const parts = [String(flat.parts)];
  for (const v of flat.data) parts.push(v.toString(16));
  return createHash('sha256').update(parts.join(',')).digest('hex');
};

const P = fheParams();

hr('STEP 0 — the scheme');
kv('ring', `Z_q[X]/(X^${P.n}+1)`);
kv('log2 q', P.logQ);
kv('plaintext modulus t', P.t);
kv('slots per ciphertext', P.slots);
kv('secret distribution', 'ternary {-1,0,1}');
kv('error', `centered binomial, eta=${P.eta} (stddev ~3.24)`);

hr('STEP 1 — KEYS. The aggregator gets pk and rlk. It never gets sk.');
const { sk, pk, rlk } = fheKeyGen();
kv('sk (ternary secret)', `${sk.s.length} coefficients — held ONLY by the data owner`);
kv('pk (public key)', `2 × ${pk.a.length} coefficients`);
kv('rlk (relinearization key)', `${rlk.length} digits × 2 — PUBLIC, lets a product shrink back to 2 parts`);
kv('what the aggregator holds', 'pk, rlk, and ciphertexts. No sk.');

hr('STEP 2 — the PRIVATE DATA. Shown here only so the result can be checked.');
const values = [37n, 12n, 45n, 8n, 23n, 50n, 19n, 31n, 4n, 41n, 27n, 16n];
kv('parties', values.length);
kv('their values', values.join(', '));
const trueSum = values.reduce((a, b) => a + b, 0n);
const trueSumSq = values.reduce((a, b) => a + b * b, 0n);
kv('true sum', trueSum);
kv('true sum of squares', trueSumSq);
kv('', '↑ the aggregator sees NONE of this');

hr('STEP 3 — each party ENCRYPTS locally and publishes ciphertext');
const cts = values.map((v) => fheEncryptInt(pk, v));
cts.slice(0, 3).forEach((ct, i) => kv(`party ${i} ciphertext`, `${short(ctHex(ct), 32)}  (${(fheSerialize(ct).data.length * 16 / 1024).toFixed(0)} KB)`));
kv('', `… ${cts.length - 3} more`);
const twoOfTheSame = [fheEncryptInt(pk, 37n), fheEncryptInt(pk, 37n)];
kv('two encryptions of 37 differ', ctHex(twoOfTheSame[0]) !== ctHex(twoOfTheSame[1]));
assert.notStrictEqual(ctHex(twoOfTheSame[0]), ctHex(twoOfTheSame[1]), 'encryption is randomized');
kv('fresh noise budget', `${fheNoiseBudget(sk, cts[0])} bits`);

hr('STEP 4 — AGGREGATE THE SUM: 11 homomorphic additions, no secret key');
let encSum = cts[0];
for (let i = 1; i < cts.length; i++) {
  encSum = fheAdd(encSum, cts[i]);
  if (i <= 3 || i === cts.length - 1) {
    kv(`after adding party ${i}`, `ct ${short(ctHex(encSum), 20)}   budget ${fheNoiseBudget(sk, encSum)} bits`);
  } else if (i === 4) kv('', '…');
}
kv('additions performed', cts.length - 1);

hr('STEP 5 — AGGREGATE THE SUM OF SQUARES: 12 homomorphic MULTIPLICATIONS');
kv('', 'this is the operation an additive scheme does not have');
const t0 = Date.now();
let encSumSq = fheMul(cts[0], cts[0], rlk);
kv('square party 0', `ct ${short(ctHex(encSumSq), 20)}   budget ${fheNoiseBudget(sk, encSumSq)} bits`);
for (let i = 1; i < cts.length; i++) {
  const sq = fheMul(cts[i], cts[i], rlk);
  encSumSq = fheAdd(encSumSq, sq);
  if (i <= 2) kv(`+ square of party ${i}`, `ct ${short(ctHex(encSumSq), 20)}   budget ${fheNoiseBudget(sk, encSumSq)} bits`);
  else if (i === 3) kv('', '…');
}
const mulMs = Date.now() - t0;
kv('multiplications performed', cts.length);
kv('wall clock', `${mulMs} ms  (~${(mulMs / cts.length).toFixed(0)} ms per multiply)`);
kv('remaining budget', `${fheNoiseBudget(sk, encSumSq)} bits`);

hr('STEP 6 — the aggregator CANNOT read any of it');
kv('sum ciphertext', short(ctHex(encSum), 32));
kv('sumsq ciphertext', short(ctHex(encSumSq), 32));
const wrong = fheKeyGen();
kv('opened with the WRONG key', `sum -> ${fheDecryptInt(wrong.sk, encSum)}   (true ${trueSum})`);
assert.notStrictEqual(fheDecryptInt(wrong.sk, encSum), trueSum, 'a wrong key must not open it');

hr('STEP 7 — the KEY HOLDER decrypts the aggregates');
const gotSum = fheDecryptInt(sk, encSum);
const gotSumSq = fheDecryptInt(sk, encSumSq);
kv('decrypt(sum)', `${gotSum}   true ${trueSum}   ${gotSum === trueSum ? '✓' : '✗'}`);
kv('decrypt(sum of squares)', `${gotSumSq}   true ${trueSumSq}   ${gotSumSq === trueSumSq ? '✓' : '✗'}`);
assert.strictEqual(gotSum, trueSum);
assert.strictEqual(gotSumSq, trueSumSq);

hr('STEP 8 — the STATISTICS, from the two decrypted numbers');
const n = BigInt(values.length);
const mean = Number(gotSum) / Number(n);
// n²·variance = n·sumsq − sum², computed exactly in integers, then divided once
const varNum = n * gotSumSq - gotSum * gotSum;
const variance = Number(varNum) / Number(n * n);
const trueMean = Number(trueSum) / Number(n);
const trueVar = values.reduce((a, b) => a + (Number(b) - trueMean) ** 2, 0) / Number(n);
kv('count', n);
kv('mean = sum / n', `${mean.toFixed(4)}   direct ${trueMean.toFixed(4)}`);
kv('variance = sumsq/n − mean²', `${variance.toFixed(4)}   direct ${trueVar.toFixed(4)}`);
kv('std deviation', Math.sqrt(variance).toFixed(4));
assert.ok(Math.abs(mean - trueMean) < 1e-9, 'mean must match');
assert.ok(Math.abs(variance - trueVar) < 1e-6, 'variance must match');

hr('STEP 9 — WEIGHTED aggregate: encrypted values, public weights');
const weights = [3n, 1n, 4n, 1n, 5n, 9n, 2n, 6n, 5n, 3n, 5n, 8n];
kv('public weights', weights.join(', '));
let encWeighted = fheMulPlain(cts[0], fheEncode(weights[0]));
for (let i = 1; i < cts.length; i++) encWeighted = fheAdd(encWeighted, fheMulPlain(cts[i], fheEncode(weights[i])));
const trueWeighted = values.reduce((a, v, i) => a + v * weights[i], 0n);
kv('decrypt(Σ wᵢ·xᵢ)', `${fheDecryptInt(sk, encWeighted)}   true ${trueWeighted}`);
assert.strictEqual(fheDecryptInt(sk, encWeighted), trueWeighted % P.t);
kv('', 'a public weight costs no ciphertext-ciphertext multiply');

hr(`STEP 10 — SCALE: ${FHE_SLOTS} records in ONE ciphertext, one multiply for all of them`);
const many = Array.from({ length: FHE_SLOTS }, (_, i) => BigInt((i * 37 + 11) % 200));
const encMany = fheEncryptVec(pk, many);
const tb = Date.now();
const encManySq = fheMul(encMany, encMany, rlk);
const batchMs = Date.now() - tb;
const gotMany = fheDecryptVec(sk, encManySq);
const wantMany = many.map((v) => (v * v) % P.t);
kv('records in one ciphertext', FHE_SLOTS);
kv('one multiply squares all of them', `${batchMs} ms  →  ${(batchMs / FHE_SLOTS).toFixed(4)} ms per record`);
kv('slot 0', `${many[0]}² = ${gotMany[0]}   ${gotMany[0] === wantMany[0] ? '✓' : '✗'}`);
kv('slot 2047', `${many[2047]}² = ${gotMany[2047]}   (mod ${P.t})   ${gotMany[2047] === wantMany[2047] ? '✓' : '✗'}`);
kv('all slots correct', gotMany.every((v, i) => v === wantMany[i]));
assert.ok(gotMany.every((v, i) => v === wantMany[i]));
kv('speedup vs one-at-a-time', `${((mulMs / cts.length) / (batchMs / FHE_SLOTS)).toFixed(0)}×`);

hr('STEP 11 — THE SAME AGGREGATION INSIDE A DEPLOYED CONTRACT');
// evaluate(): h = fhe_mul(0,0); h = fhe_add(h, 1); h = fhe_add(h, 2); digest -> 8 slots
const HDR = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const uleb = (v) => { const b = []; do { let x = v & 0x7f; v >>>= 7; if (v) x |= 0x80; b.push(x); } while (v); return b; };
const sleb = (v) => { let more = true; const b = []; while (more) { let x = v & 0x7f; v >>= 7; if ((v === 0 && !(x & 0x40)) || (v === -1 && (x & 0x40))) more = false; else x |= 0x80; b.push(x); } return b; };
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];
const str = (t) => [...uleb(t.length), ...[...t].map((c) => c.charCodeAt(0))];
function aggContract(ops) {
  const code = [0x01, 0x01, 0x7f];
  for (const [imp, a, b] of ops) {
    code.push(a < 0 ? 0x20 : 0x41, ...(a < 0 ? uleb(0) : sleb(a)));
    code.push(b < 0 ? 0x20 : 0x41, ...(b < 0 ? uleb(0) : sleb(b)));
    code.push(0x10, ...uleb(imp), 0x21, ...uleb(0));
  }
  code.push(0x20, ...uleb(0), 0x41, ...sleb(0), 0x10, ...uleb(2), 0x1a);
  for (let i = 0; i < 8; i++) code.push(0x41, ...sleb(i), 0x41, ...sleb(i * 4), 0x28, 0x02, 0x00, 0x10, ...uleb(3), 0x1a);
  code.push(0x20, ...uleb(0), 0x0b);
  return Uint8Array.from([
    ...HDR,
    ...section(1, vec([[0x60, ...vec([0x7f, 0x7f]), ...vec([0x7f])], [0x60, ...vec([]), ...vec([0x7f])]])),
    ...section(2, vec([
      [...str('env'), ...str('xmbl_fhe_add'), 0x00, ...uleb(0)],
      [...str('env'), ...str('xmbl_fhe_mul'), 0x00, ...uleb(0)],
      [...str('env'), ...str('xmbl_fhe_digest'), 0x00, ...uleb(0)],
      [...str('env'), ...str('xmbl_verkle_set'), 0x00, ...uleb(0)],
    ])),
    ...section(3, vec([uleb(1)])),
    ...section(5, vec([[0x01, ...uleb(1), ...uleb(1)]])),
    ...section(7, vec([[...str('memory'), 0x02, ...uleb(0)], [...str('evaluate'), 0x00, ...uleb(4)]])),
    ...section(10, vec([[...uleb(code.length), ...code]])),
  ]);
}
const ADD = 0, MUL = 1;
const three = cts.slice(0, 3);
// x0² + x1 + x2  — a multiply and two adds, chained by handle
const ops = [[MUL, 0, 0], [ADD, -1, 1], [ADD, -1, 2]];
const host = new ContractHost({ runtime: new ComputeRuntime({ maxTime: 60000 }), state: new VerkleStateTree() });
const { id } = host.deploy(aggContract(ops), [0, 1, 2, 3, 4, 5, 6, 7], { fheHost: true });
const rootBefore = host.state.getRoot();
const r = await host.call(id, 'evaluate', [], { fhe: { inputs: three, rlk } });
const committed = Buffer.alloc(32);
for (let i = 0; i < 8; i++) committed.writeInt32LE(host.getSlot(id, i), i * 4);
const offchain = fheAdd(fheAdd(fheMul(three[0], three[0], rlk), three[1]), three[2]);
kv('contract program', 'x0² + x1 + x2  (1 multiply, 2 adds)');
kv('handle returned', r.result);
kv('Verkle root before', short(rootBefore, 24));
kv('Verkle root after', short(host.state.getRoot(), 24));
kv('committed digest', short(committed.toString('hex'), 32));
kv('off-chain digest', short(ctHex(offchain), 32));
assert.strictEqual(committed.toString('hex'), ctHex(offchain), 'the chain must commit the digest of exactly this ciphertext');
const wantOnChain = (values[0] * values[0] + values[1] + values[2]) % P.t;
kv('decrypt(result)', `${fheDecryptInt(sk, offchain)}   true ${values[0]}² + ${values[1]} + ${values[2]} = ${wantOnChain}`);
assert.strictEqual(fheDecryptInt(sk, offchain), wantOnChain);
const plainNums = [...values, trueSum, trueSumSq, wantOnChain].map(Number);
const slotWords = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => host.getSlot(id, i));
assert.ok(!slotWords.some((w) => plainNums.includes(w) || plainNums.includes(w >>> 0)), 'no plaintext in committed state');
kv('plaintext in committed state', 'none');

const srcHash = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
hr('RESULT');
kv('content address', short(srcHash, 32));
console.log('\n✅ PASS — count, sum, sum of squares, mean, variance and a weighted total were');
console.log(`   computed over ${values.length} encrypted values by a party holding no secret key, all`);
console.log('   matched the plaintext statistics, and the same aggregation ran inside a deployed');
console.log('   contract that committed the result digest to Verkle state.');
