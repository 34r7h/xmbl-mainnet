import { createHash } from 'crypto';
import { Level } from 'level';

// ⛔ THE TRIE IS HELD COMPRESSED; ITS SHAPE AND EVERY HASH ARE NOT. The commitment is a 256-ary sha256 trie
// over the 32-byte key hash, 32 levels deep, each node hashing the 256 x 32-byte row of its children's hashes.
// It was held as one VerkleNode (own Map, own 32-byte Buffer, own ArrayBuffer) per level per key, so a key
// alone below depth 2 cost ~30 objects that each commit to nothing but "my only child is the next byte".
// MEASURED 2026-10-10 on the live 14,134-anchor canonical set: 436,927 VerkleNodes, ~200 MB of a 262 MB heap,
// and a box under 1 GiB thrashing into OOM. Now a key alone below a node is ONE Leaf (key hash, value hash,
// the depth it starts at) standing for that whole single-child chain, and the chain's hashes are computed
// from it — the same bytes the 30 nodes hashed — so getRoot, generateProof, keyPath and getTreeShape answer
// exactly what the per-level trie answered. Hashes are held as 32-char latin1 strings, not Buffers.
// Hashing is lazy: a write marks its path dirty, and the next read of the root hashes each dirty node once.
const ROW = Buffer.alloc(256 * 32); // the one 8 KB child row every node hash is taken over; zero between uses
const ZERO = '\0'.repeat(32);
const sha = (buf) => createHash('sha256').update(buf).digest('latin1');
const hex = (s) => Buffer.from(s, 'latin1').toString('hex');

// A node holding more than one key below it, or the root. `children` is nibble -> Branch | Leaf in arrival
// order, which is the order generateProof lists siblings in.
class Branch {
  constructor() {
    this.children = new Map();
    this.hash = null;
  }
}

// One key alone below its parent: the virtual nodes at `depth` .. 32, each the only child of the one above,
// ending in the value at depth 32. `hash` is the node at `depth`; `below` is the node at depth + 1, kept so a
// leaf pushed one level down by a new neighbour (the common split) or pulled one level up by a delete costs
// one hash instead of thirty.
class Leaf {
  constructor(key, value, depth) {
    this.key = key;
    this.value = value;
    this.depth = depth;
    this.hash = null;
    this.below = null;
  }
}

// The hash of a node whose only child, at `nib`, hashes to `h`.
function oneChild(nib, h) {
  const o = nib * 32;
  ROW.write(h, o, 32, 'latin1');
  const d = sha(ROW);
  ROW.fill(0, o, o + 32);
  return d;
}

function leafHash(leaf) {
  if (leaf.hash !== null) return leaf.hash;
  if (leaf.depth === 32) return (leaf.hash = leaf.value);
  let below = leaf.below;
  if (below === null) {
    below = leaf.value;
    for (let j = 31; j > leaf.depth; j--) below = oneChild(leaf.key.charCodeAt(j), below);
    leaf.below = below;
  }
  return (leaf.hash = oneChild(leaf.key.charCodeAt(leaf.depth), below));
}

// Every node of a leaf's chain, from `from` down to the value: out[j - from] is the node at depth j.
function chainOf(leaf, from) {
  const out = new Array(33 - from);
  let h = leaf.value;
  out[32 - from] = h;
  for (let j = 31; j >= from; j--) { h = oneChild(leaf.key.charCodeAt(j), h); out[j - from] = h; }
  return out;
}

function branchHash(b) {
  if (b.hash !== null) return b.hash;
  if (b.children.size === 0) return (b.hash = ZERO);
  const slots = [];
  for (const [nib, c] of b.children) slots.push(nib * 32, hashOf(c)); // children first: they use ROW too
  for (let i = 0; i < slots.length; i += 2) ROW.write(slots[i + 1], slots[i], 32, 'latin1');
  const h = sha(ROW);
  for (let i = 0; i < slots.length; i += 2) ROW.fill(0, slots[i], slots[i] + 32);
  return (b.hash = h);
}

function hashOf(n) { return n instanceof Leaf ? leafHash(n) : branchHash(n); }

const keyHashOf = (key) => createHash('sha256').update(key).digest('latin1');
const valueHashOf = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('latin1');

