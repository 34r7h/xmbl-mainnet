// REPRODUCTION — host and USE an XMBL agentic contract end-to-end: every function driven through
// the real root→coordinator→agent delegation chain, with XMBL state observed updating at EVERY
// surface (contract fields, the Verkle root, the UTXO ledger) and every unauthorized or value-
// violating call leaving the root UNMOVED.
//
// CLAIM (the operator's directive): "host and use an xmbl agentic contract with every function and
// you can see the xmbl state updated wherever it should be as it should be." This reproduction does
// that with the REAL compiler, runtime, host, Verkle state machine, and MAYO identity chain — no
// mocks, no stubs.
//
// It proves four load-bearing properties the operator named, using only the shipped @xmbl/* API:
//   1. GATING       — a gated contract runs ONLY under a valid root→coordinator→agent chain; an
//                     unauthorized / out-of-scope / replayed / revoked call is refused BEFORE the
//                     WASM runs, so the Verkle root does not move.
//   2. EVERY FUNCTION— the set of entrypoints exercised is checked against the set the COMPILER
//                     emitted (WebAssembly.Module.exports), so "every function" is machine-verified,
//                     not a hand-kept list that can silently drift.
//   3. PROVABILITY  — each committed state change is verified with a Verkle membership proof against
//                     the committed root (contract field AND UTXO spend marker); a tampered value is
//                     rejected. "Provable" means the proof checks, not that a number was printed.
//   4. CONSERVATION — a gated UTXO contract spends an input and creates a conserved output committed
//                     to the same Verkle tree; value cannot be minted even by a fully-authorized
//                     agent, and a double-spend is refused — both leave the root unmoved.
//   +  DETERMINISM  — two independent hosts fed the same authorized call converge to one root, and
//                     the committed set reproduces the same root under any insertion order.
//
// Exits non-zero if any claim fails, so it is also a gate test (reproductions/reproductions.test.mjs).
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compile, contractFields } from '@xmbl/lng';
import { ComputeRuntime } from '@xmbl/storage-compute';
import { ContractHost, byteKey, utxoKey, spendKey } from '@xmbl/contracts';
import { VerkleStateTree } from '@xmbl/state-machine';
import {
  Identity, mintGrant, mintZspToken, signAction, makeAuthorizer, RevocationSet,
} from '@xmbl/identity';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(HERE, '..', 'packages', 'contracts', 'src', 'xcl', 'utxo-fixtures.mjs');
const { TRANSFER, MINT, RECIP } = await import(FIXTURES_PATH);

const runtime = () => new ComputeRuntime({ maxTime: 8000 });
const fieldKey = (id, name) => byteKey(id, Buffer.from(name, 'utf8').toString('hex'));

// A multi-function agentic vault. Four entrypoints, one of which (`accrue`) reads its OWN field
// (`bal = bal + v`) so the reproduction also exercises a read-modify-write, not only assignments.
const VAULT_SRC =
  "~contract `V {\n" +
  "  ~state { ~public { `bal ~u256 0\n `owner ~u256 0 } }\n" +
  "  ~on `deposit(`v ~u256) { `bal = `v }\n" +
  "  ~on `accrue(`v ~u256) { `bal = `bal + `v }\n" +
  "  ~on `setOwner(`o ~u256) { `owner = `o }\n" +
  "  ~on `withdraw(`amt ~u256) { `bal = 0 }\n" +
  "}";

