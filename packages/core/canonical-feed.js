// A NODE NOBODY FEEDS FETCHES THE CANONICAL SET ITSELF — and rebuilds from it exactly the way its coordinator would.
//
// MEASURED 2026-10-11 on 831cfb42 (aws-syd1, 0.1.27, 5 libp2p peers): applied 15403, root 955850f3, blocks 15399
// for hours, while 356a2a7a / 413e090a / 4293b3c6 moved together to 15711 / root c392171d. A node without the
// lead role applies nothing it hears from peers; its chain moves only when something calls rebuild_ledger (or
// apply_canonical) on its control socket with the broker's canonical anchor set. The coordinator does that every
// 90 s — except for a node it ADOPTED at boot instead of spawning, which never gets the timer at all. So one box's
// supervision bug froze its chain, and the protocol had no way to notice.
//
// The node now notices. When no caller has handed it a set for `staleMs`, it GETs the same URL the coordinator
// does, asks its own `ledger_capabilities` which feed and which op the coordinator would choose (typed feed
// `?from_epoch=1` when it refuses untyped anchors; rebuild_ledger when it rescues non-anchor blocks, else
// apply_canonical), and runs that op through the SAME in-process dispatch the socket uses — so it takes the same
// one-ledger-write-at-a-time lock (control-socket.js runLedgerWrite), the same eviction filter, the same refusal of
// a set that would empty the chain. Same input, same code, so the same root and the same blocks as a fed node.
//
// WHAT THIS DOES NOT CHANGE: the broker is still where the anchor set comes from. Its payload is not signed and an
// anchor block carries no signature, so a set relayed between peers could be forged; fetching it over TLS from the
// broker adds no new source of trust, it only removes the dependence on one coordinator's adopt path.
//
// A FED NODE IS LEFT ALONE. A set handed over the socket stamps `last_external_at` and the set's digest
// (control-socket.js). The self-feed stays quiet while that stamp is younger than `staleMs`; when it is older (the
// coordinator gets a 304 in a quiet period and calls nothing) a fetched set whose digest equals the last applied
// one is skipped, a set OLDER than the last applied one (an nginx-cached copy) is skipped, and a NEW set on a node
// that has been fed this process waits one more interval for its feeder before the node applies it itself.
import { createHash } from 'node:crypto';

export const DEFAULT_CANONICAL_BASE = 'https://handoff.lol/api/v1';

// The set's identity, independent of the order the rows arrive in: every field a rebuild reads, row by row, sorted.
export function canonicalDigest(anchors) {
  const rows = new Set();
  for (const a of Array.isArray(anchors) ? anchors : []) {
    if (!a || !a.event || !a.hash) continue;
    rows.add([a.event, a.hash, a.ts ?? '', a.xid ?? '', a.nonce ?? '', a.prior ?? ''].join('\u0000'));
  }
  return createHash('sha256').update([...rows].sort().join('\n')).digest('hex');
}

