import { createHash } from 'node:crypto';

// A minimal state store so the contracts module is usable ON ITS OWN — deploy and call a
// contract with zero dependency on @xmbl/state-machine. It implements exactly the surface
// ContractHost needs: get(key), async insert(key, value), getRoot(). In the full suite you
// pass a real VerkleStateTree from @xmbl/state-machine instead; ContractHost cannot tell the
// difference. The root here is an order-independent hash of the committed entries, so two
// stores that received the same writes in any order report the same root (the convergence
// property a chain needs), but it is NOT a Verkle proof — that is the state-machine's job.
export class InMemoryState {
  constructor() { this.map = new Map(); }
  get(key) { return this.map.get(key); }
  async insert(key, value) { this.map.set(key, value); }
  getRoot() {
    const parts = [...this.map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`);
    return createHash('sha256').update(parts.join('|')).digest('hex');
  }
}
