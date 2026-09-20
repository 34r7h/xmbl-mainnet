// REPRODUCTION — a contract gates Verkle state on a proof of ARBITRARY COMPUTATION.
//
// reproductions/contract-zk.mjs proves a contract can verify ONE fixed statement: a committed curve
// through given points. This proves the general case — the prover ran a whole computation and the
// contract checks it was done correctly without ever seeing the execution.
//
// The statement here is a PROOF OF KNOWLEDGE: "I know a value that reaches this digest after 16
// rounds of x -> x^3 + RC." The prover never reveals the preimage or any intermediate state; the
// contract checks the proof against the digest IT asserts from its own memory and only then writes.
//
// WHY THE STATEMENT IS NAMED RATHER THAN STAGED: a constraint system is code, and staging code to
// execute inside the runtime is not a capability this host grants. The staged data names an entry
// in @xmbl/zero-knowledge's fixed registry; the proof is staged, and the CLAIM comes from the
// guest, which is what binds the verdict to bytes the contract chose.
//
// CLAIMS:
//   1. an honest proof + the correct digest -> verify returns 1, the contract writes, the root MOVES
//   2. the same proof + a digest off by one -> 0, no write, the root is UNMOVED
//   3. the preimage and every intermediate state are absent from the proof
//   4. a proof of a DIFFERENT statement is refused for this one
//   5. the same import without the airHost flag -> DENIED (deny-by-default)
//   6. a malformed staged proof -> 0, never a trap
//   7. two independent nodes -> the same verdict and the same root
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ComputeRuntime } from '@xmbl/storage-compute';
import { VerkleStateTree } from '@xmbl/state-machine';
import { ContractHost } from '@xmbl/contracts';
import { airProve, airStatementCtx, AIR_STATEMENTS, airVerifyStatement, fadd, fmul } from '@xmbl/zero-knowledge';

