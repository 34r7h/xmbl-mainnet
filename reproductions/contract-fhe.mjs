// REPRODUCTION — a contract MULTIPLIES encrypted values it cannot read (packages/contracts ×
// packages/identity BFV × packages/storage-compute × packages/state-machine).
//
// CLAIM: `reproductions/contract-he.mjs` proves a contract can ADD post-quantum ciphertexts. That
// scheme adds, on one bit, and ENC(1)+ENC(1) decrypts to 0. This proves the operation it does not
// have: a deployed contract takes encrypted INTEGERS, MULTIPLIES them with no secret key, and
// commits the result to Verkle state — while the chain, the contract and every validator that
// re-executes the call see only ciphertext.
//
// WHY IT IS REAL: BFV (packages/identity/src/bfv.js) over R_q = Z_q[X]/(X^4096+1). A ciphertext
// product is a quadratic form in the secret, which the PUBLIC relinearization key shrinks back to
// two components — no secret key anywhere in the evaluation. Decryption is on no allow surface.
//
// HANDLE-BASED ABI: a BFV ciphertext is ~256 KB and the relinearization key ~1 MB, so they do not
// travel through guest linear memory like the additive scheme's words. The host holds the table;
// the guest names entries by index and asks for a 32-byte DIGEST of a result to commit. Every
// homomorphic operation is deterministic, so the digest binds the chain to a ciphertext anyone
// holding the staged inputs can recompute byte-for-byte.
//
// WHAT THIS REPRODUCES, with the REAL scheme + runtime + host (no mocks):
//   1. ENC(a) * ENC(b) inside the contract → committed digest === off-chain digest, and decrypting
//      the off-chain product gives a*b mod t. The contract never held a, b or the product.
//   2. ENC(a) + ENC(b) the same way.
//   3. COMPOSITION: (a+b)*c in one call, two host operations chained by handle.
//   4. The committed state holds the digest and NO plaintext.
//   5. The same imports declared WITHOUT the fheHost opt-in → DENIED (deny-by-default holds).
//   6. A contract that declares a DECRYPT import, even WITH fheHost → DENIED.
//   7. Two independent nodes → the same digest and the same Verkle root.
//
// Exits non-zero if any claim fails, so it is also a hard-gate test (reproductions.test.mjs).
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ComputeRuntime } from '@xmbl/storage-compute';
import { VerkleStateTree } from '@xmbl/state-machine';
import { ContractHost } from '@xmbl/contracts';
import { fheKeyGen, fheEncryptInt, fheDecryptInt, fheAdd, fheMul, fheSerialize, fheParams } from '@xmbl/identity';

const HDR = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const uleb = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };
const sleb = (n) => { let more = true; const b = []; while (more) { let x = n & 0x7f; n >>= 7; if ((n === 0 && !(x & 0x40)) || (n === -1 && (x & 0x40))) more = false; else x |= 0x80; b.push(x); } return b; };
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];
const s = (t) => [...uleb(t.length), ...[...t].map((c) => c.charCodeAt(0))];

// The digest the host computes — recomputed here independently so the check is an equality between
// two separately derived values, not a tautology.
const digestOf = (ct) => {
  const flat = fheSerialize(ct);
  const parts = [String(flat.parts)];
  for (const v of flat.data) parts.push(v.toString(16));
  return createHash('sha256').update(parts.join(',')).digest();
};

