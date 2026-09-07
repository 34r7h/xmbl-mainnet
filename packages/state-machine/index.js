export { VerkleStateTree } from './src/verkle-tree.js';
export { StateDiff } from './src/state-diff.js';
// WASMExecutor was removed: executing (untrusted) contract WASM is @xmbl/storage-compute's
// hardened ComputeRuntime, driven by @xmbl/contracts' ContractHost, which composes this
// module's VerkleStateTree. The state machine owns state, not a second WASM sandbox.
export { StateShard } from './src/sharding.js';
export { StateAssembler } from './src/state-assembly.js';
export { StateMachine } from './src/state-machine.js';

const port = process.env.PORT || 3002;
console.log(`XVSM (XMBL Virtual State Machine) starting on port ${port}`);



