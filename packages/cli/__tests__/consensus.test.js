import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

const execAsync = promisify(exec);
const testKeyDir = './test-keys-consensus';

describe('Consensus Commands', () => {
  beforeAll(async () => {
    await fs.mkdir(testKeyDir, { recursive: true });
    await execAsync(`node index.js identity create --name submitter --key-dir ${testKeyDir}`);
  });
  afterAll(async () => {
    try { await fs.rm(testKeyDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  });

  test('should submit a SIGNED transaction to mempool', async () => {
    const tx = { type: 'utxo', to: 'bob', amount: 100 };
    const { stdout } = await execAsync(
      `node index.js consensus submit --tx '${JSON.stringify(tx)}' --leader leader1 --key submitter --key-dir ${testKeyDir}`
    );
    const result = JSON.parse(stdout.trim());
    expect(result.ok).toBe(true);
    expect(result).toHaveProperty('rawTxId');
    expect(result.rawTxId).toBeTruthy();
  });

  test('an UNSIGNED transaction is refused at ingress, and the CLI says so (exit 1, ok:false)', async () => {
    const tx = { type: 'utxo', to: 'bob', amount: 100 };
    await expect(execAsync(`node index.js consensus submit --tx '${JSON.stringify(tx)}' --leader leader1`))
      .rejects.toMatchObject({ code: 1 });
    const { stdout } = await execAsync(`node index.js consensus submit --tx '${JSON.stringify(tx)}' --leader leader1`).catch((e) => e);
    const result = JSON.parse(stdout.trim());
    expect(result.ok).toBe(false);
    expect(result.rawTxId).toBeNull();
  });

  test('should get mempool statistics', async () => {
    const { stdout } = await execAsync('node index.js consensus stats mempool');
    const stats = JSON.parse(stdout.trim());
    expect(stats).toHaveProperty('rawTx');
    expect(stats).toHaveProperty('processing');
    expect(stats).toHaveProperty('finalized');
    expect(stats).toHaveProperty('lockedUtxos');
    expect(typeof stats.rawTx).toBe('number');
  });

  test('should list raw transactions', async () => {
    const { stdout } = await execAsync('node index.js consensus raw-tx list');
    const txs = JSON.parse(stdout.trim());
    expect(Array.isArray(txs)).toBe(true);
  });

  test('should elect leaders', async () => {
    const { stdout } = await execAsync('node index.js consensus leader elect --count 3');
    const result = JSON.parse(stdout.trim());
    expect(result).toHaveProperty('leaders');
    expect(Array.isArray(result.leaders)).toBe(true);
  });
});

