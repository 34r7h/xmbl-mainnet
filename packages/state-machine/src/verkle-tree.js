import { createHash } from 'crypto';
import { Level } from 'level';

class VerkleNode {
  constructor() {
    this.children = new Map();
    this.value = null;
    this.hash = null;
  }
}

export class VerkleStateTree {
  constructor(options = {}) {
    this.root = new VerkleNode();
    this.state = new Map(); // key -> value
    this.db = options.db || null;
    this._dbOpen = false;
    
    if (this.db) {
      this._initDb().catch(() => {});
    }
  }
  
  async _initDb() {
    try {
      if (this.db && typeof this.db.open === 'function') {
        await this.db.open();
      }
      this._dbOpen = true;
      await this._loadState();
    } catch (error) {
      this._dbOpen = false;
    }
  }
  
  async _loadState() {
    if (!this.db || !this._dbOpen) return;
    
    try {
      for await (const [key, value] of this.db.iterator({ gt: 'state:', lt: 'state:\xFF' })) {
        const stateKey = key.toString().substring(6); // Remove 'state:' prefix
        const stateValue = JSON.parse(value.toString());
        this.state.set(stateKey, stateValue);
      }
    } catch (error) {
      // Ignore errors during load
    }
  }
  
  async _saveState(key, value) {
    if (!this.db || !this._dbOpen) return;
    
    try {
      await this.db.put(`state:${key}`, JSON.stringify(value));
    } catch (error) {
      // Ignore save errors
    }
  }
  
  async _deleteState(key) {
    if (!this.db || !this._dbOpen) return;
    
    try {
      await this.db.del(`state:${key}`);
    } catch (error) {
      // Ignore delete errors
    }
  }

  // Drop EVERY key — in memory and on disk — back to an empty tree. This is what makes a node adopt a
  // canonical set authoritatively: a plain re-insert leaves stale/extra keys (probe.seal, test anchors, a
  // fuller history than the broker's) in the tree, so its root can never match a node that never had them.
  // Clearing first means the rebuilt root is a pure function of the set applied next — identical on every box.
  async clear() {
    this.root = new VerkleNode();
    this.state = new Map();
    if (this.db && this._dbOpen) {
      // ONE range clear, not thousands of per-key deletes — on a node with a big state that per-key loop
      // took minutes and timed the control call out. Level's clear() drops the whole `state:` keyspace in a
      // single batch; fall back to a range iterator+del only if this build's db lacks clear().
      try {
        if (typeof this.db.clear === 'function') { await this.db.clear({ gte: 'state:', lt: 'state:\xFF' }); }
        else { for await (const [k] of this.db.iterator({ gte: 'state:', lt: 'state:\xFF' })) { try { await this.db.del(k); } catch { /* */ } } }
      } catch { /* best-effort — the in-memory reset above already makes the rebuild authoritative for this run */ }
    }
  }

  async insert(key, value) {
    this.state.set(key, value);
    await this._saveState(key, value);
    const keyHash = this._hashKey(key);
    const valueHash = this._hashValue(value);
    const path = [];
    this._insertNode(this.root, keyHash, valueHash, 0, path);
    // Only update hashes along the insertion path
    this._updateHashPath(path);
  }

  get(key) {
    return this.state.get(key);
  }

  async delete(key) {
    this.state.delete(key);
    await this._deleteState(key);
    const keyHash = this._hashKey(key);
    const path = [];
    this._deleteNode(this.root, keyHash, 0, path);
    // Only update hashes along the deletion path
    this._updateHashPath(path);
  }

  generateProof(key) {
    const keyHash = this._hashKey(key);
    const value = this.state.get(key);
    if (value === undefined) {
      throw new Error(`Key ${key} not found in state tree`);
    }
    const path = [];
    const valueHash = this._hashValue(value);
    this._generateProofPath(this.root, keyHash, path, 0);
    return {
      root: this.root.hash ? this.root.hash.toString('hex') : null,
      path: path,
      key: keyHash.toString('hex'),
      valueHash: valueHash.toString('hex')
    };
  }

