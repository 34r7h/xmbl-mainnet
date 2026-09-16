export { VerkleStateTree } from './src/verkle-tree.js';
export { StateDiff } from './src/state-diff.js';
// WASMExecutor was removed: executing (untrusted) contract WASM is @xmbl/storage-compute's
// hardened ComputeRuntime, driven by @xmbl/contracts' ContractHost, which composes this
// module's VerkleStateTree. The state machine owns state, not a second WASM sandbox.
export { StateShard } from './src/sharding.js';
export { StateAssembler } from './src/state-assembly.js';
export { StateMachine } from './src/state-machine.js';


// THE VERSION OF THE CODE THIS PROCESS LOADED. Read once at import time from this package's own manifest, so a
// running node can report what it is actually executing — an install that lands on disk after this module was
// loaded changes the file, not this constant. Consumed by @xmbl/core's control socket (`status`.versions).
import { readFileSync as __readPkg } from 'node:fs';
export const VERSION = JSON.parse(__readPkg(new URL('./package.json', import.meta.url), 'utf8')).version;
