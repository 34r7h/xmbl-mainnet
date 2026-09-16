// THE ANCHORING PIPELINE HAD NO TEST AT ALL.
//
// Four files — anchoring-normalizer.js, anchoring-subscriber.js, txqueue.js, tx-submitter.js — were
// never loaded by a single suite in the 67-file gate (measured with NODE_V8_COVERAGE; see
// scripts/coverage-report.mjs). Together they are the path by which an off-chain activity event
// becomes an on-chain anchor, and one of them opens with the words "MONEY-SAFE BY DEFAULT".
// Untested, that claim was an assertion in a comment.
//
// This suite exercises the whole chain — event -> normalize -> enqueue -> drain -> submit — and the
// failure modes each stage documents about itself: JCS key-order independence, at-least-once dedup by
// content hash, a torn trailing write from a crash mid-append, retry backoff, and the paper-mode gate
// refusing to silently downgrade when the operator asked for live submission.
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  jcsCanonicalize, sha256Hex, normalizeEvent,
  canonicalRecordForTaskCreated, canonicalRecordForTaskVerified,
  canonicalRecordForSettlementExecuted, canonicalRecordForArtifactUploaded, canonicalRecordForSocPosted,
} from './anchoring-normalizer.js';
import { createAnchoringSubscriber, ANCHORED_EVENT_KINDS } from './anchoring-subscriber.js';
import { TxQueue, replay, drainOnce, defaultQueuePath } from './txqueue.js';
import { createTxSubmitter, isTxLive } from './tx-submitter.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

const dir = mkdtempSync(join(tmpdir(), 'xmbl-anchoring-'));
const qpath = (n) => join(dir, `q-${n}.jsonl`);

// ── 1. JCS: THE CANONICAL FORM IS WHAT MAKES TWO NODES AGREE ON ONE DIGEST ──
// The digest is the anchor. If two nodes holding the same record serialize it differently, they
// anchor different hashes for the same event and the chain records a disagreement that does not exist.
{
  ok('object keys are sorted, not insertion-ordered',
     jcsCanonicalize({ b: 1, a: 2 }) === '{"a":2,"b":1}');
  ok('sorting is applied at EVERY nesting level',
     jcsCanonicalize({ z: { d: 1, c: 2 }, a: 3 }) === '{"a":3,"z":{"c":2,"d":1}}');
  ok('array order is PRESERVED (an array is ordered data, not a set)',
     jcsCanonicalize([3, 1, 2]) === '[3,1,2]');
  ok('arrays of objects still get their keys sorted',
     jcsCanonicalize([{ b: 1, a: 2 }]) === '[{"a":2,"b":1}]');
  ok('undefined properties are omitted, not serialized as null',
     jcsCanonicalize({ a: 1, b: undefined }) === '{"a":1}');
  ok('null is a value and survives', jcsCanonicalize({ a: null }) === '{"a":null}');
  ok('a bare scalar canonicalizes as JSON', jcsCanonicalize('x') === '"x"' && jcsCanonicalize(7) === '7');

  // The property the whole scheme exists for.
  const a = { event: 'task.created', task_id: 't1', created_by: 'alice', created_at: '2026-01-01T00:00:00Z' };
  const b = { created_at: '2026-01-01T00:00:00Z', created_by: 'alice', task_id: 't1', event: 'task.created' };
  ok('TWO RECORDS WITH THE SAME FIELDS IN DIFFERENT ORDER HASH IDENTICALLY',
     sha256Hex(jcsCanonicalize(a)) === sha256Hex(jcsCanonicalize(b)));
  ok('...and a one-character change to a value does NOT hash identically',
     sha256Hex(jcsCanonicalize(a)) !== sha256Hex(jcsCanonicalize({ ...a, task_id: 't2' })));

  // Pin the digest against node's own crypto rather than against this module's opinion of itself.
  const canon = '{"a":1}';
  ok('sha256Hex is sha-256 lowercase hex, not some other digest',
     sha256Hex(canon) === createHash('sha256').update(canon, 'utf8').digest('hex'));
  ok('the digest is 64 hex characters', /^[0-9a-f]{64}$/.test(sha256Hex(canon)));
}