// evalContract(ops): a contract that performs `ops` (each [importIndex, handleA, handleB]) in
// sequence, digests the LAST result into address 0, and stores the 32-byte digest as 8 i32 slots.
//   evaluate() -> i32 { h = op_k(...); ...; fhe_digest(h, 0); for i in 0..7: verkle_set(i, load(i*4)); return h }
// Import indices: 0 = xmbl_fhe_add, 1 = xmbl_fhe_mul, 2 = xmbl_fhe_digest, 3 = xmbl_verkle_set.
function evalContract(ops) {
  const code = [0x01, 0x01, 0x7f]; // one i32 local: the running handle
  ops.forEach(([imp, a, b], k) => {
    // operands: a literal handle, or -1 meaning "the handle in the local"
    code.push(a < 0 ? 0x20 : 0x41, ...(a < 0 ? uleb(0) : sleb(a)));
    code.push(b < 0 ? 0x20 : 0x41, ...(b < 0 ? uleb(0) : sleb(b)));
    code.push(0x10, ...uleb(imp), 0x21, ...uleb(0));
  });
  code.push(0x20, ...uleb(0), 0x41, ...sleb(0), 0x10, ...uleb(2), 0x1a); // fhe_digest(h, 0); drop
  for (let i = 0; i < 8; i++) {
    code.push(0x41, ...sleb(i));            // slot i
    code.push(0x41, ...sleb(i * 4));        // address
    code.push(0x28, 0x02, 0x00);            // i32.load
    code.push(0x10, ...uleb(3), 0x1a);      // verkle_set; drop
  }
  code.push(0x20, ...uleb(0), 0x0b);        // return handle; end
  return Uint8Array.from([
    ...HDR,
    ...section(1, vec([
      [0x60, ...vec([0x7f, 0x7f]), ...vec([0x7f])],   // (i32,i32)->i32
      [0x60, ...vec([]), ...vec([0x7f])],             // ()->i32
    ])),
    ...section(2, vec([
      [...s('env'), ...s('xmbl_fhe_add'), 0x00, ...uleb(0)],
      [...s('env'), ...s('xmbl_fhe_mul'), 0x00, ...uleb(0)],
      [...s('env'), ...s('xmbl_fhe_digest'), 0x00, ...uleb(0)],
      [...s('env'), ...s('xmbl_verkle_set'), 0x00, ...uleb(0)],
    ])),
    ...section(3, vec([uleb(1)])),
    ...section(5, vec([[0x01, ...uleb(1), ...uleb(1)]])),
    ...section(7, vec([[...s('memory'), 0x02, ...uleb(0)], [...s('evaluate'), 0x00, ...uleb(4)]])),
    ...section(10, vec([[...uleb(code.length), ...code]])),
  ]);
}

// A contract that tries to DECRYPT. Must be denied even with fheHost: the secret key is on no
// allow surface, exactly as for the additive scheme's xmbl_lwe_decrypt.
function decryptAttemptContract() {
  const code = [0x00, 0x41, ...sleb(0), 0x10, ...uleb(0), 0x0b];
  return Uint8Array.from([
    ...HDR,
    ...section(1, vec([[0x60, ...vec([0x7f]), ...vec([0x7f])], [0x60, ...vec([]), ...vec([0x7f])]])),
    ...section(2, vec([[...s('env'), ...s('xmbl_fhe_decrypt'), 0x00, ...uleb(0)]])),
    ...section(3, vec([uleb(1)])),
    ...section(5, vec([[0x01, ...uleb(1), ...uleb(1)]])),
    ...section(7, vec([[...s('memory'), 0x02, ...uleb(0)], [...s('steal'), 0x00, ...uleb(1)]])),
    ...section(10, vec([[...uleb(code.length), ...code]])),
  ]);
}

const runtime = () => new ComputeRuntime({ maxTime: 60000 });
const line = (k, v) => console.log(`  ${k.padEnd(40)}: ${v}`);
const OP_ADD = 0, OP_MUL = 1;
const digestFromSlots = (host, id) => {
  const b = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) b.writeInt32LE(host.getSlot(id, i), i * 4);
  return b;
};

