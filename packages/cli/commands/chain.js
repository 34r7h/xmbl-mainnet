import { Command } from 'commander';
import { spawn } from 'child_process';
import { mkdir, rm, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// `xmbl chain` — a LOCAL XMBL DEVNET from the command line, the "hardhat for XMBL".
//
// This used to be an in-process mock (a LocalChain object with a Map of balances) that died with the process
// that started it, so `chain start` in one shell and `chain accounts` in the next could never see each other.
// It now runs the REAL thing: @xmbl/simulator's LocalDevnet (real MAYO identities, a real cubic ledger with
// signature verification ON) served over its DevnetRpc — the same loopback contract the browser extension's
// node bridge speaks — as a detached daemon. Every other subcommand is a client of that RPC, so the numbers
// it prints are read from the running devnet, never from this process's memory.
//
// RESULTS GO TO STDOUT, AND ONLY RESULTS. Library logs are routed to stderr by index.js.
const out = (s) => process.stdout.write(String(s) + '\n');

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'index.js');
// The pointer a later invocation follows to find the devnet this shell started (cwd-scoped, like a .env).
const POINTER = '.xmbl-devnet.json';
const STATE_FILE = 'devnet.json';
// The devnet's named participants. Index 0 is the FAUCET: it funds every other account at start with real,
// signed transfers, so a fresh devnet has spendable balances — and its own balance reads NEGATIVE by exactly the
// amount it minted, because a devnet balance is the genuine net of applied deltas (LocalDevnet.balanceOf).
const ACCOUNT_NAMES = ['faucet', 'alice', 'bob', 'charlie', 'deployer', 'validator1', 'validator2', 'validator3', 'storage1', 'compute1'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

// process.kill(pid, 0) throws ESRCH when the process is gone, EPERM when it exists but is not ours (alive).
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Locate the running devnet: an explicit --data-dir, else the cwd pointer. Returns { dataDir, state } or null.
async function findDevnet(dataDirOpt) {
  const dataDir = dataDirOpt ? resolve(dataDirOpt) : (await readJson(POINTER))?.data_dir;
  if (!dataDir) return null;
  const state = await readJson(join(dataDir, STATE_FILE));
  if (!state || !isAlive(state.pid)) return null;
  return { dataDir, state };
}

async function rpc(url, message) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
  return res.json();
}

function notRunning() {
  out('Chain not running. Start with: xmbl chain start');
}

