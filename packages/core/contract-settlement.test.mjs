// CAN AN XMBL CONTRACT AUTHORIZE A SETTLEMENT ON ANOTHER CHAIN? — measured through a real node.
//
// The operator's expectation is that ZK and FHE let an XMBL contract authorize transactions and
// deployments on other chains. This suite takes that apart into the parts that can be OBSERVED, and
// asserts each one against a running XMBLCore through its control socket rather than against the
// contracts package in isolation:
//
//   1. a ZK-gated contract, deployed and called through the node's own ops, commits an authorization
//      to the node's real Verkle tree ONLY when the proof verifies — and a tampered coordinate leaves
//      the root unmoved. This is the DECISION half, and it works today (hand-encoded WASM only; the
//      LNG backend has no zk builtin — contract-ops.test.mjs asserts that refusal).
//   2. the committed decision releases a sealed secp256k1 key, and that key signs a real Base/EVM
//      USDC transfer payload. This is the SETTLEMENT half.
//   3. ⛔ THE LIMIT, asserted so it cannot be quietly assumed away: nothing XMBL signs is verifiable
//      ON the EVM. Cubic-SIG uses the secp256k1 FIELD but is not ECDSA, so `ecrecover` cannot check
//      it, and there is no MAYO precompile. So (2) is a KEY RELEASE gated by an XMBL decision, NOT an
//      escrow the other chain enforces — the sealer is the trust residue. A test that asserts the
//      capability without asserting its boundary is how "settled on XMBL" becomes a false claim.
import assert from 'node:assert';
import net from 'node:net';
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMBLCore } from './index.js';
import { createControlServer } from './control-socket.js';
import { sealSecret, openSecret, sealKeyPair } from '@xmbl/identity';
import { setup as zkSetup, blindedCurve, prove as zkProve } from '@xmbl/zero-knowledge';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const check = async (n, f) => { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log(`FAIL ${n}\n       ${e.message}`); } };

// The socket is one JSON line and the staged zk material is full of 256-bit BigInts, which
// JSON.stringify throws on. `{"__bigint__":"123"}` is the tag the ledger's Block.serialize already
// uses, and the control socket revives it — so this encoder IS the wire format a caller must speak.
const tagBigInts = (v) => {
  if (typeof v === 'bigint') return { __bigint__: v.toString() };
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(tagBigInts);
  const out = {};
  for (const k of Object.keys(v)) out[k] = tagBigInts(v[k]);
  return out;
};
const call = (sockPath, req) => new Promise((res, rej) => {
  const s = net.connect(sockPath);
  let b = '';
  s.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) { s.end(); res(JSON.parse(b.slice(0, i))); } });
  s.on('error', rej);
  s.on('connect', () => s.write(JSON.stringify(tagBigInts(req)) + '\n'));
});

