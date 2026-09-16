// WHICH FEED MAY BE HANDED TO THIS NODE — the coordinator's pre-flight, answered by the RUNNING code.
//
// The coordinator disarmed its automatic rebuild_ledger (handoff 08ed182) because it could not tell whether a
// node's rebuild requires typed anchors: its on-disk version probe takes a min across install dirs and reads
// an OLD version while the process already runs the NEW one — inverted polarity during exactly the OTA this
// rollout performs. Handing the DEFAULT canonical feed (~3,990 rows minted before typing, which can never be
// back-mined) to a typed-only node rebuilds an EMPTY chain: measured 0 of 4008. So the node must say so itself.
//
// Asserted by count against the real control socket and the real ledger.
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

const dir = mkdtempSync(join(tmpdir(), 'xmbl-caps-'));
const core = new XMBLCore({ ledger: { dbPath: join(dir, 'l') }, stateMachine: { dbPath: join(dir, 'v') }, storage: { dbPath: join(dir, 's') } });
await core.start();
const sockPath = join(dir, 'n.sock');
const server = await createControlServer({ core, config: {}, sockPath, statusSnapshot: () => ({ pid: process.pid }) });
const call = (req) => new Promise((res, rej) => { const s = net.connect(sockPath); let b = ''; s.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) { s.end(); res(JSON.parse(b.slice(0, i))); } }); s.on('error', rej); s.on('connect', () => s.write(JSON.stringify(req) + '\n')); });

const caps = (await call({ op: 'ledger_capabilities' })).capabilities;
ok('requires_typed_anchors is TRUE on a node that refuses untyped anchors (the feed veto)', caps.requires_typed_anchors === true);
ok('rebuild_is_content_addressed is true — a prior outside the set is still a valid value', caps.rebuild_is_content_addressed === true);
ok('rebuild_counts_untyped is true — a wrong feed shows up in the counts, not as a silent wipe', caps.rebuild_counts_untyped === true);
ok('apply_canonical_accepts_untyped is true — the safe holding pattern mid-rollout', caps.apply_canonical_accepts_untyped === true);
ok('the existing rebuild veto is unchanged', caps.rescues_non_anchor_blocks === true && caps.reports_wiped_count === true);

// THE CLAIM BEHIND EACH FLAG, MEASURED — untyped rows into each op, on the same node.
const untypedFeed = [1, 2, 3].map((i) => ({ event: 'legacy.event', hash: digest('legacy' + i), ts: 1000 + i }));
const typedFeed = [1, 2, 3].map((i) => { const t = micromineTx({ type: 'anchor', event: 'typed.event', hash: digest('typed' + i), ts: 2000 + i }); return { event: t.event, hash: t.hash, ts: t.ts, xid: t.xid, nonce: t.nonce, prior: t.prior }; });

const rbUntyped = await call({ op: 'rebuild_ledger', anchors: untypedFeed });
ok('rebuild_ledger on an UNTYPED feed rebuilds NOTHING and says so (3 untyped, 0 rebuilt)',
  rbUntyped.ok === true && rbUntyped.untyped === 3 && (rbUntyped.anchors?.length ?? rbUntyped.anchors) === 0);
const rbTyped = await call({ op: 'rebuild_ledger', anchors: typedFeed });
ok('rebuild_ledger on a TYPED feed rebuilds all 3 with 0 untyped, 0 rejected',
  rbTyped.ok === true && (rbTyped.anchors?.length ?? rbTyped.anchors) === 3 && rbTyped.untyped === 0 && rbTyped.rejected === 0);

// apply_canonical: untyped rows are FINE and the block store is NOT touched.
const blocksBefore = core.xclt.blocks?.size ?? null;
const ac = await call({ op: 'apply_canonical', anchors: untypedFeed });
const blocksAfter = core.xclt.blocks?.size ?? null;
ok('apply_canonical APPLIES all 3 untyped rows (it reads only event/hash/ts)', ac.ok === true && ac.applied === 3 && ac.skipped === 0);
ok('apply_canonical leaves the block store untouched — non-destructive to the chain', blocksBefore === blocksAfter);
ok('apply_canonical returns a real state root, and the root moved off the before-root', /^[0-9a-f]{64}$/.test(String(ac.state_root)) && ac.state_root !== ac.state_root_before);

// Determinism: the same set applied twice lands on the same root.
const ac2 = await call({ op: 'apply_canonical', anchors: untypedFeed.slice().reverse() });
ok('apply_canonical is order-independent — the root is a pure function of the set', ac2.state_root === ac.state_root);

server.closeAllConnections?.(); await new Promise((r) => server.close(r));
await core.stop?.();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