const HDR = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const uleb = (v) => { const b = []; do { let x = v & 0x7f; v >>>= 7; if (v) x |= 0x80; b.push(x); } while (v); return b; };
const sleb = (v) => { let more = true; const b = []; while (more) { let x = v & 0x7f; v >>= 7; if ((v === 0 && !(x & 0x40)) || (v === -1 && (x & 0x40))) more = false; else x |= 0x80; b.push(x); } return b; };
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];
const str = (t) => [...uleb(t.length), ...[...t].map((c) => c.charCodeAt(0))];
const WORD = 32;
const word32 = (v) => { const b = new Uint8Array(WORD); let x = BigInt(v); for (let i = 0; i < WORD; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };

// gatedContract(digestBytes): bakes the digest it asserts at address 0 and does
//   check() -> i32 { if (xmbl_air_verify(0)) verkle_set(7, 1); return that }
function gatedContract(digestBytes) {
  const code = [0x01, 0x01, 0x7f];
  code.push(0x41, ...sleb(0), 0x10, ...uleb(0), 0x21, ...uleb(0));          // v = air_verify(0)
  code.push(0x20, ...uleb(0), 0x04, 0x40);                                   // if v
  code.push(0x41, ...sleb(7), 0x41, ...sleb(1), 0x10, ...uleb(1), 0x1a);     //   verkle_set(7,1)
  code.push(0x0b);                                                           // end if
  code.push(0x20, ...uleb(0), 0x0b);                                         // return v
  return Uint8Array.from([
    ...HDR,
    ...section(1, vec([
      [0x60, ...vec([0x7f]), ...vec([0x7f])],
      [0x60, ...vec([0x7f, 0x7f]), ...vec([0x7f])],
      [0x60, ...vec([]), ...vec([0x7f])],
    ])),
    ...section(2, vec([
      [...str('env'), ...str('xmbl_air_verify'), 0x00, ...uleb(0)],
      [...str('env'), ...str('xmbl_verkle_set'), 0x00, ...uleb(1)],
    ])),
    ...section(3, vec([uleb(2)])),
    ...section(5, vec([[0x01, ...uleb(1), ...uleb(1)]])),
    ...section(7, vec([[...str('memory'), 0x02, ...uleb(0)], [...str('check'), 0x00, ...uleb(2)]])),
    ...section(10, vec([[...uleb(code.length), ...code]])),
    ...section(11, vec([[0x00, 0x41, ...sleb(0), 0x0b, ...vec([...digestBytes])]])),
  ]);
}

const runtime = () => new ComputeRuntime({ maxTime: 60000 });
const line = (k, v) => console.log(`  ${String(k).padEnd(40)}: ${v}`);

async function main() {
  console.log('REPRODUCTION — a contract gates state on a proof of ARBITRARY COMPUTATION\n');

  // The prover's side: a secret preimage run through 16 rounds of x -> x^3 + RC.
  const NAME = 'hashchain-16', RC = 987654321n;
  const st = AIR_STATEMENTS[NAME];
  const ctx = airStatementCtx(NAME);
  const secret = 424242424n;
  const trace = []; let x = secret;
  for (let r = 0; r < st.params.traceLen; r++) { trace.push([x]); x = fadd(fmul(fmul(x, x), x), RC); }
  const digest = trace[st.params.traceLen - 1][0];
  line('statement', st.describe);
  line('secret preimage', `${secret}   (never leaves the prover)`);
  line('public digest', digest);
  line('trace', `${st.params.traceLen} rows x ${st.params.width} column, constraint degree ${st.params.constraintDeg}`);
  line('derived parameters', `K=${ctx.K} N=${ctx.N} blowup=${ctx.blowup} nq=${ctx.nq} nc=${ctx.nc}`);

  const t0 = Date.now();
  const proof = airProve(ctx, { trace, transitions: st.transitions, boundary: st.boundary(digest) });
  line('prove ms', Date.now() - t0);
  const blob = JSON.stringify(proof, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  line('proof size KB', (blob.length / 1024).toFixed(0));
  console.log('');

  // 3) the witness is absent
  assert.ok(!blob.includes(secret.toString()), 'the preimage must not appear in the proof');
  const leaked = trace.slice(0, -1).filter((r) => blob.includes(r[0].toString()));
  line('preimage in proof', 'no');
  line('intermediate states in proof', `none of ${trace.length - 1}`);
  assert.strictEqual(leaked.length, 0, 'no intermediate state may appear');
  console.log('');

  const staged = { statement: NAME, proof };
  const call = async (assertedDigest, opts = {}, stage = staged) => {
    const host = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
    const { id } = host.deploy(gatedContract(word32(assertedDigest)), [7], { airHost: true, ...opts });
    const before = host.state.getRoot();
    const r = await host.call(id, 'check', [], { air: stage });
    return { host, id, result: r.result, before, after: host.state.getRoot() };
  };

  // 1) honest
  {
    const { host, id, result, before, after } = await call(digest);
    line('honest: xmbl_air_verify', result);
    line('honest: slot 7 after call', host.getSlot(id, 7));
    line('root before -> after', `${before.slice(0, 12)}… -> ${after.slice(0, 12)}…`);
    assert.strictEqual(result, 1, 'an honest proof must verify');
    assert.strictEqual(host.getSlot(id, 7), 1, 'the contract must write');
    assert.notStrictEqual(after, before, 'the root must move');
    console.log('');
  }

  // 2) the contract asserts a digest the proof does not support
  {
    const { host, id, result, before, after } = await call(fadd(digest, 1n));
    line('tampered digest: verify', result);
    line('tampered digest: slot 7', host.getSlot(id, 7));
    assert.strictEqual(result, 0, 'a digest the proof does not support must refuse');
    assert.strictEqual(after, before, 'the root must be unmoved');
    console.log('');
  }

  // 4) a proof of a DIFFERENT statement
  {
    const fibCtx = airStatementCtx('fib-32'), fib = AIR_STATEMENTS['fib-32'];
    const ft = []; let a = 1n, b = 1n;
    for (let r = 0; r < 32; r++) { ft.push([a, b]); const nb = fadd(a, b); a = b; b = nb; }
    const fibProof = airProve(fibCtx, { trace: ft, transitions: fib.transitions, boundary: fib.boundary(ft[31][0]) });
    assert.strictEqual(airVerifyStatement('fib-32', fibProof, ft[31][0]), true, 'the fib proof must be valid for ITS statement');
    const { result, before, after } = await call(digest, {}, { statement: NAME, proof: fibProof });
    line('proof of a different statement', result === 0 ? 'refused' : 'ACCEPTED (wrong)');
    assert.strictEqual(result, 0, 'a proof of another statement must not verify here');
    assert.strictEqual(after, before, 'root unmoved');
  }

  // 5) deny-by-default
  {
    const host = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
    const { id } = host.deploy(gatedContract(word32(digest)), [7]);   // NO airHost
    await assert.rejects(() => host.call(id, 'check', [], { air: staged }), /denied import: env\.xmbl_air_verify/);
    line('deny-by-default (no airHost)', 'refused');
  }

  // 6) malformed proof, no trap
  {
    const { result, before, after } = await call(digest, {}, { statement: NAME, proof: { roots: ['deadbeef'], garbage: true } });
    line('malformed proof (no trap)', result);
    assert.strictEqual(result, 0, 'a malformed proof must refuse, not trap');
    assert.strictEqual(after, before, 'root unmoved');
    console.log('');
  }

  // 7) determinism
  {
    const n1 = await call(digest), n2 = await call(digest);
    line('node1 verdict === node2 verdict', n1.result === n2.result);
    line('node1 root === node2 root', n1.after === n2.after);
    assert.strictEqual(n1.after, n2.after, 'same call -> same root on both nodes');
    console.log('');
  }

  const srcHash = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  line('content address (sha256 of file)', srcHash);
  console.log('\n✅ PASS — a contract verified a proof that a 16-round computation reached a digest,');
  console.log('   gated a Verkle write on the digest IT asserted, refused a tampered digest and a');
  console.log('   proof of another statement, and never saw the preimage.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('\n❌ FAIL —', e.message); process.exit(1); });