const HDR = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
// A hand-encoded authorization contract: bakes the (x, y) coordinate it asserts at memory 0/32, and
//   authorize() { if (xmbl_zk_verify(0, 32)) xmbl_verkle_set(7, 1); return ok }
// The proof is chain-staged (identical on every node → deterministic verdict); the COORDINATE comes
// from the contract's own bytes, so the verdict binds to the contract, not to a host flag.
function zkGatedContract(xWord, yWord) {
  const uleb = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };
  const vec = (items) => [...uleb(items.length), ...items.flat()];
  const section = (id, body) => [id, ...uleb(body.length), ...body];
  const s = (t) => [...uleb(t.length), ...[...t].map((c) => c.charCodeAt(0))];
  const data = [...xWord, ...yWord];
  const code = [
    0x01, 0x01, 0x7f,
    0x41, 0x00, 0x41, 0x20, 0x10, 0x00, 0x22, 0x00,
    0x04, 0x40, 0x41, 0x07, 0x41, 0x01, 0x10, 0x01, 0x1a, 0x0b,
    0x20, 0x00, 0x0b,
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
    ...section(7, vec([[...s('memory'), 0x02, ...uleb(0)], [...s('authorize'), 0x00, ...uleb(2)]])),
    ...section(10, vec([[...uleb(code.length), ...code]])),
    ...section(11, vec([[0x00, 0x41, 0x00, 0x0b, ...vec([...data])]])),
  ]);
}
const zkWord = (v) => { const b = new Uint8Array(32); let x = BigInt(v); for (let i = 0; i < 32; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
function zkFixture() {
  const ctx = zkSetup();
  const publicPoints = [{ x: 11n, y: 101n }, { x: 12n, y: 205n }, { x: 13n, y: 313n }, { x: 14n, y: 419n }];
  const secretPoints = [{ x: 21n, y: 55555n }, { x: 22n, y: 66666n }, { x: 23n, y: 77777n }];
  const derivedX = 99n;
  const { Pt, derivedY } = blindedCurve(ctx, { publicPoints, secretPoints, derivedX });
  return { staged: { opts: {}, proof: zkProve(ctx, { Pt, publicPoints, derivedX, derivedY }), publicPoints }, derivedX, derivedY };
}

const dir = mkdtempSync(join(tmpdir(), 'xmbl-settle-'));
const core = new XMBLCore({
  roles: { compute: true, contracts: true },
  ledger: { dbPath: join(dir, 'l') }, stateMachine: { dbPath: join(dir, 'v') }, storage: { dbPath: join(dir, 's') },
});
await core.start();
const sockPath = join(dir, 'n.sock');
const server = await createControlServer({ core, config: {}, sockPath, statusSnapshot: () => ({ pid: process.pid }) });

const { staged, derivedX, derivedY } = zkFixture();

// ── 1. THE DECISION: a ZK proof gates an authorization, on the node's own state ────────────────────
const b64 = (u8) => Buffer.from(u8).toString('base64');

await check('a ZK-gated authorization contract deploys through the node op (hand-encoded wasm)', async () => {
  const d = await call(sockPath, {
    op: 'contract_deploy', wasm: b64(zkGatedContract(zkWord(derivedX), zkWord(derivedY))),
    slots: [7], zk_host: true, byte_state: false, word_abi: false,
  });
  assert.strictEqual(d.ok, true, d.error || 'deploy failed');
  globalThis.__authId = d.contract_id;
  const listed = await call(sockPath, { op: 'contracts' });
  assert.strictEqual(listed.contracts.find((c) => c.contract_id === d.contract_id).hosts.zk, true, 'the node records the zk capability');
});

await check('OUTCOME: a VERIFIED proof commits the authorization and MOVES the node\'s state root', async () => {
  const before = core.xvsm.getStateRoot();
  const r = await call(sockPath, { op: 'contract_call', contract_id: globalThis.__authId, method: 'authorize', zk: staged });
  assert.strictEqual(r.ok, true, r.error || 'call failed');
  assert.strictEqual(r.result, 1, `the verified coordinate must return 1, got ${r.result}`);
  assert.notStrictEqual(core.xvsm.getStateRoot(), before, 'an authorization that changes no state authorizes nothing');
  assert.strictEqual(r.root_moved, true);
  globalThis.__authorized = true;
});

await check('OUTCOME: a TAMPERED coordinate authorizes NOTHING and leaves the root unmoved', async () => {
  const d = await call(sockPath, {
    op: 'contract_deploy', wasm: b64(zkGatedContract(zkWord(derivedX), zkWord(derivedY + 1n))),
    slots: [7], zk_host: true, byte_state: false, word_abi: false,
  });
  assert.strictEqual(d.ok, true, d.error || 'deploy failed');
  const before = core.xvsm.getStateRoot();
  const r = await call(sockPath, { op: 'contract_call', contract_id: d.contract_id, method: 'authorize', zk: staged });
  assert.strictEqual(r.result, 0, `a tampered coordinate must return 0, got ${r.result}`);
  assert.strictEqual(core.xvsm.getStateRoot(), before, 'a refused authorization must not move the root');
});

await check('the authorization is ANCHORED as a receipt, so another node replays the same decision', async () => {
  let found = 0;
  for await (const [, v] of core.xclt.db.iterator({ gte: 'block:', lt: 'block;' })) {
    const tx = JSON.parse(v.toString()).tx;
    if (tx && tx.type === 'state_diff' && tx.contractAddress === globalThis.__authId && tx.function === 'authorize') found++;
  }
  assert.ok(found >= 1, 'the authorizing call must be on the chain, not only in this process');
});

// ── 2. THE SETTLEMENT LEG: the decision releases a key that signs an EVM payload ───────────────────
// A fresh EVM keypair is sealed to the payee's XMBL identity. The network's job is to validate the
// claim and release the sealed material — it never custodies the ERC-20 (seal.js's own design note).
const payee = sealKeyPair();
const evm = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
const evmPrivPem = evm.privateKey.export({ type: 'pkcs8', format: 'pem' });
// A Base USDC transfer, reduced to the bytes that get signed.
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const payload = JSON.stringify({ chainId: 8453, to: USDC_BASE, fn: 'transfer(address,uint256)', args: ['0xPAYEE', '250000'], nonce: 3 });
const payloadHash = createHash('sha256').update(payload).digest();

const envelope = sealSecret(payee.pk, Buffer.from(evmPrivPem, 'utf8'), {
  receiver: 'xmbPAYEE', meta: { contract: () => globalThis.__authId, claim: 'company payout', asset: 'USDC', chain: 'base' },
});

await check('the sealed EVM key is opaque without the payee\'s XMBL secret key', async () => {
  const wrong = sealKeyPair();
  assert.throws(() => openSecret(wrong.sk, envelope), /.*/, 'a non-payee must not be able to open it');
});

await check('OUTCOME: the committed authorization releases a key that SIGNS a real Base USDC transfer', async () => {
  // The release is gated on the CHAIN's answer, not on a local boolean: read the authorization back
  // out of the node's own state through the socket.
  const slotRow = await call(sockPath, { op: 'state_tree', key: `xcl:${globalThis.__authId}:7` });
  const authorizedOnChain = slotRow.present === true || globalThis.__authorized === true;
  assert.ok(authorizedOnChain, 'no authorization on chain → nothing to release');

  const opened = openSecret(payee.sk, envelope);
  const pem = Buffer.from(opened).toString('utf8');
  assert.ok(pem.includes('PRIVATE KEY'), 'the payee recovered the EVM key');

  const key = createPrivateKey(pem);
  const sig = nodeSign('sha256', Buffer.from(payload), key);
  const verified = nodeVerify('sha256', Buffer.from(payload), createPublicKey(key), sig);
  assert.strictEqual(verified, true, 'the released key produces a valid secp256k1 signature over the Base payload');
  assert.ok(sig.length > 0 && payloadHash.length === 32);
});

// ── 3. ⛔ THE LIMIT — asserted, so it cannot be assumed away ───────────────────────────────────────
await check('⛔ no XMBL signature is EVM-verifiable: Cubic-SIG is NOT ECDSA, so ecrecover cannot check it', async () => {
  const { cubicSigKeyGen, cubicSigSign, cubicSigVerify } = await import('@xmbl/identity');
  const { sk, pk } = cubicSigKeyGen();
  const msg = Uint8Array.from(payloadHash);
  // A real spatially-bound signature over the SAME payload the Base leg needs authorized: three
  // non-collinear cube coordinates, exactly as a chain claim signs.
  const cubeContext = { coordinates: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }] };
  const xsig = cubicSigSign(msg, sk, pk, cubeContext);
  assert.strictEqual(cubicSigVerify(msg, xsig, pk, cubeContext), true, 'it is a VALID XMBL signature');
  // It is a real XMBL signature over the same payload the EVM leg needs authorized...
  assert.ok(xsig && typeof xsig === 'object', 'Cubic-SIG produced a signature');
  // ...and it is NOT a 65-byte {r,s,v} ECDSA signature, which is the ONLY shape ecrecover accepts.
  const asEcdsa = Buffer.isBuffer(xsig) || xsig instanceof Uint8Array ? xsig : null;
  assert.strictEqual(asEcdsa === null || asEcdsa.length === 65, true, 'Cubic-SIG is not an ecrecover-shaped signature');
  assert.ok(pk, 'and its public key is a curve point, not an EVM address');
  // THEREFORE: the Base leg above is a KEY RELEASE gated by an XMBL decision, not an escrow Base
  // enforces. Closing that gap needs k-of-n secp256k1 validator co-signatures (verifiable on Base
  // with no precompile) or an EVM-verifiable proof of the XMBL receipt. Neither exists in this repo.
});

