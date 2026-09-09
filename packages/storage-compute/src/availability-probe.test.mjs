// Availability-probe adversarial soundness (MAINNET-GATES §@xmbl/storage-compute).
// The probe proves a REMOTE node still holds a shard's bytes: the challenger picks a fresh
// nonce, the responder returns proof = sha256(nonce || bytes), and the challenger — who knows
// the shard's bytes from the source it stored them at — accepts only when it can recompute the
// same proof. The gate: a node WITHOUT the shard must FAIL the probe, and no forged or replayed
// answer may pass. `held:true` is a claim, not evidence — the verifier trusts the proof, never
// the flag. Run: node availability-probe.test.mjs
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageNode, computeProbeProof } from './storage-node.js';

let pass = 0, fail = 0;
const check = async (n, f) => {
  try { await f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; }
};

// An honest challenger: it holds the shard's bytes (from where it sourced the shard) and
// accepts a probe answer ONLY if held is true AND the returned proof recomputes over the
// fresh nonce and those exact bytes. This is the sole trust boundary under test.
const verifyProbe = (response, nonce, expectedBytes) =>
  response?.held === true &&
  typeof response.proof === 'string' &&
  response.proof === computeProbeProof(nonce, expectedBytes);

const nodes = [];
const spawn = async () => {
  const dbPath = await mkdtemp(join(tmpdir(), 'xmbl-probe-'));
  const n = new StorageNode({ dbPath });
  await n._ensureInit();
  nodes.push({ n, dbPath });
  return n;
};

const SHARD_BYTES = Buffer.from('availability-probe: the exact bytes a holder must possess', 'utf8');
const shard = { index: 0, data: SHARD_BYTES };

// A holder that stored the shard; an idler that never did.
const holder = await spawn();
const idler = await spawn();
const shardId = await holder.storeShard(shard);

await check('completeness — a holder answers a fresh probe and the proof verifies', async () => {
  const nonce = 'nonce-A-' + Date.now();
  const res = await holder.respondToProbe({ shardId, nonce });
  assert.strictEqual(res.held, true, 'holder should report held');
  assert.ok(verifyProbe(res, nonce, SHARD_BYTES), 'honest proof must verify');
});

await check('soundness — a node WITHOUT the shard FAILS the probe (held:false, no proof)', async () => {
  const nonce = 'nonce-B-' + Date.now();
  const res = await idler.respondToProbe({ shardId, nonce });
  assert.strictEqual(res.held, false, 'a node missing the shard must not report held');
  assert.ok(!verifyProbe(res, nonce, SHARD_BYTES), 'a missing node must not pass verification');
});

await check('soundness — a forged held:true with a fabricated proof is REJECTED by the verifier', async () => {
  const nonce = 'nonce-C-' + Date.now();
  const forged = { shardId, held: true, proof: 'deadbeef'.repeat(8) };
  assert.ok(!verifyProbe(forged, nonce, SHARD_BYTES), 'the verifier must not trust the held flag');
});

await check('soundness — a proof computed over the WRONG bytes is rejected', async () => {
  const nonce = 'nonce-D-' + Date.now();
  // An attacker who does not hold the shard can only hash bytes it does have.
  const attacker = { shardId, held: true, proof: computeProbeProof(nonce, Buffer.from('bytes it actually has')) };
  assert.ok(!verifyProbe(attacker, nonce, SHARD_BYTES), 'wrong-byte proof must not verify against the real shard');
});

await check('freshness — a proof captured for one nonce does NOT verify against a fresh nonce (no replay)', async () => {
  const nonce1 = 'nonce-E1-' + Date.now();
  const captured = await holder.respondToProbe({ shardId, nonce: nonce1 });
  assert.ok(verifyProbe(captured, nonce1, SHARD_BYTES), 'sanity: it verifies for its own nonce');
  const nonce2 = 'nonce-E2-' + (Date.now() + 1);
  assert.ok(!verifyProbe(captured, nonce2, SHARD_BYTES), 'a replayed proof must fail under a new challenge');
});

await check('binding — a holder of DIFFERENT bytes cannot answer for this shardId', async () => {
  const other = await spawn();
  await other.storeShard({ index: 7, data: Buffer.from('a completely different shard') });
  const nonce = 'nonce-F-' + Date.now();
  const res = await other.respondToProbe({ shardId, nonce });
  assert.strictEqual(res.held, false, 'it does not hold THIS shard');
  assert.ok(!verifyProbe(res, nonce, SHARD_BYTES), 'and cannot pass the probe for it');
});

for (const { n, dbPath } of nodes) {
  try { if (n.db && typeof n.db.close === 'function') await n.db.close(); } catch {}
  try { await rm(dbPath, { recursive: true, force: true }); } catch {}
}

console.log(`\navailability probe: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
