// B5 — A NODE THAT SAYS WHEN AND WHY IT DIED.
//
// MEASURED on the audited node: ~199 of 264 exits left NO marker of any kind, node.log carried no timestamps,
// and ten FATALs could not be placed in time at all. An exit with no marker is indistinguishable from a kill,
// an OOM, a clean stop and a crash loop — which is why nobody could say what had been happening to that node
// for weeks. Two things fix it and they are both unconditional:
//
//   1. EVERY log line carries an ISO-8601 timestamp — every LINE, not every call, so a multi-line banner is
//      still parseable line by line.
//   2. EVERY exit emits exactly ONE marker line naming how it ended: a signal, an uncaught error, an
//      unhandled rejection, or a clean stop, with the exit code and the uptime.
//
// Both are installed by the daemon at start only. `xmbl-node status` prints JSON that the coordinator parses,
// and prefixing that would break it.

import { format } from 'node:util';

/** An ISO-8601 timestamp on EVERY line of `args`, formatted the way console would. */
export function stampLines(args, now = new Date()) {
  const t = now.toISOString();
  return format(...args).split('\n').map((line) => `${t} ${line}`).join('\n');
}

/** Wrap a console-like object so every line it writes is timestamped. Returns a restore function. */
export function installTimestampedLogging(target = console) {
  const saved = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    if (typeof target[level] !== 'function') continue;
    const original = target[level].bind(target);
    saved[level] = target[level];
    target[level] = (...args) => original(stampLines(args));
  }
  return () => { for (const [level, fn] of Object.entries(saved)) target[level] = fn; };
}

/** The one marker line for an exit. */
export function exitMarker({ kind, code, detail, uptimeSeconds, pid }) {
  const parts = [
    'xmbl-node EXIT',
    `kind=${kind}`,
    `code=${code ?? 0}`,
    `pid=${pid ?? process.pid}`,
    `uptime=${Math.round(uptimeSeconds ?? 0)}s`,
  ];
  if (detail) parts.push(`detail=${String(detail).split('\n')[0].slice(0, 200)}`);
  return parts.join(' ');
}

/**
 * Install the unconditional exit handlers. ONE marker per process, whatever ends it:
 * a signal and a clean stop both arrive as 'exit'; an uncaught error and an unhandled rejection are named and
 * still terminate the process, because a node that keeps running after one lies about its own state.
 */
export function installExitMarkers({
  proc = process,
  log = (line) => console.log(line),
  fatal = (line) => console.error(line),
  exit = (code) => proc.exit(code),
} = {}) {
  let marked = false;
  const mark = (kind, code, detail) => {
    if (marked) return false;   // a crash that then exits must not print twice
    marked = true;
    log(exitMarker({ kind, code, detail, uptimeSeconds: proc.uptime ? proc.uptime() : 0, pid: proc.pid }));
    return true;
  };
  proc.on('uncaughtException', (e) => {
    fatal(`xmbl-node FATAL uncaught: ${(e && e.stack) || e}`);
    mark('uncaught-exception', 1, e && e.message);
    exit(1);
  });
  proc.on('unhandledRejection', (r) => {
    fatal(`xmbl-node FATAL unhandled rejection: ${(r && r.stack) || r}`);
    mark('unhandled-rejection', 1, (r && r.message) || String(r));
    exit(1);
  });
  proc.on('exit', (code) => { mark(code ? 'error-exit' : 'clean-exit', code); });
  return { mark, marked: () => marked };
}