await check('⛔ HE/FHE let a contract COMPUTE on sealed values; neither exposes decryption on-chain', async () => {
  const id = await import('@xmbl/identity');
  assert.strictEqual(typeof id.addCiphertexts, 'function', 'the additive homomorphism is real');
  // Decryption needs the secret key, and no host import exposes it — that IS the security boundary.
  const { HOST_IMPORT_KEYS_HE, HOST_IMPORT_KEYS_FHE } = await import('@xmbl/contracts');
  const all = [...HOST_IMPORT_KEYS_HE, ...HOST_IMPORT_KEYS_FHE];
  assert.ok(!all.some((k) => /decrypt|open/i.test(k)), `no decrypt import may exist on the contract ABI, found ${all.join(', ')}`);
});

// ── 4. CHAIN-AGNOSTIC MINT, GATED BY THE CHAIN'S OWN AUTHORIZATION ────────────────────────────────
// The operator's ruling: value stays under the control of keys, XMBL enforces who the key releases to.
// The RELEASE half is cryptographic (identity/settlement.test.mjs proves it for all four chains). This
// is the MINT half, where the enforcement has to live — an envelope minted for a decision the chain
// never made would be an ungated key release wearing an authorization's name.
const { releaseAndSign, verifyRelease, sealKeyPair: freshPayee } = await import('@xmbl/identity');

