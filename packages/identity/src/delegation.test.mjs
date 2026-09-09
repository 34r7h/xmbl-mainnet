// delegation conformance — the true-impute chain, EVERY hop enforced.
//
// Two crypto seams are exercised:
//   • an INJECTED deterministic signer for the full rejection matrix (fast, hundreds of checks),
//   • REAL MAYO (through signer.js → Identity) for an end-to-end accept + one forgery reject,
//     so the default path is proven, not just the stub.
//
// The property under test is REJECTION: a green verify with a matching key proves nothing on its
// own; each case below tampers with exactly one hop and asserts the specific reason it fails.
// Run: node delegation.test.mjs
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { Identity } from './identity.js';
import {
  mintGrant, mintZspToken, signAction, verifyChain,
  grantHash, tokenHash, makeAuthorizer, RevocationSet, NonceRegistry, NO_ATTESTATION,
} from './delegation.js';

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ok  ', n); pass++; };
const eq = (n, a, b) => { assert.strictEqual(a, b, `${n}: ${a} !== ${b}`); console.log('  ok  ', n); pass++; };

// ---- A fast, deterministic INJECTED signer with the same address discipline as MAYO ----
// pub is 'K:<seed>', sk is 'S:<seed>'; a signature is sha256(msg|seed). verify recomputes it.
// Identity.deriveAddress works on any base64 pub, so we make the pub a base64 string of the seed.
const b64 = (s) => Buffer.from(s).toString('base64');
function fakeKeypair(seed) {
  const pub = b64('K:' + seed);
  const sk = 'S:' + seed;
  return { pub, sk, address: Identity.deriveAddress(pub) };
}
const fakeSigner = {
  async sign(message, sk) {
    const seed = String(sk).slice(2); // strip 'S:'
    return 'sig:' + createHash('sha256').update(seed + '|' + message).digest('hex');
  },
  async verify(message, sig, pub) {
    const seed = Buffer.from(String(pub), 'base64').toString().slice(2); // strip 'K:'
    return sig === 'sig:' + createHash('sha256').update(seed + '|' + message).digest('hex');
  },
};
// Identity-like wrapper so mint* can read .address/.publicKey/.privateKey
const asId = (kp) => ({ address: kp.address, publicKey: kp.pub, privateKey: kp.sk });

const S = { signer: fakeSigner };

// Build a valid presentation with the injected signer.
async function buildValid(over = {}) {
  const root = asId(fakeKeypair('root'));
  const coord = asId(fakeKeypair('coord'));
  const agent = asId(fakeKeypair('agent'));
  const grant = await mintGrant(root, {
    coordinatorPub: coord.publicKey,
    scope: ['update_task', 'submit_result', 'inc'],
    exp: 4000000000, tee: { quote: 'stub' }, nonce: 'g1',
  }, S);
  const token = await mintZspToken(coord, {
    grant, agentPub: agent.publicKey, aud: over.aud ?? 'contract:xc1_demo',
    scope: over.tokenScope ?? ['update_task', 'inc'], ttlSeconds: 3600, nonce: 't1',
  }, S);
  const action = over.action ?? 'inc';
  const { sig: actionSig, nonce } = await signAction(agent, { token, action, args: over.args ?? [8] }, S);
  return { root, coord, agent, grant, token, nonce,
    pres: { grant, token, action, args: over.args ?? [8], actionSig, nonce } };
}
const policyFor = (root, extra = {}) => ({ rootAddress: root.address, signer: fakeSigner, aud: 'contract:xc1_demo', ...extra });

// ================= (1) the happy path verifies, every hop =================
{
  const { root, pres } = await buildValid();
  const r = await verifyChain(pres, policyFor(root));
  ok('valid chain verifies (root → TEE coordinator → ZSP token → agent action)', r.ok === true);
  eq('reports the token hash', r.tokenHash, tokenHash(pres.token));
}

// ================= (2) Tier-1 grant tampering =================
{
  const { root, pres } = await buildValid();
  const bad = { ...pres, grant: { ...pres.grant, scope: [...pres.grant.scope, 'STEAL'] } };
  eq('grant body tampered → grant-sig fails', (await verifyChain(bad, policyFor(root))).reason, 'grant-sig');
}
{
  const { root, pres } = await buildValid();
  eq('grant from an untrusted root → untrusted-root', (await verifyChain(pres, { ...policyFor(root), rootAddress: 'xmbSOMEONEELSE' })).reason, 'untrusted-root');
}
{
  const { root, pres } = await buildValid();
  eq('grant expired → grant-expired', (await verifyChain(pres, policyFor(root, { now: 4000000001 })).then(r => r.reason)), 'grant-expired');
}
{
  const { root, pres } = await buildValid();
  eq('grant not yet valid → grant-not-yet-valid', (await verifyChain(pres, policyFor(root, { now: 1 })).then(r => r.reason)), 'grant-not-yet-valid');
}

