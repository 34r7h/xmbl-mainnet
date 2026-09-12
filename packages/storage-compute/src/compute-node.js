import { ComputeRuntime } from './compute.js';
import { MarketPricing } from './pricing.js';

/**
 * Compute role (E3): accepts + executes compute jobs under this node's own
 * resource_caps (compute_cpu_ms/compute_mem_mb, A5a), gated on roles.compute.
 * Mirrors StorageNode's shard-request wiring: an xn pubsub topic pair for
 * network-submitted jobs, plus a directly-callable runJob() for anything
 * driving it in-process (control socket, tests).
 *
 * Cap enforcement is delegated entirely to ComputeRuntime.execute — it
 * already throws on both an over-declared WASM memory export and an
 * over-time execution, so "over-cap is refused" falls out of the existing,
 * already-tested runtime rather than duplicating the check here.
 */
export class ComputeNode {
  constructor(options = {}) {
    this.maxTime = options.maxTime ?? 10000;
    this.maxMemory = options.maxMemory ?? 512 * 1024 * 1024;
    this.runtime = options.runtime || new ComputeRuntime({ maxMemory: this.maxMemory, maxTime: this.maxTime });
    // Optional smart-contract execution. When the node is wired with a ContractHost (from
    // @xmbl/contracts, itself composing THIS runtime + a state-machine VerkleStateTree), a
    // compute node also executes contracts — "storage-compute includes state machine and
    // smart contracting". It is INJECTED, not imported, so there is no dependency cycle:
    // storage-compute never reaches up to @xmbl/contracts; the caller wires the two together.
    this.contractHost = options.contractHost || null;
    // Market pricing driven by MEASURED resource use (finding C1): a completed job is priced
    // from the cpuMs/peakMem the runtime actually measured, not an assumed figure.
    this.pricing = options.pricing || new MarketPricing();
    // Cumulative count of jobs that completed WITHIN caps (metrics: compute_jobs_run).
    // A refused (over-cap or failed) job is never counted.
    this.computeJobsRun = 0;

    // Integration: xn for P2P job submission
    this.xn = options.xn || null;
    this.requestTopic = options.requestTopic || 'compute:job_request';
    this.responseTopic = options.responseTopic || 'compute:job_response';

    if (this.xn && this.xn.started) {
      this.xn.subscribe(this.requestTopic).catch(() => {});
      this.xn.on(`message:${this.requestTopic}`, (data) => {
        this._handleJobRequest(data);
      });
    }
  }

  async _handleJobRequest(data) {
    if (!data || !data.jobId) return;
    const response = await this.runJob(data);
    if (this.xn && this.xn.started) {
      try {
        await this.xn.publish(this.responseTopic, response);
      } catch (error) {
        // Silently handle network errors
      }
    }
  }

  /**
   * Run a compute job under this node's resource_caps.
   * @param {{jobId: string, wasmCode: Uint8Array|string, functionName: string, args?: any[]}} job
   * @returns {Promise<{jobId: string, ok: boolean, result?: any, error?: string}>}
   */
  async runJob(job) {
    const { jobId, wasmCode, functionName, args = [] } = job || {};
    try {
      if (!wasmCode || !functionName) {
        throw new Error('runJob requires wasmCode and functionName');
      }
      const code = typeof wasmCode === 'string' ? Buffer.from(wasmCode, 'base64') : wasmCode;
      // Raw compute-market path: NO host binding (an untrusted market job never gets a
      // state-bearing host — that is strictly the contract path below), but METERED so the job
      // is priced on measured resource use. The runtime returns { result, metrics } here.
      const { result, metrics } = await this.runtime.execute(code, functionName, args, { meter: true });
      this.computeJobsRun += 1;
      const price = this.pricing.calculateComputePrice(metrics.cpuMs, metrics.peakMemBytes / (1024 * 1024));
      return { jobId, ok: true, result, metrics, price };
    } catch (error) {
      // Over-cap (memory/time limit exceeded) or any other execution failure
      // is a clean refusal, never a thrown error and never counted.
      return { jobId, ok: false, error: error.message };
    }
  }

  /**
   * Execute a deployed smart contract on this compute node. Requires a ContractHost to have
   * been injected (see constructor) — a node without one is not a contracting node.
   * @param {{contractId:string, functionName:string, args?:number[], caller?:number}} job
   * @returns {Promise<{ok:boolean, result?:any, writes?:any[], stateRoot?:string, error?:string}>}
   */
  async runContract(job) {
    if (!this.contractHost) {
      return { ok: false, error: 'this compute node has no ContractHost; contract execution is not enabled' };
    }
    const { contractId, functionName, args = [], caller = 0 } = job || {};
    try {
      if (!contractId || !functionName) throw new Error('runContract requires contractId and functionName');
      const out = await this.contractHost.call(contractId, functionName, args, { caller });
      this.computeJobsRun += 1;
      return { ok: true, ...out };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}
