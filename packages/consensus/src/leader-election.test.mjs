// WHO LEADS IS A CONSENSUS-RELEVANT ANSWER, AND IT WAS 45.3% COVERED.
//
// LeaderElection decides which nodes lead, from pulse evidence the nodes supply about themselves. Only
// the happy path had ever run. The parts that decide whether the answer is trustworthy — the timeout
// that resets a node's accumulated credit, the 4-hour rotation hold, and the scoring function's
// treatment of a node that reports no response time at all — had not.
//
// SECTION 6 RECORDS A GAMEABLE PROPERTY rather than asserting it is correct: score is
// count / (avgResponseTime + 1), and a node that omits responseTime keeps avgResponseTime at 0, so it
// outranks an identically-active node that accurately reported fast responses. The evidence is
// self-reported, so this is an incentive to report nothing. Pinned here as behaviour, flagged as a
// question for whoever owns leader selection — the test asserts what the code does today.
import { LeaderElection } from './leader-election.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };

// ── 1. PULSES ACCUMULATE PER IP, AND nodeId RESOLVES TO ONE ──
{
  const e = new LeaderElection();
  ok('an unknown node has no uptime record', e.getUptime('node-x') === null);

  e.recordPulse('node-a', '10.0.0.1', 50);
  const u = e.getUptime('node-a');
  ok('a first pulse creates the record', u && u.count === 1);
  ok('the first response time becomes the average', u.avgResponseTime === 50);

  e.recordPulse('node-a', '10.0.0.1', 150);
  ok('a second pulse increments the count', e.getUptime('node-a').count === 2);
  ok('the average is a running mean, not the latest sample', e.getUptime('node-a').avgResponseTime === 100);
  e.recordPulse('node-a', '10.0.0.1', 200);
  ok('...and it keeps averaging correctly across three samples',
     Math.abs(e.getUptime('node-a').avgResponseTime - (50 + 150 + 200) / 3) < 1e-9);

  ok('a node whose id was never pulsed resolves to nothing', e.getUptime('ghost') === null);

  // The mempool is keyed by IP, so two ids behind one address share the record. That is the documented
  // shape ({ ip: {...} }) and it means co-located nodes pool their credit.
  e.recordPulse('node-b', '10.0.0.1', 100);
  ok('TWO NODE IDS ON ONE IP SHARE ONE UPTIME RECORD — the mempool is keyed by address',
     e.getUptime('node-b') === e.getUptime('node-a') && e.getUptime('node-a').count === 4);
}

// ── 2. A PULSE WITH NO RESPONSE TIME STILL COUNTS AS PRESENCE ──
{
  const e = new LeaderElection();
  e.recordPulse('n', '10.0.0.9', 40);
  e.recordPulse('n', '10.0.0.9');                       // no measurement offered
  ok('the presence count still increments', e.getUptime('n').count === 2);
  ok('the average is left untouched rather than being polluted by a zero',
     e.getUptime('n').avgResponseTime === 40);

  const f = new LeaderElection();
  f.recordPulse('m', '10.0.0.8');
  ok('a first pulse with no measurement records a 0 average', f.getUptime('m').avgResponseTime === 0);
}

// ── 3. THE TIMEOUT RESETS ACCUMULATED CREDIT ──
// A node that goes away for longer than the timeout must not resume where it left off — otherwise an
// intermittent node accumulates the same credit as one that stayed up.
{
  const e = new LeaderElection();
  e.recordPulse('n', '10.0.0.2', 10);
  e.recordPulse('n', '10.0.0.2', 10);
  e.recordPulse('n', '10.0.0.2', 10);
  ok('three pulses, three credits', e.getUptime('n').count === 3);

  // Reach into the record to age it past the 60s timeout rather than waiting a minute.
  e.uptimeMempool.get('10.0.0.2').timestamp = Date.now() - (e.timeout + 1000);
  e.recordPulse('n', '10.0.0.2', 99);
  ok('A NODE THAT TIMED OUT RESTARTS AT ONE — it does not resume its old credit',
     e.getUptime('n').count === 1);
  ok('...and its average restarts from the new sample', e.getUptime('n').avgResponseTime === 99);

  const f = new LeaderElection();
  f.recordPulse('n', '10.0.0.3', 10);
  f.uptimeMempool.get('10.0.0.3').timestamp = Date.now() - (f.timeout - 1000);   // just inside
  f.recordPulse('n', '10.0.0.3', 10);
  ok('a node pulsing just inside the timeout keeps its credit', f.getUptime('n').count === 2);
  ok('the defaults are a 20s pulse and a 60s timeout', f.pulseInterval === 20000 && f.timeout === 60000);
}