// ================= (3) Tier-2 token: the ZSP attenuation guarantees =================
{
  // token scope NOT a subset of grant scope → refused (a coordinator cannot mint more than it holds)
  const root = asId(fakeKeypair('root'));
  const coord = asId(fakeKeypair('coord'));
  const agent = asId(fakeKeypair('agent'));
  const grant = await mintGrant(root, { coordinatorPub: coord.publicKey, scope: ['inc'], exp: 4000000000, nonce: 'g' }, S);
  const token = await mintZspToken(coord, { grant, agentPub: agent.publicKey, aud: 'contract:xc1_demo', scope: ['inc', 'DRAIN'], ttlSeconds: 3600, nonce: 't' }, S);
  const { sig: actionSig, nonce } = await signAction(agent, { token, action: 'DRAIN', args: [] }, S);
  eq('token scope exceeds grant → scope-exceeds-grant', (await verifyChain({ grant, token, action: 'DRAIN', args: [], actionSig, nonce }, policyFor(root))).reason, 'scope-exceeds-grant');
}
{
  const { root, pres } = await buildValid({ action: 'submit_result', tokenScope: ['update_task', 'inc'] });
  // action not in token scope
  eq('action outside token scope → action-out-of-scope', (await verifyChain(pres, policyFor(root))).reason, 'action-out-of-scope');
}
{
  // A token legitimately minted for a DIFFERENT audience (valid signature) presented to a
  // seam expecting 'contract:xc1_demo' → aud-mismatch. Built with the real mint so the token
  // signature is valid and the audience check is the thing under test (not the sig).
  const root = asId(fakeKeypair('root'));
  const coord = asId(fakeKeypair('coord'));
  const agent = asId(fakeKeypair('agent'));
  const grant = await mintGrant(root, { coordinatorPub: coord.publicKey, scope: ['inc'], exp: 4000000000, nonce: 'g' }, S);
  const token = await mintZspToken(coord, { grant, agentPub: agent.publicKey, aud: 'contract:OTHER', scope: ['inc'], ttlSeconds: 3600, nonce: 't' }, S);
  const { sig: actionSig, nonce } = await signAction(agent, { token, action: 'inc', args: [8] }, S);
  eq('token minted for a different audience → aud-mismatch', (await verifyChain({ grant, token, action: 'inc', args: [8], actionSig, nonce }, policyFor(root))).reason, 'aud-mismatch');
}
{
  // A token whose coordinator_pub does not match the grant's coordinator — a different coordinator
  // trying to spend this grant. Re-sign so the token signature is internally valid.
  const root = asId(fakeKeypair('root'));
  const coord = asId(fakeKeypair('coord'));
  const evil = asId(fakeKeypair('evil'));
  const agent = asId(fakeKeypair('agent'));
  const grant = await mintGrant(root, { coordinatorPub: coord.publicKey, scope: ['inc'], exp: 4000000000, nonce: 'g' }, S);
  const token = await mintZspToken(evil, { grant, agentPub: agent.publicKey, aud: 'contract:xc1_demo', scope: ['inc'], ttlSeconds: 3600, nonce: 't' }, S);
  const { sig: actionSig, nonce } = await signAction(agent, { token, action: 'inc', args: [8] }, S);
  eq('wrong coordinator spends the grant → token-coordinator-mismatch', (await verifyChain({ grant, token, action: 'inc', args: [8], actionSig, nonce }, policyFor(root))).reason, 'token-coordinator-mismatch');
}
{
  const { root, pres } = await buildValid();
  eq('token expired → token-expired', (await verifyChain(pres, policyFor(root, { now: pres.token.exp + 1 })).then(r => r.reason)), 'token-expired');
}

