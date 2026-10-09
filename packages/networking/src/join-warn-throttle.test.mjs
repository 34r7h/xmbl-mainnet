// ⛔ ONE DEAD ADDRESS WAS BURYING node.log. The dial loop warned on EVERY attempt for the life of the
// process, so a node whose only configured peer is down wrote one line per address per retry interval,
// indefinitely. MEASURED on a live node 2026-09-16: 8,542 identical "... unreachable" lines against 10 give-up
// lines, from a single address refusing connections. node.log is the file an operator greps; burying it under
// one dead address is the same defect as not logging at all.
//
// This drives the REAL loop with mocked timers and counts the lines the shipped code actually emits.
import { test, mock } from 'node:test';
import assert from 'node:assert';
import { PeerDiscovery } from './discovery.js';

const DEAD = '/ip4/10.0.0.1/tcp/4001/p2p/12D3KooWFakeDeadFakeDeadFakeDeadFakeDeadFakeDeadFa';

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
  let pastBudgetRatioLines = 0;
  console.warn = (m) => {
    const t = String(m);
    if (!t.includes('did not answer (round')) return;
    unreachableLines++;
    // A counter printed past its own denominator is the tell that the loop outlived its bound.
    const m2 = /round (\d+)\/(\d+)/.exec(t);
    if (m2 && Number(m2[1]) > Number(m2[2])) pastBudgetRatioLines++;
  };
  console.error = (m) => { if (String(m).includes('holds NO peers and is isolated')) giveUpLines++; };
  console.log = () => {};
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const d = new PeerDiscovery(unreachableNode());
    await d.join({ given: [DEAD] });    // round 1 runs inline
    for (let i = 1; i < n; i++) {
      mock.timers.tick(retryMs);
      await new Promise((r) => setImmediate(r));      // let the async dial reject and the catch run
    }
    d.stop();
  } finally {
    mock.timers.reset();
    console.warn = prevWarn; console.error = prevErr; console.log = prevLog;
  }
  return { unreachableLines, giveUpLines, pastBudgetRatioLines };
}

test('a permanently dead address stops writing one line per round once the retry budget is spent', async () => {
  process.env.XN_JOIN_RETRY_MS = '5000';
  process.env.XN_JOIN_MAX_TRIES = '10';
  process.env.XN_JOIN_QUIET_EVERY = '10';
  const ATTEMPTS = 100;

  const r = await runAttempts(ATTEMPTS, 5000);

  // Before the fix this was exactly ATTEMPTS. Now: every round while the budget lasts, then 1 per 10.
  assert.ok(r.unreachableLines < ATTEMPTS, `must not warn on every round (got ${r.unreachableLines}/${ATTEMPTS})`);
  assert.strictEqual(r.unreachableLines, 19, '10 while the budget lasts, then rounds 20,30,...,100');
  // And it must NOT go silent — a peer that comes back has to be able to reconnect, and an operator has to
  // be able to see that the node is still isolated.
  assert.ok(r.unreachableLines > 0, 'still reports, just not every tick');
  assert.strictEqual(r.giveUpLines, 1, 'the loud give-up is said exactly once, not repeated');
  // The original line read "attempt 206/40". A ratio past its own denominator says the loop outlived the
  // bound that was supposed to stop it — a different fault from the volume, and the one a reader who only
  // counts lines would leave behind.
  assert.strictEqual(r.pastBudgetRatioLines, 0, 'never print round N/MAX with N > MAX');

  delete process.env.XN_JOIN_RETRY_MS;
  delete process.env.XN_JOIN_MAX_TRIES;
  delete process.env.XN_JOIN_QUIET_EVERY;
});
