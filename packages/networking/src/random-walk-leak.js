// ⛔ THE HEAP LEAK THAT TOOK A PUBLIC NODE DOWN. Measured 2026-10-01 on two public nodes: the node on 173.255.233.69
// hit "JavaScript heap out of memory" every 30-45 min (12 times on 2026-09-29, then its supervisor gave up — the
// outage the broker's deploy gate reported as a dead node), and the ap-southeast-2 node OOM'd after 8.8 h. Two heap
// snapshots 7.5 min apart on the latter grew by exactly 2,838 of each of: CustomEvent, Ed25519PeerId, Digest,
// Ed25519PublicKey, Promise, Listener, and the closures `onItem` / `rejectHandler` / `cancel` — a linked list of
// abort listeners on ONE AbortSignal, each holding a walked peer.
//
// The cause is in libp2p 3.3.11's RandomWalk.walk(): it waits for every `walk:peer` with
// `pEvent(this, 'walk:peer', { signal })`, and p-event (7.1.0 and 7.1.1, the latest) adds an `abort` listener to
// that signal on every call and never removes it when the event arrives. The signal lives as long as the walk, and
// the circuit-relay transport (`discoverRelays`) walks for as long as it has no relay reservation — forever, on a
// public node, or on any node while no relay answers. So every peer the walk ever met stays on the heap.
//
// The fix replaces walk() on this node's RandomWalk instance with the same loop waiting on listeners it removes
// itself. Everything else — startWalk(), the needNext pause, the walker count — is libp2p's own code, untouched.
// If a future libp2p changes the shape this relies on, nothing is replaced and the node says so.
//
// ⛔ AND THE WALK RAN AS FAST AS THE CPU ALLOWED. libp2p's startWalk() starts the next DHT query the moment the last
// one ends, with no pause: on a small mesh a query is one round trip to a peer already connected, so the walk is a
// hot loop. Measured 2026-10-11 on two idle XNNodes in one process (no txs, no relay reservation, so relay discovery
// walks): 1,451 to 3,621 inbound FIND_NODE per 5 s, about 500 a second, every one an inbound yamux stream that
// kad-dht's handler keeps for its 10 s message timeout. A heap snapshot of a fleet node after 1,008 txs held 5,178
// such streams in 48.5 MB of Node's timeout-signal set, which is 10 s of that rate. Any node that holds no relay
// reservation walks like this for as long as it holds none, and the CPU it burns is CPU the txs do not get.
// startWalk() is replaced with the same loop paced: the first query runs at once (a booting node still finds a relay
// promptly), and each later one waits `minGapMs`, doubling up to `maxGapMs` while queries turn up no peer this walk
// has not already seen.
import { setMaxListeners } from 'node:events';

export const WALK_MIN_GAP_MS = 2000;
export const WALK_MAX_GAP_MS = 60000;
const SEEN_MAX = 4096;

// Resolves when `promise` does, rejects when `signal` aborts; either way the abort listener is removed.
function untilOrAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

// Waits `ms`, or less if `signal` aborts; resolves either way, and leaves no listener or timer behind.
function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function nextWalkEvent(target, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const done = () => {
      target.removeEventListener('walk:peer', onPeer);
      target.removeEventListener('walk:error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onPeer = (evt) => { done(); resolve(evt); };
    // libp2p's walk() rethrows a walk:error event's detail, not the event.
    const onError = (evt) => { done(); reject(evt?.detail ?? evt); };
    const onAbort = () => { done(); reject(signal.reason); };
    target.addEventListener('walk:peer', onPeer);
    target.addEventListener('walk:error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Replace the leaking walk() and the unpaced startWalk() on a started-or-constructed libp2p node. Returns true when
 *  both were replaced. */
export function plugRandomWalkLeak(libp2p, { minGapMs = WALK_MIN_GAP_MS, maxGapMs = WALK_MAX_GAP_MS } = {}) {
  const rw = libp2p?.components?.randomWalk;
  if (!rw || typeof rw.walk !== 'function' || typeof rw.startWalk !== 'function' || !('shutdownController' in rw)
    || typeof rw.safeDispatchEvent !== 'function' || typeof rw.peerRouting?.getClosestPeers !== 'function') return false;
  rw.startWalk = function startWalk() {
    this.walking = true;
    // aborted by walk() when no consumer is left, as in libp2p's own startWalk()
    this.walkController = new AbortController();
    setMaxListeners(Infinity, this.walkController.signal);
    const signal = AbortSignal.any([this.walkController.signal, this.shutdownController.signal]);
    setMaxListeners(Infinity, signal);
    const seen = new Set();
    let idle = 0;
    Promise.resolve().then(async () => {
      for (let first = true; this.walkers > 0 && !signal.aborted; first = false) {
        if (!first) {
          await pause(Math.min(maxGapMs, minGapMs * 2 ** idle), signal);
          if (signal.aborted) break;
        }
        let fresh = 0;
        try {
          for await (const peer of this.peerRouting.getClosestPeers(crypto.getRandomValues(new Uint8Array(32)), { signal })) {
            signal.throwIfAborted();
            const id = peer?.id?.toString?.();
            if (id && !seen.has(id)) {
              fresh++;
              seen.add(id);
              if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
            }
            this.safeDispatchEvent('walk:peer', { detail: peer });
            // one consumer: hold the query until it asks for another peer (libp2p's own pause)
            if (this.walkers === 1 && this.needNext != null) await untilOrAbort(this.needNext.promise, signal);
          }
        } catch (err) {
          if (signal.aborted) break;
          this.safeDispatchEvent('walk:error', { detail: err });
        }
        idle = fresh > 0 ? 0 : Math.min(idle + 1, 30);
      }
    }).catch(() => {}).finally(() => {
      this.walking = false;
      // a walk() that arrived while this loop was winding down saw `walking` and did not start one
      if (this.walkers > 0 && !this.shutdownController.signal.aborted) this.startWalk();
    });
  };
  rw.walk = async function* walk(options) {
    if (!this.walking) this.startWalk();
    this.walkers++;
    const signal = AbortSignal.any([this.shutdownController.signal, options?.signal].filter(Boolean));
    setMaxListeners(Infinity, signal);
    try {
      while (true) {
        // if another consumer has paused the query, start it again (libp2p's own protocol with startWalk())
        this.needNext?.resolve();
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        this.needNext = { promise, resolve, reject };
        const event = await nextWalkEvent(this, signal);
        yield event.detail;
      }
    } finally {
      this.walkers--;
      // stop the walk if no more consumers are interested
      if (this.walkers === 0) {
        this.walkController?.abort();
        this.walkController = undefined;
      }
    }
  };
  rw.__xmblWalkLeakPlugged = true;
  return true;
}