  static verifyProof(key, value, proof) {
    const keyHash = VerkleStateTree._hashKey(key);
    const valueHash = VerkleStateTree._hashValue(value);
    
    if (valueHash.toString('hex') !== proof.valueHash) {
      return false;
    }
    
    // Reconstruct hash by following the path from leaf to root
    let currentHash = valueHash;
    let depth = 31; // Start from leaf depth
    
    for (let i = proof.path.length - 1; i >= 0; i--) {
      const pathNode = proof.path[i];
      const nibble = keyHash[depth];
      
      // Build children array for this node (256 children)
      const childrenHashes = [];
      for (let j = 0; j < 256; j++) {
        if (j === nibble) {
          childrenHashes.push(currentHash);
        } else {
          // Find sibling hash
          const sibling = pathNode.siblings.find(s => s.nibble === j);
          if (sibling) {
            childrenHashes.push(Buffer.from(sibling.hash, 'hex'));
          } else {
            childrenHashes.push(Buffer.alloc(32));
          }
        }
      }
      
      const combined = Buffer.concat(childrenHashes);
      currentHash = createHash('sha256').update(combined).digest();
      depth--;
    }
    
    const rootHash = Buffer.from(proof.root, 'hex');
    return currentHash.equals(rootHash);
  }

  // THE TREE ITSELF, walkable. Everything else on this class answers "what is the root" or "prove one key";
  // nothing could describe the SHAPE, so any view of the state had to fall back to drawing categories of
  // transactions instead of the structure that actually commits them. This returns the real nodes and the
  // real parent->child edges, bounded, with the counts needed to say what was left out.
  //
  // Bounded on BOTH axes and honest about it: `maxDepth` limits how far down, `maxNodes` caps the total, and
  // the result carries `truncated` plus each node's own `descendants` so a cut branch reports its real size
  // rather than looking like a leaf. A viewer that silently stopped at 500 nodes would draw a tree that is
  // simply the wrong shape.
  //
  // `at` walks to a specific prefix first (an array of byte nibbles), so a caller can drill into a branch
  // without ever fetching the whole tree.
  getTreeShape({ maxDepth = 4, maxNodes = 600, at = [] } = {}) {
    let start = this.root;
    for (const nib of at) {
      const next = start.children.get(Number(nib));
      if (!next) return { ok: false, error: `no node at prefix ${at.join('/')}`, at };
      start = next;
    }
    if (!start.hash) this._updateHash(start);

    // Subtree size is what makes a truncated branch honest, so it is computed for every node we emit.
    const sizeOf = (node) => {
      let n = 1;
      for (const c of node.children.values()) n += sizeOf(c);
      return n;
    };

    const nodes = [], edges = [];
    let truncated = false;
    const queue = [{ node: start, id: 'r', depth: 0, nibble: null }];
    while (queue.length) {
      const { node, id, depth, nibble } = queue.shift();
      if (nodes.length >= maxNodes) { truncated = true; break; }
      if (!node.hash) this._updateHash(node);
      const kids = [...node.children.entries()].sort((a, b) => a[0] - b[0]);
      nodes.push({
        id, depth, nibble,
        hash: node.hash ? node.hash.toString('hex') : null,
        children: kids.length,
        descendants: sizeOf(node) - 1,
        leaf: !!node.value,
      });
      if (depth >= maxDepth) { if (kids.length) truncated = true; continue; }
      for (const [nib, child] of kids) {
        const cid = `${id}.${nib}`;
        edges.push({ from: id, to: cid, nibble: nib });
        queue.push({ node: child, id: cid, depth: depth + 1, nibble: nib });
      }
    }
    return {
      ok: true, at, root: this.getRoot(), total_keys: this.state.size,
      total_nodes: sizeOf(this.root) - 1, max_depth: maxDepth, truncated, nodes, edges,
    };
  }

