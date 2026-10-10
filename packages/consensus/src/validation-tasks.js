// validation_tasks_mempool — stage 2 of the 5-stage mempool workflow.
//
// Tasks are assigned to the transaction's OWN submitter (user-as-validator) alongside other leaders, per the
// consensus process: "Validation tasks created and assigned to transaction user".
//
// ⚠ THIS STAGE MUST PERSIST. It is a mempool tier exactly like rawTx / lockedUtxo / processingTx / tx, and it
// was the only one held purely in memory. On restart the raw pool came back with no tasks attached and nothing
// regenerates them, so every pooled tx was stranded permanently (measured 2026-08-02: raw 856, tasks 0,
// validations 0). `store` is the Mempool; when supplied, every mutation writes through.
// INDEXED, NOT SCANNED. Each leader's tasks were one array, and every assign, completion, persist and lookup
// walked it, as did every clear (one walk per leader, plus a rebuilt array); with n txs in flight that is O(n) per
// operation and O(n^2) per run. Measured on 4 real nodes, 2007 node-signed datums: 0.45 s of 10.9 s per node in
// this file. A leader's tasks are now a Map by task id, and a tx's tasks are indexed by its rawTxId.
const rawTxIdOf = (taskId) => { const s = String(taskId); const i = s.indexOf(':'); return i < 0 ? s : s.slice(0, i); };

export class ValidationTaskManager {
  constructor(options = {}) {
    this.tasks = new Map(); // leaderId -> Map(taskId -> {task, complete, leaderId}), in assignment order
    this._byTx = new Map(); // rawTxId -> Map(leaderId -> [task])
    this.store = options.store || null;
  }

  _index(leaderId, task) {
    let mine = this.tasks.get(leaderId);
    if (!mine) this.tasks.set(leaderId, (mine = new Map()));
    // Idempotent: re-assigning after a restart or a re-gossip must not duplicate a task, or the same
    // validator would appear to have completed it twice and could false-quorum the tx.
    if (mine.has(task.task)) return false;
    mine.set(task.task, task);
    const rawTxId = rawTxIdOf(task.task);
    let byLeader = this._byTx.get(rawTxId);
    if (!byLeader) this._byTx.set(rawTxId, (byLeader = new Map()));
    const list = byLeader.get(leaderId);
    if (list) list.push(task); else byLeader.set(leaderId, [task]);
    return true;
  }

  // Rehydrate from the persisted stage-2 mempool. Called after the store's own load completes. `keep(rawTxId)`,
  // when given, decides which txs' tasks are still wanted; the rest are dropped here and on disk (a tx that
  // reached processing before this fix left its tasks behind forever).
  hydrate(keep = null) {
    if (!this.store?.getAllValidationTasks) return 0;
    const all = this.store.getAllValidationTasks();
    let n = 0;
    const dropped = new Set();
    for (const [leaderId, tasks] of all) {
      if (!Array.isArray(tasks)) continue;
      for (const t of tasks) {
        if (!t || typeof t.task !== 'string') continue;
        if (keep && !keep(rawTxIdOf(t.task))) { dropped.add(`${leaderId}\u0000${rawTxIdOf(t.task)}`); continue; }
        if (this._index(leaderId, t)) n++;
      }
    }
    for (const k of dropped) { const [leaderId, rawTxId] = k.split('\u0000'); this.store.clearValidationTasksFor?.(leaderId, rawTxId); }
    // This manager owns stage 2 from here on; the store's boot-time copy would only go stale.
    if (typeof all?.clear === 'function') all.clear();
    return n;
  }

  // Persist only the slice for ONE rawTxId. Writing the leader's whole array per assign was O(n^2).
  _persist(leaderId, rawTxId) {
    if (!this.store?.setValidationTasksFor) return;
    this.store.setValidationTasksFor(leaderId, rawTxId, this.tasksOf(leaderId, rawTxId));
  }

  createTasks(rawTxId, leaderIds) {
    return leaderIds.map(leaderId => ({
      task: `${rawTxId}:${leaderId}:validate`,
      complete: false,
      leaderId
    }));
  }

  assignTasks(rawTxId, tasks) {
    const touched = new Set();
    for (const task of tasks) {
      this._index(task.leaderId, task);
      touched.add(task.leaderId);
    }
    touched.forEach(leaderId => this._persist(leaderId, rawTxId));
  }

  completeTask(leaderId, taskId) {
    const task = this.tasks.get(leaderId)?.get(taskId);
    if (task && !task.complete) {
      task.complete = true;
      this._persist(leaderId, rawTxIdOf(taskId));
    }
  }

  /** A copy of the leader's tasks, in assignment order. */
  getTasksForLeader(leaderId) {
    const mine = this.tasks.get(leaderId);
    return mine ? [...mine.values()] : [];
  }

  getTask(leaderId, taskId) {
    return this.tasks.get(leaderId)?.get(taskId);
  }

  /** The leader's tasks for one tx. */
  tasksOf(leaderId, rawTxId) {
    return this._byTx.get(rawTxId)?.get(leaderId) || [];
  }

  /** The leaders holding a task for this tx. */
  leadersHolding(rawTxId) {
    const byLeader = this._byTx.get(rawTxId);
    return byLeader ? [...byLeader.keys()] : [];
  }

  getKnownLeaderIds() {
    return Array.from(this.tasks.keys());
  }

  /** How many tasks are held, over how many txs. */
  size() {
    let tasks = 0;
    for (const mine of this.tasks.values()) tasks += mine.size;
    return { tasks, txs: this._byTx.size };
  }

  // Stage 2 -> stage 4 transition: once a tx reaches processing, its tasks are spent. Dropping them keeps the
  // stage bounded, which matters because it is now on disk.
  clearTasksForRawTx(rawTxId) {
    const byLeader = this._byTx.get(rawTxId);
    if (!byLeader) return;
    this._byTx.delete(rawTxId);
    for (const [leaderId, list] of byLeader) {
      const mine = this.tasks.get(leaderId);
      if (mine) for (const t of list) mine.delete(t.task);
      this.store?.clearValidationTasksFor?.(leaderId, rawTxId);
      if (mine && !mine.size) { this.tasks.delete(leaderId); this.store?.clearValidationTasks?.(leaderId); }
    }
  }
}
