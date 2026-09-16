// xmbl networking module
export { XNNode } from './src/node.js';
export { PeerDiscovery } from './src/discovery.js';
export { MessageRouter } from './src/routing.js';
export { PubSubManager } from './src/pubsub.js';
export { GossipManager } from './src/gossip.js';
export { ConnectionManager } from './src/connection.js';
export { loadOrCreatePeerKey } from './src/peer-identity.js';

// THE VERSION OF THE CODE THIS PROCESS LOADED. Read once at import time from this package's own manifest, so a
// running node can report what it is actually executing — an install that lands on disk after this module was
// loaded changes the file, not this constant. Consumed by @xmbl/core's control socket (`status`.versions).
import { readFileSync as __readPkg } from 'node:fs';
export const VERSION = JSON.parse(__readPkg(new URL('./package.json', import.meta.url), 'utf8')).version;
