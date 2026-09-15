export class StateDiff {
  constructor(txId, changes) {
    this.txId = txId;
    this.timestamp = Date.now();
    this.changes = changes; // key -> new value
  }

  // THE IDENTITY OF A STATE CHANGE IS THE KEY IT WRITES, not the id of whatever block happened to carry it.
  // A node mints a fresh tx id every time it re-submits an anchor, so `diff:<txId>` made one durable row per
  // SUBMISSION: measured on a live node 2026-09-15, 92,505 rows over 50,497 distinct anchors — 42,008 of them
  // redundant, still growing by ~34 every seven hours, and every one of them replayed into the tree on boot.
  // Keying by the change itself makes a re-submission an upsert, which is what it always was semantically.
  // Multi-key changes (explicit `state_diff` txs) have no single content key, so they keep the tx id.
  identity() {
    const keys = Object.keys(this.changes || {});
    return keys.length === 1 ? keys[0] : this.txId;
  }

  apply(state) {
    const newState = { ...state };
    for (const [key, value] of Object.entries(this.changes)) {
      newState[key] = value;
    }
    return newState;
  }

  static merge(diffs) {
    const merged = {};
    for (const diff of diffs) {
      Object.assign(merged, diff.changes);
    }
    return new StateDiff('merged', merged);
  }

  serialize() {
    return JSON.stringify({
      txId: this.txId,
      timestamp: this.timestamp,
      changes: this.changes
    });
  }

  static deserialize(data) {
    const obj = JSON.parse(data);
    return new StateDiff(obj.txId, obj.changes);
  }
}

