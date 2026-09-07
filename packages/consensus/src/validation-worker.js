import { EventEmitter } from 'events';

/**
 * user-as-validator (E1): a node's own worker loop that reacts to newly
 * created validation tasks, claims ONLY the ones addressed to its own
 * identity (never another leaderId's), runs the check by driving the real
 * completeValidation flow, and reports the result back — counting successes
 * for the caller (node metrics, E1c).
 */
export class ValidationWorker extends EventEmitter {
  constructor({ workflow, identityAddress, onValidationCompleted = null } = {}) {
    super();
    if (!workflow || !identityAddress) {
      throw new Error('ValidationWorker requires a workflow and identityAddress');
    }
    this.workflow = workflow;
    this.identityAddress = identityAddress;
    this.onValidationCompleted = onValidationCompleted;
    this.claimed = new Set(); // taskId -> already claimed, never double-process
    this.running = false;
    this._onCreated = this._onValidationTasksCreated.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.workflow.on('validation_tasks:created', this._onCreated);
    // ⛔ THIS WORKER WAS PURELY EVENT-DRIVEN, AND TASKS OUTLIVE THE EVENT THAT CREATED THEM.
    // validation_tasks:created fires once, when tasks are built. Tasks are then PERSISTED — a restart
    // restores them from disk ("[XPC] stage 2 rehydrated: 957 validation task(s) restored") and no event is
    // ever emitted for them, so nothing claimed them again. The stranded-pool recovery sweep does not help:
    // it skips exactly these, because a tx that already HAS tasks is by its test not stranded, so it reports
    // "recovery: complete, sweep stopped" and exits while the pool sits full.
    //
    // Measured on a live node: 131 raw pooled, 957 restored tasks, validations frozen at 25 across a 70s
    // window, faces_sealed 3, cubes_in_memory 1, cubes_persisted unmoved. Those transactions could never
    // advance and never be evicted as invalid — pure accumulation, which is the leak, and the reason cubes
    // stop part-built: the blocks that would fill the next face never exist.
    //
    // So the worker sweeps for work it ALREADY has on start, then keeps reacting to new events as before.
    // Idempotent via the same `claimed` set, so a task cannot be processed twice.
    Promise.resolve().then(() => this.drainExistingTasks()).catch(() => {});
  }

  // Claim every incomplete task already addressed to this identity — the restart path the creation event
  // cannot cover. Returns how many it ran, so a caller can log a number rather than assert a state.
  async drainExistingTasks() {
    const mine = this.workflow?.taskManager?.getTasksForLeader?.(this.identityAddress) || [];
    let ran = 0;
    for (const task of mine) {
      if (task.complete) continue;
      if (this.claimed.has(task.task)) continue;
      const rawTxId = String(task.task).split(':')[0];
      if (!rawTxId) continue;
      this.claimed.add(task.task);
      try { await this._runCheckAndReport(rawTxId, task); ran++; } catch { /* one bad task must not stop the sweep */ }
    }
    if (ran) console.log(`[XPC] validation worker: claimed ${ran} task(s) that were restored from disk and had no creation event to react to`);
    return ran;
  }

  stop() {
    if (!this.running) return;
    this.workflow.off('validation_tasks:created', this._onCreated);
    this.running = false;
  }

  // E1a: fetch + claim loop. Filter to tasks addressed to THIS identity only
  // — a task assigned to a different leaderId is never touched — and claim
  // atomically (the Set add happens before any await) so a task is never
  // processed twice even if the same rawTxId's creation event fires again.
  async _onValidationTasksCreated({ rawTxId, tasks }) {
    const myTasks = tasks.filter((t) => t.leaderId === this.identityAddress);
    for (const task of myTasks) {
      if (this.claimed.has(task.task)) continue;
      this.claimed.add(task.task);
      await this._runCheckAndReport(rawTxId, task);
    }
  }

  // E1b: run checks + report. The actual check (signature/address ownership)
  // already lives in workflow.completeValidation; this drives it for the
  // claimed task and reports pass/fail back into the xpc flow via its return
  // value, handling both the correct and incorrect cases.
  async _runCheckAndReport(rawTxId, task) {
    // Generate the validation timestamp HERE (a plain ms Number — JSON-safe and stored
    // identically on every node) and carry it in the report, so all nodes average the same
    // three timestamps → the same validatedHash → they seal the identical batch.
    const timestamp = Date.now();
    const passed = await this.workflow.completeValidation(
      rawTxId,
      task.task,
      timestamp,
      null,
      this.identityAddress,
    );

    if (!passed) {
      this.emit('validation:rejected', { rawTxId, taskId: task.task, leaderId: this.identityAddress });
      return;
    }

    // E1c: count validations in node metrics — only on a genuine pass. `count` is the "N/3" progress
    // label (same value completeValidation already logs internally) for consumers surfacing per-tx events.
    if (typeof this.onValidationCompleted === 'function') {
      const count = typeof this.workflow.getValidationCount === 'function' ? this.workflow.getValidationCount(rawTxId) : undefined;
      // The "N/3" label must use the requirement for THIS transaction, not the global constant. With the
      // fabricated leader1/2/3 validators gone, requiredValidations is a CAP and the real requirement is the
      // size of the tx's actual validator set — so a solo node that validated its own tx and sealed it was
      // still reporting "count:0 required:3", which reads as a stalled quorum and was diagnosed as one.
      const required = typeof this.workflow._requiredFor === 'function'
        ? this.workflow._requiredFor(rawTxId)
        : this.workflow.requiredValidations;
      this.onValidationCompleted({ rawTxId, taskId: task.task, count, required });
    }
    // validatorId + timestamp let peers count THIS validation toward their own quorum.
    this.emit('validation:reported', { rawTxId, taskId: task.task, leaderId: this.identityAddress, validatorId: this.identityAddress, timestamp });
  }
}
