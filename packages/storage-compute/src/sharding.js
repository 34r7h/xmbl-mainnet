export class StorageShard {
  /**
   * @param {number} index data shards are 0..k-1; parity shards are k..k+m-1.
   * @param {Buffer} data the chunk (all shards in one encoding are the same length).
   * @param {boolean} isParity
   * @param {number|null} originalLength the payload's length before padding — without it the padding
   *   cannot be trimmed, so decode refuses.
   * @param {number|null} parityCount m, THE PARITY DEGREE OF THE ENCODING. Carried on every shard for
   *   the same reason originalLength is: it is a property of the ENCODING, not of whatever subset of
   *   shards happens to survive, and decode cannot be correct without it. parity[i] is the XOR of data
   *   shards {i, i+m, i+2m, …}, so recovery needs m — and inferring it from the number of parity shards
   *   PRESENT is wrong exactly when a parity shard is among the losses. MEASURED on k=4, m=2: given data
   *   shards 0,1,2 and parity shard 4 only, the inferred m was 1, which made the recovery group
   *   {0,1,2,3} instead of {0,2}, and decode returned wrong bytes with no error. Null means a legacy
   *   shard that predates this field; decode then refuses parity recovery rather than guessing.
   */
  constructor(index, data, isParity = false, originalLength = null, parityCount = null) {
    this.index = index;
    this.data = data;
    this.isParity = isParity;
    this.originalLength = originalLength;
    this.parityCount = parityCount;
  }

  static create(data, index, totalShards) {
    const chunkSize = Math.ceil(data.length / totalShards);
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, data.length);
    const chunk = data.slice(start, end);
    const padded = Buffer.alloc(chunkSize);
    chunk.copy(padded);
    return new StorageShard(index, padded, false, data.length);
  }

  static reconstruct(shards) {
    const dataShards = shards.filter(s => !s.isParity).sort((a, b) => a.index - b.index);
    if (dataShards.length === 0) {
      throw new Error('No data shards provided');
    }
    
    // Get original length from first shard that has it, or calculate from shards
    const originalLength = dataShards[0].originalLength || 
      (dataShards.length * dataShards[0].data.length);
    
    const chunkSize = dataShards[0].data.length;
    const totalSize = Math.min(originalLength, dataShards.length * chunkSize);
    const reconstructed = Buffer.alloc(totalSize);
    
    let offset = 0;
    for (const shard of dataShards) {
      const remaining = totalSize - offset;
      const copySize = Math.min(shard.data.length, remaining);
      if (copySize > 0) {
        shard.data.copy(reconstructed, offset, 0, copySize);
        offset += copySize;
      }
      if (offset >= totalSize) break;
    }
    
    return reconstructed;
  }

  static encode(data, k, m) {
    // k data shards, m parity shards
    const shards = [];
    const chunkSize = Math.ceil(data.length / k);
    
    // Split data into k shards
    for (let i = 0; i < k; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, data.length);
      const chunk = data.slice(start, end);
      // Pad if necessary
      const padded = Buffer.alloc(chunkSize);
      chunk.copy(padded);
      shards.push(new StorageShard(i, padded, false, data.length, m));
    }
    
    // Generate parity shards
    // Each parity shard is XOR of pairs of data shards to allow recovery
    // parity[0] = data[0] XOR data[2], parity[1] = data[1] XOR data[3], etc.
    const parity = [];
    for (let i = 0; i < m; i++) {
      const parityData = Buffer.alloc(chunkSize);
      // XOR corresponding data shards (i pairs with i + m)
      for (let j = 0; j < k; j += m) {
        const shardIdx = i + j;
        if (shardIdx < k) {
          for (let b = 0; b < chunkSize; b++) {
            parityData[b] ^= shards[shardIdx].data[b];
          }
        }
      }
      parity.push(new StorageShard(k + i, parityData, true, data.length, m));
    }
    
    return { shards, parity };
  }

  static decode(shards) {
    // Reconstruct original data from shards (can use data shards or parity shards)
    const allShards = shards.sort((a, b) => a.index - b.index);
    const dataShards = allShards.filter(s => !s.isParity);
    const parityShards = allShards.filter(s => s.isParity);
    
    // Get original length from first shard
    const originalLength = (dataShards[0] || parityShards[0])?.originalLength;
    if (!originalLength) {
      throw new Error('Cannot determine original data length');
    }
    
    const chunkSize = (dataShards[0] || parityShards[0])?.data.length || 0;
    if (chunkSize === 0) {
      throw new Error('Invalid shard data');
    }
    
    // Determine k (number of data shards) from parity shard indices
    // Parity shards have indices k, k+1, ..., k+m-1
    // So k = min(parity shard indices), or calculate from original length if no parity
    // m is the ENCODING's parity degree, taken from the shards that carry it (see the constructor doc).
    // Falling back to parityShards.length is only safe when no parity recovery is needed, which is
    // enforced below — a legacy shard set missing a data shard is refused rather than decoded wrongly.
    const stamped = allShards.find((sh) => Number.isInteger(sh.parityCount) && sh.parityCount > 0);
    const m = stamped ? stamped.parityCount : parityShards.length;
    const mIsInferred = !stamped;
    let k;
    if (parityShards.length > 0) {
      const minParityIndex = Math.min(...parityShards.map(p => p.index));
      k = minParityIndex;
    } else {
      k = Math.ceil(originalLength / chunkSize);
    }
    const neededShards = Math.ceil(originalLength / chunkSize);
    
    // Build a map of available shards by index
    const shardMap = new Map();
    for (const shard of allShards) {
      shardMap.set(shard.index, shard);
    }
    
    // Reconstruct each needed chunk
    const reconstructed = Buffer.alloc(originalLength);
    const recoveredDataShards = [];
    
    // First, collect all available data shards
    for (let i = 0; i < neededShards; i++) {
      const shard = shardMap.get(i);
      if (shard && !shard.isParity) {
        recoveredDataShards.push(shard);
      }
    }
    
    // If we have enough data shards, use them directly
    if (recoveredDataShards.length >= neededShards) {
      let offset = 0;
      for (const shard of recoveredDataShards.slice(0, neededShards)) {
        const remaining = originalLength - offset;
        const copySize = Math.min(shard.data.length, remaining);
        if (copySize > 0) {
          shard.data.copy(reconstructed, offset, 0, copySize);
          offset += copySize;
        }
        if (offset >= originalLength) break;
      }
      return reconstructed;
    }
    
    // Otherwise, we need to use parity shards to recover missing data shards
    // Our parity scheme: parity[i] = XOR of data shards at indices i, i+m, i+2m, ...
    // To recover data[j]: data[j] = parity[i] XOR (all other data shards in parity group)
    // where i = j % m
    
    // Build chunks array, recovering missing ones from parity.
    //
    // XOR parity recovers AT MOST ONE loss PER PARITY GROUP: parity[i] covers data shards
    // i, i+m, i+2m, … so losing two members of one group is mathematically unrecoverable. That is
    // inherent to the scheme and fine. What was NOT fine is what this loop used to do about it — fill the
    // missing chunk with zeros and return the buffer as if decoding had succeeded. A storage layer that
    // hands back silently corrupted bytes is worse than one that fails: the caller has no way to tell.
    // MEASURED on k=4, m=2: losing data shards 0 and 2 (both in parity group 0) returned a buffer that
    // differed from the original with no error, no flag and no short read.
    //
    // So an unrecoverable chunk is now REPORTED. The indices are collected rather than thrown on the
    // first one, so the error names everything that is missing instead of only the earliest.
    const chunks = [];
    const unrecoverable = [];
    
    for (let i = 0; i < neededShards; i++) {
      const dataShard = shardMap.get(i);
      if (dataShard && !dataShard.isParity) {
        chunks.push(Buffer.from(dataShard.data));
      } else {
        // Missing data shard - try to recover from parity
        const parityIdx = i % m;
        // Find parity shard with index k + parityIdx
        const parityShard = parityShards.find(p => {
          const expectedIdx = k + parityIdx;
          return p.index === expectedIdx;
        });
        
        // The XOR is only a recovery if EVERY OTHER member of the parity group is present. With one
        // member missing, parity XOR (the rest) is exactly the missing chunk. With two missing, the same
        // arithmetic still produces a buffer — it is just not the data, and nothing downstream can tell.
        // So the group is checked for completeness BEFORE the XOR is trusted.
        if (mIsInferred) {
          // The recovery group cannot be computed without the encoding's real parity degree.
          unrecoverable.push(i);
          chunks.push(Buffer.alloc(chunkSize));
          continue;
        }
        const groupComplete = (() => {
          for (let j = parityIdx; j < k; j += m) {
            if (j === i) continue;
            const other = shardMap.get(j);
            if (!other || other.isParity) return false;
          }
          return true;
        })();

        if (parityShard && m > 0 && groupComplete) {
          // Recover: data[i] = parity[parityIdx] XOR (all other data shards in this parity group)
          const recovered = Buffer.from(parityShard.data);
          
          // XOR out the other data shards in this parity group
          for (let j = parityIdx; j < k; j += m) {
            if (j !== i) {
              const otherShard = shardMap.get(j);
              if (otherShard && !otherShard.isParity) {
                for (let b = 0; b < chunkSize; b++) {
                  recovered[b] ^= otherShard.data[b];
                }
              }
            }
          }
          
          chunks.push(recovered);
        } else {
          unrecoverable.push(i);
          chunks.push(Buffer.alloc(chunkSize));
        }
      }
    }

    if (unrecoverable.length > 0) {
      throw new Error(`Cannot reconstruct data: shard(s) ${unrecoverable.join(', ')} are missing and no parity shard covers them (XOR parity recovers at most one loss per parity group)`);
    }
    
    // Reconstruct from chunks
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      const remaining = originalLength - offset;
      const copySize = Math.min(chunks[i].length, remaining);
      if (copySize > 0) {
        chunks[i].copy(reconstructed, offset, 0, copySize);
        offset += copySize;
      }
      if (offset >= originalLength) break;
    }
    
    return reconstructed.slice(0, originalLength);
  }
}

