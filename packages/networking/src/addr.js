// IS THIS BOX THE ONE THE MESH CAN DIAL? Measured on prod 2026-09-15: 0 of 73 coordinators announced a
// single /p2p-circuit address, because the relay SERVER in node.js was gated solely on XMBL_RELAY_SERVER=1 /
// a ~/.handoff/xmbl-relay-server marker and NOBODY HAD EVER SET EITHER. Every node therefore ran the relay
// CLIENT with no relay in existence to reserve on, so 44 of 45 announced only 127.0.0.1 and a 172.17.x
// docker bridge and nothing could be dialed back. A control whose default is "off everywhere" is not a
// control, it is an outage waiting for someone to remember a marker file.
//
// A box that announces or listens on a PUBLIC address already is the dialable box — that is not a policy
// choice an operator has to ratify, it is a fact about its addresses. So elect it automatically and leave
// the env var as the two overrides that actually mean something: '1' forces the server on a box whose
// public address this code cannot see (behind a load balancer, a dns4 name resolved elsewhere), '0' forces
// it off. Private, loopback, link-local and CGNAT ranges never elect — they are exactly the boxes that need
// a relay rather than provide one.
const PRIVATE_V4 = [
  /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,   // CGNAT 100.64.0.0/10
  /^0\./, /^22[4-9]\./, /^2[34]\d\./,           // unspecified + multicast/reserved
];
export function isPublicMultiaddr(ma) {
  if (typeof ma !== 'string' || !ma) return false;
  const v4 = ma.match(/^\/ip4\/([0-9.]+)/);
  if (v4) return !PRIVATE_V4.some((re) => re.test(v4[1]));
  const v6 = ma.match(/^\/ip6\/([0-9a-fA-F:]+)/);
  if (v6) {
    const a = v6[1].toLowerCase();
    return !(a === '::1' || a === '::' || a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd'));
  }
  // A dns name is only in a config because someone resolved it to a reachable host.
  return /^\/dns(4|6|addr)?\//.test(ma);
}
