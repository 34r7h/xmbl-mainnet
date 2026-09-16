import { Command } from 'commander';

// RESULTS GO TO STDOUT, AND ONLY RESULTS. Library logs (module rehydration, ingress-guard lines) are routed to
// stderr by index.js, so a caller can `JSON.parse(stdout)` without stripping noise that arrives after the reply.
const out = (s) => process.stdout.write(String(s) + '\n');

export function createTxCommand(xid, xclt, xpc, xn) {
  const txCmd = new Command('tx');

  txCmd
    .command('create')
    .description('Create a new transaction')
    .requiredOption('--to <address>', 'Recipient address')
    .requiredOption('--amount <number>', 'Amount to send')
    .option('--fee <number>', 'Transaction fee', '0.1')
    .option('--stake <number>', 'Validation stake', '0.2')
    .option('--type <type>', 'Transaction type', 'utxo')
    .option('--from <address>', 'Sender address')
    .action(async (options) => {
      const tx = {
        type: options.type,
        to: options.to,
        amount: parseFloat(options.amount),
        fee: parseFloat(options.fee),
        stake: parseFloat(options.stake),
        timestamp: Date.now()
      };
      
      if (options.from) {
        tx.from = options.from;
      }
      
      out(JSON.stringify(tx, null, 2));
    });

  txCmd
    .command('sign')
    .description('Sign a transaction')
    .requiredOption('--tx <json>', 'Transaction JSON')
    .requiredOption('--key <name>', 'Identity name (from KeyManager)')
    .option('--key-dir <path>', 'Key directory path', './keys')
    .option('--password <password>', 'Password for encrypted key')
    .action(async (options) => {
      if (!xid || !xid.KeyManager || !xid.Identity) {
        console.error('Error: XID module not available');
        process.exit(1);
      }

      try {
        const tx = JSON.parse(options.tx);
        const keyManager = new xid.KeyManager(options.keyDir);
        const identity = await keyManager.loadIdentity(options.key, options.password);
        const signed = await identity.signTransaction(tx);
        // Output compact JSON for easier piping
        out(JSON.stringify(signed));
      } catch (error) {
        console.error('Error signing transaction:', error.message);
        process.exit(1);
      }
    });

  txCmd
    .command('submit')
    .description('Submit transaction to network')
    .requiredOption('--tx <json>', 'Signed transaction JSON')
    .requiredOption('--leader <leader-id>', 'Leader ID for submission')
    .action(async (options) => {
      if (!xpc || !xpc.ConsensusWorkflow) {
        console.error('Error: XPC module not available');
        process.exit(1);
      }

      try {
        const tx = JSON.parse(options.tx);
        const workflow = new xpc.ConsensusWorkflow({ xid, xclt, xn });
        const rawTxId = await workflow.submitTransaction(options.leader, tx);
        out('Transaction submitted');
        out(`raw_tx_id: ${rawTxId}`);
      } catch (error) {
        console.error('Error submitting transaction:', error.message);
        process.exit(1);
      }
    });

  return txCmd;
}

