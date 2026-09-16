export { StorageShard } from './src/sharding.js';
export { StorageNode, computeProbeProof } from './src/storage-node.js';
export { ComputeRuntime } from './src/compute.js';
export { ComputeNode } from './src/compute-node.js';
export { MarketPricing } from './src/pricing.js';
export { AvailabilityTester } from './src/availability.js';


// THE VERSION OF THE CODE THIS PROCESS LOADED. Read once at import time from this package's own manifest, so a
// running node can report what it is actually executing — an install that lands on disk after this module was
// loaded changes the file, not this constant. Consumed by @xmbl/core's control socket (`status`.versions).
import { readFileSync as __readPkg } from 'node:fs';
export const VERSION = JSON.parse(__readPkg(new URL('./package.json', import.meta.url), 'utf8')).version;
