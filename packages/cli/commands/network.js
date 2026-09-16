import { Command } from 'commander';

// RESULTS GO TO STDOUT, AND ONLY RESULTS. Library logs (module rehydration, ingress-guard lines) are routed to
// stderr by index.js, so a caller can `JSON.parse(stdout)` without stripping noise that arrives after the reply.
const out = (s) => process.stdout.write(String(s) + '\n');

export function createNetworkCommand(xn) {
  const networkCmd = new Command('network');

  let node = null;
  let nodeStartTime = null;

  networkCmd
    .command('start')
    .description('Start networking node')
    .option('--port <port>', 'Port number', '3000')
    .action(async (options) => {
      if (!xn || !xn.XNNode) {
        console.error('Error: XN module not available');
        process.exit(1);
      }

      try {
        if (node && node.isStarted && node.isStarted()) {
          console.error('Error: Node already running');
          process.exit(1);
        }
        node = new xn.XNNode({ port: parseInt(options.port) });
        await node.start();
        nodeStartTime = Date.now();
        const addresses = node.getAddresses();
        out(JSON.stringify({
          started: true,
          peerId: node.getPeerId().toString(),
          addresses: addresses.map(a => a.toString())
        }));
      } catch (error) {
        console.error('Error starting node:', error.message);
        process.exit(1);
      }
    });

  networkCmd
    .command('status')
    .description('Show node status')
    .action(async () => {
      if (!node) {
        console.error('Error: Node not started. Use "network start" first.');
        process.exit(1);
      }

      try {
        const uptime = nodeStartTime ? Date.now() - nodeStartTime : 0;
        out(JSON.stringify({
          started: node.isStarted(),
          peerId: node.getPeerId()?.toString(),
          addresses: node.getAddresses().map(a => a.toString()),
          uptime: uptime
        }));
      } catch (error) {
        console.error('Error getting status:', error.message);
        process.exit(1);
      }
    });

  networkCmd
    .command('peers')
    .description('Show connected peers')
    .action(async () => {
      if (!node) {
        console.error('Error: Node not started. Use "network start" first.');
        process.exit(1);
      }

      try {
        const peers = node.getConnectedPeers ? node.getConnectedPeers() : [];
        out(JSON.stringify({ peers: peers.map(p => p.toString()) }));
      } catch (error) {
        console.error('Error getting peers:', error.message);
        process.exit(1);
      }
    });

  networkCmd
    .command('stop')
    .description('Stop networking node')
    .action(async () => {
      if (!node || !node.isStarted || !node.isStarted()) {
        console.error('Error: Node not running');
        process.exit(1);
      }

      try {
        await node.stop();
        node = null;
        nodeStartTime = null;
        out(JSON.stringify({ stopped: true }));
      } catch (error) {
        console.error('Error stopping node:', error.message);
        process.exit(1);
      }
    });

  networkCmd
    .command('restart')
    .description('Restart networking node')
    .option('--port <port>', 'Port number', '3000')
    .action(async (options) => {
      if (node && node.isStarted && node.isStarted()) {
        await node.stop();
        node = null;
        nodeStartTime = null;
      }

      try {
        node = new xn.XNNode({ port: parseInt(options.port) });
        await node.start();
        nodeStartTime = Date.now();
        const addresses = node.getAddresses();
        out(JSON.stringify({
          restarted: true,
          peerId: node.getPeerId().toString(),
          addresses: addresses.map(a => a.toString())
        }));
      } catch (error) {
        console.error('Error restarting node:', error.message);
        process.exit(1);
      }
    });

  return networkCmd;
}