// ── 2. THE FIVE RECORD BUILDERS, INCLUDING THE TWO THAT REFUSE BAD STATE ──
{
  const created = canonicalRecordForTaskCreated({ id: 't1', request_id: 'r1', title: 'T', created_by: 'alice',
                                                  created_at: '2026-01-01T00:00:00Z', goal_id: undefined });
  ok('task.created carries its event tag', created.event === 'task.created');
  ok('task.created maps id -> task_id', created.task_id === 't1');
  ok('an undefined optional field is absent from the record, not present-as-undefined',
     !Object.prototype.hasOwnProperty.call(created, 'goal_id'));

  ok('task.verified accepts status=verified',
     canonicalRecordForTaskVerified({ id: 't1', status: 'verified', verified_by: 'bob' }).status === 'verified');
  ok('task.verified accepts status=rejected (a rejection is an anchored outcome too)',
     canonicalRecordForTaskVerified({ id: 't1', status: 'rejected', verified_by: 'bob' }).status === 'rejected');
  ok('TASK.VERIFIED REFUSES A TASK THAT IS NOT ACTUALLY VERIFIED',
     throws(() => canonicalRecordForTaskVerified({ id: 't1', status: 'pending' }), /must be 'verified' or 'rejected'/));

  const settled = canonicalRecordForSettlementExecuted({ id: 'r1', status: 'settled', resource: 'task:t9 (ship it)',
                                                         payTo: 'addr1', amount: '5', asset: 'USDC', network: 'base' });
  ok('settlement.executed parses task_id out of the resource string', settled.task_id === 't9');
  ok('settlement.executed maps payTo -> pay_to', settled.pay_to === 'addr1');
  ok('a resource with no task: prefix leaves task_id absent rather than guessing',
     !Object.prototype.hasOwnProperty.call(
       canonicalRecordForSettlementExecuted({ id: 'r', status: 'settled', resource: 'invoice:9' }), 'task_id'));
  ok('SETTLEMENT.EXECUTED REFUSES A RECEIPT THAT IS NOT SETTLED — an unsettled payment must never anchor',
     throws(() => canonicalRecordForSettlementExecuted({ id: 'r1', status: 'pending' }), /must be 'settled'/));

  ok('artifact.uploaded maps uploader_agent',
     canonicalRecordForArtifactUploaded({ file_id: 'f1', uploader_agent: 'carol' }).uploader_agent === 'carol');
  ok('soc.posted maps id -> post_id', canonicalRecordForSocPosted({ id: 'p1', author: 'dave' }).post_id === 'p1');
}

// ── 3. normalizeEvent: THE PAYLOAD SHAPE AND WHO IT IS ATTRIBUTED TO ──
{
  const task = { id: 't1', request_id: 'r1', created_by: 'alice', created_at: '2026-01-01T00:00:00Z' };
  const p = normalizeEvent('task.created', task);
  ok('the payload carries the kind', p.kind === 'task.created');
  ok('the payload carries a 64-hex digest', /^[0-9a-f]{64}$/.test(p.sha256_hex));
  ok('the timestamp comes from created_at', p.timestamp === '2026-01-01T00:00:00Z');
  ok('with no address supplied, attribution FALLS BACK to the per-kind responsible field',
     p.agent_xmbl_address === 'alice');
  ok('an EXPLICIT resolved address wins over the fallback',
     normalizeEvent('task.created', task, '0xRESOLVED').agent_xmbl_address === '0xRESOLVED');
  ok('the digest does not depend on which address was attached — it covers the RECORD',
     normalizeEvent('task.created', task, '0xRESOLVED').sha256_hex === p.sha256_hex);

  const verified = normalizeEvent('task.verified', { id: 't1', status: 'verified', verified_by: 'bob',
                                                     updated_at: '2026-01-02T00:00:00Z' });
  ok('task.verified takes its timestamp from updated_at when there is no created_at',
     verified.timestamp === '2026-01-02T00:00:00Z');
  ok('task.verified attributes to verified_by', verified.agent_xmbl_address === 'bob');
  ok('settlement attributes to pay_to',
     normalizeEvent('settlement.executed', { id: 'r', status: 'settled', resource: 'task:t1', payTo: 'addr9' })
       .agent_xmbl_address === 'addr9');
  ok('soc.posted attributes to the author',
     normalizeEvent('soc.posted', { id: 'p1', author: 'dave' }).agent_xmbl_address === 'dave');
  ok('AN UNKNOWN KIND IS REFUSED, not silently anchored under a wrong shape',
     throws(() => normalizeEvent('task.deleted', {}), /unknown event kind/));
}

