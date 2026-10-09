import { multiaddr } from '@multiformats/multiaddr';

export class PeerDiscovery {
  constructor(node) {
    this.node = node;
    this.discoveredPeers = new Set();
    this._joinTimer = null;
    this._stopped = false;

    // Track discovered peers
    node.on('peer:discovered', (peer) => {
      this.discoveredPeers.add(peer.id.toString());
    });
  }

  // ⛔ NO PEER IS SPECIAL. A node joins the mesh through ANY peer it knows, and no box is the way in.
  //
  // THE DESIGN THIS REPLACES gave the addresses in bootstrap_peers a role no other peer had: they alone were
  // dialed at boot, they alone were kept connected forever, and node.js took the node's relay reservation from
  // them alone. The installer shipped one such address, so the mesh had one way in. MEASURED 2026-10-09: the only
  // public node up, 173.255.233.69, had been re-keyed on 09-20; every config written before then named its old
  // peer id, the node there refused that id ("Payload identity key … does not match expected remote identity
  // key …"), and every NAT'd box holding such a config sat at 0 peers — this Mac included, while the same ip and
  // port without the id connected at once.
  //
  // Now there is ONE list of candidates and ONE dialer. The candidates are the peers this node has connected to
  // before (`book`, peer-cache.js) and the addresses it was given at start (`given`, the bootstrap_peers input —
  // an entry in the address book like any other, not a role). Each round, while the node holds fewer than TARGET
  // peers, every candidate it does not already hold is dialed at once, and any one that answers is as good as any
  // other; at TARGET nothing is dialed. The DHT, identify and mDNS find the rest (node.js auto-dials what they
  // find) — they need one connection to start from, and that is all a candidate is for. A NAT'd node's relay
  // comes from circuit-relay's discoverRelays, which reserves on whichever connected peer runs a relay server.
  //
  // A PEER ID IN AN ADDRESS IS A CLAIM, AND IT GOES STALE when a box is re-keyed. On that refusal ONLY (not on a
  // timeout, not on a closed port), the dialer dials the same address without the id and uses the id that answered;
  // the transport still authenticates whoever answers, and every block and tx is still verified on arrival.
  //
  // It keeps going and it says what happened: a round with failures is ONE line naming them, every round while the
  // budget lasts and then once per QUIET_EVERY rounds — MEASURED 2026-09-16, one dead address per line per retry
  // wrote 8,542 identical lines into node.log, which buries the evidence as surely as not logging it.
  async join({ given = [], book = null } = {}) {
    const RETRY_MS = Math.max(1000, Number(process.env.XN_JOIN_RETRY_MS) || 15000);
    const TARGET = Math.max(1, Number(process.env.XN_JOIN_TARGET) || 4);
    const MAX_TRIES = Math.max(1, Number(process.env.XN_JOIN_MAX_TRIES) || 40);          // ~10 min at 15s
    const QUIET_EVERY = Math.max(1, Number(process.env.XN_JOIN_QUIET_EVERY) || MAX_TRIES);
    this._stopped = false;

    const lib = this.node.node;
    const selfId = (() => { try { return lib.peerId.toString(); } catch { return null; } })();
    const peerIdOf = (addr) => { const m = /\/p2p\/([^/]+)$/.exec(String(addr)); return m ? m[1] : null; };
    // libp2p merges concurrent dials to one peer id and then throws "All multiaddr dials failed" with the real
    // reasons in `.errors`, so every test below reads those too.
    const why = (e) => (Array.isArray(e?.errors) && e.errors.length ? e.errors.map(why).join(' | ') : String(e?.message || e));
    const wrongKey = (e) => e?.name === 'UnexpectedPeerError' || (Array.isArray(e?.errors) && e.errors.some(wrongKey))
      || /does not match expected remote identity|unexpected peer/i.test(String(e?.message || e));
    const isSelfDial = (e) => /can not dial self/i.test(why(e));
    const heldIds = () => {
      try { if (typeof lib.getPeers === 'function') return new Set(lib.getPeers().map(String)); } catch { /* fall through */ }
      return new Set((this.node.connectionManager?.getAllConnections?.() || []).map(([id]) => String(id)));
    };

    // NEVER DIAL YOURSELF. The installer hands every box the same address list, the box at that address included.
    const all = [...new Set((given || []).filter(Boolean))];
    const mine = all.filter((a) => selfId && peerIdOf(a) === selfId);
    if (mine.length) console.log(`[xn] join: skipping ${mine.length} given address(es) that are THIS node`);
    let addrs = all.filter((a) => !mine.includes(a));
    if (!addrs.length && !book) return;
    const resolved = new Map();                       // given address → the peer id that actually answered there

    // Dial; if the address answers under a different key, dial it again without the id. Returns the connection.
    const dialAt = async (target) => {
      try { return await lib.dial(target); } catch (e) {
        if (!wrongKey(e)) throw e;
        const bare = (Array.isArray(target) ? target : [target]).map((m) => m.decapsulateCode(421));
        return lib.dial(bare.length === 1 ? bare[0] : bare);
      }
    };
    const rekeyed = (where, was, now) => console.warn(`[xn] join: ${where} answers as ${now}, not ${was} — that id is stale (the box was re-keyed); using ${now}`);

    let tries = 0;
    const round = async () => {
      if (this._stopped) return;
      const held = heldIds();
      if (held.size >= TARGET) { tries = 0; return; }
      const fromGiven = addrs.map((a) => ({ a, id: resolved.get(String(a)) || peerIdOf(a) })).filter((c) => !(c.id && held.has(c.id)));
      const learned = book
        ? book.targets(selfId).filter((t) => !held.has(t.id) && !fromGiven.some((c) => c.id === t.id)).slice(0, TARGET * 2)
        : [];
      const n = fromGiven.length + learned.length;
      if (!n) return;
      tries++;
      let reached = 0;
      const failures = [];
      await Promise.all([
        ...fromGiven.map(async ({ a, id }) => {
          try {
            const ma = typeof a === 'string' ? multiaddr(a) : a;
            const known = resolved.get(String(a));
            const conn = await dialAt(known ? ma.decapsulateCode(421).encapsulate(`/p2p/${known}`) : ma);
            const now = conn?.remotePeer?.toString();
            if (now && id && now !== id) { resolved.set(String(a), now); rekeyed(String(ma.decapsulateCode(421)), id, now); }
            reached++;
          } catch (e) {
            if (isSelfDial(e)) {                       // THIS node, behind an id it had before a re-key
              addrs = addrs.filter((x) => x !== a);
              console.log(`[xn] join: dropping ${a} — it is THIS node under an old id`);
              return;
            }
            failures.push(`${a}: ${why(e)}`);
          }
        }),
        ...learned.map(async (t) => {
          try {
            const conn = await dialAt(t.addrs.map((x) => multiaddr(x)));
            const now = conn?.remotePeer?.toString();
            if (now && now !== t.id) { book.forget(t.id); rekeyed(t.addrs[0].replace(/\/p2p\/[^/]+$/, ''), t.id, now); }
            reached++;
          } catch (e) {
            book.failed(t.id);
            failures.push(`${t.id} (met before): ${why(e)}`);
          }
        }),
      ]);
      const holding = heldIds().size;
      if (reached) console.log(`[xn] join: ${reached} of ${n} known peer(s) answered — holding ${holding}`);
      if (failures.length && (tries <= MAX_TRIES || tries % QUIET_EVERY === 0)) {
        const where = tries <= MAX_TRIES
          ? `round ${tries}/${MAX_TRIES}`
          : `round ${tries}, retry budget spent — still dialing, next line in ${QUIET_EVERY} round(s)`;
        const shown = failures.slice(0, 3).join('; ') + (failures.length > 3 ? `; +${failures.length - 3} more` : '');
        console.warn(`[xn] join: ${failures.length} of ${n} known peer(s) did not answer (${where}, holding ${holding}): ${shown}`);
      }
      // ISOLATED MEANS NO PEERS. Said once, when the budget runs out; the dialing does not stop, so a peer that
      // comes back is still reached.
      if (tries === MAX_TRIES && holding === 0) {
        console.error(`[xn] join: no known peer has answered in ${tries} rounds — this node holds NO peers and is isolated (mdns can still find LAN peers); still dialing every ${RETRY_MS / 1000}s`);
      }
    };

    await round();                                     // first round inline, so a reachable peer is held at boot
    this._joinTimer = setInterval(() => { round().catch(() => { /* never throw out of the loop */ }); }, RETRY_MS);
    if (this._joinTimer.unref) this._joinTimer.unref();   // never hold the process open
  }

  // Stop the join loop (node shutdown). Safe to call when it was never armed.
  stop() {
    this._stopped = true;
    if (this._joinTimer) { clearInterval(this._joinTimer); this._joinTimer = null; }
  }

  getDiscoveredPeers() {
    return Array.from(this.discoveredPeers);
  }
}