export class VerkleStateTree {
  constructor(options = {}) {
    this.root = new Branch();
    this.state = new Map(); // key -> value
    this.db = options.db || null;
    this._dbOpen = false;
    
    // KEEP THE PROMISE. This was fire-and-forget, so XVSM's own _loadDiffs raced the tree's _loadState and
    // could not tell "the tree is empty" from "the tree has not finished loading" — the exact distinction the
    // replay decision below now turns on. `ready()` is the join point.
    this._ready = this.db ? this._initDb().catch(() => {}) : Promise.resolve();
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
  
  // Resolves once the `state:` keyspace has been read and the trie rebuilt from it.
  ready() { return this._ready || Promise.resolve(); }

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
    // ⛔ REBUILD THE TRIE. This loop restored `this.state` — the key->value map — and stopped there, leaving
    // `this.root` a fresh empty node. So a node that had loaded EVERY key off disk answered getRoot()
    // with 64 zeros: a tree that holds the whole state and commits to nothing. MEASURED 2026-09-15: after a
    // canonical rebuild of 10 anchors, restart loaded all 10 keys and published root 0000…0000; across the
    // nodes 39 of 44 reporting nodes published exactly that, including one with 11,691 blocks persisted. The
    // only boxes showing a real root were showing it by accident, via XVSM's diff replay re-inserting keys
    // through insert(). The state map is not the commitment — the hashed trie over it is, and it has to be
    // reconstructed on open or every restart silently un-commits the node's entire state.
    this._rebuildTrie();
  }

  // Rebuild the hashed trie from `this.state` in ONE bottom-up pass: every key is placed first, then the root
  // read hashes each node exactly once, so a 50k-key store rehydrates in a single walk.
  _rebuildTrie() {
    this.root = new Branch();
    for (const [k, v] of this.state) this._put(keyHashOf(k), valueHashOf(v));
    this.getRoot();
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
    this.root = new Branch();
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
    this._put(keyHashOf(key), valueHashOf(value));
  }

  get(key) {
    return this.state.get(key);
  }

  async delete(key) {
    this.state.delete(key);
    await this._deleteState(key);
    this._drop(keyHashOf(key));
  }

