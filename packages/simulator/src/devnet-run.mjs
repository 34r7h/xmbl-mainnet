// Runner for the XMBL LocalDevnet + its RPC surface.  `npm run devnet -w packages/simulator`
//
// Boots a real local network (real MAYO identities + real cubic ledger, signature verification
// ON), seeds a little activity so balances/height are non-trivial, then serves the browser
// -extension message contract over loopback HTTP and stays up until Ctrl-C. The printed URL is
// the one a node bridge (replacing the extension's stub BackgroundNode) would POST to.
//
//   PORT=8645 npm run devnet -w packages/simulator     # pin the RPC port (default: OS-assigned)
//   IDENTITIES=6 SEED=12 npm run devnet -w packages/simulator
import { LocalDevnet } from './devnet.js';
import { DevnetRpc } from './devnet-rpc.js';

const identities = Number(process.env.IDENTITIES || 4);
const seed = Number(process.env.SEED || 9);
const port = Number(process.env.PORT || 0);

const net = await new LocalDevnet({ identities }).start();
console.log(`[devnet] booted ${net.metrics.identities} real identities; wallet = ${net.addressOf(0)}`);

// Seed: wallet → participant 1, varied amounts, through the real verified direct path.
for (let k = 0; k < seed; k++) {
  const r = await net.submitTransfer(0, 1, 1 + k);
  if (!r.ok) console.warn(`[devnet] seed tx ${k} rejected: ${r.error}`);
}
const m = await net.getMetrics();
console.log(`[devnet] seeded ${m.landed} landed tx, ${m.facesCompleted} face(s) sealed, pooled ${m.pooled}, root ${m.root ?? '(none)'}`);

const rpc = new DevnetRpc(net, { walletIndex: 0 });
await rpc.listen(port);
console.log(`[devnet] RPC (extension message contract) listening at ${rpc.url()}`);
console.log('[devnet] POST JSON {type:"getNodeStatus"} | {"getBalance"} | {"sendTransaction",tx:{to,amount}} | {"startNode"} | {"stopNode"}');
console.log('[devnet] Ctrl-C to stop.');

const shutdown = async () => {
  console.log('\n[devnet] shutting down…');
  await rpc.close();
  await net.dispose();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
