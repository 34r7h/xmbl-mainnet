// @xmbl/consensus Byzantine / no-fork seal-agreement matrix (MAINNET-GATES §@xmbl/consensus, T7.1).
//
// THE PROPERTY UNDER TEST — the whole point of the seal boundary: honest seal-leads either converge on
// ONE sealed set-hash or safely STALL; they NEVER seal two different sets for the same face. Proven here
// by driving the REAL SealRoundManager (not a re-implementation) across an in-memory gossip bus with a
// partition mask, for the three adversarial scenarios the gate names:
//   (a) an EQUIVOCATING peer  — a Byzantine lead broadcasts conflicting (setHash,memberIds) to different
//                               honest nodes; it must not manufacture a second sealed set.
//   (b) WITHHELD coverage/data — a minority holds the agreed hash but not the member data; it must STALL
//                               (never fabricate a seal) and later CONVERGE to the same hash once data arrives.
//   (c) a network PARTITION    — two disjoint honest groups with DIVERGENT pools. With the correct fixed
//                               quorum both STALL (no fork); with the presence-SHRUNK quorum both seal
//                               DIFFERENT sets → a PERMANENT fork that survives heal. The contrast is the
//                               demonstration that the quorum DENOMINATOR is load-bearing (see @xmbl/core
//                               sealQuorumFrom: the denominator must be the FIXED configured lead set).
//
// The quorum is INJECTED here as a literal (the real derivation + its own mutation-regression live in the
// core seal-quorum test). Mutation that proves this suite bites: seal-agreement.decideRound
// `winCount < quorum` -> `winCount < quorum - 1` lets a partition side seal on 2/3 → scenario (c) fork check
// goes red. Run: node byzantine-matrix.test.mjs
import assert from 'node:assert';
import { SealRoundManager } from './seal-round.js';
import { setHash } from './seal-agreement.js';

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };

const KEY = (it) => it.key;
const H = (items) => setHash(items, KEY);           // content hash of a set, exactly as the manager computes it
const CHUNK = 2;                                     // small chunk so a 2-item pool is one complete candidate

// An in-memory gossip bus with a partition mask. broadcast reaches only same-side peers; a Byzantine peer
// injects proposals directly. Delivery is QUEUED, not synchronous: the real transport is async fire-and-forget
// (`.catch(()=>{})`), so a node's done-answer re-broadcast (onPeerProposal → broadcast) must not re-enter
// delivery inline — inline delivery mutually recurses forever between two done nodes. Each distinct
// (from → to, setHash) is delivered at most once (it lands in the target's _peers and persists there), which
// both breaks that storm and keeps propagation deterministic. No timers — rounds are ticked explicitly.
class Bus {
  constructor() { this.mgrs = new Map(); this.partition = null; this.queue = []; this.seen = new Set(); }
  sameSide(a, b) { return !this.partition || this.partition.some((g) => g.has(a) && g.has(b)); }
  heal() { this.partition = null; }
  deliver(from, msg) { this.queue.push({ from, msg }); }                  // enqueue; drained between ticks
  drain() {
    while (this.queue.length) {
      const { from, msg } = this.queue.shift();
      for (const [id, mgr] of this.mgrs) {
        if (id === from || !this.sameSide(from, id)) continue;
        const k = `${from}>${id}:${msg.setHash}`;
        if (this.seen.has(k)) continue;                                   // each proposal delivered once per pair
        this.seen.add(k);
        mgr.onPeerProposal({ nodeId: from, setHash: msg.setHash, memberIds: msg.memberIds });
      }
    }
  }
}

