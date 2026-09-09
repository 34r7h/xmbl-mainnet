// delegation — XMBL's native "true impute" authorization protocol.
//
// This is the identity model handoff proved out (impute SPEC §1: a bifurcated, tiered
// delegation chain) lifted onto XMBL and made enforceable with MAYO signatures instead of
// ENS/ERC-8004 registrations. The chain the operator described:
//
//   Tier 0/1  a USER holds a root MAYO identity (@xmbl/identity `Identity`).
//   Tier 1    the user DELEGATES a scope to a COORDINATOR that runs inside a TEE. The grant
//             is a root-signed record that names the coordinator's key and carries the
//             coordinator's attestation quote (verified by an INJECTED verifier — never
//             self-asserted here).
//   Tier 2    the coordinator, inside the TEE, mints a Zero-Standing-Privilege (ZSP) token
//             for an AGENT: scoped, short-TTL, coordinator-signed, and ATTENUATED (its scope
//             can only be a subset of the grant's). "Zero standing privilege" = the agent
//             holds no ambient authority; every action rides a token that expires and can be
//             burned (membership-is-liveness revocation, adopted from handoff's zsp store).
//   Tier 3    the agent SIGNS the concrete action with its own key; verification checks that
//             signature under the token's subject key, so a stolen token without the agent's
//             key cannot act.
//
// `verifyChain` checks EVERY hop, including that each presented public key derives to the
// address the previous hop named (the same `derivedAddress === from` discipline
// identity/signer already enforces for transactions) — a grant that names a coordinator by
// address is NOT satisfiable by an unrelated key. This module is what a load-bearing seam
// (ContractHost.call, a validation task) calls to REJECT an unauthorized action; a green
// verify with no such caller is not enforcement.
//
// Crypto is delegated to the ONE signer seam (signer.js → MAYO). For test matrices that need
// hundreds of chains, an alternate `signer` may be injected via opts; the default is MAYO.

import { createHash, randomBytes } from 'node:crypto';
import { sign as mayoSign, verify as mayoVerify } from './signer.js';
import { Identity } from './identity.js';

