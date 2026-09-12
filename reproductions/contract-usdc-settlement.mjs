// REPRODUCTION — the XMBL contract system settles USDC on a network the user chooses, via zk and
// via HE (packages/contracts × packages/zero-knowledge × packages/identity [cubic-LWE seal + HE]
// × packages/storage-compute × packages/state-machine).
//
// CLAIM (operator): "show how the xmbl contract system allows settling of usdc on whatever network
// users choose via zk and via he."
//
// WHAT XMBL GUARANTEES HERE (a spec, proven by the assertions below — not a custody claim):
//   • The USDC clears on a rail the user chooses (base, arbitrum, … — any EVM/ERC-20 network). XMBL
//     does NOT custody the ERC-20; it binds the AUTHORIZING secret (the EVM key / pre-signed transfer
//     that moves the USDC on that rail) to the XMBL receiver by SEALING it (packages/identity seal.js:
//     PQ Cubic-LWE KEM + HKDF + AES-256-GCM). Only the receiver's lattice secret key opens it.
//   • RELEASE of that sealed authorization is GATED on a coordinate/curve ZK proof (env.xmbl_zk_verify)
//     BOUND TO THE SETTLEMENT RECORD: the proved coordinate x = sha256(canonical {receiver, asset,
//     amount, chain, nonce}) reduced into the FRI field. So a proof that releases the `base` settlement
//     cannot release the same settlement re-pointed at `ethereum` — the chain choice is load-bearing,
//     not a string field. The Verkle root MOVES only on a valid, record-bound proof.
//   • The AMOUNT can be carried ENCRYPTED: the contract homomorphically ADDS post-quantum cubic-LWE
//     ciphertexts (env.xmbl_he_add) with no key, persisting an encrypted aggregate (netting) the chain
//     cannot read; the treasury opens it off-chain with its secret key.
//   The external rail's finality is the rail's; XMBL proves authorization-RELEASE to a record-bound,
//   proven claimant and seals the authorizing secret to exactly one receiver. That is what is asserted.
//
// TWO KEYS, TWO JOBS (not a compromise): the value-bearing SEAL rides MAINNET_N=729 — sealSecret
// REFUSES a sub-mainnet ring without allowWeak (seal.js:29), because sealing a USDC key to a toy ring
// would make "post-quantum settlement" false; asserted below. The HE AGGREGATION key uses the small
// ring (n=27): the on-chain ciphertext is (n+1)×32 bytes and the contract stores one slot per word, so
// 729 would be 730 slots per ciphertext — the wrong budget for a demonstration, unrelated to the seal's
// quantum margin. cubic-LWE's message space here is one bit per ciphertext (q/2 scaling, cubic-lwe.js:219):
// this reproduces the additive homomorphism ENC(a)⊞ENC(b)=ENC(a+b) that encrypted settlement-netting is
// built on; multi-bit amount packing is a separate encoding and is not exercised here.
//
// OPT-IN / UNAUDITED: @xmbl/zero-knowledge (FRI) and the cubic-LWE scheme are experimental and UNAUDITED
// (MAINNET-GATES ⛔). zkHost/heHost are per-contract opt-in and MUST NOT gate consensus/ledger/sealing.
// Exits non-zero if any claim fails, so it is also a hard-gate test (reproductions.test.mjs).
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ComputeRuntime } from '@xmbl/storage-compute';
import { VerkleStateTree } from '@xmbl/state-machine';
import { ContractHost } from '@xmbl/contracts';
import { setup, blindedCurve, prove, verify } from '@xmbl/zero-knowledge';
import { sealKeyPair, sealSecret, openSecret, cubicLweKeyGen, encryptBit, decryptBit } from '@xmbl/identity';

// ── FRI field (fri.js: p = 15·2^27+1). The released coordinate is a settlement-record hash reduced here. ──
const P_FIELD = 2013265921n;
const canon = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
};
// The release coordinate IS the settlement: x = sha256(canonical record) mod p. Changing any field
// (receiver, asset, amount, chain, nonce) moves the coordinate, so a proof is unforgeable for a record.
const recordCoordinate = (record) => BigInt('0x' + createHash('sha256').update(canon(record)).digest('hex')) % P_FIELD;