  generateProof(key) {
    const keyHash = keyHashOf(key);
    const value = this.state.get(key);
    if (value === undefined) {
      throw new Error(`Key ${key} not found in state tree`);
    }
    const valueHash = valueHashOf(value);
    const root = this.getRoot(); // hashes every dirty node, so every sibling below carries its hash
    const path = [];
    let node = this.root;
    for (let depth = 0; depth < 32; depth++) {
      const nibble = keyHash.charCodeAt(depth);
      if (node instanceof Leaf) {
        // inside a lone key's chain: one child per level, so no siblings
        if (node.key.charCodeAt(depth) !== nibble) break;
        path.push({ depth, siblings: [] });
        continue;
      }
      const child = node.children.get(nibble);
      if (!child) break;
      const siblings = [];
      for (const [n, c] of node.children) {
        if (n !== nibble) siblings.push({ nibble: n, hash: hex(hashOf(c)) });
      }
      path.push({ depth, siblings });
      node = child;
    }
    return {
      root,
      path: path,
      key: hex(keyHash),
      valueHash: hex(valueHash)
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
  // Bounded on BOTH axes and genuine about it: `maxDepth` limits how far down, `maxNodes` caps the total, and
  // the result carries `truncated` plus each node's own `descendants` so a cut branch reports its real size
  // rather than looking like a leaf. A viewer that silently stopped at 500 nodes would draw a tree that is
  // simply the wrong shape.
  //
  // `at` walks to a specific prefix first (an array of byte nibbles), so a caller can drill into a branch
  // without ever fetching the whole tree.
  getTreeShape({ maxDepth = 4, maxNodes = 600, at = [] } = {}) {
    // A node here is (node, absolute depth): a Leaf stands for every node of its chain, so the same Leaf is
    // visited once per depth it covers, exactly as the per-level trie's chain of single-child nodes was.
    this.getRoot();
    let start = this.root, abs = 0;
    for (const nib of at) {
      const b = Number(nib);
      if (start instanceof Leaf) {
        if (abs >= 32 || start.key.charCodeAt(abs) !== b) return { ok: false, error: `no node at prefix ${at.join('/')}`, at };
      } else {
        const next = start.children.get(b);
        if (!next) return { ok: false, error: `no node at prefix ${at.join('/')}`, at };
        start = next;
      }
      abs++;
    }

    // Subtree size is what makes a truncated branch genuine, so it is computed for every node we emit.
    const sizes = new Map();
    const sizeOf = (node, d) => {
      if (node instanceof Leaf) return 33 - d;
      let n = sizes.get(node);
      if (n === undefined) {
        n = 1;
        for (const c of node.children.values()) n += sizeOf(c, d + 1);
        sizes.set(node, n);
      }
      return n;
    };
    const chains = new Map();
    const hashAt = (node, d) => {
      if (!(node instanceof Leaf)) return branchHash(node);
      let c = chains.get(node);
      if (!c) chains.set(node, (c = chainOf(node, node.depth)));
      return c[d - node.depth];
    };
    const kidsOf = (node, d) => {
      if (node instanceof Leaf) return d < 32 ? [[node.key.charCodeAt(d), node]] : [];
      return [...node.children.entries()].sort((x, y) => x[0] - y[0]);
    };

    const nodes = [], edges = [];
    let truncated = false;
    const queue = [{ node: start, abs, id: 'r', depth: 0, nibble: null }];
    while (queue.length) {
      const { node, abs: d, id, depth, nibble } = queue.shift();
      if (nodes.length >= maxNodes) { truncated = true; break; }
      const kids = kidsOf(node, d);
      nodes.push({
        id, depth, nibble,
        hash: hex(hashAt(node, d)),
        children: kids.length,
        descendants: sizeOf(node, d) - 1,
        leaf: node instanceof Leaf && d === 32,
      });
      if (depth >= maxDepth) { if (kids.length) truncated = true; continue; }
      for (const [nib, child] of kids) {
        const cid = `${id}.${nib}`;
        edges.push({ from: id, to: cid, nibble: nib });
        queue.push({ node: child, abs: d + 1, id: cid, depth: depth + 1, nibble: nib });
      }
    }
    return {
      ok: true, at, root: this.getRoot(), total_keys: this.state.size,
      total_nodes: sizeOf(this.root, 0) - 1, max_depth: maxDepth, truncated, nodes, edges,
    };
  }

  // The exact path a key takes through the tree — which byte at which depth, and the hash at each step.
  // This is the "where does MY transaction live in the tree" answer, and it is a pure read.
  keyPath(key) {
    const keyHash = keyHashOf(key);
    this.getRoot();
    const steps = [];
    let node = this.root, id = 'r', chain = null;
    for (let depth = 0; depth < 32; depth++) {
      const nibble = keyHash.charCodeAt(depth);
      let hash, siblings;
      if (node instanceof Leaf) {
        if (node.key.charCodeAt(depth) !== nibble) break;
        if (!chain) chain = chainOf(node, node.depth);
        hash = chain[depth + 1 - node.depth];
        siblings = 0;
      } else {
        const child = node.children.get(nibble);
        if (!child) break;
        hash = hashOf(child);
        siblings = node.children.size - 1;
        node = child;
      }
      id = `${id}.${nibble}`;
      steps.push({ depth, nibble, id, hash: hex(hash), siblings });
    }
    return {
      ok: steps.length > 0, key, key_hash: hex(keyHash),
      present: this.state.has(key), value: this.state.get(key) ?? null,
      depth: steps.length, steps,
    };
  }

  getRoot() {
    return hex(branchHash(this.root));
  }

  // Place one key. Every node passed through is marked dirty. A key landing where a Leaf already stands
  // turns that slot into a Branch one level down holding the Leaf, and the walk continues into it, so two
  // keys sharing more bytes get a Branch per shared byte — what the per-level trie held at those depths.
  _put(keyHash, valueHash) {
    let node = this.root;
    node.hash = null;
    for (let depth = 0; ; depth++) {
      const nib = keyHash.charCodeAt(depth);
      const child = node.children.get(nib);
      if (child === undefined) { node.children.set(nib, new Leaf(keyHash, valueHash, depth + 1)); return; }
      if (child instanceof Branch) { child.hash = null; node = child; continue; }
      if (child.key === keyHash) { child.value = valueHash; child.hash = null; child.below = null; return; }
      const b = new Branch(); // set() on an existing nibble keeps its place in the arrival order
      node.children.set(nib, b);
      child.depth++;
      child.hash = child.below;
      child.below = null;
      b.children.set(child.key.charCodeAt(child.depth - 1), child);
      node = b;
    }
  }

  // Remove one key. A Branch left with no keys is removed, and a Branch left holding one Leaf becomes that
  // Leaf one level up — both hash exactly as the per-level trie's emptied and single-child nodes did.
  _drop(keyHash) {
    const trail = [];
    let node = this.root;
    for (let depth = 0; depth < 32; depth++) {
      const nib = keyHash.charCodeAt(depth);
      const child = node.children.get(nib);
      if (child === undefined) return false;
      trail.push(node, nib);
      if (child instanceof Branch) { node = child; continue; }
      if (child.key !== keyHash) return false;
      node.children.delete(nib);
      for (let i = 0; i < trail.length; i += 2) trail[i].hash = null;
      for (let i = trail.length - 2; i >= 2; i -= 2) {
        const b = trail[i], parent = trail[i - 2], pnib = trail[i - 1];
        if (b.children.size === 0) { parent.children.delete(pnib); continue; }
        if (b.children.size > 1) break;
        const only = b.children.values().next().value;
        if (!(only instanceof Leaf)) break;
        only.depth--;
        only.below = only.hash;
        only.hash = null;
        parent.children.set(pnib, only);
      }
      return true;
    }
    return false;
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

