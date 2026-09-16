import { ConsensusWorkflow } from './src/workflow.js';
import { LeaderElection } from './src/leader-election.js';
import { Mempool } from './src/mempool.js';
import { ValidationTaskManager } from './src/validation-tasks.js';
import { ConsensusGossip } from './src/gossip.js';
import { ValidationWorker } from './src/validation-worker.js';
import { runValidationRetryTick } from './src/validation-retry.js';
import { SealRoundManager } from './src/seal-round.js';
import { setHash as sealSetHash } from './src/seal-agreement.js';

export {
  ConsensusWorkflow,
  LeaderElection,
  Mempool,
  ValidationTaskManager,
  ConsensusGossip,
  ValidationWorker,
  runValidationRetryTick,
  SealRoundManager,
  sealSetHash
};


// Module implementation here

// THE VERSION OF THE CODE THIS PROCESS LOADED. Read once at import time from this package's own manifest, so a
// running node can report what it is actually executing — an install that lands on disk after this module was
// loaded changes the file, not this constant. Consumed by @xmbl/core's control socket (`status`.versions).
import { readFileSync as __readPkg } from 'node:fs';
export const VERSION = JSON.parse(__readPkg(new URL('./package.json', import.meta.url), 'utf8')).version;
