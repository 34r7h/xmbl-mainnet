import { Command } from 'commander';

// RESULTS GO TO STDOUT, AND ONLY RESULTS. Library logs (module rehydration, ingress-guard lines) are routed to
// stderr by index.js, so a caller can `JSON.parse(stdout)` without stripping noise that arrives after the reply.
const out = (s) => process.stdout.write(String(s) + '\n');

// A named subcommand GROUP on `parent`, created once and reused (see ledger.js for why `.command('a b')` is wrong).
function group(parent, name) {
  const existing = parent.commands.find((c) => c.name() === name);
  return existing || parent.command(name);
}


export function createStateCommand(xvsm) {
  const stateCmd = new Command('state');

  stateCmd
    .command('get <key>')
    .description('Get state value')
    .action(async (key) => {
      if (!xvsm || !xvsm.VerkleStateTree) {
        console.error('Error: XVSM module not available');
        process.exit(1);
      }

      try {
        const tree = new xvsm.VerkleStateTree();
        const value = tree.get(key);
        out(JSON.stringify({ key, value }));
      } catch (error) {
        console.error('Error getting state:', error.message);
        process.exit(1);
      }
    });

  stateCmd
    .command('set <key>')
    .description('Set state value')
    .requiredOption('--value <json>', 'Value JSON')
    .action(async (key, options) => {
      if (!xvsm || !xvsm.VerkleStateTree) {
        console.error('Error: XVSM module not available');
        process.exit(1);
      }

      try {
        const tree = new xvsm.VerkleStateTree();
        const value = JSON.parse(options.value);
        tree.insert(key, value);
        out(JSON.stringify({ key, value, root: tree.getRoot() }));
      } catch (error) {
        console.error('Error setting state:', error.message);
        process.exit(1);
      }
    });

  stateCmd
    .command('root')
    .description('Get state root')
    .action(async () => {
      if (!xvsm || !xvsm.VerkleStateTree) {
        console.error('Error: XVSM module not available');
        process.exit(1);
      }

      try {
        const tree = new xvsm.VerkleStateTree();
        const root = tree.getRoot();
        out(JSON.stringify({ stateRoot: root }));
      } catch (error) {
        console.error('Error getting state root:', error.message);
        process.exit(1);
      }
    });

  group(stateCmd, 'proof')
    .command('generate <key>')
    .description('Generate state proof')
    .action(async (key) => {
      if (!xvsm || !xvsm.VerkleStateTree) {
        console.error('Error: XVSM module not available');
        process.exit(1);
      }

      try {
        const tree = new xvsm.VerkleStateTree();
        const proof = tree.generateProof(key);
        out(JSON.stringify(proof));
      } catch (error) {
        console.error('Error generating proof:', error.message);
        process.exit(1);
      }
    });

  return stateCmd;
}

