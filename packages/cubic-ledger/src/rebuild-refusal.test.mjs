// A REBUILD THAT WOULD EMPTY THE CHAIN IS REFUSED — the race the coordinator's restart ordering cannot close.
//
// The broker's DEFAULT canonical feed still serves 4008 rows of which 3991 predate typing and can never be
// back-mined: fed to a node that requires typed anchors it rebuilds to NOTHING. The gate that picks the right
// feed lives in the coordinator PROCESS, so a coordinator still holding old code — or restarted after a node's
// OTA rather than before it — drives exactly that call. Ordering is a promise; this is a refusal.
//
// Asserted by count: what the ledger HELD before the refused call is what it holds after.
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Ledger } from './ledger.js';
import { micromineTx } from './transaction-validator.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const digest = (s) => createHash('sha256').update(String(s)).digest('hex');
const typedRow = (i) => { const t = micromineTx({ type: 'anchor', event: 'typed.event', hash: digest('typed' + i), ts: 1000 + i }); return { event: t.event, hash: t.hash, ts: t.ts, xid: t.xid, nonce: t.nonce, prior: t.prior }; };
const untypedRow = (i) => ({ event: 'legacy.event', hash: digest('legacy' + i), ts: 2000 + i });

const dir = mkdtempSync(join(tmpdir(), 'xmbl-refuse-'));
const l = new Ledger({ dbPath: dir });
await l.initialize?.();

// A node with a real chain: 12 typed anchors rebuilt into blocks.
const seed = Array.from({ length: 12 }, (_, i) => typedRow(i));
const first = await l.rebuildFromAnchors(seed);
ok('a typed set rebuilds normally (12 of 12, nothing refused)', first.refused === undefined && first.anchors === 12);
const heldBlocks = l.blocks.size, heldCubes = l.cubes.size, heldFaces = first.faces_sealed;
ok('the node now holds a chain (blocks > 0)', heldBlocks === 12);

// THE DANGEROUS CALL: the old default feed, all untyped, handed to this typed-only node.
const oldFeed = Array.from({ length: 40 }, (_, i) => untypedRow(i));
const refused = await l.rebuildFromAnchors(oldFeed);
ok('an all-untyped feed is REFUSED, not applied', refused.refused === 'would-empty-the-chain');
ok('the refusal counts what it saw (40 offered, 40 untyped, 0 would rebuild)',
   refused.requested === 40 && refused.untyped === 40 && refused.would_rebuild === 0 && refused.rejected === 0);
ok('the refusal names the fix (the epoch-scoped feed / the capability)', /from_epoch=1/.test(refused.reason) && /requires_typed_anchors/.test(refused.reason));
ok('NOTHING WAS TOUCHED: the block count is unchanged', l.blocks.size === heldBlocks);
ok('nothing was touched: the cube count is unchanged', l.cubes.size === heldCubes);
ok('the refusal reports how many blocks it protected', refused.blocks_held === heldBlocks + 0 || refused.blocks_held >= heldBlocks);

// A feed of TYPED-BUT-FORGED rows is refused the same way (they reject, they do not rebuild).
const forged = seed.map((r) => ({ ...r, hash: digest('tampered' + r.hash) }));
const refused2 = await l.rebuildFromAnchors(forged);
ok('a feed whose every typed row is forged is REFUSED too', refused2.refused === 'would-empty-the-chain' && refused2.rejected === 12 && refused2.untyped === 0);
ok('still nothing touched after the second refusal', l.blocks.size === heldBlocks && l.cubes.size === heldCubes);

// A MIXED feed that still rebuilds SOMETHING is allowed — the rule is narrow, not a veto on shrinking.
const mixed = [...Array.from({ length: 9 }, (_, i) => typedRow(100 + i)), ...Array.from({ length: 20 }, (_, i) => untypedRow(100 + i))];
const applied = await l.rebuildFromAnchors(mixed);
ok('a mixed feed that rebuilds 9 of 29 is APPLIED (a legitimate shrink is not blocked)',
   applied.refused === undefined && applied.anchors === 9 && applied.untyped === 20);
ok('the chain is now the mixed set, so the rebuild really did run', l.blocks.size === 9);

// An EMPTY node accepts anything — there is nothing to protect.
const dir2 = mkdtempSync(join(tmpdir(), 'xmbl-refuse2-'));
const fresh = new Ledger({ dbPath: dir2 });
await fresh.initialize?.();
const onEmpty = await fresh.rebuildFromAnchors(oldFeed);
ok('an EMPTY node is not refused — it has no chain to lose (0 rebuilt, 40 untyped, reported accurately)',
   onEmpty.refused === undefined && onEmpty.untyped === 40 && onEmpty.anchors === 0);

await l.close?.(); await fresh.close?.();
rmSync(dir, { recursive: true, force: true }); rmSync(dir2, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