async function main() {
  console.log('REPRODUCTION — a contract MULTIPLIES encrypted values it cannot read\n');

  const p = fheParams();
  const { sk, pk, rlk } = fheKeyGen();
  line('ring', `Z_q[X]/(X^${p.n}+1), log2 q = ${p.logQ}, t = ${p.t}`);
  line('ciphertext size (KB)', ((fheSerialize(fheEncryptInt(pk, 1n)).data.length * 16) / 1024).toFixed(0));
  console.log('');

  const A = 123n, B = 45n, C = 7n;
  const ctA = fheEncryptInt(pk, A), ctB = fheEncryptInt(pk, B), ctC = fheEncryptInt(pk, C);
  const staged = { inputs: [ctA, ctB, ctC], rlk };
  const slots = [0, 1, 2, 3, 4, 5, 6, 7];

  // Run `ops` inside a contract and return what the chain committed.
  const run = async (ops) => {
    const host = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
    const { id } = host.deploy(evalContract(ops), slots, { fheHost: true });
    const before = host.state.getRoot();
    const r = await host.call(id, 'evaluate', [], { fhe: staged });
    return { host, id, handle: r.result, committed: digestFromSlots(host, id), before, after: host.state.getRoot() };
  };

  // 1) MULTIPLICATION — the operation the additive scheme does not have.
  {
    const { handle, committed, before, after } = await run([[OP_MUL, 0, 1]]);
    const offchain = fheMul(ctA, ctB, rlk);
    line('mul: handle returned', handle);
    line('committed digest', committed.toString('hex').slice(0, 24) + '…');
    line('off-chain digest', digestOf(offchain).toString('hex').slice(0, 24) + '…');
    assert.ok(handle >= 0, 'xmbl_fhe_mul must return a handle');
    assert.strictEqual(committed.toString('hex'), digestOf(offchain).toString('hex'),
      'the digest the chain committed must equal the digest of the product computed off-chain');
    assert.notStrictEqual(after, before, 'a committed digest must move the Verkle root');
    const opened = fheDecryptInt(sk, offchain);
    line(`decrypt(product) === ${A}*${B} mod t`, `${opened} === ${(A * B) % p.t}`);
    assert.strictEqual(opened, (A * B) % p.t, 'the product must decrypt to a*b mod t');
    console.log('');
  }

  // 2) ADDITION, on integers rather than a single bit.
  {
    const { committed } = await run([[OP_ADD, 0, 1]]);
    const offchain = fheAdd(ctA, ctB);
    assert.strictEqual(committed.toString('hex'), digestOf(offchain).toString('hex'), 'sum digest must match');
    line(`decrypt(sum) === ${A}+${B}`, fheDecryptInt(sk, offchain).toString());
    assert.strictEqual(fheDecryptInt(sk, offchain), A + B, 'the sum must decrypt to a+b (no single-bit wrap)');
    console.log('');
  }

  // 3) COMPOSITION — two host operations chained by handle inside ONE call: (a+b)*c.
  {
    const { committed, handle } = await run([[OP_ADD, 0, 1], [OP_MUL, -1, 2]]);
    const offchain = fheMul(fheAdd(ctA, ctB), ctC, rlk);
    assert.strictEqual(committed.toString('hex'), digestOf(offchain).toString('hex'), '(a+b)*c digest must match');
    const want = ((A + B) * C) % p.t;
    line(`decrypt((a+b)*c) === (${A}+${B})*${C}`, `${fheDecryptInt(sk, offchain)} === ${want}`);
    assert.strictEqual(fheDecryptInt(sk, offchain), want, '(a+b)*c must decrypt correctly');
    assert.strictEqual(handle, 4, 'the second operation must see the first result as a handle');
    console.log('');
  }

  // 4) The committed state holds the digest and NOTHING readable.
  {
    const { host, id, committed } = await run([[OP_MUL, 0, 1]]);
    const plain = [A, B, C, (A * B) % p.t].map(Number);
    const stateWords = slots.map((i) => host.getSlot(id, i));
    line('committed slots', `${stateWords.length} × i32 = 32-byte digest`);
    assert.ok(!stateWords.some((w) => plain.includes(w >>> 0) || plain.includes(w)),
      'no plaintext value may appear in committed state');
    assert.strictEqual(digestFromSlots(host, id).toString('hex'), committed.toString('hex'), 'state holds the digest');
    console.log('');
  }

  // 5) DENY: the same imports without the fheHost flag.
  {
    const host = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
    const { id } = host.deploy(evalContract([[OP_MUL, 0, 1]]), slots); // NO fheHost
    await assert.rejects(() => host.call(id, 'evaluate', [], { fhe: staged }), /denied import: env\.xmbl_fhe_/);
    line('deny-by-default (no fheHost)', 'refused');
  }

  // 6) DENY: a decrypt import, even WITH fheHost.
  {
    const host = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
    const { id } = host.deploy(decryptAttemptContract(), [0], { fheHost: true });
    await assert.rejects(() => host.call(id, 'steal', [], { fhe: staged }), /denied import: env\.xmbl_fhe_decrypt/);
    line('decrypt import (with fheHost)', 'refused');
    console.log('');
  }

  // 7) DETERMINISM — two independent nodes reach the same digest and the same root.
  {
    const n1 = await run([[OP_MUL, 0, 1]]);
    const n2 = await run([[OP_MUL, 0, 1]]);
    line('node1 digest === node2 digest', n1.committed.toString('hex') === n2.committed.toString('hex'));
    line('node1 root === node2 root', n1.after === n2.after);
    assert.strictEqual(n1.committed.toString('hex'), n2.committed.toString('hex'), 'same inputs → same ciphertext bytes');
    assert.strictEqual(n1.after, n2.after, 'same call → same Verkle root on both nodes');
    console.log('');
  }

  const srcHash = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  line('content address (sha256 of file)', srcHash);
  console.log('\n✅ PASS — a contract multiplied encrypted integers it cannot read, committed the');
  console.log('   result digest to Verkle state, and every decrypt path was refused.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('\n❌ FAIL —', e.message); process.exit(1); });
