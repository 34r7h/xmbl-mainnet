// THE WORKER THAT MAKES A NODE A VALIDATOR WAS 21.6% COVERED.
//
// ValidationWorker is E1: the loop that claims validation tasks addressed to this node, runs the check,
// and reports the result. Its own header records a live incident — 131 raw pooled transactions, 957
// validation tasks restored from disk, validations frozen at 25 across a 70-second window — caused by
// the worker being purely event-driven while tasks OUTLIVE the event that created them. The fix (a
// drain sweep on start) had no test. Neither did the claim filter that stops this node touching another
// leader's tasks, nor the idempotency that stops one task being validated twice.
//
// The workflow is faked here on purpose: the point is the worker's claim/report contract, and a fake is
// the only way to drive the restart path (tasks present, no event ever emitted) deterministically.
import { EventEmitter } from 'node:events';
import { ValidationWorker } from './validation-worker.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const tick = () => new Promise((r) => setImmediate(r));

const ME = '0xME', OTHER = '0xOTHER';

// A workflow stand-in with the surface the worker actually uses.
function makeWorkflow({ tasks = [], pass: passes = () => true, counts = {}, requiredFor = null } = {}) {
  const wf = new EventEmitter();
  wf.completed = [];
  wf.taskManager = { getTasksForLeader: (leader) => tasks.filter((t) => t.leaderId === leader) };
  wf.requiredValidations = 3;
  wf.completeValidation = async (rawTxId, taskId, timestamp, _unused, validator) => {
    wf.completed.push({ rawTxId, taskId, timestamp, validator });
    return passes(rawTxId, taskId);
  };
  wf.getValidationCount = (rawTxId) => counts[rawTxId] ?? 0;
  if (requiredFor) wf._requiredFor = requiredFor;
  return wf;
}
const task = (id, leaderId = ME, complete = false) => ({ task: id, leaderId, complete });

// ── 1. CONSTRUCTION REFUSES A WORKER THAT COULD NOT VALIDATE ANYTHING ──
{
  const bad = (args) => { try { new ValidationWorker(args); return false; } catch (e) { return /requires a workflow and identityAddress/.test(e.message); } };
  ok('a worker with no workflow is refused', bad({ identityAddress: ME }));
  ok('a worker with no identity is refused — it could not tell its tasks from anyone else\'s',
     bad({ workflow: makeWorkflow() }));
  ok('a worker with neither is refused', bad({}) && bad(undefined));
  const w = new ValidationWorker({ workflow: makeWorkflow(), identityAddress: ME });
  ok('a valid worker starts not running with nothing claimed', w.running === false && w.claimed.size === 0);
}

// ── 2. A NODE CLAIMS ONLY ITS OWN TASKS ──
// Claiming another leader's task is not a performance bug; it is a node validating work it was not
// assigned, which corrupts the quorum count for that transaction on every node that believes it.
{
  const wf = makeWorkflow();
  const w = new ValidationWorker({ workflow: wf, identityAddress: ME });
  w.start();
  await tick();

  wf.emit('validation_tasks:created', { rawTxId: 'tx1', tasks: [task('tx1:a', ME), task('tx1:b', OTHER)] });
  await tick();
  ok('the task addressed to this node is run', wf.completed.some((c) => c.taskId === 'tx1:a'));
  ok('THE TASK ADDRESSED TO ANOTHER LEADER IS NEVER TOUCHED',
     !wf.completed.some((c) => c.taskId === 'tx1:b'));
  ok('only the claimed one is recorded as claimed', w.claimed.has('tx1:a') && !w.claimed.has('tx1:b'));

  wf.emit('validation_tasks:created', { rawTxId: 'tx2', tasks: [task('tx2:a', OTHER), task('tx2:b', OTHER)] });
  await tick();
  ok('an event carrying nothing for this node runs nothing', wf.completed.length === 1);

  wf.emit('validation_tasks:created', { rawTxId: 'tx3', tasks: [] });
  await tick();
  ok('an empty task list is handled without error', wf.completed.length === 1);
  w.stop();
}

