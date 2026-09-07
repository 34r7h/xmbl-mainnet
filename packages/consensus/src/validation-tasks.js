// validation_tasks_mempool — stage 2 of the 5-stage mempool workflow.
//
// Tasks are assigned to the transaction's OWN submitter (user-as-validator) alongside other leaders, per the
// consensus process: "Validation tasks created and assigned to transaction user".
//
// ⚠ THIS STAGE MUST PERSIST. It is a mempool tier exactly like rawTx / lockedUtxo / processingTx / tx, and it
// was the only one held purely in memory. On restart the raw pool came back with no tasks attached and nothing
// regenerates them, so every pooled tx was stranded permanently (measured 2026-08-02: raw 856, tasks 0,
// validations 0). `store` is the Mempool; when supplied, every mutation writes through.
export class ValidationTaskManager {
  constructor(options = {}) {
    this.tasks = new Map(); // leaderId -> [ {task, complete, leaderId} ]
    this.store = options.store || null;
  }

  // Rehydrate from the persisted stage-2 mempool. Called after the store's own load completes.
  hydrate() {
    if (!this.store?.getAllValidationTasks) return 0;
    let n = 0;
    for (const [leaderId, tasks] of this.store.getAllValidationTasks()) {
      if (!Array.isArray(tasks) || !tasks.length) continue;
      this.tasks.set(leaderId, tasks);
      n += tasks.length;
    }
    return n;
  }

  // Persist only the slice for ONE rawTxId. Writing the leader's whole array per assign was O(n^2).
  _persist(leaderId, rawTxId) {
    if (!this.store?.setValidationTasksFor) return;
    const whole = this.tasks.get(leaderId) || [];
    const forTx = whole.filter(t => t.task.startsWith(`${rawTxId}:`));
    this.store.setValidationTasksFor(leaderId, rawTxId, forTx, whole);
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
    tasks.forEach(task => {
      if (!this.tasks.has(task.leaderId)) {
        this.tasks.set(task.leaderId, []);
      }
      const list = this.tasks.get(task.leaderId);
      // Idempotent: re-assigning after a restart or a re-gossip must not duplicate a task, or the same
      // validator would appear to have completed it twice and could false-quorum the tx.
      if (!list.some(t => t.task === task.task)) list.push(task);
      touched.add(task.leaderId);
    });
    touched.forEach(leaderId => this._persist(leaderId, rawTxId));
  }

  completeTask(leaderId, taskId) {
    const leaderTasks = this.tasks.get(leaderId);
    if (leaderTasks) {
      const task = leaderTasks.find(t => t.task === taskId);
      if (task && !task.complete) {
        task.complete = true;
        this._persist(leaderId, String(taskId).split(':')[0]);
      }
    }
  }

  getTasksForLeader(leaderId) {
    return this.tasks.get(leaderId) || [];
  }

  getTask(leaderId, taskId) {
    return this.getTasksForLeader(leaderId).find(t => t.task === taskId);
  }

  getKnownLeaderIds() {
    return Array.from(this.tasks.keys());
  }

  // Stage 2 -> stage 4 transition: once a tx reaches processing, its tasks are spent. Dropping them keeps the
  // stage bounded, which matters because it is now on disk.
  clearTasksForRawTx(rawTxId) {
    for (const [leaderId, list] of this.tasks) {
      const kept = list.filter(t => !t.task.startsWith(`${rawTxId}:`));
      if (kept.length === list.length) continue;
      if (kept.length) this.tasks.set(leaderId, kept); else this.tasks.delete(leaderId);
      this.store?.clearValidationTasksFor?.(leaderId, rawTxId);
      if (!kept.length) this.store?.clearValidationTasks?.(leaderId);
    }
  }
}
