// ⛔ ONE DEAD SEED WAS BURYING node.log. The bootstrap retry warned on EVERY attempt for the life of the
// process, so a node whose only seed is down wrote one line per seed per retry interval, indefinitely.
// MEASURED on a live node 2026-09-16: 8,542 identical "seed ... unreachable" lines against 10 give-up lines,
// from a single seed refusing connections. node.log is the file an operator greps; burying it under one dead
// seed is the same defect as not logging at all.
//
// This drives the REAL loop with mocked timers and counts the lines the shipped code actually emits.
import { test, mock } from 'node:test';
import assert from 'node:assert';
import { PeerDiscovery } from './discovery.js';

const SEED = '/ip4/10.0.0.1/tcp/4001/p2p/12D3KooWFakeSeedFakeSeedFakeSeedFakeSeedFakeSeedFa';

function unreachableNode() {
  return {
    on: () => {},                                    // PeerDiscovery subscribes to peer:discovered
    node: {
      peerId: { toString: () => '12D3KooWSelfSelfSelfSelfSelfSelfSelfSelfSelfSelfSelf' },
      dial: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:4001'); },
      getConnections: () => [],
      addEventListener: () => {},
    },
  };
}

async function runAttempts(n, retryMs) {
  const prevWarn = console.warn, prevErr = console.error, prevLog = console.log;
  let unreachableLines = 0, giveUpLines = 0;
  console.warn = (m) => { if (String(m).includes('unreachable (attempt')) unreachableLines++; };
  console.error = (m) => { if (String(m).includes('have not answered in')) giveUpLines++; };
  console.log = () => {};
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const d = new PeerDiscovery(unreachableNode());
    await d.bootstrap([SEED]);          // attempt 1 runs inline
    for (let i = 1; i < n; i++) {
      mock.timers.tick(retryMs);
      await new Promise((r) => setImmediate(r));      // let the async dial reject and the catch run
    }
    d.stop();
  } finally {
    mock.timers.reset();
    console.warn = prevWarn; console.error = prevErr; console.log = prevLog;
  }
  return { unreachableLines, giveUpLines };
}

test('a permanently dead seed stops writing one line per attempt once the retry budget is spent', async () => {
  process.env.XN_BOOTSTRAP_RETRY_MS = '5000';
  process.env.XN_BOOTSTRAP_MAX_TRIES = '10';
  process.env.XN_BOOTSTRAP_QUIET_EVERY = '10';
  const ATTEMPTS = 100;

  const r = await runAttempts(ATTEMPTS, 5000);

  // Before the fix this was exactly ATTEMPTS. Now: every attempt while the budget lasts, then 1 per 10.
  assert.ok(r.unreachableLines < ATTEMPTS, `must not warn on every attempt (got ${r.unreachableLines}/${ATTEMPTS})`);
  assert.strictEqual(r.unreachableLines, 19, '10 while the budget lasts, then attempts 20,30,...,100');
  // And it must NOT go silent — a seed that comes back has to be able to reconnect, and an operator has to
  // be able to see that the node is still isolated.
  assert.ok(r.unreachableLines > 0, 'still reports, just not every tick');
  assert.strictEqual(r.giveUpLines, 1, 'the loud give-up is said exactly once, not repeated');

  delete process.env.XN_BOOTSTRAP_RETRY_MS;
  delete process.env.XN_BOOTSTRAP_MAX_TRIES;
  delete process.env.XN_BOOTSTRAP_QUIET_EVERY;
});