// An honest seal-lead: a REAL SealRoundManager over a mutable pool, recording what it actually seals.
function honest(bus, id, pool, quorumFn) {
  const items = pool.map((p) => ({ ...p }));
  const st = { id, sealed: [], sealedHash: null, items, bus };
  const drop = (set) => { for (const it of set) { const i = items.findIndex((p) => p.id === it.id); if (i >= 0) items.splice(i, 1); } };
  const mgr = new SealRoundManager({
    getItems: () => items,
    keyFn: KEY,
    memberId: (it) => it.id,
    chunkSize: CHUNK,
    quorum: quorumFn,
    broadcast: (msg) => bus.deliver(id, msg),
    sealSet: (set) => { drop(set); st.sealed.push(set.map((it) => it.id)); st.sealedHash = H(set); },
    adoptSet: async (agreedHash, memberIds) => {
      const set = memberIds.map((mid) => items.find((p) => p.id === mid)).filter(Boolean);
      if (set.length < memberIds.length) return false;      // member data withheld → STALL, never fabricate
      drop(set); st.sealed.push(set.map((it) => it.id)); st.sealedHash = agreedHash; return true;
    },
  });
  st.mgr = mgr; bus.mgrs.set(id, mgr); return st;
}

// A Byzantine peer that never runs the real manager: it just injects proposals (optionally different per target).
function evilInject(bus, id, byTarget) { for (const [tid, mgr] of bus.mgrs) { const m = byTarget(tid); if (m) mgr.onPeerProposal({ nodeId: id, setHash: m.setHash, memberIds: m.memberIds }); } }

const runRounds = async (nodes, rounds, before) => {
  for (let r = 0; r < rounds; r++) {
    if (before) before();
    for (const n of nodes) { await n.mgr.tick(); n.bus.drain(); }
  }
};
const distinctSealed = (nodes) => new Set(nodes.filter((n) => n.sealedHash).map((n) => n.sealedHash));

// Fixtures: content-addressed items. Lowest-2-by-key is the candidate; different sets ⇒ different hashes.
const A = { id: 'A', key: 'a' }, B = { id: 'B', key: 'b' }, C = { id: 'C', key: 'c' };
const H_AB = H([A, B]), H_AC = H([A, C]);
assert.notStrictEqual(H_AB, H_AC, 'fixture sanity: divergent sets must hash differently');

// ---- (a) EQUIVOCATION: a Byzantine peer cannot manufacture a second sealed set --------------------------
await check('(a) equivocating peer: honest majority seals ONE set; the forged set seals nowhere', async () => {
  const bus = new Bus();
  const Q = () => 3;                                   // fixed majority of 4 configured leads (3 honest + evil)
  const nodes = [honest(bus, 'h0', [A, B], Q), honest(bus, 'h1', [A, B], Q), honest(bus, 'h2', [A, B], Q)];
  // evil equivocates: tells h0 the honest set, but tells h1/h2 a FORGED set with fabricated member ids.
  const forged = { setHash: H([{ key: 'zz1' }, { key: 'zz2' }]), memberIds: ['zz1', 'zz2'] };
  await runRounds(nodes, 4, () => evilInject(bus, 'evil', (t) => (t === 'h0' ? { setHash: H_AB, memberIds: ['A', 'B'] } : forged)));
  assert.strictEqual(distinctSealed(nodes).size, 1, 'honest nodes sealed more than one set under equivocation');
  assert.ok(nodes.every((n) => n.sealedHash === H_AB), 'an honest node sealed something other than the true set');
  assert.ok(![...bus.mgrs.keys()].some((id) => nodes.find((n) => n.id === id)?.sealedHash === forged.setHash), 'the forged set was sealed');
});