// ---- the daemon body: boots the devnet in THIS process and serves it until SIGTERM ----
async function runForeground({ port, dataDir, accounts, defaultBalance }) {
  const { LocalDevnet, DevnetRpc } = await import('@xmbl/simulator');
  await mkdir(dataDir, { recursive: true });
  const count = Math.max(2, Math.min(accounts, ACCOUNT_NAMES.length));
  const net = await new LocalDevnet({ identities: count, dbPath: join(dataDir, 'ledger') }).start();
  // Fund every named account from the faucet with a REAL signed transfer that the ledger verifies.
  for (let i = 1; i < count; i++) {
    const r = await net.submitTransfer(0, i, defaultBalance);
    if (!r.ok) console.error(`[chain] faucet grant to ${ACCOUNT_NAMES[i]} rejected: ${r.error}`);
  }
  const server = new DevnetRpc(net, { walletIndex: 0 });
  const boundPort = await server.listen(port);
  const state = {
    pid: process.pid,
    url: server.url(),
    port: boundPort,
    data_dir: dataDir,
    started_at: new Date().toISOString(),
    accounts: net.identities.slice(0, count).map((id, index) => ({ name: ACCOUNT_NAMES[index], index, address: id.address, public_key: id.publicKey })),
  };
  await writeFile(join(dataDir, STATE_FILE), JSON.stringify(state, null, 2));
  console.error(`[chain] devnet up pid=${process.pid} rpc=${state.url} accounts=${count}`);
  const shutdown = async () => {
    try { await server.close(); } catch { /* already closed */ }
    try { await net.dispose(); } catch { /* in-memory */ }
    await rm(join(dataDir, STATE_FILE), { force: true });
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  setInterval(() => {}, 1 << 30);   // stay up until signalled
}

export function createChainCommand() {
  const chainCmd = new Command('chain');

  chainCmd
    .command('start')
    .description('Start a local XMBL devnet (real identities + ledger) and serve its RPC')
    .option('--port <port>', 'RPC port (0 = OS-assigned)', '8646')
    .option('--data-dir <path>', 'Data directory', './chain-data')
    .option('--nodes <number>', 'Number of nodes (a LocalDevnet is one node; kept for CLI compatibility)', '1')
    .option('--accounts <number>', 'Named test accounts to mint (faucet + up to 9)', '10')
    .option('--balance <amount>', 'Starting balance the faucet grants each account', '10000')
    .option('--foreground', 'Run in this process instead of daemonizing', false)
    .action(async (options) => {
      const dataDir = resolve(options.dataDir);
      const port = parseInt(options.port, 10);
      const accounts = parseInt(options.accounts, 10);
      const defaultBalance = parseFloat(options.balance);
      if (options.foreground) {
        await runForeground({ port, dataDir, accounts, defaultBalance });
        return;
      }
      const running = await findDevnet(options.dataDir);
      if (running) {
        console.error(`Error: Chain already running (pid ${running.state.pid}, ${running.state.url})`);
        process.exit(1);
      }
      await mkdir(dataDir, { recursive: true });
      await rm(join(dataDir, STATE_FILE), { force: true });
      const logPath = join(dataDir, 'devnet.log');
      const { openSync } = await import('fs');
      const log = openSync(logPath, 'a');
      const child = spawn(process.execPath, [CLI_ENTRY, 'chain', 'start', '--foreground',
        '--port', String(port), '--data-dir', dataDir, '--accounts', String(accounts), '--balance', String(defaultBalance)],
        { detached: true, stdio: ['ignore', log, log] });
      child.unref();
      // The daemon writes its state file once the RPC is listening; that file, not the spawn, is the proof.
      let state = null;
      for (let i = 0; i < 300 && !state; i++) { await sleep(100); state = await readJson(join(dataDir, STATE_FILE)); }
      if (!state) {
        console.error(`Error starting chain: devnet did not come up within 30s (see ${logPath})`);
        process.exit(1);
      }
      await writeFile(POINTER, JSON.stringify({ data_dir: dataDir }, null, 2));
      out('Local chain started');
      out(`RPC: http://localhost:${state.port}`);
      out(`Accounts: ${state.accounts.length} (faucet + ${state.accounts.length - 1} funded)`);
      out(`Data: ${dataDir}`);
    });

  chainCmd
    .command('stop')
    .description('Stop the local devnet')
    .option('--data-dir <path>', 'Data directory (default: the devnet this directory started)')
    .option('--clean', 'Remove the data directory afterwards', false)
    .action(async (options) => {
      const found = await findDevnet(options.dataDir);
      if (!found) { out('Chain not running'); await rm(POINTER, { force: true }); return; }
      const { dataDir, state } = found;
      try { process.kill(state.pid, 'SIGTERM'); } catch { /* already gone */ }
      for (let i = 0; i < 150 && isAlive(state.pid); i++) await sleep(100);
      if (isAlive(state.pid)) { console.error(`Error: devnet pid ${state.pid} did not stop within 15s`); process.exit(1); }
      await rm(join(dataDir, STATE_FILE), { force: true });
      await rm(POINTER, { force: true });
      out('Local chain stopped');
      if (options.clean) { await rm(dataDir, { recursive: true, force: true }); out('Data directory cleaned'); }
    });

  chainCmd
    .command('accounts')
    .description('List the devnet accounts with their live balances')
    .option('--data-dir <path>', 'Data directory')
    .action(async (options) => {
      const found = await findDevnet(options.dataDir);
      if (!found) return notRunning();
      const rows = [];
      for (const a of found.state.accounts) {
        const r = await rpc(found.state.url, { type: 'getBalance', address: a.address });
        rows.push({ name: a.name, address: a.address, balance: r.balance });
      }
      out(JSON.stringify(rows, null, 2));
    });

  chainCmd
    .command('account <name>')
    .description('Show one devnet account')
    .option('--data-dir <path>', 'Data directory')
    .action(async (name, options) => {
      const found = await findDevnet(options.dataDir);
      if (!found) return notRunning();
      const a = found.state.accounts.find((x) => x.name === name || x.address === name);
      if (!a) { console.error(`Account ${name} not found`); process.exit(1); }
      const r = await rpc(found.state.url, { type: 'getBalance', address: a.address });
      out(JSON.stringify({ name: a.name, address: a.address, balance: r.balance, publicKey: a.public_key }, null, 2));
    });

  chainCmd
    .command('balance <name-or-address>')
    .description('Live balance of a devnet account (by name) or any address')
    .option('--data-dir <path>', 'Data directory')
    .action(async (who, options) => {
      const found = await findDevnet(options.dataDir);
      if (!found) return notRunning();
      const a = found.state.accounts.find((x) => x.name === who);
      const address = a ? a.address : who;
      const r = await rpc(found.state.url, { type: 'getBalance', address });
      out(JSON.stringify({ address, balance: r.balance }, null, 2));
    });

  chainCmd
    .command('status')
    .description('Devnet status: running, height, state root, RPC url')
    .option('--data-dir <path>', 'Data directory')
    .action(async (options) => {
      const found = await findDevnet(options.dataDir);
      if (!found) return notRunning();
      const [node, root] = await Promise.all([
        rpc(found.state.url, { type: 'getNodeStatus' }),
        rpc(found.state.url, { type: 'getStateRoot' }),
      ]);
      out(JSON.stringify({
        running: !!node.running,
        nodes: 1,
        accounts: found.state.accounts.length,
        height: node.height ?? null,
        state_root: root.root ?? null,
        pooled: root.pooled ?? null,
        rpc: found.state.url,
        pid: found.state.pid,
        started_at: found.state.started_at,
        data_dir: found.dataDir,
      }, null, 2));
    });

  chainCmd
    .command('reset')
    .description('Stop the devnet and delete its data directory')
    .option('--data-dir <path>', 'Data directory')
    .option('--confirm', 'Confirm reset', false)
    .action(async (options) => {
      if (!options.confirm) { out('Use --confirm to reset chain'); return; }
      const found = await findDevnet(options.dataDir);
      const dataDir = found ? found.dataDir : (options.dataDir ? resolve(options.dataDir) : (await readJson(POINTER))?.data_dir);
      if (found) {
        try { process.kill(found.state.pid, 'SIGTERM'); } catch { /* gone */ }
        for (let i = 0; i < 150 && isAlive(found.state.pid); i++) await sleep(100);
      }
      if (dataDir && existsSync(dataDir)) await rm(dataDir, { recursive: true, force: true });
      await rm(POINTER, { force: true });
      out('Chain reset complete');
    });

  return chainCmd;
}