// The newest anchor time in a set, in ms (0 when none parse). A set whose newest row is older than the last set
// applied is a stale copy, never an update.
export function canonicalMaxTs(anchors) {
  let max = 0;
  for (const a of Array.isArray(anchors) ? anchors : []) {
    const t = typeof a?.ts === 'number' ? a.ts : Date.parse(a?.ts);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

export function feedState(core) {
  if (!core.canonicalFeed) {
    core.canonicalFeed = { last_external_at: null, last: null, self: { enabled: false, checks: 0, applied: 0, last_reason: null, last_error: null } };
  }
  return core.canonicalFeed;
}

// Record a canonical rebuild's outcome. `by` is 'control' for a set handed over the socket, 'self' for one this
// node fetched. Only a clean result (ok, nothing untyped or rejected) becomes the set the node holds.
export function noteCanonicalApplied(core, anchors, result, by, now = Date.now()) {
  const st = feedState(core);
  if (by === 'control') st.last_external_at = now;
  const clean = !!result && result.ok === true && !((result.untyped | 0) > 0) && !((result.rejected | 0) > 0);
  if (!clean) return false;
  st.last = {
    by, at: new Date(now).toISOString(), op: result.op || null,
    digest: canonicalDigest(anchors), max_ts: canonicalMaxTs(anchors), anchors: Array.isArray(anchors) ? anchors.length : 0,
    state_root: result.state_root || null, blocks: result.blocks ?? null,
  };
  return true;
}

function canonicalUrl(env) {
  if (env.XMBL_CANONICAL_URL) return env.XMBL_CANONICAL_URL;
  return `${String(env.HANDOFF_API || DEFAULT_CANONICAL_BASE).replace(/\/$/, '')}/xmbl/anchors/canonical`;
}

/**
 * Start the self-feed. `callOp(req)` is the control socket's own dispatch (createControlServer's server.localOp).
 * XMBL_SELF_FEED_MS (default 90000, 0 turns it off) is the check interval; XMBL_SELF_FEED_STALE_MS (default twice
 * that) is how long without a handed-over set before the node feeds itself. Returns { tick, stop } or null.
 */
export function startCanonicalSelfFeed({ core, callOp, env = process.env, fetchImpl = globalThis.fetch, log = console.log, now = Date.now }) {
  const st = feedState(core);
  const everyMs = Number(env.XMBL_SELF_FEED_MS ?? 90_000);
  if (!(everyMs > 0) || typeof callOp !== 'function' || typeof fetchImpl !== 'function') { st.self.enabled = false; return null; }
  const staleMs = Number(env.XMBL_SELF_FEED_STALE_MS) > 0 ? Number(env.XMBL_SELF_FEED_STALE_MS) : 2 * everyMs;
  const url = canonicalUrl(env);
  const bootAt = now();
  Object.assign(st.self, { enabled: true, url, every_ms: everyMs, stale_ms: staleMs });
  let etag = null, typedFeed = null, pending = null, running = false, stopped = false, loggedReason = null;

  const settle = (reason, detail) => {
    st.self.last_reason = reason;
    if (reason !== loggedReason || reason === 'applied') {
      loggedReason = reason;
      log(`xmbl-node: canonical self-feed — ${reason}${detail ? ` (${detail})` : ''}`);
    }
    return reason;
  };

  const tick = async () => {
    if (running || stopped) return 'running';
    running = true;
    st.self.checks++;
    try {
      if (core.suspended) return settle('suspended');
      const t = now();
      const quietFor = t - Math.max(bootAt, st.last_external_at || 0);
      if (quietFor < staleMs) return settle('fed', st.last_external_at ? `a set was handed over ${Math.round((t - st.last_external_at) / 1000)} s ago` : 'booted, waiting for a feeder');
      const caps = await callOp({ op: 'ledger_capabilities' });
      if (!caps || !caps.ok || !caps.capabilities) return settle('no ledger', caps && caps.error);
      // The coordinator's own choice, from the same answer it reads (coord-xmbl-node.mjs probeLedgerCaps).
      const typed = caps.capabilities.requires_typed_anchors === true;
      const op = caps.capabilities.rescues_non_anchor_blocks === true ? 'rebuild_ledger' : 'apply_canonical';
      if (typed !== typedFeed) { etag = null; typedFeed = typed; }
      const r = await fetchImpl(`${url}${typed ? (url.includes('?') ? '&' : '?') + 'from_epoch=1' : ''}`,
        { headers: etag ? { 'If-None-Match': etag } : {}, signal: AbortSignal.timeout(30_000) });
      if (r.status === 304) return settle('unchanged');
      if (!r.ok) { st.self.last_error = `canonical feed answered ${r.status}`; return settle('feed error', st.self.last_error); }
      const j = await r.json();
      const anchors = Array.isArray(j?.anchors) ? j.anchors : [];
      if (!anchors.length) return settle('empty feed');
      const tag = r.headers.get('etag');
      const digest = canonicalDigest(anchors);
      if (st.last && st.last.digest === digest) { etag = tag; pending = null; return settle('held', `this node already holds set ${digest.slice(0, 12)}`); }
      const maxTs = canonicalMaxTs(anchors);
      // Both guards below are against racing a feeder, so they apply only to a node some caller has fed this
      // process. A set older than the one held is a cached copy of what that feeder already handed over; a new
      // set gets one more interval for the feeder to hand it over first.
      if (st.last_external_at) {
        if (st.last && maxTs < st.last.max_ts) return settle('older', 'the fetched set is older than the one this node holds');
        if (!pending || pending.digest !== digest) pending = { digest, since: t };
        if (t - pending.since < everyMs) return settle('waiting for feeder', `new set ${digest.slice(0, 12)}`);
      }
      const res = await callOp({ op, anchors });
      if (res && res.busy) return settle('busy', res.error);
      const applied = noteCanonicalApplied(core, anchors, { ...res, op }, 'self', now());
      if (!applied) {
        st.self.last_error = res && res.ok === false ? String(res.error || 'refused') : `untyped=${res?.untyped | 0} rejected=${res?.rejected | 0}`;
        return settle('not applied', st.self.last_error);
      }
      etag = tag; pending = null; st.self.applied++; st.self.last_error = null;
      return settle('applied', `${op} of ${anchors.length} anchors -> ${res.blocks ?? '?'} blocks, root ${String(res.state_root || '').slice(0, 16)}`);
    } catch (e) {
      st.self.last_error = String(e?.message || e);
      return settle('error', st.self.last_error);
    } finally { running = false; }
  };

  const first = setTimeout(tick, staleMs + 1000);
  const timer = setInterval(tick, everyMs);
  first.unref?.(); timer.unref?.();
  return { tick, stop: () => { stopped = true; clearTimeout(first); clearInterval(timer); } };
}
