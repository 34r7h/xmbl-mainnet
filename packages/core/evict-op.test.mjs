// REMOVING ONE ANCHOR FROM A NODE — the op that did not exist while `ledger_capabilities` advertised it.
//
// `evicts_invalid_for_good: true` has been on the wire since 0.1.9 for `xclt.evict()`, and nothing on the
// control socket could call it. So the only way a coordinator could drop a named anchor was `rebuild_ledger`,
// which gets there by WIPING the block store — the exact operation a node answering
// `rescues_non_anchor_blocks: false` must never be given. The nodes that most needed a specific row removed
// were the nodes with no way to remove it.
//
// A removal is only real if it holds in THREE places: the ledger (block row + pool + anchor-dedup + the
// durable `evicted:` key), the verkle tree (the `anchor:<event>:<hash>` key, or the state root does not move),
// and the `diff:` row behind that key (or the next boot replays it back into an empty tree). Each is asserted
// by reading the store AFTER the call — never from the op's own return flag.
import assert from 'node:assert';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { XMBLCore } from './index.js';
import { createControlServer } from './control-socket.js';
import { micromineTx } from '@xmbl/cubic-ledger';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const digest = (s) => createHash('sha256').update(String(s)).digest('hex');

const dir = mkdtempSync(join(tmpdir(), 'xmbl-evict-'));
const core = new XMBLCore({ ledger: { dbPath: join(dir, 'l') }, stateMachine: { dbPath: join(dir, 'v') }, storage: { dbPath: join(dir, 's') } });
await core.start();
const sockPath = join(dir, 'n.sock');
const server = await createControlServer({ core, config: {}, sockPath, statusSnapshot: () => ({ pid: process.pid }) });
const call = (req) => new Promise((res, rej) => { const s = net.connect(sockPath); let b = ''; s.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) { s.end(); res(JSON.parse(b.slice(0, i))); } }); s.on('error', rej); s.on('connect', () => s.write(JSON.stringify(req) + '\n')); });

const row = (t) => ({ event: t.event, hash: t.hash, ts: t.ts, xid: t.xid, nonce: t.nonce, prior: t.prior });
const mk = (event, seed) => micromineTx({ type: 'anchor', event, hash: digest(seed), ts: 3000 });

// The capability must answer for the OP, not for the method — the coordinator gates XMBL_XOPS on this flag.
const caps = (await call({ op: 'ledger_capabilities' })).capabilities;
ok('ledger_capabilities.evict_op is true — the flag now names something a caller can reach', caps.evict_op === true);
ok('ledger_capabilities.eviction_survives_rebuild is true', caps.eviction_survives_rebuild === true);

// A node holding three anchors, applied to the verkle tree the way the canonical feed applies them.
const keep = mk('task.created', 'keep');
const doomedB = mk('value.transfer', 'B-class');
const doomedC = mk('task.verified', 'C-class');
const feed = [row(keep), row(doomedB), row(doomedC)];
const built = await call({ op: 'rebuild_ledger', anchors: feed });
ok('setup: three typed anchors rebuilt', built.ok === true && built.anchors === 3);

const stateKey = (t) => `anchor:${t.event}:${t.hash}`;
const present = async (t) => (await call({ op: 'state_tree', key: stateKey(t) })).present;
ok('setup: all three are keys in the verkle tree', (await present(keep)) && (await present(doomedB)) && (await present(doomedC)));
const rootBefore = built.state_root;

// ---- the op ----
const ev = await call({ op: 'evict', keys: [stateKey(doomedB), `${doomedC.event}:${doomedC.hash}`] });
ok('evict accepts BOTH spellings — anchor:<event>:<hash> and the bare content key', ev.ok === true && ev.requested === 2 && ev.evicted === 2);
ok('evict reports was_present per key, read BEFORE the delete', ev.keys.every((k) => k.was_present === true));
ok('evict reports the state root moved', ev.root_moved === true && ev.state_root !== rootBefore);

// OUTCOME 1 — the verkle tree.
ok('OUTCOME: the evicted keys are gone from the tree', (await present(doomedB)) === false && (await present(doomedC)) === false);
ok('OUTCOME: the key that was not named is untouched', (await present(keep)) === true);