// ── 3. A TASK IS NEVER PROCESSED TWICE, EVEN IF ITS EVENT FIRES AGAIN ──
{
  const wf = makeWorkflow();
  const w = new ValidationWorker({ workflow: wf, identityAddress: ME });
  w.start();
  await tick();

  const ev = { rawTxId: 'tx1', tasks: [task('tx1:a', ME)] };
  wf.emit('validation_tasks:created', ev);
  await tick();
  wf.emit('validation_tasks:created', ev);
  await tick();
  wf.emit('validation_tasks:created', ev);
  await tick();
  ok('A REPEATED CREATION EVENT VALIDATES THE TASK EXACTLY ONCE', wf.completed.length === 1);
  ok('the claim set holds one entry, not three', w.claimed.size === 1);
  w.stop();
}

// ── 4. THE RESTART PATH: TASKS THAT EXIST WITH NO EVENT TO ANNOUNCE THEM ──
// This is the incident. Tasks are persisted; a restart rehydrates them; validation_tasks:created never
// fires for a rehydrated task. Before the drain sweep, the pool simply accumulated forever.
{
  const restored = [task('a1:0', ME), task('a2:0', ME), task('b1:0', OTHER), task('c1:0', ME, true)];
  const wf = makeWorkflow({ tasks: restored });
  const w = new ValidationWorker({ workflow: wf, identityAddress: ME });

  ok('before start, nothing has been claimed', wf.completed.length === 0);
  w.start();
  await tick(); await tick();

  ok('ON START, TASKS RESTORED FROM DISK ARE CLAIMED WITHOUT ANY EVENT', wf.completed.length === 2);
  ok('another leader\'s restored task is still not touched', !wf.completed.some((c) => c.taskId === 'b1:0'));
  ok('AN ALREADY-COMPLETE TASK IS SKIPPED — the sweep does not re-validate finished work',
     !wf.completed.some((c) => c.taskId === 'c1:0'));
  ok('the rawTxId is parsed off the task id for the check',
     wf.completed.map((c) => c.rawTxId).sort().join(',') === 'a1,a2');

  const ran = await w.drainExistingTasks();
  ok('A SECOND SWEEP CLAIMS NOTHING — the drain is idempotent against the same claim set', ran === 0);
  ok('...and runs no further validations', wf.completed.length === 2);
  w.stop();
}

// ── 5. ONE BAD TASK MUST NOT STOP THE SWEEP ──
// The sweep is the recovery path. If it aborts on the first throw, a node that accumulated one poisoned
// task never recovers any of the others — the accumulation the sweep exists to clear.
{
  const wf = makeWorkflow({ tasks: [task('x1:0', ME), task('x2:0', ME), task('x3:0', ME)] });
  const seen = [];
  wf.completeValidation = async (rawTxId) => {
    seen.push(rawTxId);
    if (rawTxId === 'x2') throw new Error('this task is poison');
    return true;
  };
  const w = new ValidationWorker({ workflow: wf, identityAddress: ME });
  const ran = await w.drainExistingTasks();
  ok('EVERY TASK IS ATTEMPTED EVEN THOUGH ONE THREW', seen.length === 3);
  ok('the two good tasks are counted as run, the thrower is not', ran === 2);
  ok('the failed task stays claimed, so the sweep does not spin on it forever', w.claimed.has('x2:0'));
}

// ── 6. A WORKFLOW WITH NO TASK MANAGER AT ALL ──
// The sweep runs on every start, including on a workflow shape that predates the task manager.
{
  const wf = new EventEmitter();
  wf.completeValidation = async () => true;
  const w = new ValidationWorker({ workflow: wf, identityAddress: ME });
  let threw = null;
  try { ok('a workflow with no taskManager sweeps zero tasks instead of throwing', await w.drainExistingTasks() === 0); }
  catch (e) { threw = e; fail++; console.log('FAIL the sweep threw: ' + e.message); }
  w.start();
  await tick(); await tick();
  ok('...and start() survives it (the sweep rejection is swallowed by design)', w.running === true && threw === null);
  w.stop();
}