// ================= (4) revocation (burn = membership) =================
{
  const { root, pres } = await buildValid();
  const rev = new RevocationSet();
  ok('live before burn', (await verifyChain(pres, policyFor(root, { isRevoked: (h) => rev.isRevoked(h) }))).ok === true);
  rev.burn(pres.token);
  eq('burned token → revoked', (await verifyChain(pres, policyFor(root, { isRevoked: (h) => rev.isRevoked(h) }))).reason, 'revoked');
  eq('burn recorded by hash', rev.size, 1);
}

// ================= (5) Tier-3 agent action signature =================
{
  const { root, pres } = await buildValid();
  eq('missing action signature → action-unsigned', (await verifyChain({ ...pres, actionSig: undefined }, policyFor(root))).reason, 'action-unsigned');
}
{
  // A stolen token presented WITHOUT the agent's key: attacker signs the action with a different key.
  const { root, pres, token } = await buildValid();
  const thief = asId(fakeKeypair('thief'));
  // Sign over the SAME nonce as the presentation, so the ONLY thing wrong is the signing key.
  const { sig: forged } = await signAction(thief, { token, action: 'inc', args: [8], nonce: pres.nonce }, S);
  eq('token replayed with a non-agent action sig → action-sig', (await verifyChain({ ...pres, actionSig: forged }, policyFor(root))).reason, 'action-sig');
}
{
  // Same token, different args than were signed → action-sig (the sig commits to args)
  const { root, pres } = await buildValid();
  eq('args tampered after signing → action-sig', (await verifyChain({ ...pres, args: [9999] }, policyFor(root))).reason, 'action-sig');
}

// ================= (6) TEE attestation is honest + enforceable =================
{
  const { root, pres } = await buildValid();
  // default NO_ATTESTATION asserts nothing; with requireAttestation the chain is refused
  eq('requireAttestation with no real verifier → tee-unattested', (await verifyChain(pres, policyFor(root, { requireAttestation: true }))).reason, 'tee-unattested');
  // an injected verifier that attests lets it through and surfaces the verifier name
  const av = { name: 'test-sgx', async verify() { return { attested: true, verifier: 'test-sgx' }; } };
  const r = await verifyChain(pres, policyFor(root, { requireAttestation: true, attestationVerifier: av }));
  ok('injected attestation verifier admits + reports verifier', r.ok === true && r.verifier === 'test-sgx');
  ok('NO_ATTESTATION never claims attestation', (await NO_ATTESTATION.verify({})).attested === false);
}

// ================= (7) content ids are stable + structural =================
{
  const { pres } = await buildValid();
  ok('grantHash is grant_-prefixed + stable', grantHash(pres.grant).startsWith('grant_') && grantHash(pres.grant) === grantHash(pres.grant));
  ok('tokenHash is zsp_-prefixed', tokenHash(pres.token).startsWith('zsp_'));
  ok('token references its grant by hash', pres.token.grant_ref === grantHash(pres.grant));
}

// ================= (8) makeAuthorizer wraps a policy for injection =================
{
  const { root, pres } = await buildValid();
  const authz = makeAuthorizer(policyFor(root));
  ok('makeAuthorizer.verify accepts a valid presentation', (await authz.verify(pres)).ok === true);
  ok('makeAuthorizer.verify rejects a tampered one', (await authz.verify({ ...pres, args: [1] })).ok === false);
}

// ================= (9) REAL MAYO end-to-end (default seam) =================
{
  const root = await Identity.create();     // real MAYO keypair
  const coord = await Identity.create();
  const agent = await Identity.create();
  const grant = await mintGrant(root, { coordinatorPub: coord.publicKey, scope: ['inc'], exp: 4000000000, tee: null, nonce: 'g' });
  const token = await mintZspToken(coord, { grant, agentPub: agent.publicKey, aud: 'contract:real', scope: ['inc'], ttlSeconds: 3600, nonce: 't' });
  const { sig: actionSig, nonce } = await signAction(agent, { token, action: 'inc', args: [8] });
  const r = await verifyChain({ grant, token, action: 'inc', args: [8], actionSig, nonce }, { rootAddress: root.address, aud: 'contract:real' });
  ok('REAL MAYO chain verifies end-to-end', r.ok === true);

  // forge the agent action sig with the coordinator's key (same nonce) → action-sig under real MAYO
  const { sig: forged } = await signAction(coord, { token, action: 'inc', args: [8], nonce });
  eq('REAL MAYO rejects a forged agent action sig', (await verifyChain({ grant, token, action: 'inc', args: [8], actionSig: forged, nonce }, { rootAddress: root.address, aud: 'contract:real' })).reason, 'action-sig');

  // untrusted root under real MAYO
  eq('REAL MAYO rejects an untrusted root', (await verifyChain({ grant, token, action: 'inc', args: [8], actionSig, nonce }, { rootAddress: 'xmbNOPE', aud: 'contract:real' })).reason, 'untrusted-root');
}

