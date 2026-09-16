import { Command } from 'commander';
import fs from 'fs/promises';

// RESULTS GO TO STDOUT, AND ONLY RESULTS. Library logs (module rehydration, ingress-guard lines) are routed to
// stderr by index.js, so a caller can `JSON.parse(stdout)` without stripping noise that arrives after the reply.
const out = (s) => process.stdout.write(String(s) + '\n');

// A named subcommand GROUP on `parent`, created once and reused, so `xmbl ledger tx add` and `xmbl ledger tx list`
// share one `tx` group. (`.command('tx add')` does NOT do this: commander reads `add` as a required positional
// argument, and the action then receives the word where it expects its options.)
function group(parent, name) {
  const existing = parent.commands.find((c) => c.name() === name);
  return existing || parent.command(name);
}


export function createStorageCommand(xsc) {
  const storageCmd = new Command('storage');

  storageCmd
    .command('store')
    .description('Store data')
    .requiredOption('--data <file>', 'Data file path')
    .option('--shards <number>', 'Number of data shards', '4')
    .option('--parity <number>', 'Number of parity shards', '2')
    .action(async (options) => {
      if (!xsc || !xsc.StorageShard || !xsc.StorageNode) {
        console.error('Error: XSC module not available');
        process.exit(1);
      }

      try {
        const data = await fs.readFile(options.data);
        const { shards, parity } = xsc.StorageShard.encode(data, parseInt(options.shards), parseInt(options.parity));
        const node = new xsc.StorageNode();
        const shardIds = [];
        for (const shard of [...shards, ...parity]) {
          const shardId = await node.storeShard(shard);
          shardIds.push(shardId);
        }
        out(JSON.stringify({ shardIds, shards: shards.length, parity: parity.length }));
      } catch (error) {
        console.error('Error storing data:', error.message);
        process.exit(1);
      }
    });

  group(storageCmd, 'node')
    .command('status')
    .description('Show storage node status')
    .action(async () => {
      if (!xsc || !xsc.StorageNode) {
        console.error('Error: XSC module not available');
        process.exit(1);
      }

      try {
        const node = new xsc.StorageNode();
        out(JSON.stringify({
          capacity: node.getCapacity(),
          used: node.getUsed(),
          available: node.getCapacity() - node.getUsed()
        }));
      } catch (error) {
        console.error('Error getting node status:', error.message);
        process.exit(1);
      }
    });

  group(storageCmd, 'pricing')
    .command('storage')
    .description('Calculate storage price')
    .requiredOption('--size <bytes>', 'Size in bytes')
    .option('--utilization <0-1>', 'Utilization factor', '0.5')
    .action(async (options) => {
      if (!xsc || !xsc.MarketPricing) {
        console.error('Error: XSC module not available');
        process.exit(1);
      }

      try {
        const pricing = new xsc.MarketPricing();
        const price = pricing.calculateStoragePrice(parseInt(options.size), parseFloat(options.utilization));
        out(JSON.stringify({ size: options.size, utilization: options.utilization, price }));
      } catch (error) {
        console.error('Error calculating price:', error.message);
        process.exit(1);
      }
    });

  return storageCmd;
}

