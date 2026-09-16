// B5 — every line stamped, every exit marked. Asserted by COUNT over the lines the module actually writes.
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { stampLines, exitMarker, installTimestampedLogging, installExitMarkers } from './lifecycle-log.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

// ── every LINE, not every call ──
const multi = stampLines(['xmbl-node listening\n  socket: /tmp/n.sock\n  peers: 0']);
const lines = multi.split('\n');
ok('a 3-line banner yields 3 lines, each starting with an ISO timestamp', lines.length === 3 && lines.every((l) => ISO.test(l)));
ok('the timestamp on every line of one call is identical', new Set(lines.map((l) => l.slice(0, 24))).size === 1);
ok('printf-style args are formatted, not concatenated', /peers=7 of 9$/.test(stampLines(['peers=%d of %d', 7, 9])));
ok('an object argument survives formatting', /\{ ok: true \}/.test(stampLines(['state', { ok: true }])));

// ── the wrapper covers every level and restores cleanly ──
{
  const seen = [];
  const fake = { log: (s) => seen.push(s), info: (s) => seen.push(s), warn: (s) => seen.push(s), error: (s) => seen.push(s), debug: (s) => seen.push(s) };
  const originals = { ...fake };
  const restore = installTimestampedLogging(fake);
  fake.log('a'); fake.info('b'); fake.warn('c'); fake.error('d'); fake.debug('e');
  ok('all 5 console levels are wrapped and every emitted line is stamped', seen.length === 5 && seen.every((l) => ISO.test(l)));
  restore();
  ok('restore() puts every original level back', ['log', 'info', 'warn', 'error', 'debug'].every((k) => fake[k] === originals[k]));
  fake.log('after');
  ok('a restored console no longer stamps', seen.length === 6 && !ISO.test(seen[5]));
}

// ── the marker line names how it ended ──
const m = exitMarker({ kind: 'uncaught-exception', code: 1, detail: 'boom\nsecond line', uptimeSeconds: 12.4, pid: 4242 });
ok('the marker names kind, code, pid and uptime', m === 'xmbl-node EXIT kind=uncaught-exception code=1 pid=4242 uptime=12s detail=boom');
ok('a multi-line detail is flattened to the first line (one marker = one line)', !m.includes('\n'));

// ── ONE marker per process, for every way a node can end ──
const run = (emit) => {
  const proc = new EventEmitter();
  proc.pid = 99; proc.uptime = () => 3;
  const out = [], errs = [], exits = [];
  installExitMarkers({ proc, log: (l) => out.push(l), fatal: (l) => errs.push(l), exit: (c) => exits.push(c) });
  emit(proc);
  return { out, errs, exits };
};
{
  const r = run((p) => p.emit('exit', 0));
  ok('a clean stop emits exactly ONE marker, kind=clean-exit code=0', r.out.length === 1 && /kind=clean-exit code=0/.test(r.out[0]));
}
{
  const r = run((p) => p.emit('exit', 75));
  ok('an OTA restart (exit 75) is marked as an error-exit carrying its code', r.out.length === 1 && /kind=error-exit code=75/.test(r.out[0]));
}
{
  const r = run((p) => { p.emit('uncaughtException', new Error('kaboom')); p.emit('exit', 1); });
  ok('an uncaught error is marked ONCE, not twice when the exit follows', r.out.length === 1 && /kind=uncaught-exception/.test(r.out[0]) && /detail=kaboom/.test(r.out[0]));
  ok('the stack still reaches stderr, and the process is terminated with code 1', r.errs.length === 1 && /FATAL uncaught/.test(r.errs[0]) && r.exits.length === 1 && r.exits[0] === 1);
}
{
  const r = run((p) => { p.emit('unhandledRejection', new Error('nope')); p.emit('exit', 1); });
  ok('an unhandled rejection is named, marked once, and terminates the process', r.out.length === 1 && /kind=unhandled-rejection/.test(r.out[0]) && r.exits[0] === 1);
}
{
  // The soak invariant: N exits => N marker lines, one per process, never zero.
  const runs = [0, 1, 75, 143].map((code) => run((p) => p.emit('exit', code)));
  ok('4 processes that exit produce 4 marker lines (exits == markers)', runs.reduce((n, r) => n + r.out.length, 0) === 4);
  ok('every marker line is a single line naming a kind', runs.every((r) => !r.out[0].includes('\n') && /kind=\S+/.test(r.out[0])));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
