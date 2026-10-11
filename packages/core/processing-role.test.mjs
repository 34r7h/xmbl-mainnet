// ONLY A NODE THAT FINALIZES HOLDS THE PROCESSING TIER. The lead role is the one thing that calls finalizeTransaction,
// so core hands the workflow `finalizes` from the same role that builds its LeadWorker: a lead:false node (both
// seeds, 2026-10-11) keeps no processing rows, and a lead node keeps them for its LeadWorker exactly as before.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMBLCore } from './index.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };
const dir = mkdtempSync(join(tmpdir(), 'xmbl-processing-role-'));
const mk = (name, roles) => new XMBLCore({
  roles,
  ledger: { dbPath: join(dir, name, 'ledger') }, stateMachine: { dbPath: join(dir, name, 'vsm') },
  storage: { dbPath: join(dir, name, 'xsc') }, consensus: { dbPath: join(dir, name, 'xpc') },
});

const lead = mk('lead', { lead: true, validate: true });
ok('lead: a LeadWorker and a workflow that finalizes', !!lead.leadWorker && lead.xpc.finalizes === true);
const seed = mk('seed', { lead: false, validate: true, relay: true, storage: true });
ok('lead:false: no LeadWorker and a workflow that keeps no processing tier', lead.leadWorker !== null && seed.leadWorker === null && seed.xpc.finalizes === false);
const bare = mk('bare', undefined);
ok('no roles at all: same as lead:false', bare.leadWorker === null && bare.xpc.finalizes === false);
await Promise.all([lead, seed, bare].map((c) => c.xpc.ready));

for (const c of [lead, seed, bare]) { try { await c.stop?.(); } catch { /* never started */ } }
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
