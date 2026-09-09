// AvailabilityTester soundness (MAINNET-GATES §@xmbl/storage-compute).
// The named module: availability.js decided "available" from a bare /health 200, so an idle node
// that discarded every shard still scored as available. probeNode() replaces that with a possession
// proof — the challenger issues a FRESH nonce and accepts only when the responder returns
// proof === computeProbeProof(nonce, expectedBytes). This suite is the adversarial half the module
// lacked: a node that does NOT hold the shard, or lies about it, must FAIL the probe.
// Run: node availability.test.mjs
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AvailabilityTester } from './availability.js';
import { StorageNode, computeProbeProof } from './storage-node.js';

let pass = 0, fail = 0;
const check = async (n, f) => {
  try { await f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; }
};

// The transport seam: turn a StorageNode into the { held, proof } prober probeNode() expects.
const proberFor = (node) => (probe) => node.respondToProbe(probe);

const nodes = [];
const spawn = async () => {
  const dbPath = await mkdtemp(join(tmpdir(), 'xmbl-avail-'));
  const n = new StorageNode({ dbPath });
  await n._ensureInit();
  nodes.push({ n, dbPath });
  return n;
};

const SHARD_BYTES = Buffer.from('availability soundness: the exact bytes a holder must possess', 'utf8');

const holder = await spawn();
const idler = await spawn();
const shardId = await holder.storeShard({ index: 0, data: SHARD_BYTES });

await check('completeness — a holder proves possession and scores available', async () => {
  const tester = new AvailabilityTester();
  const ok = await tester.probeNode('holder', { shardId, expectedBytes: SHARD_BYTES, prober: proberFor(holder) });
  assert.strictEqual(ok, true, 'a true holder must pass the probe');
  assert.strictEqual(tester.getStats('holder').availability, 1, 'and be recorded available');
});

await check('soundness — a node that does NOT hold the shard FAILS the probe', async () => {
  const tester = new AvailabilityTester();
  const ok = await tester.probeNode('idler', { shardId, expectedBytes: SHARD_BYTES, prober: proberFor(idler) });
  assert.strictEqual(ok, false, 'a node missing the shard must not score available');
  assert.strictEqual(tester.getStats('idler').availability, 0, 'and must be recorded unavailable');
});

await check('soundness — a reachable node is NOT enough: a liar answering held:true with a forged proof FAILS', async () => {
  const tester = new AvailabilityTester();
  // The node is up (answers the probe) but never held the shard: it fabricates a proof.
  const liar = () => Promise.resolve({ shardId, held: true, proof: 'deadbeef'.repeat(8) });
  const ok = await tester.probeNode('liar', { shardId, expectedBytes: SHARD_BYTES, prober: liar });
  assert.strictEqual(ok, false, 'the verifier must not trust the held flag — only the recomputed proof');
});

await check('soundness — a proof computed over the WRONG bytes is rejected', async () => {
  const tester = new AvailabilityTester();
  // An attacker can only hash bytes it actually has; those are not the shard's bytes.
  const wrongByteAttacker = ({ nonce }) =>
    Promise.resolve({ shardId, held: true, proof: computeProbeProof(nonce, Buffer.from('bytes it actually has')) });
  const ok = await tester.probeNode('wrong', { shardId, expectedBytes: SHARD_BYTES, prober: wrongByteAttacker });
  assert.strictEqual(ok, false, 'a proof over the wrong bytes must not verify against the real shard');
});

await check('freshness — a proof captured under one nonce cannot be replayed for a fresh challenge', async () => {
  const tester = new AvailabilityTester();
  // Capture a genuine proof for a nonce the attacker observed, then replay it verbatim.
  const observed = await holder.respondToProbe({ shardId, nonce: 'observed-nonce' });
  assert.strictEqual(observed.proof, computeProbeProof('observed-nonce', SHARD_BYTES), 'sanity: captured proof is genuine');
  const replayer = () => Promise.resolve({ shardId, held: true, proof: observed.proof });
  // probeNode issues its OWN fresh random nonce, so the stale proof will not recompute.
  const ok = await tester.probeNode('replayer', { shardId, expectedBytes: SHARD_BYTES, prober: replayer });
  assert.strictEqual(ok, false, 'a proof bound to a stale nonce must fail under a fresh challenge');
});

await check('binding — a holder of DIFFERENT bytes cannot answer for this shardId', async () => {
  const other = await spawn();
  await other.storeShard({ index: 7, data: Buffer.from('a completely different shard') });
  const tester = new AvailabilityTester();
  const ok = await tester.probeNode('other', { shardId, expectedBytes: SHARD_BYTES, prober: proberFor(other) });
  assert.strictEqual(ok, false, 'a node holding other bytes cannot pass the probe for this shard');
});

await check('transport failure — an unreachable prober scores unavailable, not a crash', async () => {
  const tester = new AvailabilityTester();
  const dead = () => Promise.reject(new Error('ECONNREFUSED'));
  const ok = await tester.probeNode('dead', { shardId, expectedBytes: SHARD_BYTES, prober: dead });
  assert.strictEqual(ok, false, 'a transport error must resolve to unavailable');
  assert.strictEqual(tester.getStats('dead').availability, 0, 'and be recorded, not thrown');
});

for (const { n, dbPath } of nodes) {
  try { if (n.db && typeof n.db.close === 'function') await n.db.close(); } catch {}
  try { await rm(dbPath, { recursive: true, force: true }); } catch {}
}

console.log(`\navailability tester: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
