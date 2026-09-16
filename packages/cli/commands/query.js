import { Command } from 'commander';

// RESULTS GO TO STDOUT, AND ONLY RESULTS. Library logs (module rehydration, ingress-guard lines) are routed to
// stderr by index.js, so a caller can `JSON.parse(stdout)` without stripping noise that arrives after the reply.
const out = (s) => process.stdout.write(String(s) + '\n');
// Block timestamps are nanosecond BigInts, which JSON.stringify refuses; print them as digit strings.
const json = (v, pretty) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), pretty ? 2 : undefined);


export function createQueryCommand(xclt, xvsm, xpc) {
  const queryCmd = new Command('query');

  queryCmd
    .command('balance')
    .description('Query account balance')
    .requiredOption('--address <address>', 'Account address')
    .action(async (options) => {
      if (!xclt || !xclt.Ledger) {
        console.error('Error: XCLT module not available');
        process.exit(1);
      }

      try {
        const ledger = new xclt.Ledger();
        if (typeof ledger.ready === 'function') await ledger.ready();
        // Query balance from ledger state
        // In a implementation, this would query the state tree
        const balance = {
          address: options.address,
          balance: 0 // Would query actual balance from state
        };
        out(JSON.stringify(balance));
      } catch (error) {
        console.error('Error querying balance:', error.message);
        process.exit(1);
      }
    });

  queryCmd
    .command('tx')
    .description('Query transaction by ID')
    .requiredOption('--id <tx-id>', 'Transaction ID')
    .action(async (options) => {
      if (!xclt || !xclt.Ledger) {
        console.error('Error: XCLT module not available');
        process.exit(1);
      }

      try {
        const ledger = new xclt.Ledger();
        if (typeof ledger.ready === 'function') await ledger.ready();
        const block = await ledger.getBlock(options.id);
        if (!block) {
          console.error('Error: Transaction not found');
          process.exit(1);
        }
        out(json({
          id: block.id,
          tx: block.tx,
          status: 'confirmed',
          blockId: block.id,
          timestamp: block.timestamp
        }));
      } catch (error) {
        console.error('Error querying transaction:', error.message);
        process.exit(1);
      }
    });

  queryCmd
    .command('state')
    .description('Query ledger state')
    .action(async () => {
      if (!xclt || !xclt.Ledger) {
        console.error('Error: XCLT module not available');
        process.exit(1);
      }

      try {
        const ledger = new xclt.Ledger();
        if (typeof ledger.ready === 'function') await ledger.ready();
        const cubes = await ledger.getCubes();
        const stateRoot = await ledger.getStateRoot();
        out(JSON.stringify({
          height: cubes.length,
          cubes: cubes.length,
          stateRoot: stateRoot
        }));
      } catch (error) {
        console.error('Error querying state:', error.message);
        process.exit(1);
      }
    });

  return queryCmd;
}