async function main() {
  console.log('=== REPRODUCTION: host & use an XMBL agentic contract end-to-end ===\n');

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // PART 1 — a GATED multi-function contract: every entrypoint driven through the delegation chain.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  console.log('── PART 1 — gated vault: every function through root→coordinator→agent ──\n');

  const vaultBytes = compile(VAULT_SRC, { hostState: true });
  const fields = contractFields(VAULT_SRC);

  // MACHINE-DERIVED entrypoint set: what the COMPILER actually exported (not a hand-kept list).
  // Housekeeping exports (memory, __alloc, __reset, __field, __events) are filtered out.
  const entrypoints = WebAssembly.Module.exports(new WebAssembly.Module(vaultBytes))
    .filter((e) => e.kind === 'function' && !e.name.startsWith('__'))
    .map((e) => e.name);
  console.log(`  contract fields (compiler-derived) : ${JSON.stringify(fields)}`);
  console.log(`  entrypoints (from WASM exports)     : ${JSON.stringify(entrypoints)}`);

  // The real, committed Verkle state tree — the same one a node runs. Contract field writes land
  // here under byte keys, so getRoot() and generateProof() observe exactly what consensus would.
  const state = new VerkleStateTree();
  const host = new ContractHost({ runtime: runtime(), state });
  const { id: vaultId } = host.deploy(vaultBytes, [], {
    byteState: true, wordAbi: true, gated: true, fields,
  });
  console.log(`  deployed gated vault                : ${vaultId}\n`);

  // The delegation chain: a USER root delegates to a TEE COORDINATOR, which mints a short-TTL,
  // zero-standing-privilege token for an AGENT scoped to EVERY entrypoint. Real MAYO identities.
  const rootId = await Identity.create();
  const coord = await Identity.create();
  const agent = await Identity.create();
  const aud = `contract:${vaultId}`;
  const grant = await mintGrant(rootId, { coordinatorPub: coord.publicKey, scope: entrypoints, exp: 4000000000, tee: null });
  const token = await mintZspToken(coord, { grant, agentPub: agent.publicKey, aud, scope: entrypoints, ttlSeconds: 3600 });

  const rev = new RevocationSet();
  host.authorizer = makeAuthorizer({ rootAddress: rootId.address, aud, isRevoked: (h) => rev.isRevoked(h) });

  // Drive EVERY entrypoint through the chain. Each call: a fresh agent signature + single-use nonce,
  // then assert the contract field updated as expected AND the Verkle root moved.
  // Args are plain Numbers: the agent signature canonicalizes args (JSON), and ContractHost uses
  // the SAME args array for both the signature check and the word-ABI marshal — so they must be
  // JSON-serializable and identical. Safe integers satisfy both; getBytes returns the word as BigInt.
  const calls = {
    deposit:  { args: [100], expect: { bal: 100n, owner: 0n } },
    accrue:   { args: [50],  expect: { bal: 150n, owner: 0n } }, // read-modify-write: 100 + 50
    setOwner: { args: [7],   expect: { bal: 150n, owner: 7n } },
    withdraw: { args: [0],   expect: { bal: 0n,   owner: 7n } },
  };
  const exercised = new Set();
  let lastPresentation = null;
  for (const fn of entrypoints) {
    const spec = calls[fn];
    assert.ok(spec, `test must specify a call for every entrypoint — missing ${fn}`);
    const rootBefore = state.getRoot();
    const { sig: actionSig, nonce } = await signAction(agent, { token, action: fn, args: spec.args });
    const presentation = { grant, token, actionSig, nonce };
    await host.call(vaultId, fn, spec.args, { auth: presentation });
    exercised.add(fn);
    lastPresentation = { fn, args: spec.args, presentation };

    const bal = host.getBytes(vaultId, 'bal');
    const owner = host.getBytes(vaultId, 'owner');
    const rootAfter = state.getRoot();
    assert.strictEqual(bal, spec.expect.bal, `${fn}: bal`);
    assert.strictEqual(owner, spec.expect.owner, `${fn}: owner`);
    assert.notStrictEqual(rootAfter, rootBefore, `${fn}: the authorized call moved the Verkle root`);
    console.log(`  ✔ ${fn.padEnd(9)} authorized → bal=${bal} owner=${owner}  root ${rootBefore.slice(0, 10)}… → ${rootAfter.slice(0, 10)}…`);
  }

  // "Every function" — MACHINE-CHECKED: the exercised set equals the compiler's export set.
  assert.deepStrictEqual([...exercised].sort(), [...entrypoints].sort(),
    'every compiled entrypoint must have been exercised');
  console.log(`\n  ✔ ${exercised.size} of ${entrypoints.length} entrypoints exercised (machine-checked against WASM exports)\n`);

  // FAIL-CLOSED refusals — each must leave the Verkle root UNMOVED.
  const rootLocked = state.getRoot();
  const refuse = async (label, fn, opts, rx) => {
    await assert.rejects(() => host.call(vaultId, fn, (opts.args || []), opts), rx, label);
    assert.strictEqual(state.getRoot(), rootLocked, `${label}: root must not move on a refused call`);
    console.log(`  ✔ refused: ${label}`);
  };
  // (a) no authorization presented at all
  await refuse('no authorization → unauthorized', 'deposit', { args: [1] }, /no-authorization-presented/);
  // (b) an action outside the token's scope (token scoped to deposit only, attempt withdraw)
  const narrowToken = await mintZspToken(coord, { grant, agentPub: agent.publicKey, aud, scope: ['deposit'], ttlSeconds: 3600 });
  const { sig: oosSig, nonce: oosNonce } = await signAction(agent, { token: narrowToken, action: 'withdraw', args: [0] });
  await refuse('out-of-scope action → rejected', 'withdraw',
    { args: [0], auth: { grant, token: narrowToken, actionSig: oosSig, nonce: oosNonce } }, /action-out-of-scope/);
  // (c) replay of an already-consumed presentation (single-use nonce)
  await refuse('replayed action → rejected', lastPresentation.fn,
    { args: lastPresentation.args, auth: lastPresentation.presentation }, /action-replayed/);
  // (d) a revoked token (live revocation)
  rev.burn(token);
  const { sig: revSig, nonce: revNonce } = await signAction(agent, { token, action: 'deposit', args: [1] });
  await refuse('revoked token → rejected', 'deposit',
    { args: [1], auth: { grant, token, actionSig: revSig, nonce: revNonce } }, /revoked/);

  // PROVABILITY — the committed field value is verifiable against the committed Verkle root.
  const ownerKey = fieldKey(vaultId, 'owner');
  const ownerVal = state.get(ownerKey);
  const ownerProof = state.generateProof(ownerKey);
  assert.strictEqual(ownerProof.root, state.getRoot(), 'proof is against the committed root');
  assert.strictEqual(VerkleStateTree.verifyProof(ownerKey, ownerVal, ownerProof), true,
    'the committed `owner` field is provable against the root');
  assert.strictEqual(VerkleStateTree.verifyProof(ownerKey, '11'.repeat(32), ownerProof), false,
    'a tampered `owner` value fails the proof');
  console.log(`\n  ✔ field \`owner\` is Verkle-provable against root ${state.getRoot().slice(0, 14)}… (tampered value rejected)\n`);

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // PART 2 — a GATED UTXO contract: agent-authorized spend, committed to the SAME Verkle tree.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  console.log('── PART 2 — gated UTXO transfer: spend, conservation, provability ──\n');

  // AUTHORIZATION BOUNDARY (audit-relevant, stated explicitly): the delegation chain authorizes the
  // CALL — the entrypoint name and its signed args. The UTXO INPUT SET is presented by the caller in
  // opts.inputs and is NOT covered by the agent's signature; it is constrained instead by value
  // CONSERVATION and the double-spend nullifier, enforced fail-closed. So an authorized agent cannot
  // mint value or double-spend even though it chose the inputs — the two guarantees are independent.
  console.log('  boundary: the chain authorizes the CALL (action+args); the input set is bound by');
  console.log('            conservation + the double-spend nullifier, not by the agent signature.\n');

  const utxoState = new VerkleStateTree();
  await utxoState.insert(utxoKey('U1'), { from: 'genesis', to: 'alice', amount: '100' });
  const utxoHost = new ContractHost({ runtime: runtime(), state: utxoState });
  const { id: transferId } = utxoHost.deploy(TRANSFER, [], { utxoHost: true, gated: true });

  const uRoot = await Identity.create();
  const uCoord = await Identity.create();
  const uAgent = await Identity.create();
  const uAud = `contract:${transferId}`;
  const uGrant = await mintGrant(uRoot, { coordinatorPub: uCoord.publicKey, scope: ['transfer'], exp: 4000000000, tee: null });
  const uToken = await mintZspToken(uCoord, { grant: uGrant, agentPub: uAgent.publicKey, aud: uAud, scope: ['transfer'], ttlSeconds: 3600 });
  utxoHost.authorizer = makeAuthorizer({ rootAddress: uRoot.address, aud: uAud });

  const uRoot0 = utxoState.getRoot();
  const { sig: tSig, nonce: tNonce } = await signAction(uAgent, { token: uToken, action: 'transfer', args: [] });
  const tr = await utxoHost.call(transferId, 'transfer', [], { auth: { grant: uGrant, token: uToken, actionSig: tSig, nonce: tNonce }, inputs: ['U1'] });

  assert.deepStrictEqual(tr.utxo.spent, ['U1'], 'the presented input was spent');
  assert.strictEqual(tr.utxo.created.length, 1, 'one output created');
  assert.strictEqual(tr.utxo.created[0].amount, '100', 'output equals input — value conserved');
  assert.strictEqual(tr.utxo.created[0].to, RECIP, 'output goes to the contract-chosen recipient');
  assert.notStrictEqual(utxoState.get(spendKey('U1')), undefined, 'a spend-marker (nullifier) was committed');
  const createdRec = utxoState.get(utxoKey(tr.utxo.created[0].id));
  assert.strictEqual(createdRec.amount, '100', 'the new UTXO record is committed to Verkle');
  assert.notStrictEqual(utxoState.getRoot(), uRoot0, 'the authorized transfer moved the Verkle root');
  console.log(`  ✔ agent-authorized transfer: spent U1(100) → created ${tr.utxo.created[0].id} (100) to ${RECIP}`);
  console.log(`    root ${uRoot0.slice(0, 10)}… → ${utxoState.getRoot().slice(0, 10)}…`);

  // PROVABILITY — the spend is verifiable against the committed root; a tampered value is rejected.
  const sk = spendKey('U1');
  const skVal = utxoState.get(sk);
  const skProof = utxoState.generateProof(sk);
  assert.strictEqual(skProof.root, utxoState.getRoot(), 'proof is against the committed root');
  assert.strictEqual(VerkleStateTree.verifyProof(sk, skVal, skProof), true, 'the spend is provable');
  assert.strictEqual(VerkleStateTree.verifyProof(sk, { by: 'someone-else' }, skProof), false, 'tampered spend rejected');
  console.log('  ✔ the U1 spend marker is Verkle-provable against the committed root (tampered value rejected)');

  // CONSERVATION — a fully-authorized agent still cannot mint value, and cannot double-spend.
  const mintState = new VerkleStateTree();
  const mintHost = new ContractHost({ runtime: runtime(), state: mintState });
  const { id: mintId } = mintHost.deploy(MINT, [], { utxoHost: true, gated: true });
  const mAud = `contract:${mintId}`;
  const mGrant = await mintGrant(uRoot, { coordinatorPub: uCoord.publicKey, scope: ['mint'], exp: 4000000000, tee: null });
  const mToken = await mintZspToken(uCoord, { grant: mGrant, agentPub: uAgent.publicKey, aud: mAud, scope: ['mint'], ttlSeconds: 3600 });
  mintHost.authorizer = makeAuthorizer({ rootAddress: uRoot.address, aud: mAud });
  const mRoot0 = mintState.getRoot();
  const { sig: mSig, nonce: mNonce } = await signAction(uAgent, { token: mToken, action: 'mint', args: [] });
  await assert.rejects(
    () => mintHost.call(mintId, 'mint', [], { auth: { grant: mGrant, token: mToken, actionSig: mSig, nonce: mNonce }, inputs: [] }),
    /value not conserved|mint refused/,
    'an authorized agent still cannot mint value',
  );
  assert.strictEqual(mintState.getRoot(), mRoot0, 'the refused mint moved nothing');
  console.log('  ✔ refused: authorized agent mint (out > in) → value not conserved, root unmoved');

  // double-spend: a SECOND authorized transfer of the already-spent U1 is refused by the nullifier.
  const dRoot0 = utxoState.getRoot();
  const { sig: dSig, nonce: dNonce } = await signAction(uAgent, { token: uToken, action: 'transfer', args: [] });
  await assert.rejects(
    () => utxoHost.call(transferId, 'transfer', [], { auth: { grant: uGrant, token: uToken, actionSig: dSig, nonce: dNonce }, inputs: ['U1'] }),
    /already spent|double-spend/,
    'an authorized re-spend of U1 is refused',
  );
  assert.strictEqual(utxoState.getRoot(), dRoot0, 'the refused double-spend moved nothing');
  console.log('  ✔ refused: authorized re-spend of U1 → double-spend refused, root unmoved\n');

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // DETERMINISM — the state transition is a pure function of the call, reproducible across nodes.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  console.log('── DETERMINISM — same call → same root on independent nodes; root is set-, not order-, dependent ──\n');
  const oneNode = async () => {
    const s = new VerkleStateTree();
    await s.insert(utxoKey('U1'), { from: 'genesis', to: 'alice', amount: '100' });
    const h = new ContractHost({ runtime: runtime(), state: s });
    const { id } = h.deploy(TRANSFER, [], { utxoHost: true, gated: true });
    const r = await Identity.create(); const c = await Identity.create(); const a = await Identity.create();
    const au = `contract:${id}`;
    const g = await mintGrant(r, { coordinatorPub: c.publicKey, scope: ['transfer'], exp: 4000000000, tee: null });
    const t = await mintZspToken(c, { grant: g, agentPub: a.publicKey, aud: au, scope: ['transfer'], ttlSeconds: 3600 });
    h.authorizer = makeAuthorizer({ rootAddress: r.address, aud: au });
    const { sig, nonce } = await signAction(a, { token: t, action: 'transfer', args: [] });
    await h.call(id, 'transfer', [], { auth: { grant: g, token: t, actionSig: sig, nonce }, inputs: ['U1'] });
    return s;
  };
  const sA = await oneNode();
  const sB = await oneNode();
  assert.strictEqual(sA.getRoot(), sB.getRoot(), 'two independent nodes → identical root (different identities, same transition)');
  console.log(`  ✔ two independent nodes converge to one root: ${sA.getRoot().slice(0, 18)}…`);

  const entries = [...sA.state.entries()];
  const replay = new VerkleStateTree();
  for (const [k, v] of [...entries].reverse()) await replay.insert(k, v);
  assert.strictEqual(replay.getRoot(), sA.getRoot(), 'the committed set reproduces the same root under reversed insertion order');
  console.log('  ✔ the committed set reproduces the same root under any insertion order\n');

  // ── content address: SHA-256 over this file + the vault source + the UTXO fixture bytecode ──
  const srcHash = createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .update(VAULT_SRC)
    .update(readFileSync(FIXTURES_PATH))
    .digest('hex');
  console.log(`  content address (sha256 of this file + vault source + fixture bytecode): ${srcHash}`);
  console.log('\n✅ PASS — an XMBL agentic contract was hosted and used with every function, and XMBL');
  console.log('   state was observed updating at every surface (fields, Verkle root, UTXO ledger),');
  console.log('   with every unauthorized or value-violating call leaving the root unmoved.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('\n❌ FAIL —', e.message, '\n', e.stack); process.exit(1); });
