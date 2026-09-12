// REPRODUCTION — a contract COMPUTES on encrypted data it cannot read (packages/contracts ×
// packages/identity cubic-LWE × packages/storage-compute × packages/state-machine).
//
// CLAIM (the operator's demand: "homomorphic encryption baked onto the system and useable by
// contracts"): a deployed contract can take two post-quantum LWE ciphertexts, ADD them
// homomorphically (ENC(a) ⊞ ENC(b) = ENC(a+b)) WITHOUT any secret key, and persist the encrypted
// aggregate to Verkle state. Only the key holder can open it — the chain, the contract, and every
// validator that re-executes the call see only ciphertext.
//
// WHY THIS IS REAL HE, NOT A TRICK: the cubic-LWE scheme (packages/identity) is additively
// homomorphic BY CONSTRUCTION — decryption d = v − sᵀu is linear, so the component-wise modular
// sum of two ciphertexts decrypts to the sum of the plaintexts. The host exposes ONLY the add
// (env.xmbl_he_add); DECRYPTION is deliberately absent because it needs the SECRET key (the same
// boundary that excludes xmbl_lwe_decrypt from the crypto ABI).
//
// HOW THIS REPRODUCES IT, with the REAL scheme + runtime + host (no mocks):
//   • keyGen → {sk, pk}. Two bits are encrypted under pk OFF-chain (the voters/bidders).
//   • A hand-encoded contract bakes the two ciphertexts in its memory and does:
//       aggregate() { st = xmbl_he_add(ctA, ctB, OUT); store each word of OUT to a slot; return st }
//     It NEVER receives sk. ContractHost stages only the PUBLIC key params {n, q}.
//   • The sum ciphertext is read back from committed state and decrypted OFF-chain with sk.
//   1. ENC(1) ⊞ ENC(0) → decrypts to 1   (the homomorphic sum 1+0, computed on-chain blind).
//   2. ENC(1) ⊞ ENC(1) → decrypts to 0   (1+1 mod 2 — the DOCUMENTED single-bit message-space wrap).
//   3. ENC(0) ⊞ ENC(0) → decrypts to 0.
//   4. The same import declared WITHOUT the heHost opt-in → DENIED (deny-by-default holds).
//   5. A contract that declares a DECRYPT import (env.xmbl_lwe_decrypt), even WITH heHost → DENIED
//      (decryption is on no allow surface — the secret-key boundary holds).
//   6. Two independent nodes produce the SAME sum ciphertext (deterministic homomorphic add).
//
// Exits non-zero if any claim fails, so it is also a hard-gate test (reproductions.test.mjs).
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ComputeRuntime } from '@xmbl/storage-compute';
import { VerkleStateTree } from '@xmbl/state-machine';
import { ContractHost } from '@xmbl/contracts';
import { cubicLweKeyGen, encryptBit, decryptBit } from '@xmbl/identity';

