// ⛔ THE HEAP LEAK THAT TOOK THE SEED DOWN. Measured 2026-10-01 on two public nodes: the node on 173.255.233.69
// hit "JavaScript heap out of memory" every 30-45 min (12 times on 2026-09-29, then its supervisor gave up — the
// outage the broker's deploy gate reported as a dead seed), and the ap-southeast-2 node OOM'd after 8.8 h. Two heap
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
import { setMaxListeners } from 'node:events';

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

/** Replace the leaking walk() on a started-or-constructed libp2p node. Returns true when it was replaced. */
export function plugRandomWalkLeak(libp2p) {
  const rw = libp2p?.components?.randomWalk;
  if (!rw || typeof rw.walk !== 'function' || typeof rw.startWalk !== 'function' || !('shutdownController' in rw)) return false;
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