  // The exact path a key takes through the tree — which byte at which depth, and the hash at each step.
  // This is the "where does MY transaction live in the tree" answer, and it is a pure read.
  keyPath(key) {
    const keyHash = VerkleStateTree._hashKey(key);
    const steps = [];
    let node = this.root, id = 'r';
    for (let depth = 0; depth < 32; depth++) {
      const nibble = keyHash[depth];
      const child = node.children.get(nibble);
      if (!child) break;
      id = `${id}.${nibble}`;
      if (!child.hash) this._updateHash(child);
      steps.push({ depth, nibble, id, hash: child.hash ? child.hash.toString('hex') : null, siblings: node.children.size - 1 });
      node = child;
    }
    return {
      ok: steps.length > 0, key, key_hash: keyHash.toString('hex'),
      present: this.state.has(key), value: this.state.get(key) ?? null,
      depth: steps.length, steps,
    };
  }

  getRoot() {
    if (!this.root.hash) {
      // Initialize empty root hash
      this._updateHash(this.root);
    }
    return this.root.hash ? this.root.hash.toString('hex') : '0'.repeat(64);
  }

  _insertNode(node, keyHash, valueHash, depth, path) {
    path.push(node);
    if (depth >= 32) {
      node.value = valueHash;
      return;
    }

    const nibble = keyHash[depth];
    if (!node.children.has(nibble)) {
      node.children.set(nibble, new VerkleNode());
    }
    
    this._insertNode(node.children.get(nibble), keyHash, valueHash, depth + 1, path);
  }

  _updateHashPath(path) {
    // Update hashes from leaf to root
    for (let i = path.length - 1; i >= 0; i--) {
      this._updateHash(path[i]);
    }
  }

  _deleteNode(node, keyHash, depth, path) {
    path.push(node);
    if (depth >= 32) {
      node.value = null;
      return;
    }

    const nibble = keyHash[depth];
    if (node.children.has(nibble)) {
      this._deleteNode(node.children.get(nibble), keyHash, depth + 1, path);
      if (node.children.get(nibble).children.size === 0 && !node.children.get(nibble).value) {
        node.children.delete(nibble);
      }
    }
  }

  _generateProofPath(node, keyHash, path, depth) {
    if (depth >= 32) {
      return;
    }

    const nibble = keyHash[depth];
    const child = node.children.get(nibble);
    
    if (child) {
      // Collect sibling hashes
      const siblings = [];
      for (const [n, childNode] of node.children.entries()) {
        if (n !== nibble && childNode.hash) {
          siblings.push({ nibble: n, hash: childNode.hash.toString('hex') });
        }
      }
      
      path.push({ depth, siblings });
      this._generateProofPath(child, keyHash, path, depth + 1);
    }
  }

  _updateHash(node) {
    if (node.value) {
      node.hash = node.value;
      return;
    }

    if (node.children.size === 0) {
      node.hash = Buffer.alloc(32);
      return;
    }

    const childrenHashes = [];
    for (let i = 0; i < 256; i++) {
      const child = node.children.get(i);
      if (child) {
        // Only update if hash is not set (lazy evaluation)
        if (!child.hash) {
          this._updateHash(child);
        }
        childrenHashes.push(child.hash);
      } else {
        childrenHashes.push(Buffer.alloc(32));
      }
    }

    const combined = Buffer.concat(childrenHashes);
    node.hash = createHash('sha256').update(combined).digest();
  }

  static _hashKey(key) {
    return createHash('sha256').update(key).digest();
  }

  static _hashValue(value) {
    const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
    return createHash('sha256').update(valueStr).digest();
  }

  _hashKey(key) {
    return VerkleStateTree._hashKey(key);
  }

  _hashValue(value) {
    return VerkleStateTree._hashValue(value);
  }
}