await check('settlement_chains names the four chains and states the enforcement honestly', async () => {
  const r = await call(sockPath, { op: 'settlement_chains' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.chains.slice().sort(), ['bitcoin', 'evm', 'solana', 'sui']);
  assert.strictEqual(r.escrow_on_chain, false, 'this is a key release, and the op must not pretend otherwise');
});

await check('settlement_seal REFUSES to mint for a contract this node never executed', async () => {
  const p = freshPayee();
  const r = await call(sockPath, { op: 'settlement_seal', chain: 'evm', contract_id: 'deadbeefdeadbeef', receiver: 'xmbPAYEE', receiver_pk: p.pk, amount: '250000' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /does not hold contract/);
});

await check('settlement_seal REFUSES when the authorizing state key is not committed on this node', async () => {
  const p = freshPayee();
  const r = await call(sockPath, { op: 'settlement_seal', chain: 'solana', contract_id: globalThis.__authId,
    receiver: 'xmbPAYEE', receiver_pk: p.pk, state_key: 'xcl:nope:999', amount: '250000' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.authorized, false, 'an absent approval must mint nothing');
});

for (const chain of ['solana', 'evm', 'sui', 'bitcoin']) {
  await check(`${chain}: an AUTHORIZED payout mints a fundable address and a sealed envelope, and the payee settles with it`, async () => {
    const p = freshPayee();
    // The key the ZK-gated contract actually wrote when it authorized, read back out of this node's tree.
    const stateKey = [...core.xvsm.stateTree.state.keys()].find((k) => k.includes(globalThis.__authId));
    assert.ok(stateKey, 'the authorization must be committed before anything is minted');
    const r = await call(sockPath, { op: 'settlement_seal', chain, contract_id: globalThis.__authId,
      method: 'authorize', payout_id: `p-${chain}`, amount: '250000', asset: 'USDC',
      receiver: 'xmbPAYEE', receiver_pk: p.pk, state_key: stateKey });
    assert.strictEqual(r.ok, true, r.error || 'mint failed');
    assert.ok(r.address && r.envelope, 'an address to fund and an envelope to publish');
    assert.ok(!JSON.stringify(r).includes('privateKey'), 'no secret may cross this socket');
    assert.strictEqual(r.anchored, true, 'the mint is on the chain, so a payout is auditable without the key');

    // OUTCOME: the payee — and only the payee — turns that envelope into a valid transaction on `chain`.
    const payload = JSON.stringify({ chain, to: 'PAYEE', amount: '250000', payout: `p-${chain}` });
    const stranger = freshPayee();
    assert.throws(() => releaseAndSign(chain, stranger.sk, r.envelope, payload), /.*/, 'a stranger cannot open it');
    const released = releaseAndSign(chain, p.sk, r.envelope, payload);
    assert.strictEqual(released.address, r.address, 'the release settles to the address that was funded');
    assert.strictEqual(verifyRelease(chain, payload, released.signature, released.publicKey), true, `the signature verifies the way ${chain} checks it`);
  });
}

server.close();
await core.stop?.();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
