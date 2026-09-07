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

const port = process.env.PORT || 3004;

console.log(`XPC (XMBL Peer Consensus) starting on port ${port}`);

// Module implementation here