// ── 4. ELECTION PICKS THE TOP N BY SCORE ──
{
  const e = new LeaderElection();
  for (let i = 0; i < 10; i++) e.recordPulse('busy', '10.0.0.1', 10);        // 10 pulses, 10ms
  for (let i = 0; i < 5; i++) e.recordPulse('mid', '10.0.0.2', 10);          // 5 pulses, 10ms
  for (let i = 0; i < 2; i++) e.recordPulse('quiet', '10.0.0.3', 10);        // 2 pulses, 10ms

  const leaders = e.electLeaders(2);
  ok('exactly the requested number are elected', leaders.length === 2);
  ok('THE MOST ACTIVE NODE LEADS', leaders[0] === '10.0.0.1');
  ok('the order is by score, descending', leaders[1] === '10.0.0.2');
  ok('the least active is not elected', !leaders.includes('10.0.0.3'));

  ok('asking for more leaders than there are nodes returns everyone, not padding',
     e.forceElection(99).length === 3);
  ok('asking for zero returns nobody', e.forceElection(0).length === 0);
  ok('an election with no nodes at all returns an empty list',
     new LeaderElection().forceElection(3).length === 0);

  // A faster node with the same activity should outrank a slower one.
  const f = new LeaderElection();
  for (let i = 0; i < 5; i++) { f.recordPulse('fast', '10.0.0.4', 10); f.recordPulse('slow', '10.0.0.5', 500); }
  ok('AT EQUAL ACTIVITY, THE FASTER NODE LEADS', f.forceElection(1)[0] === '10.0.0.4');
}

// ── 5. THE ROTATION HOLD: AN ELECTION RESULT IS STABLE FOR FOUR HOURS ──
// Re-electing on every call would make leadership flap with every pulse, and a leader set that changes
// under the transactions assigned to it is worse than a slightly stale one.
{
  const e = new LeaderElection();
  e.recordPulse('a', '10.0.0.1', 10);
  const first = e.electLeaders(1);
  ok('the first call elects', first.length === 1 && first[0] === '10.0.0.1');

  for (let i = 0; i < 50; i++) e.recordPulse('b', '10.0.0.2', 1);   // b is now far more deserving
  ok('A SECOND CALL WITHIN THE WINDOW RETURNS THE HELD RESULT, not a fresh election',
     e.electLeaders(1)[0] === '10.0.0.1');
  ok('getCurrentLeaders agrees with what was held', e.getCurrentLeaders()[0] === '10.0.0.1');

  ok('forceElection overrides the hold', e.forceElection(1)[0] === '10.0.0.2');
  ok('...and the forced result becomes the held one', e.electLeaders(1)[0] === '10.0.0.2');

  // Age past the rotation interval.
  e.lastElectionTime = Date.now() - (e.leaderRotationInterval + 1000);
  for (let i = 0; i < 500; i++) e.recordPulse('c', '10.0.0.3', 1);
  ok('AFTER FOUR HOURS THE ELECTION RE-RUNS', e.electLeaders(1)[0] === '10.0.0.3');
  ok('the rotation interval is four hours', e.leaderRotationInterval === 4 * 60 * 60 * 1000);

  ok('the countdown reports time remaining', (() => {
    const g = new LeaderElection();
    const t = g.getTimeUntilNextElection();
    return t > 0 && t <= g.leaderRotationInterval;
  })());
  ok('the countdown floors at zero rather than going negative', (() => {
    const g = new LeaderElection();
    g.lastElectionTime = Date.now() - (g.leaderRotationInterval * 3);
    return g.getTimeUntilNextElection() === 0;
  })());

  ok('the returned leader list is a COPY — a caller cannot rewrite the elected set', (() => {
    const g = new LeaderElection();
    g.recordPulse('a', '10.0.0.1', 1);
    const l = g.electLeaders(1);
    l[0] = '10.6.6.6'; l.push('10.6.6.7');
    return g.getCurrentLeaders().length === 1 && g.getCurrentLeaders()[0] === '10.0.0.1';
  })());
  ok('getCurrentLeaders is a copy too', (() => {
    const g = new LeaderElection();
    g.recordPulse('a', '10.0.0.1', 1); g.forceElection(1);
    g.getCurrentLeaders().push('injected');
    return g.getCurrentLeaders().length === 1;
  })());
  ok('an election held with zero prior leaders always re-runs, hold or not', (() => {
    const g = new LeaderElection();
    g.lastElectionTime = Date.now();                     // inside the hold window
    g.recordPulse('a', '10.0.0.1', 1);
    return g.electLeaders(1).length === 1;               // currentLeaders was empty, so it elects anyway
  })());
}

// ── 6. THE SCORING ASYMMETRY, PINNED AS BEHAVIOUR (see this file's header) ──
// score = count / (avgResponseTime + 1). Evidence is self-reported, and omitting responseTime leaves
// avgResponseTime at 0, which maximises the score. Two nodes, identical activity: the one that reported
// nothing beats the one that reported accurately fast responses.
{
  const e = new LeaderElection();
  for (let i = 0; i < 5; i++) {
    e.recordPulse('genuine', '10.0.0.1', 5);              // reports a genuinely fast 5ms
    e.recordPulse('silent', '10.0.0.2');                 // reports no measurement at all
  }
  ok('both nodes accumulated identical presence',
     e.getUptime('genuine').count === e.getUptime('silent').count);
  ok('TODAY, THE NODE THAT REPORTED NOTHING OUTRANKS THE ONE THAT REPORTED FAST RESPONSES',
     e.forceElection(1)[0] === '10.0.0.2');
  ok('...because its average stayed at the maximal-score value of 0',
     e.getUptime('silent').avgResponseTime === 0 && e.getUptime('genuine').avgResponseTime === 5);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
