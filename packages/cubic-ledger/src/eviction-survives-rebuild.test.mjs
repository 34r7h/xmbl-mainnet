import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, micromineTx } from '../index.js';

// ⛔ THE BUG THIS SUITE EXISTS FOR. `this._evicted` has always been documented as surviving "a restart AND a
// canonical rebuild: rebuildFromAnchors clears block:/cube:/pool: and deliberately does not touch this one".
// Not touching the keyspace is only half of it — the rebuild loop never CONSULTED the set, so a broker feed
// that still carried an evicted anchor minted the block straight back on the next ~90s convergence tick. An
// eviction that the convergence primitive undoes is not an eviction, and the fleet runs that primitive on a
// timer. Every one of the three admission paths must refuse an evicted key or the other two are theatre.
//
// These assert on the OUTCOME — the block rows and the anchor-key set AFTER the operation — never on a return
// flag, because the defect was invisible in every return flag the rebuild produced.

const anchor = (event, h) => micromineTx({ type: 'anchor', event, hash: h.repeat(64).slice(0, 64), ts: '2026-09-20T00:00:00.000Z' });
const feedRow = (tx) => ({ event: tx.event, hash: tx.hash, ts: tx.ts, xid: tx.xid, nonce: tx.nonce, prior: tx.prior });
const key = (tx) => `${tx.event}:${tx.hash}`;

async function freshLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'xclt-evict-'));
  const l = new Ledger({ dbPath: join(dir, 'ledger') });
  await (l.ready?.() ?? new Promise((r) => setTimeout(r, 300)));
  return { l, dir, done: async () => { try { await l.db.close(); } catch { /* */ } rmSync(dir, { recursive: true, force: true }); } };
}
async function blockRows(l) {
  let n = 0;
  for await (const _ of l.db.iterator({ gte: 'block:', lt: 'block;' })) n++;
  return n;
}
// A rebuilt anchor lives in `this.blocks` + the membership pool until nine of them seal a face, so the on-disk
// `block:` count alone is the wrong thing to measure after a rebuild. HOLDS is the honest surface: does this
// ledger hold that anchor at all, by any route.
const holds = (l, tx) => l._anchorKeys.has(`${tx.event}:${tx.hash}`);
// A type-6 value tx, shaped as tokens.json requires it (chain/from/to/amount/unspent + the mined xid/nonce).
const valueTx = (from, to, amount) => micromineTx({ type: 'tx', chain: 'xmbl', from: [from], to: [to], asset: 'XMBL', amount: String(amount), unspent: String(amount) });

test('an evicted anchor is NOT minted back by a canonical rebuild whose feed still carries it', async () => {
  const { l, done } = await freshLedger();
  try {
    const keep = anchor('task.created', 'a');
    const doomed = anchor('value.transfer', 'b');
    await l.addTransaction(keep);
    await l.addTransaction(doomed);
    assert.strictEqual(await blockRows(l), 2, 'both anchors admitted');

    const ev = await l.evict(key(doomed), 'operator eviction');
    assert.strictEqual(ev.evicted, true);
    assert.strictEqual(await blockRows(l), 1, 'the evicted anchor row is gone');

    // THE FEED STILL CARRIES IT. This is the real situation: the broker purge and the node eviction do not
    // land in the same instant, and a node may be handed a stale feed at any point in between.
    const feed = [feedRow(keep), feedRow(doomed)];
    const r = await l.rebuildFromAnchors(feed);

    assert.strictEqual(r.refused, undefined, 'a rebuild with one live anchor is not a wipe');
    assert.strictEqual(r.evicted_skipped, 1, 'the rebuild REPORTS the row it refused');
    assert.strictEqual(r.anchors, 1, 'only the live anchor was rebuilt');
    assert.strictEqual(l.blocks.size, 1, 'OUTCOME: one block held after the rebuild, not two');
    assert.ok(!holds(l, doomed), 'OUTCOME: the evicted anchor did not come back');
    assert.ok(holds(l, keep), 'while the live anchor did');
  } finally { await done(); }
});

test('the eviction survives a RESTART, so the next tick cannot mint it back either', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xclt-evict-boot-'));
  const path = join(dir, 'ledger');
  const doomed = anchor('value.transfer', 'c');
  const keep = anchor('soc.posted', 'd');
  try {
    const first = new Ledger({ dbPath: path });
    await (first.ready?.() ?? new Promise((r) => setTimeout(r, 300)));
    await first.addTransaction(keep);
    await first.addTransaction(doomed);
    await first.evict(key(doomed), 'operator eviction');
    await first.db.close();

    const second = new Ledger({ dbPath: path });
    await (second.ready?.() ?? new Promise((r) => setTimeout(r, 300)));
    assert.ok(second._evicted.has(key(doomed)), 'the evicted: keyspace rehydrated');

    const r = await second.rebuildFromAnchors([feedRow(keep), feedRow(doomed)]);
    assert.strictEqual(r.evicted_skipped, 1);
    assert.strictEqual(second.blocks.size, 1, 'OUTCOME: one block held after a reboot + rebuild, not two');
    assert.ok(!holds(second, doomed), 'OUTCOME: the evicted anchor is still gone a boot later');
    await second.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('evicting EVERY anchor in the feed refuses rather than silently emptying the chain', async () => {
  const { l, done } = await freshLedger();
  try {
    const a1 = anchor('task.created', 'e');
    const a2 = anchor('task.verified', 'f');
    await l.addTransaction(a1);
    await l.addTransaction(a2);
    // A non-anchor block this node must not lose to a wipe.
    await l.addTransaction(valueTx('xmbA', 'xmbB', 1));
    const rowsBefore = await blockRows(l);

    await l.evict(key(a1), 'operator eviction');
    await l.evict(key(a2), 'operator eviction');

    const r = await l.rebuildFromAnchors([feedRow(a1), feedRow(a2)]);
    assert.strictEqual(r.refused, 'would-empty-the-chain', 'a feed of nothing but evicted rows is a wipe');
    assert.strictEqual(r.evicted_skipped, 2, 'and it names why it would have been empty');
    assert.strictEqual(await blockRows(l), rowsBefore - 2, 'OUTCOME: the refusal touched nothing — only the two evictions removed rows');
  } finally { await done(); }
});

test('an evicted non-anchor tx is not carried back across the wipe by the rescue pass', async () => {
  const { l, done } = await freshLedger();
  try {
    const live = anchor('soc.posted', '1');
    const value = valueTx('xmbA', 'xmbB', 7);
    const doomedValue = valueTx('xmbC', 'xmbD', 9);
    await l.addTransaction(live);
    await l.addTransaction(value);
    await l.addTransaction(doomedValue);

    await l.evict(`xid:${doomedValue.xid}`, 'operator eviction');
    const r = await l.rebuildFromAnchors([feedRow(live)]);

    assert.strictEqual(r.preserved, 1, 'the good value tx was rescued across the wipe');
    assert.strictEqual(r.anchors, 1);
    // OUTCOME: read the surviving rows and name them, rather than trusting the counts above.
    const survivors = [];
    for await (const [, v] of l.db.iterator({ gte: 'block:', lt: 'block;' })) survivors.push(JSON.parse(v.toString()).tx);
    assert.ok(survivors.some((t) => t.type === 'tx' && t.xid === value.xid), 'the good value tx is on disk');
    assert.ok(!survivors.some((t) => t.type === 'tx' && t.xid === doomedValue.xid), 'the evicted one is not');
  } finally { await done(); }
});
