import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Configuration manager
 * Loads config from JSON/YAML files and environment variables
 */
export class Config {
  constructor(options = {}) {
    this.configPath = options.configPath || join(__dirname, '../config.json');
    this.config = this._loadConfig();
    this._applyEnvOverrides();
  }

  _loadConfig() {
    try {
      const configData = readFileSync(this.configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      // Return default config if file doesn't exist
      return this._getDefaultConfig();
    }
  }

  // ---- LITE MODE (XMBL_LITE=1) ------------------------------------------------------------------------
  // A node co-located with something else — the broker box is the case that forced this — must not behave
  // like a dedicated validator. Measured on the broker before lite existed: the node held 80% of the single
  // vCPU for 7.8 hours straight (22,538s CPU / 28,040s elapsed) while the chain took in 0.2 tx/sec, applied
  // 0 and sealed 0. The cost was never throughput; it was RETENTION. ~64% of that CPU was V8
  // ConcurrentMarking, re-marking a live set (20,777 pooled raw txs + 1,122 in-memory blocks) that only ever
  // grew, so every collection freed nothing and the next one started immediately.
  //
  // Lite therefore trims exactly the things whose cost scales with total chain size rather than with work:
  //   · a small mempool cap, so the pool can never become the GC's problem
  //   · a small in-memory block window (the other 13,107 are on disk and read from there)
  //   · a conservative heap ceiling, so V8 sizes itself for a shared box instead of assuming it owns RAM
  // It changes NO consensus rule and NO wire format — a lite node is a full participant, it just refuses to
  // hoard. Everything here is still individually overridable; lite only moves the DEFAULTS.
  static lite() { return process.env.XMBL_LITE === '1'; }

  _getDefaultConfig() {
    const lite = Config.lite();
    const dflt = (envName, liteVal, fullVal) => parseInt(process.env[envName] || String(lite ? liteVal : fullVal));
    return {
      lite,
      limits: {
        // Bounds the pool that produced the 20,777. Enforced in xpc/src/mempool.js addRawTransaction.
        mempoolMax: dflt('XPC_MEMPOOL_MAX', 1000, 5000),
        // Blocks kept resident. The ledger keeps every block on disk regardless; this is only the window
        // held in the heap, and holding 1,122 of 13,107 bought nothing but marking work.
        blocksInMemory: dflt('XCLT_BLOCKS_IN_MEMORY', 128, 2048),
      },
      network: {
        port: parseInt(process.env.XN_PORT || '3000'),
        bootstrap: process.env.XN_BOOTSTRAP ? process.env.XN_BOOTSTRAP.split(',') : []
      },
      ledger: {
        dbPath: process.env.XCLT_DB_PATH || './data/ledger'
      },
      stateMachine: {
        dbPath: process.env.XVSM_DB_PATH || './data/xvsm',
        totalShards: parseInt(process.env.XVSM_SHARDS || '4')
      },
      consensus: {
        dbPath: process.env.XPC_DB_PATH || './data/xpc',
        requiredValidations: parseInt(process.env.XPC_VALIDATIONS || '3')
      },
      storage: {
        dbPath: process.env.XSC_DB_PATH || './data/storage',
        capacity: parseInt(process.env.XSC_CAPACITY || '1000000')
      },
      logging: {
        level: process.env.LOG_LEVEL || 'info'
      },
      rateLimit: {
        maxRequests: parseInt(process.env.RATE_LIMIT_MAX || '100'),
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || '60000')
      }
    };
  }

  _applyEnvOverrides() {
    // Environment variables override config file
    if (process.env.XN_PORT) {
      this.config.network.port = parseInt(process.env.XN_PORT);
    }
    if (process.env.LOG_LEVEL) {
      this.config.logging.level = process.env.LOG_LEVEL;
    }
  }

  get(path, defaultValue = undefined) {
    const keys = path.split('.');
    let value = this.config;
    
    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return defaultValue;
      }
    }
    
    return value;
  }

  set(path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    let target = this.config;
    
    for (const key of keys) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      target = target[key];
    }
    
    target[lastKey] = value;
  }

  getAll() {
    return { ...this.config };
  }
}

// Singleton instance
let configInstance = null;

export function getConfig(options) {
  if (!configInstance) {
    configInstance = new Config(options);
  }
  return configInstance;
}