// ---- canonical serialization (stable key order, so a signature is over exact bytes) ----
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
function sha256hex(s) { return createHash('sha256').update(s).digest('hex'); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function newNonce() { return randomBytes(12).toString('hex'); }

/** Default crypto seam: MAYO through signer.js. Both are async. */
const MAYO_SIGNER = { sign: mayoSign, verify: mayoVerify };

// ---- Tier-1 TEE attestation: HONEST by default ----
// A verifier takes a grant's `tee` envelope and returns { attested, verifier, claims? }. The
// default asserts NOTHING — mirroring CubicCurveSource.describe() reporting secure:false until
// an audit. A real SGX/SEV/TDX quote verifier is injected by the deployment; nothing in this
// package pretends a quote was checked.
export const NO_ATTESTATION = {
  name: 'none',
  async verify() { return { attested: false, verifier: 'none' }; },
};

// ---- grant (Tier 1: root → coordinator) ----
function grantBody(g) {
  return {
    v: g.v, root_address: g.root_address, root_pub: g.root_pub,
    coordinator_address: g.coordinator_address, coordinator_pub: g.coordinator_pub,
    tee: g.tee ?? null, scope: g.scope, nbf: g.nbf, exp: g.exp, nonce: g.nonce,
  };
}
/** Stable content id of a grant (what a token references to bind itself to this grant). */
export function grantHash(g) { return 'grant_' + sha256hex(canonical(grantBody(g))); }

/**
 * Root delegates a scope to a coordinator. Signs with the root's MAYO key.
 * @param {Identity} root the user's root identity
 * @param {object} p
 * @param {string} p.coordinatorPub coordinator's public key (base64, same form as Identity.publicKey)
 * @param {string[]} p.scope actions the coordinator may sub-delegate
 * @param {number} p.exp expiry (unix seconds)
 * @param {object|null} [p.tee] the coordinator's TEE attestation envelope (verified at check time)
 * @param {number} [p.nbf] not-before (defaults now)
 * @param {string} [p.nonce]
 * @param {{signer?:object, scheme?:string}} [opts]
 */
export async function mintGrant(root, p, opts = {}) {
  const signer = opts.signer || MAYO_SIGNER;
  const body = {
    v: 1,
    root_address: root.address,
    root_pub: root.publicKey,
    coordinator_address: Identity.deriveAddress(p.coordinatorPub),
    coordinator_pub: p.coordinatorPub,
    tee: p.tee ?? null,
    scope: [...p.scope],
    nbf: p.nbf ?? nowSec(),
    exp: p.exp,
    nonce: p.nonce ?? newNonce(),
  };
  const sig = await signer.sign(canonical(body), root.privateKey, opts.scheme);
  return { ...body, sig };
}

// ---- ZSP token (Tier 2: coordinator → agent) ----
function tokenBody(t) {
  return {
    v: t.v, grant_ref: t.grant_ref, coordinator_pub: t.coordinator_pub,
    agent_address: t.agent_address, agent_pub: t.agent_pub,
    aud: t.aud, scope: t.scope, nbf: t.nbf, exp: t.exp, nonce: t.nonce,
  };
}
/** Stable content id of a token — its identity for revocation (burn = add to the revoked set). */
export function tokenHash(t) { return 'zsp_' + sha256hex(canonical(tokenBody(t))); }

/**
 * Coordinator mints a Zero-Standing-Privilege token for an agent, under a grant it holds.
 * Scope is ATTENUATED: `verifyChain` rejects any token scope not ⊆ the grant's scope, so a
 * coordinator can never hand out more than it was given.
 * @param {Identity} coordinator the coordinator identity (its pub must equal grant.coordinator_pub)
 * @param {object} p
 * @param {object} p.grant the grant authorizing this coordinator
 * @param {string} p.agentPub the agent's public key
 * @param {string} p.aud audience binding (e.g. a task/contract id) — the token is valid only for it
 * @param {string[]} p.scope actions the agent may perform (⊆ grant.scope)
 * @param {number} p.ttlSeconds short lifetime — ZSP means this is small
 * @param {number} [p.nbf]
 * @param {string} [p.nonce]
 * @param {{signer?:object, scheme?:string}} [opts]
 */
export async function mintZspToken(coordinator, p, opts = {}) {
  const signer = opts.signer || MAYO_SIGNER;
  const nbf = p.nbf ?? nowSec();
  const body = {
    v: 1,
    grant_ref: grantHash(p.grant),
    coordinator_pub: coordinator.publicKey,
    agent_address: Identity.deriveAddress(p.agentPub),
    agent_pub: p.agentPub,
    aud: p.aud,
    scope: [...p.scope],
    nbf,
    exp: nbf + (p.ttlSeconds | 0),
    nonce: p.nonce ?? newNonce(),
  };
  const sig = await signer.sign(canonical(body), coordinator.privateKey, opts.scheme);
  return { ...body, sig };
}

// ---- Tier 3: the agent signs the concrete action ----
// The action message BINDS a single-use `nonce`, so one signed authorization can never be
// replayed: the signature covers the nonce, and the enforcement seam (makeAuthorizer/ContractHost)
// CONSUMES (tokenHash, nonce) exactly once. Without the nonce a captured actionSig would re-authorize
// the same state transition indefinitely — a double-spend in the gate.
function actionMessage(token, action, args, nonce) {
  return canonical({ token_ref: tokenHash(token), action, args: args ?? [], nonce });
}
/**
 * The agent authorizes ONE concrete action under its token by signing it with the agent key.
 * Verified under the token's subject key, so possession of the token alone is not enough. Each
 * authorization carries a fresh single-use `nonce` (auto-generated when omitted); the returned
 * nonce MUST travel with the signature in the presentation, and the gate burns it after one use.
 * @returns {Promise<{sig:string, nonce:string}>}
 */
export async function signAction(agent, { token, action, args, nonce }, opts = {}) {
  const signer = opts.signer || MAYO_SIGNER;
  const n = nonce || newNonce();
  const sig = await signer.sign(actionMessage(token, action, args, n), agent.privateKey, opts.scheme);
  return { sig, nonce: n };
}

// ---- the enforcement primitive ----
const subset = (a, b) => a.every((x) => b.includes(x));

/**
 * Verify a full presentation against a policy. Returns { ok, reason?, tier?, attested?, verifier? }.
 * EVERY hop is checked; the first failure short-circuits with the reason a caller rejects on.
 *
 * @param {object} pres { grant, token, action, args?, actionSig }
 * @param {object} policy
 * @param {string} policy.rootAddress the root identity this seam trusts (the delegation's apex)
 * @param {number} [policy.now] unix seconds (defaults now) — pass to test expiry deterministically
 * @param {string} [policy.aud] required audience; when set, token.aud must equal it
 * @param {object} [policy.attestationVerifier] TEE verifier (defaults NO_ATTESTATION)
 * @param {boolean} [policy.requireAttestation] reject if the coordinator's TEE is not attested
 * @param {(tokenHash:string)=>boolean} [policy.isRevoked] burn check (membership-is-liveness)
 * @param {object} [policy.signer] crypto seam (defaults MAYO)
 */
export async function verifyChain(pres, policy) {
  const signer = policy.signer || MAYO_SIGNER;
  const now = policy.now ?? nowSec();
  const fail = (reason, tier) => ({ ok: false, reason, tier });
  const { grant, token, action, args, actionSig } = pres || {};
  if (!grant || !token) return fail('malformed-presentation', 0);

  // Tier 1 — the grant (root → coordinator)
  if (!(await signer.verify(canonical(grantBody(grant)), grant.sig, grant.root_pub)))
    return fail('grant-sig', 1);
  if (Identity.deriveAddress(grant.root_pub) !== grant.root_address)
    return fail('grant-root-address', 1);
  if (grant.root_address !== policy.rootAddress)
    return fail('untrusted-root', 1);
  if (now < grant.nbf) return fail('grant-not-yet-valid', 1);
  if (now > grant.exp) return fail('grant-expired', 1);

  // Tier 2 — the ZSP token (coordinator → agent)
  if (!(await signer.verify(canonical(tokenBody(token)), token.sig, token.coordinator_pub)))
    return fail('token-sig', 2);
  if (token.coordinator_pub !== grant.coordinator_pub)
    return fail('token-coordinator-mismatch', 2);
  if (Identity.deriveAddress(token.coordinator_pub) !== grant.coordinator_address)
    return fail('token-coordinator-address', 2);
  if (token.grant_ref !== grantHash(grant))
    return fail('token-grant-ref', 2);
  if (now < token.nbf) return fail('token-not-yet-valid', 2);
  if (now > token.exp) return fail('token-expired', 2);
  if (!subset(token.scope, grant.scope)) return fail('scope-exceeds-grant', 2);
  if (!token.scope.includes(action)) return fail('action-out-of-scope', 2);
  if (policy.aud !== undefined && token.aud !== policy.aud) return fail('aud-mismatch', 2);
  if (Identity.deriveAddress(token.agent_pub) !== token.agent_address)
    return fail('token-agent-address', 2);
  if (policy.isRevoked && policy.isRevoked(tokenHash(token))) return fail('revoked', 2);

  // Tier 1 — TEE attestation of the coordinator (honest: NO_ATTESTATION asserts nothing)
  const av = policy.attestationVerifier || NO_ATTESTATION;
  const att = await av.verify(grant.tee);
  if (policy.requireAttestation && !att.attested) return fail('tee-unattested', 1);

  // Tier 3 — the agent's action signature under the token's subject key, bound to a single-use nonce
  if (!actionSig) return fail('action-unsigned', 3);
  const nonce = pres.nonce;
  if (!nonce || typeof nonce !== 'string') return fail('action-nonce-missing', 3);
  if (!(await signer.verify(actionMessage(token, action, args, nonce), actionSig, token.agent_pub)))
    return fail('action-sig', 3);

  return { ok: true, attested: att.attested, verifier: att.verifier, tokenHash: tokenHash(token), nonce };
}

/**
 * A revocation set with handoff's semantics: MEMBERSHIP IS LIVENESS reversed — a token is live
 * until burned, and burn = add its hash here. Cheap, in-memory; a deployment backs it with a
 * durable store and passes `has` as policy.isRevoked.
 */
export class RevocationSet {
  constructor() { this._burned = new Set(); }
  burn(token) { this._burned.add(typeof token === 'string' ? token : tokenHash(token)); }
  isRevoked(h) { return this._burned.has(h); }
  get size() { return this._burned.size; }
}

/**
 * A single-use action-nonce ledger: each (tokenHash, nonce) pair may authorize exactly ONE action.
 * `consume` returns true the first time and false forever after — this is what turns a valid
 * signature into a single-use authorization and defeats replay.
 *
 * Growth is BOUNDED by expiry: `consume` takes the token's `exp` and the ledger evicts entries whose
 * token has expired — a nonce for an expired token can never be re-presented successfully anyway
 * (`verifyChain` rejects an expired token BEFORE consume), so dropping it is safe and keeps the set
 * from growing without limit. This is in-memory, so single-use does NOT survive a process restart; a
 * mainnet deployment MUST inject a DURABLE store (same `consume` contract) and share ONE instance
 * across the seam, so a replay cannot slip through a restart within a token's TTL.
 */
export class NonceRegistry {
  constructor() { this._used = new Map(); this._sweepAt = 0; }
  static key(tokenHash, nonce) { return `${tokenHash}:${nonce}`; }
  /** Atomically claim the pair. true = first use (now burned); false = already spent.
   *  @param {number} [exp] the token's expiry (unix seconds); used only for eviction. */
  consume(tokenHash, nonce, exp) {
    const k = NonceRegistry.key(tokenHash, nonce);
    if (this._used.has(k)) return false;
    this._used.set(k, exp || 0);
    this._maybeSweep();
    return true;
  }
  _maybeSweep() {
    // Amortized eviction: sweep once per 1024 inserts. Entries with a known exp in the past are dead.
    if (this._used.size < this._sweepAt) return;
    const now = nowSec();
    for (const [k, exp] of this._used) if (exp && exp < now) this._used.delete(k);
    this._sweepAt = this._used.size + 1024;
  }
  has(tokenHash, nonce) { return this._used.has(NonceRegistry.key(tokenHash, nonce)); }
  get size() { return this._used.size; }
}

/**
 * Bind a policy into an authorizer object shaped for injection into a load-bearing seam
 * (e.g. ContractHost). `verify(presentation)` resolves { ok, reason }.
 *
 * SINGLE-USE BY DEFAULT: the authorizer verifies the chain and then CONSUMES the action's
 * (tokenHash, nonce) exactly once, so re-presenting the same actionSig is rejected with
 * `action-replayed` — the double-spend the raw predicate could not stop. A deployment may pass its
 * own durable `policy.nonces` (a NonceRegistry-shaped store) to make single-use survive restarts;
 * omitting it uses a fresh in-memory ledger. The consume happens synchronously after verify with no
 * await between the check and the burn, so two concurrent calls with one nonce cannot both pass.
 */
export function makeAuthorizer(policy) {
  const nonces = policy.nonces || new NonceRegistry();
  return {
    nonces,
    async verify(pres) {
      const res = await verifyChain(pres, policy);
      if (!res.ok) return res;
      // Bind eviction to the token's expiry so the ledger can drop this entry once the token is dead.
      const exp = pres && pres.token && pres.token.exp;
      if (!nonces.consume(res.tokenHash, res.nonce, exp)) return { ok: false, reason: 'action-replayed', tier: 3 };
      return res;
    },
  };
}
