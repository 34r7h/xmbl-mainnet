// OUTCOME TEST: applied_tx_count after the convergence primitive. The metric every node reads.
const { StateMachine } = await import("../index.js");
const sm = new StateMachine({ dbPath: null });
sm._dbOpen = false;
const anchors = Array.from({ length: 3941 }, (_, i) => ({ event: 'task.created', hash: 'h' + i, ts: 1000 + i }));
const r = await sm.rebuildFromCanonical(anchors);
const s = sm.getStatistics();
console.log(`ROOT ${r.state_root.slice(0,10)}  applied(returned) ${r.applied}  applied_tx_count(published) ${s.totalTransactions}`);
// idempotence: the same set twice must not double the count
const r2 = await sm.rebuildFromCanonical(anchors);
console.log(`SECOND PASS same set: root ${r2.state_root.slice(0,10)}  applied_tx_count ${sm.getStatistics().totalTransactions}`);
process.exit(0);