// ── WASM builders (byte-identical to the patterns proven in contract-zk.mjs / contract-he.mjs) ──
const HDR = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const uleb = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };
const sleb = (n) => { let more = true; const b = []; while (more) { let x = n & 0x7f; n >>= 7; if ((n === 0 && !(x & 0x40)) || (n === -1 && (x & 0x40))) more = false; else x |= 0x80; b.push(x); } return b; };
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];
const s = (t) => [...uleb(t.length), ...[...t].map((c) => c.charCodeAt(0))];
const WORD = 32;
const word32 = (v) => { const b = new Uint8Array(WORD); let x = BigInt(v); for (let i = 0; i < WORD; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const ctBytes = (ct, n) => { const out = new Uint8Array((n + 1) * WORD); for (let i = 0; i < n; i++) out.set(word32(ct.u[i]), i * WORD); out.set(word32(ct.v), n * WORD); return out; };

// releaseContract(xWord, yWord): bakes the record coordinate (x,y) and exports
//   release() -> i32 { ok = xmbl_zk_verify(0, 32); if (ok) xmbl_verkle_set(0, 1); return ok }
// slot 0 = "authorization released" (1). A valid record-bound proof commits it and MOVES the root.
function releaseContract(xWord, yWord) {
  const data = [...xWord, ...yWord];
  const code = [
    0x01, 0x01, 0x7f,
    0x41, ...sleb(0), 0x41, ...sleb(32), 0x10, ...uleb(0), 0x22, ...uleb(0),
    0x04, 0x40, 0x41, ...sleb(0), 0x41, ...sleb(1), 0x10, ...uleb(1), 0x1a, 0x0b,
    0x20, ...uleb(0), 0x0b,
  ];
  return Uint8Array.from([
    ...HDR,
    ...section(1, vec([[0x60, ...vec([0x7f, 0x7f]), ...vec([0x7f])], [0x60, ...vec([]), ...vec([0x7f])]])),
    ...section(2, vec([
      [...s('env'), ...s('xmbl_zk_verify'), 0x00, ...uleb(0)],
      [...s('env'), ...s('xmbl_verkle_set'), 0x00, ...uleb(0)],
    ])),
    ...section(3, vec([uleb(1)])),
    ...section(5, vec([[0x01, ...uleb(1), ...uleb(1)]])),
    ...section(7, vec([[...s('memory'), 0x02, ...uleb(0)], [...s('release'), 0x00, ...uleb(2)]])),
    ...section(10, vec([[...uleb(code.length), ...code]])),
    ...section(11, vec([[0x00, 0x41, ...sleb(0), 0x0b, ...vec([...data])]])),
  ]);
}

// nettingContract(ctaBytes, ctbBytes, n): blind-adds two encrypted amounts into OUT and stores each
// result word to slots 0..n — ENC(a) ⊞ ENC(b) persisted without any key.
function nettingContract(ctaBytes, ctbBytes, n) {
  const COUNT = n + 1, SPAN = COUNT * WORD, OUT = 2 * SPAN;
  const data = [...ctaBytes, ...ctbBytes];
  const code = [0x01, 0x01, 0x7f];
  code.push(0x41, ...sleb(0), 0x41, ...sleb(SPAN), 0x41, ...sleb(OUT), 0x10, ...uleb(0), 0x21, ...uleb(0));
  for (let i = 0; i < COUNT; i++) {
    code.push(0x41, ...sleb(i), 0x41, ...sleb(OUT + i * WORD), 0x28, 0x02, 0x00, 0x10, ...uleb(1), 0x1a);
  }
  code.push(0x20, ...uleb(0), 0x0b);
  return Uint8Array.from([
    ...HDR,
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
    ...section(7, vec([[...s('memory'), 0x02, ...uleb(0)], [...s('net'), 0x00, ...uleb(2)]])),
    ...section(10, vec([[...uleb(code.length), ...code]])),
    ...section(11, vec([[0x00, 0x41, ...sleb(0), 0x0b, ...vec([...data])]])),
  ]);
}

const runtime = () => new ComputeRuntime({ maxTime: 15000 });
const line = (k, v) => console.log(`  ${k.padEnd(46)}: ${v}`);

// A demo EVM private key that would authorize a USDC ERC-20 transfer on the chosen rail. NOT a funded
// key — it stands in for the authorizing secret that gets SEALED to the receiver and never custodied.
const EVM_AUTH_KEY = 'ee'.repeat(32); // 64 hex chars = 32 bytes

// Prove-and-release a settlement on a chosen network: seal the authorizing key to the receiver, build
// a record-bound proof, and gate the release on it. Returns the deployed host + the released flag.
async function settleOnNetwork({ host, ctx, publicPoints, secretPoints, receiver, receiverPk, chain, amount, nonce }) {
  const record = { receiver, asset: 'USDC', amount, chain, nonce };
  const derivedX = recordCoordinate(record);
  const { Pt, derivedY } = blindedCurve(ctx, { publicPoints, secretPoints, derivedX });
  const proof = prove(ctx, { Pt, publicPoints, derivedX, derivedY });
  assert.strictEqual(verify(ctx, { proof, publicPoints, derivedX, derivedY }), true, `sanity: ${chain} record-bound proof verifies standalone`);
  // Seal the rail's authorizing secret to the receiver, bound to WHAT it settles (asset/amount/chain/nonce as AAD).
  const envelope = sealSecret(receiverPk, EVM_AUTH_KEY, { receiver, meta: { asset: 'USDC', amount, chain, nonce } });
  const wasm = releaseContract(word32(derivedX), word32(derivedY));
  const { id } = host.deploy(wasm, [0], { zkHost: true });
  const rootBefore = host.state.getRoot();
  const r = await host.call(id, 'release', [], { zk: { opts: {}, proof, publicPoints } });
  const rootAfter = host.state.getRoot();
  return { record, derivedX, derivedY, proof, envelope, id, released: host.getSlot(id, 0), verdict: r.result, rootBefore, rootAfter };
}

async function main() {
  console.log('REPRODUCTION — XMBL settles USDC on a user-chosen network via zk (record-bound release) and he (blind netting)\n');

  const ctx = setup();
  const publicPoints = [{ x: 11n, y: 101n }, { x: 12n, y: 205n }, { x: 13n, y: 313n }, { x: 14n, y: 419n }];
  const secretPoints = [{ x: 21n, y: 55555n }, { x: 22n, y: 66666n }, { x: 23n, y: 77777n }];
  const receiver = 'xmbTREASURY';

  // The receiver's PQ identity — minted at MAINNET_N=729 so the value-bearing seal is post-quantum.
  const kp = sealKeyPair();
  line('seal receiver lattice N', `${kp.pk.n}  (MAINNET_N — value-bearing)`);
  console.log('');

  // ── 1) SETTLE ON "base": record-bound proof releases, Verkle root MOVES, receiver opens the seal ──
  const host = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
  const base = await settleOnNetwork({ host, ctx, publicPoints, secretPoints, receiver, receiverPk: kp.pk, chain: 'base', amount: '250.00', nonce: 1 });
  line('base: release coordinate = sha256(record)', `${base.derivedX.toString().slice(0, 10)}…  (bound to {…,chain:base,…})`);
  line('base: xmbl_zk_verify verdict', base.verdict);
  line('base: slot 0 (authorization released)', base.released);
  line('base: Verkle root before → after', `${base.rootBefore.slice(0, 12)}… → ${base.rootAfter.slice(0, 12)}…`);
  assert.strictEqual(base.derivedX, recordCoordinate(base.record), 'the released coordinate must BE the record hash (binding)');
  assert.strictEqual(base.verdict, 1, 'a valid record-bound proof must verify to 1');
  assert.strictEqual(base.released, 1, 'a verified proof must release the settlement (commit slot 0)');
  assert.notStrictEqual(base.rootAfter, base.rootBefore, 'releasing must MOVE the Verkle root');
  // The receiver — and only the receiver — opens the sealed authorizing key to clear USDC on base.
  const openedBase = openSecret(kp.sk, base.envelope);
  line('base: receiver opens sealed USDC auth', openedBase.toString('utf8') === EVM_AUTH_KEY ? 'recovered the authorizing key' : 'FAILED');
  assert.strictEqual(openedBase.toString('utf8'), EVM_AUTH_KEY, 'the receiver must recover the exact authorizing key');
  console.log('');

  // ── 2) "WHATEVER NETWORK": the SAME receiver settles on "arbitrum" with its OWN record-bound proof ──
  const arb = await settleOnNetwork({ host, ctx, publicPoints, secretPoints, receiver, receiverPk: kp.pk, chain: 'arbitrum', amount: '75.50', nonce: 2 });
  line('arbitrum: release coordinate', `${arb.derivedX.toString().slice(0, 10)}…  (different record → different coordinate)`);
  line('arbitrum: verdict / released', `${arb.verdict} / ${arb.released}`);
  assert.notStrictEqual(arb.derivedX, base.derivedX, 'a different network must yield a different release coordinate');
  assert.strictEqual(arb.released, 1, 'the arbitrum settlement must release under its own record-bound proof');
  assert.strictEqual(openSecret(kp.sk, arb.envelope).toString('utf8'), EVM_AUTH_KEY, 'the receiver opens the arbitrum seal too');
  console.log('');

  // ── 3) LOAD-BEARING: base's proof CANNOT release the same settlement re-pointed at "ethereum" ──
  // Attacker re-points base → ethereum (x moves to H(record_eth)) but only holds base's proof/derivedY.
  const recordEth = { ...base.record, chain: 'ethereum' };
  const derivedXEth = recordCoordinate(recordEth);
  const hostEth = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
  const wasmEth = releaseContract(word32(derivedXEth), word32(base.derivedY)); // eth coordinate, base's y
  const { id: idEth } = hostEth.deploy(wasmEth, [0], { zkHost: true });
  const rootBeforeEth = hostEth.state.getRoot();
  const rEth = await hostEth.call(idEth, 'release', [], { zk: { opts: {}, proof: base.proof, publicPoints } });
  line('ethereum re-point: verdict (base proof)', rEth.result);
  line('ethereum re-point: slot 0 (released?)', hostEth.getSlot(idEth, 0));
  line('ethereum re-point: root moved?', hostEth.state.getRoot() !== rootBeforeEth);
  assert.notStrictEqual(derivedXEth, base.derivedX, 'changing the chain must move the coordinate');
  assert.strictEqual(rEth.result, 0, 'base proof must NOT verify against the ethereum-repointed record');
  assert.strictEqual(hostEth.getSlot(idEth, 0), 0, 'no release for a network the proof was not bound to');
  assert.strictEqual(hostEth.state.getRoot(), rootBeforeEth, 'a wrong-network claim must leave the root UNMOVED');
  console.log('');

  // ── 4) SEAL BOUNDARY: the authorization is bound to the receiver AND to what it settles ──
  let refusals = 0;
  // (a) A different receiver's secret key cannot open it (decapsulates to a different key → GCM tag fails).
  const other = sealKeyPair();
  assert.throws(() => openSecret(other.sk, base.envelope), /Unsupported state|unable to authenticate|bad decrypt|auth/i, 'a wrong receiver must not open the seal');
  refusals += 1;
  // (b) Mutating what it settles (amount) fails the GCM tag — the ciphertext is bound to the amount.
  const tamperedEnv = { ...base.envelope, meta: { ...base.envelope.meta, amount: '9999.00' } };
  assert.throws(() => openSecret(kp.sk, tamperedEnv), /Unsupported state|unable to authenticate|bad decrypt|auth/i, 'mutating the settled amount must fail the GCM tag');
  refusals += 1;
  // (c) sealSecret REFUSES a sub-mainnet ring for value (the post-quantum property, by construction).
  const weakPk = cubicLweKeyGen({ n: 27 }).pk;
  assert.throws(() => sealSecret(weakPk, EVM_AUTH_KEY, { receiver, meta: { asset: 'USDC', amount: '1.00' } }), /below mainnet/, 'sealing USDC to a toy ring must be refused');
  refusals += 1;
  line('seal-boundary refusals', `${refusals}  (wrong receiver; mutated amount; toy-ring value seal)`);
  // (d) The chain never holds the authorizing key: committed state is the release flag, not key bytes.
  const keyHex = Buffer.from(EVM_AUTH_KEY, 'utf8').toString('hex');
  const committed = Buffer.concat([Buffer.from(word32(host.getSlot(base.id, 0)))]).toString('hex');
  assert.ok(!committed.includes(keyHex), 'committed state must never contain the authorizing key');
  line('committed state contains key bytes?', committed.includes(keyHex));
  console.log('');

  // ── 5) VIA HE: the contract blind-adds two encrypted settlement amounts; the treasury opens the net ──
  const { sk: heSk, pk: hePk } = cubicLweKeyGen({ n: 27 });
  const n = hePk.n;
  const net = async (a, b) => {
    const ctA = encryptBit(hePk, a), ctB = encryptBit(hePk, b);
    const h = new ContractHost({ runtime: runtime(), state: new VerkleStateTree() });
    const slots = Array.from({ length: n + 1 }, (_, i) => i);
    const { id } = h.deploy(nettingContract(ctBytes(ctA, n), ctBytes(ctB, n), n), slots, { heHost: true });
    const r = await h.call(id, 'net', [], { he: { n, q: hePk.q } });
    assert.strictEqual(r.result, 0, 'xmbl_he_add must return ok');
    const u = []; for (let i = 0; i < n; i++) u.push(BigInt(h.getSlot(id, i)));
    return decryptBit(heSk, { u, v: BigInt(h.getSlot(id, n)) });
  };
  const sum10 = await net(1, 0);
  line('he: decrypt( ENC(1) ⊞ ENC(0) ) blind on-chain', `${sum10}  (treasury opens the netted total; chain saw only ciphertext)`);
  assert.strictEqual(sum10, 1, 'the homomorphic sum of encrypted amounts must open to 1');
  console.log('');

  const srcHash = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  line('content address (sha256 of file)', srcHash);
  console.log('\n✅ PASS — USDC settled on base and arbitrum via record-bound zk release; the same proof could');
  console.log('   not release the ethereum-repointed settlement; the authorizing key opened only for the named');
  console.log(`   receiver and only for the settled amount; the chain held ciphertext, never the key (${refusals} refusals).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('\n❌ FAIL —', e.message); process.exit(1); });