const HDR = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const uleb = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };
const sleb = (n) => { let more = true; const b = []; while (more) { let x = n & 0x7f; n >>= 7; if ((n === 0 && !(x & 0x40)) || (n === -1 && (x & 0x40))) more = false; else x |= 0x80; b.push(x); } return b; };
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];
const s = (t) => [...uleb(t.length), ...[...t].map((c) => c.charCodeAt(0))];
const WORD = 32;
const word32 = (v) => { const b = new Uint8Array(WORD); let x = BigInt(v); for (let i = 0; i < WORD; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const ctBytes = (ct, n) => { const out = new Uint8Array((n + 1) * WORD); for (let i = 0; i < n; i++) out.set(word32(ct.u[i]), i * WORD); out.set(word32(ct.v), n * WORD); return out; };

// heAggregateContract(ctaBytes, ctbBytes, n): bakes ctA at 0, ctB at SPAN, computes the homomorphic
// sum into OUT = 2*SPAN, and stores each of the (n+1) result words (low 32 bits) into slots 0..n.
//   aggregate() -> i32 { st = xmbl_he_add(0, SPAN, OUT); for i in 0..n: verkle_set(i, i32.load(OUT+i*32)); return st }
function heAggregateContract(ctaBytes, ctbBytes, n) {
  const COUNT = n + 1, SPAN = COUNT * WORD, OUT = 2 * SPAN;
  const data = [...ctaBytes, ...ctbBytes];
  const code = [0x01, 0x01, 0x7f]; // 1 i32 local (status)
  code.push(0x41, ...sleb(0), 0x41, ...sleb(SPAN), 0x41, ...sleb(OUT), 0x10, ...uleb(0), 0x21, ...uleb(0)); // status = he_add(0,SPAN,OUT)
  for (let i = 0; i < COUNT; i++) {
    code.push(0x41, ...sleb(i));                 // slot i
    code.push(0x41, ...sleb(OUT + i * WORD));    // address
    code.push(0x28, 0x02, 0x00);                 // i32.load (align=2, offset=0)
    code.push(0x10, ...uleb(1), 0x1a);           // call verkle_set; drop
  }
  code.push(0x20, ...uleb(0), 0x0b);             // return status; end
  return Uint8Array.from([
    ...HDR,
    // types: (i32,i32,i32)->i32 [he_add], (i32,i32)->i32 [verkle_set], ()->i32 [aggregate]
    ...section(1, vec([
      [0x60, ...vec([0x7f, 0x7f, 0x7f]), ...vec([0x7f])],
      [0x60, ...vec([0x7f, 0x7f]), ...vec([0x7f])],
      [0x60, ...vec([]), ...vec([0x7f])],
    ])),
    ...section(2, vec([
      [...s('env'), ...s('xmbl_he_add'), 0x00, ...uleb(0)],
      [...s('env'), ...s('xmbl_verkle_set'), 0x00, ...uleb(1)],
    ])),
    ...section(3, vec([uleb(2)])),
    ...section(5, vec([[0x01, ...uleb(1), ...uleb(1)]])),
    ...section(7, vec([[...s('memory'), 0x02, ...uleb(0)], [...s('aggregate'), 0x00, ...uleb(2)]])),
    ...section(10, vec([[...uleb(code.length), ...code]])),
    ...section(11, vec([[0x00, 0x41, ...sleb(0), 0x0b, ...vec([...data])]])),
  ]);
}

// A contract that tries to DECRYPT — imports env.xmbl_lwe_decrypt and calls it. Must be denied even
// with heHost set: decryption (secret-key) is on no allow surface.
function decryptAttemptContract() {
  const code = [0x00, 0x41, ...sleb(0), 0x41, ...sleb(0), 0x10, ...uleb(0), 0x0b]; // return xmbl_lwe_decrypt(0,0)
  return Uint8Array.from([
    ...HDR,
    ...section(1, vec([[0x60, ...vec([0x7f, 0x7f]), ...vec([0x7f])], [0x60, ...vec([]), ...vec([0x7f])]])),
    ...section(2, vec([[...s('env'), ...s('xmbl_lwe_decrypt'), 0x00, ...uleb(0)]])),
    ...section(3, vec([uleb(1)])),
    ...section(5, vec([[0x01, ...uleb(1), ...uleb(1)]])),
    ...section(7, vec([[...s('memory'), 0x02, ...uleb(0)], [...s('steal'), 0x00, ...uleb(1)]])),
    ...section(10, vec([[...uleb(code.length), ...code]])),
  ]);
}

const runtime = () => new ComputeRuntime({ maxTime: 15000 });
const line = (k, v) => console.log(`  ${k.padEnd(40)}: ${v}`);

async function main() {
  console.log('REPRODUCTION — a contract homomorphically adds ciphertexts it cannot read\n');

  const { sk, pk } = cubicLweKeyGen({ n: 27 });
  const n = pk.n, q = pk.q;
  line('lattice dimension n / modulus q', `${n} / ${q}`);
  line('ciphertext size on-chain (bytes)', `${(n + 1) * WORD}  (${n + 1} × 32-byte words)`);
  console.log('');

  // Homomorphically aggregate ENC(a) ⊞ ENC(b) inside a contract, read the sum back, decrypt OFF-chain.
  const aggregateAndOpen = async (bitA, bitB) => {
    const ctA = encryptBit(pk, bitA), ctB = encryptBit(pk, bitB);
    const host = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
    const wasm = heAggregateContract(ctBytes(ctA, n), ctBytes(ctB, n), n);
    const slots = Array.from({ length: n + 1 }, (_, i) => i);
    const { id } = host.deploy(wasm, slots, { heHost: true });
    const r = await host.call(id, 'aggregate', [], { he: { n, q } });
    assert.strictEqual(r.result, 0, `xmbl_he_add returned ok (got status ${r.result})`);
    // Reconstruct the sum ciphertext from committed state — the CHAIN only ever held these bytes.
    const u = []; for (let i = 0; i < n; i++) u.push(BigInt(host.getSlot(id, i)));
    const sum = { u, v: BigInt(host.getSlot(id, n)) };
    return { host, id, sum, ctA, ctB, root: host.state.getRoot() };
  };

  // 1-3) The homomorphism: decrypt(ENC(a) ⊞ ENC(b)) === (a + b) mod 2 (single-bit message space).
  const cases = [[1, 0, 1], [1, 1, 0], [0, 0, 0]];
  for (const [a, b, expect] of cases) {
    const { sum } = await aggregateAndOpen(a, b);
    const opened = decryptBit(sk, sum);
    const note = (a + b) > 1 ? '  (1+1 wraps mod 2 — documented message-space bound)' : '';
    line(`decrypt( ENC(${a}) ⊞ ENC(${b}) ) on-chain blind`, `${opened}  (expected ${expect})${note}`);
    assert.strictEqual(opened, expect, `homomorphic sum of ${a},${b} must open to ${expect}`);
  }
  console.log('');

  // The contract genuinely COMBINED the inputs: the stored sum differs from either operand ciphertext.
  {
    const { sum, ctA, ctB } = await aggregateAndOpen(1, 0);
    const eq = (c1, c2) => c1.v === c2.v && c1.u.every((x, i) => x === c2.u[i]);
    assert.ok(!eq(sum, ctA) && !eq(sum, ctB), 'the persisted ciphertext is the SUM, not a copy of an input');
    line('sum ciphertext ≠ either input', !eq(sum, ctA) && !eq(sum, ctB));
  }
  console.log('');

  // 4) DENY: xmbl_he_add declared WITHOUT heHost is refused.
  let denied = 0;
  {
    const ctA = encryptBit(pk, 1), ctB = encryptBit(pk, 0);
    const host = new ContractHost({ runtime: runtime() });
    const { id } = host.deploy(heAggregateContract(ctBytes(ctA, n), ctBytes(ctB, n), n), [0], {}); // NO heHost
    await assert.rejects(() => host.call(id, 'aggregate', [], { he: { n, q } }), /denied import: env\.xmbl_he_add/);
    denied += 1;
  }
  // 5) DENY: a DECRYPT import is refused even WITH heHost (the secret-key boundary).
  {
    const host = new ContractHost({ runtime: runtime() });
    const { id } = host.deploy(decryptAttemptContract(), [], { heHost: true });
    await assert.rejects(() => host.call(id, 'steal', [], { he: { n, q } }), /denied import: env\.xmbl_lwe_decrypt/);
    denied += 1;
  }
  line('denied-import refusals', `${denied}  (he_add without opt-in; decrypt even with opt-in)`);
  console.log('');

  // 6) DETERMINISM: two independent nodes compute the identical sum ciphertext.
  {
    const ctA = encryptBit(pk, 1), ctB = encryptBit(pk, 0);
    const wasm = heAggregateContract(ctBytes(ctA, n), ctBytes(ctB, n), n);
    const slots = Array.from({ length: n + 1 }, (_, i) => i);
    const mk = async () => { const h = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() }); const { id } = h.deploy(wasm, slots, { heHost: true }); await h.call(id, 'aggregate', [], { he: { n, q } }); return h.state.getRoot(); };
    const r1 = await mk(), r2 = await mk();
    line('node1 root === node2 root', r1 === r2);
    assert.strictEqual(r1, r2, 'the homomorphic add is deterministic across nodes');
  }
  console.log('');

  const srcHash = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  line('content address (sha256 of file)', srcHash);
  console.log('\n✅ PASS — a contract homomorphically combined encrypted inputs it cannot read,');
  console.log('   the key holder opened the aggregate off-chain, and no decryption was ever exposed');
  console.log(`   on-chain (${denied} refusals: add needs opt-in, decrypt is denied even with it).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('\n❌ FAIL —', e.message); process.exit(1); });
