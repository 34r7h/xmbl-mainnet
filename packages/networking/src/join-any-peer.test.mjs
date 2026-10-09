// ⛔ NO PEER IS THE WAY IN. A node joins through ANY address it knows, and losing any one box costs it nothing.
//
// MEASURED 2026-10-09: the addresses in bootstrap_peers had a role no other peer had — dialed alone at boot, kept
// connected forever, the only source of a NAT'd node's relay reservation (node.js listened on
// `<configured>/p2p-circuit`). The installer shipped one such address, the box behind it (173.255.233.69) had been
// re-keyed on 09-20, every older config named its old peer id, the box refused that id ("Payload identity key …
// does not match expected remote identity key …"), and every NAT'd node holding such a config sat at 0 peers.
//
// This asserts the OUTCOME on started nodes (mDNS off everywhere, so nothing is found over the LAN). A is given
// three addresses: one whose port is closed, B's address under B's OLD id, and C's. A must hold B (under its real
// id) and C; must listen on no address built from what it was given; must hold a relay reservation through a peer
// it is connected to; must spend one dial per round on the dead address and none on peers it holds; and when the
// peer it reserved its relay through dies, must still hold the other and reserve through it instead. The CONTROL is B's entry dialed exactly as written,
// which B must refuse — otherwise the connection to B could have come from somewhere else.
import net from 'node:net';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { XNNode } from './node.js';

process.env.XN_JOIN_RETRY_MS = '2000';
process.env.XMBL_RELAY_SERVER = '1';                 // every node here can relay; loopback never self-elects

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100); } return fn(); };
const node = (o) => new XNNode({ mdns: false, ...o });
const tcpOf = (n) => `${n.getAddresses().find((a) => String(a).includes('/tcp/') && !String(a).includes('p2p-circuit'))}`.replace(/\/p2p\/[^/]+$/, '');
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const peersOf = (n) => n.getConnectedPeers().map(String);
const circuitsVia = (n, id) => n.getAddresses().map(String).filter((a) => a.includes(`/p2p/${id}/p2p-circuit`));

const lines = [];
for (const k of ['log', 'warn', 'error']) { const orig = console[k]; console[k] = (...a) => { lines.push(a.join(' ')); orig(...a); }; }
const said = (re) => lines.filter((l) => re.test(l)).length;

const B = node({ addresses: ['/ip4/127.0.0.1/tcp/0'] });
await B.start();
const C = node({ addresses: ['/ip4/127.0.0.1/tcp/0'] });
await C.start();
const idB = B.getPeerId().toString();
const idC = C.getPeerId().toString();
const oldIdB = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();   // the key B had before
const deadId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
const deadPort = await freePort();
const given = [
  `/ip4/127.0.0.1/tcp/${deadPort}/p2p/${deadId}`,     // nothing listens here
  `${tcpOf(B)}/p2p/${oldIdB}`,                         // B, under an id it no longer has
  `${tcpOf(C)}/p2p/${idC}`,                            // C, as it is
];

const A = node({ addresses: ['/ip4/127.0.0.1/tcp/0'], bootstrap: given });
await A.start();
const both = await waitFor(() => peersOf(A).includes(idB) && peersOf(A).includes(idC), 8000);
check('A holds B under B\'s real id and C', both, `${peersOf(A).length} peer(s): B ${peersOf(A).includes(idB) ? 'yes' : 'NO'}, C ${peersOf(A).includes(idC) ? 'yes' : 'NO'}`);

let refused = '';
try { await A.node.dial(multiaddr(given[1])); refused = 'CONNECTED'; } catch (e) { refused = String(e?.message || e); }
check('CONTROL: B\'s entry dialed as written is refused for its key', /does not match expected remote identity|unexpected peer/i.test(refused), refused.slice(0, 110));
check('the stale id is reported once, naming both ids', said(new RegExp(`answers as ${idB}, not ${oldIdB}`)) === 1);

const listens = A.node.components.addressManager.getListenAddrs().map(String);
const built = listens.filter((l) => given.some((g) => l.startsWith(g)));
check('A listens on no address built from the addresses it was given', built.length === 0, built.join(', ') || `${listens.length} listen addr(s), none from the given list`);

const relayed = await waitFor(() => circuitsVia(A, idB).length + circuitsVia(A, idC).length > 0, 10000);
check('A holds a relay reservation through a peer it is connected to', relayed, A.getAddresses().map(String).filter((a) => a.includes('p2p-circuit')).join(', ') || 'no circuit address');

let dials = [];
const dialA = A.node.dial.bind(A.node);
A.node.dial = (t, ...rest) => { dials.push(String(Array.isArray(t) ? t[0] : t)); return dialA(t, ...rest); };
await sleep(4500);                                   // two rounds
const toHeld = dials.filter((d) => d.includes(String(tcpOf(B))) || d.includes(String(tcpOf(C))));
const toDead = dials.filter((d) => d.includes(`/tcp/${deadPort}`));
check('per round: one dial to the dead address, none to the peers it holds', toHeld.length === 0 && toDead.length >= 1 && toDead.length <= 3, `${toDead.length} to the dead address, ${toHeld.length} to held peers in ~2 rounds`);
A.node.dial = dialA;
check('a closed port is never reported as a stale id', said(new RegExp(`tcp/${deadPort}.*answers as`)) === 0 && said(/ECONNREFUSED/) >= 1);

// ── the peer A reserved its relay through dies. Nothing about A depended on it. ──
const viaB = circuitsVia(A, idB).length > 0;
const [gone, goneId, left, leftId] = viaB ? [B, idB, C, idC] : [C, idC, B, idB];
await gone.stop();
const kept = await waitFor(() => !peersOf(A).includes(goneId) && peersOf(A).includes(leftId), 8000);
check(`with its relay (${viaB ? 'B' : 'C'}) gone, A still holds the other peer`, kept, `${peersOf(A).length} peer(s)`);
const relayLeft = await waitFor(() => circuitsVia(A, leftId).length > 0 && circuitsVia(A, goneId).length === 0, 30000);
check(`with its relay gone, A holds a relay reservation through ${viaB ? 'C' : 'B'} instead`, relayLeft, A.getAddresses().map(String).filter((a) => a.includes('p2p-circuit')).join(', ') || 'no circuit address');

// ── the box's own entry, written before it was re-keyed, is THIS node: dropped once, never warned about ──
const ownPort = await freePort();
const S = node({ addresses: [`/ip4/127.0.0.1/tcp/${ownPort}`], bootstrap: [`/ip4/127.0.0.1/tcp/${ownPort}/p2p/${oldIdB}`] });
await S.start();
await sleep(4500);
check('an address that is this node under an old id is dropped once and not re-dialed', said(new RegExp(`dropping .*tcp/${ownPort}/.* THIS node`)) === 1 && said(new RegExp(`tcp/${ownPort}/[^ ]*: `)) === 0);
await S.stop();

await A.stop();
await left.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
