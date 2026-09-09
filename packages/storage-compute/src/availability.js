import { randomBytes } from 'crypto';
import { computeProbeProof } from './storage-node.js';

export class AvailabilityTester {
  constructor() {
    this.results = new Map(); // nodeId -> [ {available, responseTime, timestamp} ]
  }

  /**
   * LIVENESS ONLY — is the node reachable? A 200 from /health proves the process
   * is up; it does NOT prove the node still holds any particular shard. Do not use
   * this as an availability proof: an idle node that serves /health but discarded
   * every shard passes it. For a soundness check that a shard is actually held, use
   * probeNode(), which requires a possession proof.
   */
  async testNode(nodeId, address) {
    const startTime = Date.now();
    try {
      // Ping node (simplified)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`http://${address}/health`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const responseTime = Date.now() - startTime;
      const available = response.ok;
      this.recordResult(nodeId, available, responseTime);
      return available;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.recordResult(nodeId, false, responseTime);
      return false;
    }
  }

  /**
   * SOUND availability proof: the node must PROVE it holds the shard's bytes at
   * probe time, not merely answer a health check. The verifier issues a fresh,
   * unpredictable nonce and accepts ONLY when the responder returns
   * proof === computeProbeProof(nonce, expectedBytes). Because the nonce is fresh
   * and the proof binds the bytes, a node that is up but does not hold the shard
   * fails, a forged `held:true` with a fabricated proof fails, a proof over the
   * wrong bytes fails, and a proof captured under a different nonce fails.
   *
   * The `held` flag is a claim, never evidence — the verdict comes solely from the
   * recomputed proof. `expectedBytes` is what the verifier stored / sourced for this
   * shard; `prober` is the transport seam (P2P probe request/response, or an HTTP
   * /probe endpoint) that carries { shardId, nonce } to the node and returns its
   * { held, proof } answer.
   *
   * @param {string} nodeId
   * @param {object} opts
   * @param {string} opts.shardId
   * @param {Buffer|Uint8Array|string} opts.expectedBytes bytes the shard must contain
   * @param {(probe:{shardId:string,nonce:string}) => Promise<{held?:boolean,proof?:string}>} opts.prober
   * @returns {Promise<boolean>} true iff possession is proven for THIS probe.
   */
  async probeNode(nodeId, { shardId, expectedBytes, prober }) {
    const nonce = randomBytes(16).toString('hex');
    const startTime = Date.now();
    let response;
    try {
      response = await prober({ shardId, nonce });
    } catch (error) {
      // unreachable / transport error → not available
      this.recordResult(nodeId, false, Date.now() - startTime);
      return false;
    }
    const responseTime = Date.now() - startTime;
    const available =
      response?.held === true &&
      typeof response.proof === 'string' &&
      response.proof === computeProbeProof(nonce, expectedBytes);
    this.recordResult(nodeId, available, responseTime);
    return available;
  }

  recordResult(nodeId, available, responseTime) {
    if (!this.results.has(nodeId)) {
      this.results.set(nodeId, []);
    }
    this.results.get(nodeId).push({
      available,
      responseTime,
      timestamp: Date.now()
    });
  }

  getStats(nodeId) {
    const results = this.results.get(nodeId) || [];
    if (results.length === 0) {
      return { availability: 0, avgResponseTime: 0 };
    }

    const availableCount = results.filter(r => r.available).length;
    const availability = availableCount / results.length;
    const avgResponseTime = results
      .filter(r => r.available)
      .reduce((sum, r) => sum + r.responseTime, 0) / availableCount || 0;

    return { availability, avgResponseTime };
  }
}