// ── 4. THE SUBSCRIBER IS A FILTER THAT MUST NEVER THROW INTO ITS DRIVER ──
// It sits on a firehose. If one malformed record throws out of onEvent, the loop feeding it dies and
// every subsequent event is lost — a single bad row silently stops all anchoring.
{
  const enq = [], dropped = [], errors = [];
  const onEvent = createAnchoringSubscriber({
    queue: { enqueue: (p) => enq.push(p) },
    onDrop: (e) => dropped.push(e),
    onError: (e, err) => errors.push([e, err]),
  });

  onEvent({ kind: 'task.created', record: { id: 't1', created_by: 'alice', created_at: 'T' } });
  ok('an anchored kind is normalized and enqueued', enq.length === 1 && enq[0].kind === 'task.created');

  onEvent({ kind: 'agent.heartbeat', record: {} });
  ok('a NON-anchored kind is dropped, not enqueued', enq.length === 1 && dropped.length === 1);
  onEvent(undefined);
  ok('an undefined event is dropped rather than crashing the driver', dropped.length === 2);
  onEvent({ record: {} });
  ok('an event with no kind at all is dropped', dropped.length === 3);

  let threw = false;
  try { onEvent({ kind: 'task.verified', record: { id: 't', status: 'pending' } }); } catch { threw = true; }
  ok('A MALFORMED ANCHORED RECORD DOES NOT THROW OUT OF onEvent', threw === false);
  ok('...it is reported through onError instead', errors.length === 1 && /verified/.test(errors[0][1].message));
  ok('...and it is NOT enqueued', enq.length === 1);

  onEvent({ kind: 'soc.posted', record: { id: 'p1', author: 'dave' } });
  ok('THE SUBSCRIBER KEEPS WORKING AFTER A BAD EVENT', enq.length === 2);

  // An enqueue that itself throws must be caught too — the queue is I/O and I/O fails.
  const errs2 = [];
  const onEvent2 = createAnchoringSubscriber({
    queue: { enqueue: () => { throw new Error('disk full'); } },
    onError: (e, err) => errs2.push(err),
  });
  let threw2 = false;
  try { onEvent2({ kind: 'soc.posted', record: { id: 'p', author: 'a' } }); } catch { threw2 = true; }
  ok('a FAILING ENQUEUE is reported, not thrown', threw2 === false && /disk full/.test(errs2[0].message));

  ok('a resolveAgentAddress override is used for attribution', (() => {
    const got = [];
    const oe = createAnchoringSubscriber({ queue: { enqueue: (p) => got.push(p) }, resolveAgentAddress: () => '0xMAPPED' });
    oe({ kind: 'soc.posted', record: { id: 'p', author: 'dave' } });
    return got[0].agent_xmbl_address === '0xMAPPED';
  })());

  ok('a subscriber with no usable queue is refused AT CONSTRUCTION, not at the first event',
     throws(() => createAnchoringSubscriber({}), /queue with an enqueue/)
     && throws(() => createAnchoringSubscriber({ queue: {} }), /queue with an enqueue/));
  ok('the five anchored kinds are exported and frozen',
     ANCHORED_EVENT_KINDS.length === 5 && Object.isFrozen(ANCHORED_EVENT_KINDS));
}

