import { Command } from 'commander';

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


export function createConsensusCommand(xpc, xid, xclt, xn) {
  const consensusCmd = new Command('consensus');

  let workflow = null;

  consensusCmd
    .command('submit')
    .description('Submit a transaction to the mempool (signed with --key, or already carrying a sig)')
    .requiredOption('--tx <json>', 'Transaction JSON')
    .requiredOption('--leader <leader-id>', 'Leader ID')
    .option('--key <name>', 'Sign with this identity (from KeyManager) before submitting')
    .option('--key-dir <path>', 'Key directory path', './keys')
    .option('--password <password>', 'Password for an encrypted key')
    .action(async (options) => {
      if (!xpc || !xpc.ConsensusWorkflow) {
        console.error('Error: XPC module not available');
        process.exit(1);
      }

      try {
        let tx = JSON.parse(options.tx);
        // USER-AS-VALIDATOR: an unsigned tx is refused at ingress by design (nothing can ever validate it), so the
        // CLI signs here when given a key — the same KeyManager identity `tx sign` uses — instead of submitting
        // bytes the node will drop.
        if (options.key) {
          if (!xid || !xid.KeyManager) { console.error('Error: XID module not available'); process.exit(1); }
          const identity = await new xid.KeyManager(options.keyDir).loadIdentity(options.key, options.password);
          tx = await identity.signTransaction(tx);
        }
        if (!workflow) {
          workflow = new xpc.ConsensusWorkflow({ xid, xclt, xn });
        }
        const rawTxId = await workflow.submitTransaction(options.leader, tx);
        // A null id is a REJECTION (unsigned, malformed anchor, flood-banned) — report it as one, never as a submit.
        if (!rawTxId) {
          out(JSON.stringify({ ok: false, rawTxId: null, error: 'rejected at ingress — the node admitted no transaction (unsigned? pass --key <name> to sign)' }));
          process.exit(1);
        }
        out(JSON.stringify({ ok: true, rawTxId }));
      } catch (error) {
        console.error('Error submitting transaction:', error.message);
        process.exit(1);
      }
    });

  group(consensusCmd, 'raw-tx')
    .command('list')
    .description('List raw transactions')
    .option('--leader <leader-id>', 'Filter by leader')
    .action(async (options) => {
      if (!xpc || !xpc.Mempool) {
        console.error('Error: XPC module not available');
        process.exit(1);
      }

      try {
        const mempool = new xpc.Mempool();
        if (options.leader) {
          const leaderTxs = mempool.rawTx.get(options.leader);
          const txs = leaderTxs ? Array.from(leaderTxs.keys()) : [];
          out(JSON.stringify(txs));
        } else {
          const allTxs = [];
          for (const [leader, txs] of mempool.rawTx) {
            for (const txId of txs.keys()) {
              allTxs.push({ leader, rawTxId: txId });
            }
          }
          out(JSON.stringify(allTxs));
        }
      } catch (error) {
        console.error('Error listing raw transactions:', error.message);
        process.exit(1);
      }
    });

  group(consensusCmd, 'leader')
    .command('elect')
    .description('Elect leaders')
    .option('--count <number>', 'Number of leaders', '3')
    .action(async (options) => {
      if (!xpc || !xpc.LeaderElection) {
        console.error('Error: XPC module not available');
        process.exit(1);
      }

      try {
        const election = new xpc.LeaderElection();
        const leaders = election.electLeaders(parseInt(options.count));
        out(JSON.stringify({ leaders }));
      } catch (error) {
        console.error('Error electing leaders:', error.message);
        process.exit(1);
      }
    });

  group(consensusCmd, 'stats')
    .command('mempool')
    .description('Get mempool statistics')
    .action(async () => {
      if (!xpc || !xpc.Mempool) {
        console.error('Error: XPC module not available');
        process.exit(1);
      }

      try {
        const mempool = new xpc.Mempool();
        let rawCount = 0;
        for (const txs of mempool.rawTx.values()) {
          rawCount += txs.size;
        }
        out(JSON.stringify({
          rawTx: rawCount,
          processing: mempool.processingTx.size,
          finalized: mempool.tx.size,
          lockedUtxos: mempool.lockedUtxo.size
        }));
      } catch (error) {
        console.error('Error getting mempool stats:', error.message);
        process.exit(1);
      }
    });

  return consensusCmd;
}