// OUTCOME 2 — the ledger's own anchor set and block store.
ok('OUTCOME: the ledger no longer holds either anchor',
  !core.xclt._anchorKeys.has(`${doomedB.event}:${doomedB.hash}`) && !core.xclt._anchorKeys.has(`${doomedC.event}:${doomedC.hash}`));
ok('OUTCOME: the durable evicted: set names both', core.xclt._evicted.has(`${doomedB.event}:${doomedB.hash}`) && core.xclt._evicted.has(`${doomedC.event}:${doomedC.hash}`));

// OUTCOME 3 — the diff row. Left behind, _loadDiffs replays it into an empty tree on the next boot and the
// deletion lasts exactly until the next restart.
let diffRows = 0;
for await (const [k] of core.xvsm.db.iterator({ gte: 'diff:', lt: 'diff:\xFF' })) {
  const name = k.toString();
  if (name === `diff:${stateKey(doomedB)}` || name === `diff:${stateKey(doomedC)}`) diffRows++;
}
ok('OUTCOME: the durable diff: rows behind the evicted keys are gone', diffRows === 0);

// THE WHOLE POINT — the next convergence tick hands the node a feed that still carries them.
const after = await call({ op: 'rebuild_ledger', anchors: feed });
ok('a rebuild from the STALE feed refuses the evicted rows and says how many', after.ok === true && after.evicted_skipped === 2 && after.anchors === 1);
ok('OUTCOME: they are still absent from the tree after that rebuild', (await present(doomedB)) === false && (await present(doomedC)) === false);
ok('OUTCOME: and the live anchor is still there', (await present(keep)) === true);

// AND THE OTHER APPLY PATH. A node that cannot survive a wipe is driven by apply_canonical, never by
// rebuild_ledger — so that is the op where an unfiltered feed would quietly reinstate every evicted key.
const ac = await call({ op: 'apply_canonical', anchors: feed });
ok('apply_canonical from the STALE feed drops the evicted rows and says how many', ac.ok === true && ac.evicted_skipped === 2 && ac.applied === 1);
ok('OUTCOME: still absent from the tree after apply_canonical', (await present(doomedB)) === false && (await present(doomedC)) === false);
ok('OUTCOME: the live anchor survived apply_canonical', (await present(keep)) === true);

// THE OTHER SPELLING. `evict` accepts `xid:<xid>`, and a canonical row carries BOTH names — so a row evicted
// by its xid must be refused by the same filters as one evicted by its content key, or the block stays gone
// while the verkle key comes straight back on the next apply. Same defect, other door.
const byXid = mk('soc.posted', 'xid-spelling');
const feed2 = [row(keep), row(byXid)];
await call({ op: 'rebuild_ledger', anchors: feed2 });
ok('setup: the xid-spelling anchor is in the tree', (await present(byXid)) === true);
const evx = await call({ op: 'evict', keys: [`xid:${byXid.xid}`] });
ok('evict accepts the xid: spelling', evx.ok === true && evx.evicted === 1);
const rb2 = await call({ op: 'rebuild_ledger', anchors: feed2 });
ok('rebuild_ledger refuses a row evicted by XID', rb2.evicted_skipped === 1 && rb2.anchors === 1);
ok('OUTCOME: evicted-by-xid is absent from the tree after rebuild_ledger', (await present(byXid)) === false);
const ac2 = await call({ op: 'apply_canonical', anchors: feed2 });
ok('apply_canonical refuses a row evicted by XID', ac2.evicted_skipped === 1 && ac2.applied === 1);
ok('OUTCOME: evicted-by-xid is absent from the tree after apply_canonical', (await present(byXid)) === false);

// A key this node never held is a legitimate answer, not a failure — that is how a caller sweeping the fleet
// tells "never had it" from "had it, removed it".
const never = await call({ op: 'evict', keys: ['anchor:task.created:' + digest('never-seen-here')] });
ok('evicting a key this node never held answers ok with was_present:false', never.ok === true && never.keys[0].was_present === false);

// Refusals.
ok('evict with no keys is refused', (await call({ op: 'evict' })).ok === false);
const tooMany = await call({ op: 'evict', keys: new Array(501).fill('anchor:x:y') });
ok('evict is capped at 500 keys per call', tooMany.ok === false && /capped at 500/.test(tooMany.error));

server.close();
await core.stop?.();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
