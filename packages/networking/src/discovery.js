import { multiaddr } from '@multiformats/multiaddr';

export class PeerDiscovery {
  constructor(node) {
    this.node = node;
    this.discoveredPeers = new Set();
    this._seedTimer = null;

    // Track discovered peers
    node.on('peer:discovered', (peer) => {
      this.discoveredPeers.add(peer.id.toString());
    });
  }

  // BOOTSTRAP IS A STANDING INTENT, NOT ONE DIAL AT BOOT — and it must be audible.
  //
  // THE BUG THIS REPLACES: this dialed each seed exactly once, at start, and swallowed every error with the
  // comment "silently handle bootstrap errors - expected in test environments". Both halves were wrong in
  // production. One shot means a seed that is momentarily unreachable — not yet up, transport not ready, a
  // blip at boot — is never tried again, and the node sits isolated forever with a perfectly good seed sitting
  // in its config. Silence means that state produces NO evidence anywhere: no log line, no counter, nothing
  // for an operator to find.
  //
  // MEASURED, and it is exactly this shape: a node booted with a correct, reachable seed in bootstrap_peers
  // (/ip4/173.255.233.69/tcp/4001/p2p/12D3KooWKKZ…, TCP-verified open from the dialing machine) and reported
  // peers: 0 and live_lead_count: 1 indefinitely. The same address through the `connect` control op
  // succeeded immediately: 2 peers, live_lead_count 2, seal_quorum 2. Transport, identity, presence gossip
  // and quorum all worked. The only thing that had failed was the one dial at boot, quietly.
  //
  // So: keep trying until connected, with backoff, and SAY what happened each time. Stops as soon as every
  // seed is connected; a permanently dead seed reports itself instead of looking like a working config.
  async bootstrap(bootstrapAddresses) {
    const seeds = (bootstrapAddresses || []).filter(Boolean);
    if (!seeds.length) return;

    const RETRY_MS = Math.max(5000, Number(process.env.XN_BOOTSTRAP_RETRY_MS) || 15000);
    const MAX_TRIES = Math.max(1, Number(process.env.XN_BOOTSTRAP_MAX_TRIES) || 40);   // ~10 min at 15s
    // How often the per-seed warning repeats AFTER the retry budget is spent. Same cadence as the budget
    // itself (~10 min at 15s), so a permanently dead seed costs ~6 lines an hour instead of ~240.
    const QUIET_EVERY = Math.max(1, Number(process.env.XN_BOOTSTRAP_QUIET_EVERY) || MAX_TRIES);
    let tries = 0;

    const peerIdOf = (addr) => { const m = /\/p2p\/([^/]+)$/.exec(String(addr)); return m ? m[1] : null; };
    const connected = (addr) => {
      const id = peerIdOf(addr);
      return !!(id && this.node.connectionManager && this.node.connectionManager.getConnection(id));
    };

    // NEVER DIAL YOURSELF. The published seed list is a constant every provisioned node inherits, INCLUDING
    // the seed box itself — re-run the installer there and the box gets its own multiaddr in bootstrap_peers.
    // The one-shot version failed at that silently; the retry loop below would instead warn every 15s for ten
    // minutes and then declare the node unreachable from itself. The auto-dial handler in node.js already
    // carries this exact guard (`idStr === this.node.peerId.toString()`); the bootstrap path did not.
    const selfId = (() => { try { return this.node.node.peerId.toString(); } catch { return null; } })();
    const skipped = seeds.filter((a) => selfId && peerIdOf(a) === selfId);
    if (skipped.length) console.log(`[xn] bootstrap: skipping ${skipped.length} seed(s) that are THIS node`);
    const targets = seeds.filter((a) => !selfId || peerIdOf(a) !== selfId);
    if (!targets.length) return;

    // A SEED CONNECTION IS NOT A ONE-TIME EVENT EITHER. An earlier version of this loop stopped itself the
    // moment every seed was connected — which is the same one-shot mistake one level up: restart the seed box
    // and the connection dies with it, nothing re-dials, and the node is isolated again with no log line.
    // MEASURED: after the seed process was replaced, this node's live_lead_count fell 2 -> 1 (presence stopped
    // arriving, so the stale lead correctly expired) and stayed there. The loop now KEEPS RUNNING and simply
    // does nothing while everything is connected — the tick is a Map lookup per seed. `tries` counts only
    // rounds that had work to do, so a long-lived healthy node never walks into the give-up branch.
    let announcedAll = false;
    const attempt = async () => {
      const pending = targets.filter((a) => !connected(a));
      if (!pending.length) {
        if (!announcedAll) { announcedAll = true; console.log(`[xn] bootstrap: connected to all ${targets.length} seed(s)`); }
        tries = 0;                                     // healthy again — a later drop gets a full retry budget
        return;
      }
      if (announcedAll) { announcedAll = false; console.warn(`[xn] bootstrap: ${pending.length}/${targets.length} seed(s) DROPPED — re-dialing`); }
      tries++;
      for (const addr of pending) {
        try {
          const ma = typeof addr === 'string' ? multiaddr(addr) : addr;
          await this.node.node.dial(ma);
          console.log(`[xn] bootstrap: connected to seed ${addr}`);
        } catch (error) {
          // A seed that does not answer is worse than no seed at all: it looks configured, every node dials
          // it, and nothing reports the failure. Name it, with the reason — every attempt while there is still
          // a retry budget, and then PERIODICALLY rather than forever.
          //
          // ⛔ WHY THE THROTTLE. This warned on every attempt for the life of the process. A node whose only
          // seed is down writes one line per seed per RETRY_MS, indefinitely: MEASURED on this node
          // 2026-09-16, 8,542 identical lines in node.log against 10 give-up lines, from a single seed
          // refusing connections. node.log is the file an operator greps, and burying it under one dead seed
          // is the same defect as not logging at all — the evidence exists and cannot be found. After the
          // budget is spent the loop keeps watching (a seed that returns must still reconnect), but it says so
          // once per QUIET_EVERY attempts and carries the real attempt count so nothing looks like it stopped.
          //
          // ⛔ AND DO NOT PRINT A RATIO PAST ITS OWN DENOMINATOR. The old line read
          // "unreachable (attempt 206/40)" — a counter 166 past the budget that was supposed to bound it.
          // That is the tell, and it is a different fault from the volume: a reader who sees only "too many
          // lines" fixes the verbosity and leaves a loop that has outlived its own bound looking like a bug.
          // The loop being unbounded IS deliberate (a seed that comes back must reconnect), so the genuine
          // rendering is to stop pretending there is a budget left and say what the loop is actually doing.
          if (tries <= MAX_TRIES || tries % QUIET_EVERY === 0) {
            const where = tries <= MAX_TRIES
              ? `attempt ${tries}/${MAX_TRIES}`
              : `attempt ${tries}, retry budget spent — watching for recovery, next line in ${QUIET_EVERY} attempt(s)`;
            console.warn(`[xn] bootstrap: seed ${addr} unreachable (${where}): ${error?.message || error}`);
          }
        }
      }
      // GIVE UP LOUDLY, BUT KEEP THE LOOP. Stopping the timer here would restore the original defect for any
      // seed that comes back later. Say it once, then fall back to a slow watch so recovery is still possible.
      if (tries === MAX_TRIES) {
        const still = targets.filter((a) => !connected(a));
        if (still.length) console.error(`[xn] bootstrap: ${still.length}/${targets.length} seed(s) have not answered in ${tries} attempts: ${still.join(', ')}. This node is isolated (mdns can still find LAN peers); still watching.`);
      }
    };

    await attempt();                                   // first try inline, so a healthy seed connects at boot
    // Armed unconditionally, even when the first attempt connected everything: the loop's job is to keep the
    // seed connections UP, not merely to establish them once.
    this._seedTimer = setInterval(() => { attempt().catch(() => { /* never throw out of the retry */ }); }, RETRY_MS);
    if (this._seedTimer.unref) this._seedTimer.unref();   // never hold the process open
  }

  // Stop the retry loop (node shutdown). Safe to call when it was never armed.
  stop() {
    if (this._seedTimer) { clearInterval(this._seedTimer); this._seedTimer = null; }
  }

  getDiscoveredPeers() {
    return Array.from(this.discoveredPeers);
  }
}