// ── 5. THE QUEUE IS AN APPEND-ONLY LOG: DEDUP BY CONTENT HASH, SURVIVING A CRASH ──
{
  ok('the default queue path is under ~/.handoff, not the repo', /\.handoff[/\\]xmbl[/\\]txqueue\.jsonl$/.test(defaultQueuePath()));
  ok('replaying a file that does not exist yields an empty state, not a throw',
     replay(join(dir, 'nope.jsonl')).size === 0);

  let t = 0;
  const q = new TxQueue({ path: qpath('a'), now: () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}Z` });
  const pay = (h) => ({ kind: 'soc.posted', sha256_hex: h, timestamp: 'T' });

  ok('enqueue REFUSES a payload with no content hash — the hash IS the identity',
     throws(() => q.enqueue({ kind: 'soc.posted' }), /sha256_hex is required/)
     && throws(() => q.enqueue(null), /sha256_hex is required/));

  q.enqueue(pay('aa')); q.enqueue(pay('bb'));
  ok('two distinct payloads are two pending entries', q.pending().length === 2);

  q.enqueue(pay('aa'));
  ok('THE SAME PAYLOAD ENQUEUED TWICE IS STILL ONE PENDING ENTRY (at-least-once upstream, exactly-once anchor)',
     q.pending().length === 2);
  ok('the log itself still recorded all three appends — nothing was rewritten in place',
     readFileSync(qpath('a'), 'utf8').trim().split('\n').length === 3);

  q.markDone('aa');
  ok('a done entry leaves the pending set', q.pending().length === 1 && q.pending()[0].hash === 'bb');
  ok('doneCount counts it', q.doneCount() === 1);
  q.markDone('aa');
  ok('marking an already-done hash done again is harmless', q.doneCount() === 1);
  q.markDone('never-seen');
  ok('marking a never-enqueued hash done is harmless', q.doneCount() === 2);

  q.enqueue(pay('aa'));
  ok('RE-ENQUEUEING AFTER done RE-OPENS the entry — the last event in the file wins',
     q.pending().some((e) => e.hash === 'aa'));
  ok('pending entries come back in enqueue order', (() => {
    const p = q.pending(); return p.length === 2 && p[0].hash === 'bb' && p[1].hash === 'aa';
  })());
}

// ── 6. A CRASH MID-APPEND MUST NOT BLOCK RECOVERY OF EVERYTHING BEFORE IT ──
{
  const p = qpath('torn');
  writeFileSync(p, '');
  const q = new TxQueue({ path: p, now: () => '2026-01-01T00:00:00Z' });
  q.enqueue({ kind: 'soc.posted', sha256_hex: 'aa', timestamp: 'T' });
  q.enqueue({ kind: 'soc.posted', sha256_hex: 'bb', timestamp: 'T' });
  appendFileSync(p, '{"type":"enqueue","hash":"cc","payl');        // the process died mid-write

  const state = replay(p);
  ok('THE TORN TRAILING LINE IS SKIPPED, not thrown on', state.size === 2);
  ok('every entry written before the crash is recovered', state.has('aa') && state.has('bb'));
  ok('the half-written entry is absent — it was never durably enqueued', !state.has('cc'));
  ok('a blank line in the log is ignored', (() => {
    const p2 = qpath('blank');
    writeFileSync(p2, '\n{"type":"enqueue","hash":"zz","payload":{},"at":"T"}\n\n');
    return replay(p2).size === 1;
  })());
}

// ── 7. drainOnce: RETRY, BACKOFF, AND WHAT SURVIVES A FAILURE ──
{
  const q = new TxQueue({ path: qpath('drain'), now: () => '2026-01-01T00:00:00Z' });
  for (const h of ['h1', 'h2', 'h3']) q.enqueue({ kind: 'soc.posted', sha256_hex: h, timestamp: 'T' });

  const seen = [];
  const r = await drainOnce(q, async (payload) => { seen.push(payload.sha256_hex); }, { sleep: async () => {} });
  ok('every pending entry is submitted once', seen.length === 3);
  ok('all three are reported submitted', r.submitted.length === 3 && r.failed.length === 0);
  ok('THE QUEUE IS EMPTY AFTERWARDS — each was marked done by hash', q.pending().length === 0);
  ok('a second drain submits nothing (idempotent, not re-submitted)', (await drainOnce(q, async () => {
    throw new Error('must not be called');
  })).submitted.length === 0);

  // A permanently failing submit exhausts its attempts and STAYS pending for the next drain.
  const q2 = new TxQueue({ path: qpath('fail'), now: () => '2026-01-01T00:00:00Z' });
  q2.enqueue({ kind: 'soc.posted', sha256_hex: 'bad', timestamp: 'T' });
  let attempts = 0;
  const delays = [];
  const r2 = await drainOnce(q2, async () => { attempts++; throw new Error('network down'); },
                             { maxAttempts: 4, baseDelayMs: 10, sleep: async (ms) => { delays.push(ms); } });
  ok('a failing submit is retried up to maxAttempts', attempts === 4);
  ok('backoff is exponential from the base: 10, 20, 40', JSON.stringify(delays) === '[10,20,40]');
  ok('it does NOT sleep after the final attempt', delays.length === 3);
  ok('the exhausted entry is reported failed', r2.failed.length === 1 && r2.submitted.length === 0);
  ok('AND IT IS STILL PENDING — a failed submit must never be marked done', q2.pending().length === 1);

  // Succeeding on a later attempt still counts as submitted.
  let n = 0;
  const r3 = await drainOnce(q2, async () => { if (++n < 3) throw new Error('flaky'); },
                             { maxAttempts: 5, baseDelayMs: 1, sleep: async () => {} });
  ok('an entry that succeeds on retry is submitted and cleared', r3.submitted.length === 1 && q2.pending().length === 0);

  // A crash mid-drain: the entries submitted before the throw are durably done.
  const q3 = new TxQueue({ path: qpath('crash'), now: () => '2026-01-01T00:00:00Z' });
  for (const h of ['c1', 'c2', 'c3']) q3.enqueue({ kind: 'soc.posted', sha256_hex: h, timestamp: 'T' });
  let done = 0;
  try {
    await drainOnce(q3, async () => { if (++done === 2) { const e = new Error('process died'); e.fatal = 1; throw e; } },
                    { maxAttempts: 1, sleep: async () => {} });
  } catch { /* a real crash would not even unwind */ }
  const left = new Set((await q3.pending()).map((e) => e.hash));
  ok('MID-DRAIN, THE ALREADY-SUBMITTED ENTRY IS DONE AND NOT RESUBMITTED', !left.has('c1'));
  ok('...and the one whose submit failed is still pending', left.has('c2'));
}

// ── 8. MONEY-SAFE BY DEFAULT: THE PAPER GATE, AND ITS REFUSAL TO DOWNGRADE ──
// The whole point of the flag convention: without XMBL_TX_LIVE=1 nothing touches a network. The
// dangerous failure is the opposite one — an operator who SET the flag being silently given a no-op.
{
  const prior = process.env.XMBL_TX_LIVE;
  delete process.env.XMBL_TX_LIVE;
  ok('isTxLive() is false with the flag unset', isTxLive() === false);
  process.env.XMBL_TX_LIVE = '0';
  ok('isTxLive() is false for any value other than exactly "1"', isTxLive() === false);
  process.env.XMBL_TX_LIVE = '1';
  ok('isTxLive() is true for exactly "1"', isTxLive() === true);
  process.env.XMBL_TX_LIVE = 'true';
  ok('...and NOT for "true" — the convention is the literal 1', isTxLive() === false);
  if (prior === undefined) delete process.env.XMBL_TX_LIVE; else process.env.XMBL_TX_LIVE = prior;

  const lines = [];
  let liveCalls = 0;
  const paper = createTxSubmitter({ isLive: () => false, log: (l) => lines.push(l),
                                    liveSubmitFn: async () => { liveCalls++; } });
  await paper({ kind: 'soc.posted', sha256_hex: 'aa' });
  ok('PAPER MODE NEVER CALLS THE LIVE SUBMIT FN, even when one is provided', liveCalls === 0);
  ok('paper mode logs the full would-be tx', lines.length === 1 && /would submit/.test(lines[0]));
  ok('the logged line carries the actual payload, not a placeholder', /"sha256_hex":"aa"/.test(lines[0]));

  const got = [];
  const live = createTxSubmitter({ isLive: () => true, log: (l) => lines.push(l),
                                   liveSubmitFn: async (p) => { got.push(p); } });
  await live({ kind: 'soc.posted', sha256_hex: 'bb' });
  ok('live mode calls the injected submit fn with the payload', got.length === 1 && got[0].sha256_hex === 'bb');
  ok('live mode does NOT also write a paper line', lines.length === 1);

  let refused = null;
  try { await createTxSubmitter({ isLive: () => true })({ sha256_hex: 'cc' }); } catch (e) { refused = e; }
  ok('LIVE WITH NO SUBMIT FN IS REFUSED — an operator who asked for live is never silently papered',
     refused !== null && /refusing to silently fall back to paper mode/.test(refused.message));
}

// ── 9. END TO END, WITH ZERO NETWORK: an activity event becomes a done queue entry ──
{
  const q = new TxQueue({ path: qpath('e2e'), now: () => '2026-01-01T00:00:00Z' });
  const errors = [];
  const onEvent = createAnchoringSubscriber({ queue: q, onError: (e, err) => errors.push(err) });

  onEvent({ kind: 'task.created', record: { id: 't1', created_by: 'alice', created_at: '2026-01-01T00:00:00Z' } });
  onEvent({ kind: 'soc.posted', record: { id: 'p1', author: 'dave', created_at: '2026-01-01T00:00:01Z' } });
  onEvent({ kind: 'agent.heartbeat', record: {} });                       // filtered out
  onEvent({ kind: 'task.verified', record: { id: 't2', status: 'pending' } });  // malformed, reported

  ok('only the two anchorable events reached the queue', q.pending().length === 2);
  ok('the malformed one was reported rather than anchored', errors.length === 1);

  const logged = [];
  const submit = createTxSubmitter({ log: (l) => logged.push(l) });        // default: paper mode
  const res = await drainOnce(q, submit, { sleep: async () => {} });
  ok('BOTH ANCHORS DRAINED THROUGH THE PAPER SUBMITTER', res.submitted.length === 2);
  ok('the queue is empty and the log recorded both would-be txs', q.pending().length === 0 && logged.length === 2);
  ok('replaying the durable log from scratch agrees: two entries, both done', (() => {
    const s = replay(qpath('e2e'));
    return s.size === 2 && [...s.values()].every((e) => e.status === 'done');
  })());
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