// ---- (b) WITHHELD DATA: minority STALLS (never fabricates), then CONVERGES once data arrives ------------
await check('(b) withheld coverage: minority stalls without the member data, then adopts the SAME hash', async () => {
  const bus = new Bus();
  const Q = () => 3;                                   // majority = 3 of 4
  const maj = [honest(bus, 'h0', [A, B], Q), honest(bus, 'h1', [A, B], Q), honest(bus, 'h2', [A, B], Q)];
  const m = honest(bus, 'm', [C], Q);                  // minority: has NEITHER A nor B (data withheld); own pool < chunk
  await runRounds([...maj, m], 4);
  assert.ok(maj.every((n) => n.sealedHash === H_AB), 'the majority failed to seal the agreed set');
  assert.strictEqual(m.sealedHash, null, 'the minority fabricated a seal it had no data for');
  // commit-2 delivers the withheld members; the minority must now adopt the IDENTICAL hash — never a new one.
  m.items.push({ ...A }, { ...B });
  await runRounds([m], 3);
  assert.strictEqual(m.sealedHash, H_AB, 'the minority did not converge to the majority set after data arrived');
  assert.strictEqual(distinctSealed([...maj, m]).size, 1, 'convergence produced more than one sealed set');
});

// ---- (c) PARTITION: fixed quorum → safe stall + converge; shrunk quorum → PERMANENT fork ----------------
await check('(c) partition + FIXED quorum(3 of 4): both sides STALL, then converge to one set on heal', async () => {
  const bus = new Bus();
  const Q = () => 3;                                   // FIXED denominator = all 4 configured leads
  const left = [honest(bus, 'h0', [A, B], Q), honest(bus, 'h1', [A, B], Q)];   // pool {A,B}
  const right = [honest(bus, 'h2', [A, C], Q), honest(bus, 'h3', [A, C], Q)];  // DIVERGENT pool {A,C}
  bus.partition = [new Set(['h0', 'h1']), new Set(['h2', 'h3'])];
  await runRounds([...left, ...right], 4);
  assert.strictEqual(distinctSealed([...left, ...right]).size, 0, 'a partition side sealed below the fixed quorum — FORK');
  // Heal + commit-2 reconciles pools (all leads converge on {A,B,C}); the fixed quorum then seals ONE set.
  bus.heal();
  for (const n of [...left, ...right]) { for (const it of [A, B, C]) if (!n.items.find((p) => p.id === it.id)) n.items.push({ ...it }); }
  await runRounds([...left, ...right], 5);
  assert.strictEqual(distinctSealed([...left, ...right]).size, 1, 'honest nodes did not converge to a single sealed set after heal');
});

await check('(c-contrast) partition + SHRUNK quorum(2 per side): forks, and the fork is PERMANENT on heal', async () => {
  const bus = new Bus();
  const Q = () => 2;                                   // BUG: presence-shrunk denominator (each side sees only 2 live)
  const left = [honest(bus, 'h0', [A, B], Q), honest(bus, 'h1', [A, B], Q)];
  const right = [honest(bus, 'h2', [A, C], Q), honest(bus, 'h3', [A, C], Q)];
  bus.partition = [new Set(['h0', 'h1']), new Set(['h2', 'h3'])];
  await runRounds([...left, ...right], 4);
  assert.strictEqual(distinctSealed([...left, ...right]).size, 2, 'the shrunk-quorum partition did not fork as expected');
  assert.ok(left.every((n) => n.sealedHash === H_AB) && right.every((n) => n.sealedHash === H_AC), 'the two sides did not seal the two divergent sets');
  // PERMANENCE — the fork cannot heal. `A` was consumed into H_AB on the left AND into H_AC on the right;
  // it is GONE from both pools, so neither side can ever reconstruct (adoptSet) the other's set. Heal the
  // network, let every side re-gossip its sealed proposals for many rounds, and the two histories stand.
  // (We deliberately do NOT re-inject the sealed items: an already-sealed member is not re-poolable — that
  // unrecoverability is the whole point.)
  bus.heal();
  await runRounds([...left, ...right], 8);
  assert.strictEqual(distinctSealed([...left, ...right]).size, 2, 'the fork reconciled on heal — it must be shown PERMANENT (this is why the quorum denominator must be fixed)');
  assert.ok(left.every((n) => n.sealedHash === H_AB) && right.every((n) => n.sealedHash === H_AC), 'a forked node adopted the other history after heal — the fork was not permanent');
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