// ── 7. PASS AND FAIL ARE REPORTED DIFFERENTLY, AND ONLY A PASS COUNTS ──
{
  const events = { reported: [], rejected: [] };
  const counted = [];
  const wf = makeWorkflow({ pass: (rawTxId) => rawTxId !== 'bad', counts: { good: 2 } });
  const w = new ValidationWorker({ workflow: wf, identityAddress: ME, onValidationCompleted: (x) => counted.push(x) });
  w.on('validation:reported', (e) => events.reported.push(e));
  w.on('validation:rejected', (e) => events.rejected.push(e));
  w.start(); await tick();

  wf.emit('validation_tasks:created', { rawTxId: 'good', tasks: [task('good:0', ME)] });
  await tick();
  ok('a passing validation emits validation:reported', events.reported.length === 1);
  ok('it carries the validator id and a timestamp, so peers can count it toward their own quorum',
     events.reported[0].validatorId === ME && typeof events.reported[0].timestamp === 'number');
  ok('the timestamp is a plain JSON-safe Number, not a BigInt — every node must store it identically',
     Number.isInteger(events.reported[0].timestamp));
  ok('the completion callback fires with the progress count', counted.length === 1 && counted[0].count === 2);

  wf.emit('validation_tasks:created', { rawTxId: 'bad', tasks: [task('bad:0', ME)] });
  await tick();
  ok('A FAILING VALIDATION EMITS validation:rejected, NOT reported',
     events.rejected.length === 1 && events.reported.length === 1);
  ok('AND IT IS NOT COUNTED — only a genuine pass increments node metrics', counted.length === 1);
  ok('the rejection names the task and this node', events.rejected[0].taskId === 'bad:0' && events.rejected[0].leaderId === ME);
  w.stop();
}

// ── 8. THE "N/3" LABEL USES THIS TRANSACTION'S REQUIREMENT, NOT THE GLOBAL CAP ──
// A solo node that validated its own transaction and sealed it was reporting "count:0 required:3",
// which reads as a stalled quorum and was diagnosed as one.
{
  const counted = [];
  const wf = makeWorkflow({ counts: { tx: 1 }, requiredFor: () => 1 });
  const w = new ValidationWorker({ workflow: wf, identityAddress: ME, onValidationCompleted: (x) => counted.push(x) });
  w.start(); await tick();
  wf.emit('validation_tasks:created', { rawTxId: 'tx', tasks: [task('tx:0', ME)] });
  await tick();
  ok('THE REQUIREMENT COMES FROM _requiredFor(tx) — the tx\'s real validator set, not the cap',
     counted[0].required === 1);
  ok('...and it does not read as a stalled quorum', counted[0].count >= counted[0].required);
  w.stop();

  const counted2 = [];
  const wf2 = makeWorkflow({ counts: { tx: 1 } });                       // no _requiredFor
  const w2 = new ValidationWorker({ workflow: wf2, identityAddress: ME, onValidationCompleted: (x) => counted2.push(x) });
  w2.start(); await tick();
  wf2.emit('validation_tasks:created', { rawTxId: 'tx', tasks: [task('tx:0', ME)] });
  await tick();
  ok('a workflow without _requiredFor falls back to the global requiredValidations', counted2[0].required === 3);
  w2.stop();

  const counted3 = [];
  const wf3 = makeWorkflow();
  delete wf3.getValidationCount;
  const w3 = new ValidationWorker({ workflow: wf3, identityAddress: ME, onValidationCompleted: (x) => counted3.push(x) });
  w3.start(); await tick();
  wf3.emit('validation_tasks:created', { rawTxId: 'tx', tasks: [task('tx:0', ME)] });
  await tick();
  ok('a workflow with no count function reports undefined rather than throwing', counted3[0].count === undefined);
  w3.stop();
}

// ── 9. START AND STOP ARE BOTH IDEMPOTENT, AND STOP REALLY DETACHES ──
{
  const wf = makeWorkflow();
  const w = new ValidationWorker({ workflow: wf, identityAddress: ME });
  w.start(); w.start(); w.start();
  await tick();
  ok('starting three times registers ONE listener, not three',
     wf.listenerCount('validation_tasks:created') === 1);

  w.stop();
  ok('stop detaches the listener', wf.listenerCount('validation_tasks:created') === 0);
  ok('stop marks the worker not running', w.running === false);
  w.stop(); w.stop();
  ok('stopping an already-stopped worker is harmless', wf.listenerCount('validation_tasks:created') === 0);

  wf.emit('validation_tasks:created', { rawTxId: 'tx', tasks: [task('tx:0', ME)] });
  await tick();
  ok('A STOPPED WORKER VALIDATES NOTHING', wf.completed.length === 0);

  w.start();
  await tick();
  wf.emit('validation_tasks:created', { rawTxId: 'tx', tasks: [task('tx:0', ME)] });
  await tick();
  ok('a restarted worker picks up work again', wf.completed.length === 1);
  ok('...and the claim set survived the stop, so nothing is re-validated', w.claimed.size === 1);
  w.stop();
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
