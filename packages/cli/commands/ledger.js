import { Command } from 'commander';

// RESULTS GO TO STDOUT, AND ONLY RESULTS. Library logs (module rehydration, ingress-guard lines) are routed to
// stderr by index.js, so a caller can `JSON.parse(stdout)` without stripping noise that arrives after the reply.
const out = (s) => process.stdout.write(String(s) + '\n');
// Block timestamps are nanosecond BigInts, which JSON.stringify refuses; print them as digit strings.
const json = (v, pretty) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), pretty ? 2 : undefined);


// A named subcommand GROUP on `parent`, created once and reused, so `xmbl ledger tx add` and `xmbl ledger tx list`
// share one `tx` group. (`.command('tx add')` does NOT do this: commander reads `add` as a required positional
// argument, and the action then receives the word where it expects its options.)
function group(parent, name) {
  const existing = parent.commands.find((c) => c.name() === name);
  return existing || parent.command(name);
}


export function createLedgerCommand(xclt) {
  const ledgerCmd = new Command('ledger');

  group(ledgerCmd, 'tx')
    .command('add')
    .description('Add transaction to ledger')
    .requiredOption('--tx <json>', 'Transaction JSON')
    .action(async (options) => {
      if (!xclt || !xclt.Ledger) {
        console.error('Error: XCLT module not available');
        process.exit(1);
      }

      try {
        let tx = options.tx;
        if (typeof tx === 'string') {
          tx = JSON.parse(tx);
        }
        if (!tx || typeof tx !== 'object' || Array.isArray(tx)) {
          throw new Error('Transaction must be an object');
        }
        const ledger = new xclt.Ledger();
        if (typeof ledger.ready === 'function') await ledger.ready();
        // A write to a store that did not open would live only in this process — refuse rather than print an id
        // that no later command can find (a LevelDB LOCK held by another xmbl process is the usual cause).
        if (ledger._dbOpen === false) {
          throw new Error(`ledger store unavailable at ${ledger.db?.location || './data/ledger'}: ${ledger._dbError?.code || ledger._dbError?.message || 'not open'} — is another xmbl process holding it?`);
        }
        // Signed transactions from identity.signTransaction() return the full tx with sig;
        // the ledger answers with the block it pooled (id + hash) and the seal outcome.
        // An untyped tx is refused by the ledger (every tx carries its xmbl type as a micromined xid), so the
        // CLI mines it for the caller when it is not typed yet; a typed one is added exactly as given.
        const r = await ledger.addTransaction(tx.xid ? tx : xclt.micromineTx(tx));
        out(JSON.stringify({ blockId: r.id ?? null, hash: r.hash ?? null, pooled: r.pooled, sealedFaces: r.sealedFaces, duplicate: !!r.duplicate, evicted: !!r.evicted }));
      } catch (error) {
        console.error('Error adding transaction:', error.message);
        process.exit(1);
      }
    });

  group(ledgerCmd, 'block')
    .command('get <block-id>')
    .description('Get block by ID')
    .action(async (blockId) => {
      if (!xclt || !xclt.Ledger) {
        console.error('Error: XCLT module not available');
        process.exit(1);
      }

      try {
        const ledger = new xclt.Ledger();
        if (typeof ledger.ready === 'function') await ledger.ready();
        const block = await ledger.getBlock(blockId);
        if (!block) { console.error('Error: Block not found'); process.exit(1); }
        out(json(block));
      } catch (error) {
        console.error('Error getting block:', error.message);
        process.exit(1);
      }
    });

  group(ledgerCmd, 'cube')
    .command('list')
    .description('List all cubes')
    .action(async () => {
      if (!xclt || !xclt.Ledger) {
        console.error('Error: XCLT module not available');
        process.exit(1);
      }

      try {
        const ledger = new xclt.Ledger();
        if (typeof ledger.ready === 'function') await ledger.ready();
        const cubes = await ledger.getCubes();
        out(JSON.stringify(cubes.map(c => ({ id: c.id, faces: c.faces.size }))));
      } catch (error) {
        console.error('Error listing cubes:', error.message);
        process.exit(1);
      }
    });

  group(ledgerCmd, 'state')
    .command('root')
    .description('Get ledger state root')
    .action(async () => {
      if (!xclt || !xclt.Ledger) {
        console.error('Error: XCLT module not available');
        process.exit(1);
      }

      try {
        const ledger = new xclt.Ledger();
        if (typeof ledger.ready === 'function') await ledger.ready();
        const root = await ledger.getStateRoot();
        out(JSON.stringify({ stateRoot: root }));
      } catch (error) {
        console.error('Error getting state root:', error.message);
        process.exit(1);
      }
    });

  return ledgerCmd;
}

