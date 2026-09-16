#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createTxCommand } from './commands/tx.js';
import { createIdentityCommand } from './commands/identity.js';
import { createLedgerCommand } from './commands/ledger.js';
import { createConsensusCommand } from './commands/consensus.js';
import { createStateCommand } from './commands/state.js';
import { createStorageCommand } from './commands/storage.js';
import { createNetworkCommand } from './commands/network.js';
import { createQueryCommand } from './commands/query.js';
import { createMonitorCommand } from './commands/monitor.js';
import { createExportCommand } from './commands/export.js';
import { createChainCommand } from './commands/chain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const packageJson = JSON.parse(
  readFileSync(join(__dirname, 'package.json'), 'utf8')
);

const program = new Command();

program
  .name('xmbl')
  .description('XMBL Command Line Interface')
  .version(packageJson.version);

// Initialize modules - REQUIRED, no fallbacks
// Suppress console.log from module initialization
const originalLog = console.log;
console.log = () => {}; // Suppress during module loading

let xid, xclt, xpc, xn, xvsm, xsc;

try {
  // By PACKAGE NAME, never by monorepo-relative path: the published @xmbl/cli resolves these from its own
  // dependencies, and inside this repo the workspace links point them at packages/*.
  xid = await import('@xmbl/identity');
  xclt = await import('@xmbl/cubic-ledger');
  xpc = await import('@xmbl/consensus');
  xn = await import('@xmbl/networking');
  xvsm = await import('@xmbl/state-machine');
  xsc = await import('@xmbl/storage-compute');
  
  // Modules are loaded. From here on, library console.log (mempool rehydration, ingress-guard verdicts, sweep
  // notices) goes to STDERR: the modules emit it asynchronously, so it used to land AFTER a command's JSON
  // reply and break every caller that parsed stdout. Commands print their results via process.stdout.write.
  console.log = (...args) => console.error(...args);
} catch (error) {
  // Restore console.log before error
  console.log = originalLog;
  console.error('Failed to load XMBL modules:', error.message);
  console.error('Ensure the @xmbl/* protocol packages this CLI depends on are installed.');
  process.exit(1);
}

// Add all command groups
const txCmd = createTxCommand(xid, xclt, xpc, xn);
program.addCommand(txCmd);

const identityCmd = createIdentityCommand(xid);
program.addCommand(identityCmd);

const ledgerCmd = createLedgerCommand(xclt);
program.addCommand(ledgerCmd);

const consensusCmd = createConsensusCommand(xpc, xid, xclt, xn);
program.addCommand(consensusCmd);

const stateCmd = createStateCommand(xvsm);
program.addCommand(stateCmd);

const storageCmd = createStorageCommand(xsc);
program.addCommand(storageCmd);

const networkCmd = createNetworkCommand(xn);
program.addCommand(networkCmd);

const queryCmd = createQueryCommand(xclt, xvsm, xpc);
program.addCommand(queryCmd);

const monitorCmd = createMonitorCommand(xclt, xpc, xsc);
program.addCommand(monitorCmd);

const exportCmd = createExportCommand(xclt, xvsm);
program.addCommand(exportCmd);

const chainCmd = createChainCommand(xid, xn, xclt, xpc, xsc);
program.addCommand(chainCmd);

program.parse();