// ================= (10) single-use action nonce — REPLAY is the double-spend defense =================
{
  // The property: one signed action authorizes exactly ONE state transition. Re-presenting the same
  // actionSig+nonce is rejected as action-replayed — the gate the raw predicate could not provide.
  const { root, pres } = await buildValid();
  const authz = makeAuthorizer(policyFor(root));
  ok('first presentation of an action is accepted', (await authz.verify(pres)).ok === true);
  eq('REPLAY of the same actionSig+nonce → action-replayed', (await authz.verify(pres)).reason, 'action-replayed');

  // a presentation with NO nonce is refused before any state change (fail-closed)
  const { root: r2, pres: p2 } = await buildValid();
  const { nonce, ...noNonce } = p2;
  eq('action with no nonce → action-nonce-missing', (await verifyChain(noNonce, policyFor(r2))).reason, 'action-nonce-missing');

  // a fresh, independently-signed action (new nonce) on the SAME valid chain is still accepted —
  // single-use blocks replay, never a genuine second action.
  const { root: r3, agent, grant, token } = await buildValid();
  const authz3 = makeAuthorizer(policyFor(r3));
  const { sig: sigA, nonce: nA } = await signAction(agent, { token, action: 'inc', args: [8] }, S);
  const { sig: sigB, nonce: nB } = await signAction(agent, { token, action: 'inc', args: [8] }, S);
  ok('first fresh action accepted', (await authz3.verify({ grant, token, action: 'inc', args: [8], actionSig: sigA, nonce: nA })).ok === true);
  ok('second, independently-signed action (new nonce) also accepted', (await authz3.verify({ grant, token, action: 'inc', args: [8], actionSig: sigB, nonce: nB })).ok === true);

  // NonceRegistry burns exactly once
  const reg = new NonceRegistry();
  ok('NonceRegistry consume: first true', reg.consume('zsp_x', 'aa') === true);
  ok('NonceRegistry consume: replay false', reg.consume('zsp_x', 'aa') === false);
  ok('NonceRegistry size counts burns', reg.size === 1);

  // THE PRODUCTION REQUIREMENT: single-use holds only when ONE registry is SHARED across the seam.
  // Two authorizers over the SAME injected registry must reject a replay that crosses between them —
  // a per-request registry (the default) would NOT, which is why a deployment injects one shared store.
  const { root: r4, pres: p4 } = await buildValid();
  const shared = new NonceRegistry();
  const authA = makeAuthorizer({ ...policyFor(r4), nonces: shared });
  const authB = makeAuthorizer({ ...policyFor(r4), nonces: shared });
  ok('shared registry: first authorizer accepts', (await authA.verify(p4)).ok === true);
  eq('shared registry: SECOND authorizer rejects the replay (cross-instance single-use)', (await authB.verify(p4)).reason, 'action-replayed');
  // control: two SEPARATE default registries do NOT catch the cross-instance replay — proving the
  // guarantee is the SHARED store, not makeAuthorizer alone (the exact per-request-registry hazard).
  const { root: r5, pres: p5 } = await buildValid();
  const authC = makeAuthorizer(policyFor(r5));
  const authD = makeAuthorizer(policyFor(r5));
  ok('separate registries: first accepts', (await authC.verify(p5)).ok === true);
  ok('separate registries: second ALSO accepts (why a shared store is required, not optional)', (await authD.verify(p5)).ok === true);

  // eviction is bounded: an expired token's nonce is swept, so the ledger cannot grow without limit.
  const reg2 = new NonceRegistry();
  reg2.consume('zsp_old', 'n1', 1);           // exp in 1970 → dead
  reg2.consume('zsp_live', 'n2', 4000000000); // exp far future → kept
  for (let i = 0; i < 1100; i++) reg2.consume('zsp_live', 'k' + i, 4000000000); // cross the sweep threshold
  ok('NonceRegistry evicts expired entries (bounded growth)', reg2.has('zsp_live', 'n2') && !reg2.has('zsp_old', 'n1'));
}

console.log(`\nPASS — ${pass} checks\n`);
