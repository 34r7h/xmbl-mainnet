// THE NODE'S RUNTIME PRIMITIVES HAD NO TEST AT ALL.
//
// cache.js, rate-limiter.js, config.js, node-config.js, logger.js and metrics-server.js were never
// loaded by any suite in the 67-file gate (measured; see scripts/coverage-report.mjs). Two of them
// matter more than their size suggests: rate-limiter.js is the node's only DoS control, and config.js
// decides what every subsystem is pointed at on boot. A config loader that throws on boot takes the
// whole daemon with it, and a rate limiter nobody exercised is a guess.
//
// FOUND BY THIS SUITE and fixed in config.js: _applyEnvOverrides() indexed this.config.network.port
// and this.config.logging.level unconditionally. Those sections exist in the DEFAULT config, so the
// common path is fine — but when a real config.json is present and omits either section (a minimal
// operator file, which is exactly what an operator writes), setting XN_PORT or LOG_LEVEL threw
// "Cannot set properties of undefined" before the node had done anything. See section 3.
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache, createCache } from './cache.js';
import { RateLimiter, rateLimitMiddleware } from './rate-limiter.js';
import { Config, getConfig } from './config.js';
import {
  NODE_CONFIG_SCHEMA, NODE_CONFIG_FIELDS, defaultConfig, validateConfig, normalizeConfig, loadConfig,
} from './node-config.js';
import { collectMetrics, createMetricsServer } from './metrics-server.js';
import logger, { createLogger } from './logger.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

const dir = mkdtempSync(join(tmpdir(), 'xmbl-core-prims-'));

// ── 1. THE RATE LIMITER IS THE NODE'S ONLY DoS CONTROL ──
{
  const rl = new RateLimiter({ maxRequests: 3, windowMs: 10_000 });
  ok('the first request is allowed', rl.isAllowed('ip1') === true);
  ok('and the next two, up to the limit', rl.isAllowed('ip1') && rl.isAllowed('ip1'));
  ok('THE FOURTH IS REFUSED — exactly maxRequests get through, not one more',
     rl.isAllowed('ip1') === false);
  ok('it stays refused while the window holds', rl.isAllowed('ip1') === false);

  ok('a DIFFERENT key has its own budget — one noisy peer cannot starve the rest',
     rl.isAllowed('ip2') === true && rl.isAllowed('ip2') === true);
  ok('exhausting ip2 does not revive ip1', (() => {
    rl.isAllowed('ip2'); rl.isAllowed('ip2');
    return rl.isAllowed('ip2') === false && rl.isAllowed('ip1') === false;
  })());

  ok('getRemaining reports the untouched budget for an unseen key', rl.getRemaining('fresh') === 3);
  ok('getRemaining drops as the budget is spent', (() => {
    const r = new RateLimiter({ maxRequests: 3, windowMs: 10_000 });
    r.isAllowed('k'); return r.getRemaining('k') === 2;
  })());
  ok('getRemaining does NOT itself consume a token', (() => {
    const r = new RateLimiter({ maxRequests: 3, windowMs: 10_000 });
    r.getRemaining('k'); r.getRemaining('k');
    return r.isAllowed('k') && r.isAllowed('k') && r.isAllowed('k') && !r.isAllowed('k');
  })());

  // The window is what makes it a limiter rather than a permanent ban.
  const short = new RateLimiter({ maxRequests: 1, windowMs: 1 });
  short.isAllowed('k');
  ok('a blocked key RECOVERS once its window expires', await (async () => {
    await new Promise((r) => setTimeout(r, 12));
    return short.isAllowed('k') === true;
  })());
  ok('getRemaining reports a full budget again for an expired window', await (async () => {
    await new Promise((r) => setTimeout(r, 12));
    return short.getRemaining('k') === 1;
  })());

  // cleanup() bounds the map — without it, one bucket per distinct key leaks forever, which is
  // itself the memory-exhaustion attack the limiter exists to prevent.
  const leaky = new RateLimiter({ maxRequests: 5, windowMs: 1 });
  for (let i = 0; i < 50; i++) leaky.isAllowed('k' + i);
  ok('every distinct key holds a bucket', leaky.buckets.size === 50);
  await new Promise((r) => setTimeout(r, 12));
  leaky.cleanup();
  ok('CLEANUP RECLAIMS EXPIRED BUCKETS — the limiter cannot be turned into a memory leak',
     leaky.buckets.size === 0);
  ok('cleanup keeps buckets that are still live', (() => {
    const r = new RateLimiter({ maxRequests: 5, windowMs: 60_000 });
    r.isAllowed('live'); r.cleanup(); return r.buckets.size === 1;
  })());

  ok('the defaults are 100 requests per 60s', (() => {
    const r = new RateLimiter();
    return r.maxRequests === 100 && r.windowMs === 60_000;
  })());

  // The middleware is the only consumer shape, so pin its contract.
  const limiter = new RateLimiter({ maxRequests: 1, windowMs: 10_000 });
  const mw = rateLimitMiddleware(limiter);
  let nexted = 0, status = null, payload = null;
  const res = { status(c) { status = c; return this; }, json(b) { payload = b; } };
  mw({ ip: '1.2.3.4' }, res, () => nexted++);
  ok('the middleware calls next() for an allowed request', nexted === 1 && status === null);
  mw({ ip: '1.2.3.4' }, res, () => nexted++);
  ok('a limited request gets HTTP 429 and does NOT continue down the chain',
     nexted === 1 && status === 429 && payload.error === 'Too many requests');
  ok('a request with no ip falls back to a shared "unknown" key rather than crashing', (() => {
    const l2 = new RateLimiter({ maxRequests: 1, windowMs: 10_000 });
    let n = 0;
    const m2 = rateLimitMiddleware(l2);
    m2({}, res, () => n++); m2({}, res, () => n++);
    return n === 1;
  })());
  ok('a custom key extractor is honoured', (() => {
    const l3 = new RateLimiter({ maxRequests: 1, windowMs: 10_000 });
    const m3 = rateLimitMiddleware(l3, (req) => req.user);
    let n = 0;
    m3({ user: 'a' }, res, () => n++); m3({ user: 'b' }, res, () => n++);
    return n === 2;                                   // different users, separate budgets
  })());
}

// ── 2. THE CACHE: TTL AND LRU EVICTION ──
{
  const c = new Cache({ maxSize: 3, defaultTTL: 10_000 });
  ok('a miss is undefined, not null', c.get('nope') === undefined);
  c.set('a', 1);
  ok('a set value reads back', c.get('a') === 1);
  ok('a falsy value is still a hit, not a miss', (() => { c.set('zero', 0); return c.get('zero') === 0; })());
  c.delete('zero');

  c.set('b', 2); c.set('c', 3);
  ok('the cache holds up to maxSize', c.getStats().size === 3);
  c.set('d', 4);
  ok('AT CAPACITY, A NEW KEY EVICTS ONE — the cache is bounded', c.getStats().size === 3);
  ok('the evicted key is the LEAST RECENTLY USED', c.get('a') === undefined && c.get('d') === 4);

  // get() refreshes recency, which is the whole point of LRU.
  const l = new Cache({ maxSize: 2, defaultTTL: 10_000 });
  l.set('x', 1); l.set('y', 2);
  l.get('x');                                         // x is now the most recent
  l.set('z', 3);
  ok('READING A KEY PROTECTS IT FROM THE NEXT EVICTION', l.get('x') === 1 && l.get('y') === undefined);

  ok('overwriting an existing key at capacity evicts nothing', (() => {
    const o = new Cache({ maxSize: 2, defaultTTL: 10_000 });
    o.set('p', 1); o.set('q', 2); o.set('p', 9);
    return o.getStats().size === 2 && o.get('q') === 2 && o.get('p') === 9;
  })());

  // TTL.
  const t = new Cache({ maxSize: 10, defaultTTL: 10_000 });
  t.set('short', 'v', 1);
  await new Promise((r) => setTimeout(r, 12));
  ok('AN EXPIRED ENTRY READS AS A MISS', t.get('short') === undefined);
  ok('...and reading it drops it, so the map does not grow with dead entries', t.getStats().size === 0);

  const s = new Cache({ maxSize: 10, defaultTTL: 1 });
  s.set('a', 1); s.set('b', 2);
  await new Promise((r) => setTimeout(r, 12));
  ok('getStats distinguishes expired from active without deleting', (() => {
    const st = s.getStats(); return st.size === 2 && st.expired === 2 && st.active === 0;
  })());
  s.cleanup();
  ok('cleanup() reclaims every expired entry', s.getStats().size === 0);
  ok('cleanup keeps live entries', (() => {
    const k = new Cache({ maxSize: 10, defaultTTL: 60_000 });
    k.set('live', 1); k.cleanup(); return k.get('live') === 1;
  })());

  ok('a per-entry ttl overrides the default', (() => {
    const k = new Cache({ maxSize: 10, defaultTTL: 1 });
    k.set('long', 1, 60_000);
    return k.get('long') === 1;
  })());
  ok('delete removes the entry and its LRU slot', (() => {
    const k = new Cache({ maxSize: 2, defaultTTL: 10_000 });
    k.set('a', 1); k.delete('a');
    return k.get('a') === undefined && k.accessOrder.length === 0;
  })());
  ok('deleting a key that is not there is harmless', (() => {
    const k = new Cache(); k.delete('ghost'); return k.getStats().size === 0;
  })());
  ok('clear empties both the map and the LRU order', (() => {
    const k = new Cache({ maxSize: 5, defaultTTL: 10_000 });
    k.set('a', 1); k.set('b', 2); k.clear();
    return k.getStats().size === 0 && k.accessOrder.length === 0;
  })());
  ok('createCache builds a Cache', createCache({ maxSize: 7 }) instanceof Cache
     && createCache({ maxSize: 7 }).maxSize === 7);
  ok('the defaults are 1000 entries / 1h', (() => {
    const k = new Cache(); return k.maxSize === 1000 && k.defaultTTL === 3_600_000;
  })());
}

// ── 3. THE BOOT CONFIG — INCLUDING THE CRASH THIS SUITE FOUND ──
{
  const prior = { port: process.env.XN_PORT, level: process.env.LOG_LEVEL, lite: process.env.XMBL_LITE };
  const restore = () => {
    for (const [k, v] of [['XN_PORT', prior.port], ['LOG_LEVEL', prior.level], ['XMBL_LITE', prior.lite]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };

  delete process.env.XMBL_LITE;
  ok('lite mode is off unless XMBL_LITE=1 exactly', Config.lite() === false);
  process.env.XMBL_LITE = 'yes';
  ok('...and not for any other truthy string', Config.lite() === false);
  process.env.XMBL_LITE = '1';
  ok('XMBL_LITE=1 turns it on', Config.lite() === true);

  // Lite only moves DEFAULTS; it must not touch a consensus rule.
  delete process.env.XPC_MEMPOOL_MAX; delete process.env.XCLT_BLOCKS_IN_MEMORY;
  const liteCfg = new Config({ configPath: join(dir, 'absent.json') });
  ok('LITE CAPS THE MEMPOOL AND THE RESIDENT BLOCK WINDOW',
     liteCfg.get('limits.mempoolMax') === 1000 && liteCfg.get('limits.blocksInMemory') === 128);
  ok('lite leaves the required validation count alone — it is a consensus rule, not a default',
     liteCfg.get('consensus.requiredValidations') === 3);
  delete process.env.XMBL_LITE;
  const fullCfg = new Config({ configPath: join(dir, 'absent.json') });
  ok('a full node keeps the larger defaults',
     fullCfg.get('limits.mempoolMax') === 5000 && fullCfg.get('limits.blocksInMemory') === 2048);
  ok('an explicit env override beats BOTH lite and full defaults', (() => {
    process.env.XMBL_LITE = '1'; process.env.XPC_MEMPOOL_MAX = '77';
    const c = new Config({ configPath: join(dir, 'absent.json') });
    delete process.env.XPC_MEMPOOL_MAX; delete process.env.XMBL_LITE;
    return c.get('limits.mempoolMax') === 77;
  })());

  ok('a missing config file falls back to defaults instead of throwing',
     new Config({ configPath: join(dir, 'nope.json') }).get('network.port') === 3000);
  ok('a CORRUPT config file also falls back rather than taking the node down', (() => {
    const p = join(dir, 'broken.json');
    writeFileSync(p, '{ this is not json');
    return new Config({ configPath: p }).get('network.port') === 3000;
  })());

  const full = join(dir, 'full.json');
  writeFileSync(full, JSON.stringify({ network: { port: 1 }, logging: { level: 'warn' }, custom: { k: 'v' } }));
  const loaded = new Config({ configPath: full });
  ok('a config file is read when it is there', loaded.get('custom.k') === 'v');
  ok('dotted get() walks nested objects', loaded.get('network.port') === 1);
  ok('get() returns the supplied default for a missing path', loaded.get('a.b.c', 'dflt') === 'dflt');
  ok('get() returns undefined for a missing path with no default', loaded.get('a.b.c') === undefined);
  ok('get() does not walk into a non-object', loaded.get('network.port.deeper', 'x') === 'x');
  ok('set() creates intermediate objects', (() => {
    loaded.set('deep.nested.key', 42); return loaded.get('deep.nested.key') === 42;
  })());
  ok('set() overwrites a non-object on the path rather than throwing', (() => {
    loaded.set('network.port.sub', 5); return loaded.get('network.port.sub') === 5;
  })());
  ok('getAll returns a copy, so a caller cannot mutate the live config by accident', (() => {
    const snap = loaded.getAll(); snap.network = null;
    return loaded.get('network') !== null;
  })());

  // THE BUG. A minimal operator config file — the realistic one — plus an env override.
  const minimal = join(dir, 'minimal.json');
  writeFileSync(minimal, JSON.stringify({ ledger: { dbPath: '/srv/ledger' } }));
  process.env.XN_PORT = '9999';
  process.env.LOG_LEVEL = 'debug';
  let boom = null;
  let cfg = null;
  try { cfg = new Config({ configPath: minimal }); } catch (e) { boom = e; }
  ok('A CONFIG FILE WITH NO network SECTION + XN_PORT SET NO LONGER CRASHES THE NODE ON BOOT',
     boom === null);
  ok('...and the override still lands', cfg && cfg.get('network.port') === 9999);
  ok('...the same for a missing logging section + LOG_LEVEL', cfg && cfg.get('logging.level') === 'debug');
  ok('...and the operator\'s own keys survive the override', cfg && cfg.get('ledger.dbPath') === '/srv/ledger');

  restore();
  ok('getConfig() is a singleton — the second call returns the first instance',
     getConfig({ configPath: join(dir, 'absent.json') }) === getConfig({ configPath: join(dir, 'other.json') }));
}

// ── 4. THE NODE CONFIG SCHEMA — THE SURFACE THE COORDINATOR READS ──
{
  const d = defaultConfig();
  ok('every schema field appears in the default config',
     NODE_CONFIG_FIELDS.every((f) => f in d) && NODE_CONFIG_FIELDS.length === Object.keys(d).length);
  ok('ALL ROLES DEFAULT OFF — a node opts in explicitly, it is never conscripted',
     Object.values(d.roles).every((v) => v === false));
  ok('identity_path defaults empty and is required, so the template cannot be booted as-is',
     d.identity_path === '' && NODE_CONFIG_SCHEMA.identity_path.required === true);
  ok('the default listen addr binds an OS-assigned port on all interfaces',
     d.listen_addrs.length === 1 && d.listen_addrs[0] === '/ip4/0.0.0.0/tcp/0');
  ok('announce_addrs defaults empty — the pre-NAT behaviour is preserved', d.announce_addrs.length === 0);
  ok('array defaults are CLONED, so two configs cannot share one array', (() => {
    const a = defaultConfig(), b = defaultConfig();
    a.listen_addrs.push('/mutated');
    return b.listen_addrs.length === 1 && NODE_CONFIG_SCHEMA.listen_addrs.default.length === 1;
  })());
  ok('object defaults are cloned too', (() => {
    const a = defaultConfig(), b = defaultConfig();
    a.roles.validate = true; return b.roles.validate === false;
  })());

  ok('the default config is INVALID until identity_path is set', validateConfig(d).valid === false);
  ok('...and says exactly which field', validateConfig(d).errors.some((e) => /identity_path/.test(e)));
  ok('a whitespace-only identity_path is rejected as empty',
     validateConfig({ ...d, identity_path: '   ' }).valid === false);
  const good = { ...d, identity_path: '/home/a/.handoff/agents/x/xmbl.json' };
  ok('with identity_path set it validates', validateConfig(good).valid === true);

  ok('a non-object config is rejected with one clear error',
     validateConfig(null).valid === false && validateConfig('x').errors[0] === 'config must be an object'
     && validateConfig([]).valid === false);
  ok('AN UNKNOWN TOP-LEVEL KEY IS REJECTED — the typo guard the schema promises',
     validateConfig({ ...good, listen_addr: [] }).errors.some((e) => e === 'unknown field: listen_addr'));
  ok('an unknown sub-key of roles is rejected too',
     validateConfig({ ...good, roles: { ...good.roles, validat: true } })
       .errors.some((e) => e === 'unknown field: roles.validat'));
  ok('a wrong top-level type is named', validateConfig({ ...good, data_dir: 7 })
     .errors.some((e) => e === 'field data_dir must be string'));
  ok('a string[] holding a non-string is rejected',
     validateConfig({ ...good, listen_addrs: ['ok', 5] }).valid === false);
  ok('a wrong sub-field type is named', validateConfig({ ...good, roles: { ...good.roles, validate: 'yes' } })
     .errors.some((e) => e === 'field roles.validate must be boolean'));
  ok('A NEGATIVE RESOURCE CAP IS REJECTED — a cap below zero is not a cap',
     validateConfig({ ...good, resource_caps: { ...good.resource_caps, disk_mb: -1 } })
       .errors.some((e) => /resource_caps\.disk_mb must be >= 0/.test(e)));
  ok('zero is an allowed cap (it means "none of this role"),',
     validateConfig({ ...good, resource_caps: { ...good.resource_caps, disk_mb: 0 } }).valid === true);
  ok('NaN and Infinity are not finite numbers and are refused',
     validateConfig({ ...good, resource_caps: { ...good.resource_caps, disk_mb: NaN } }).valid === false
     && validateConfig({ ...good, resource_caps: { ...good.resource_caps, disk_mb: Infinity } }).valid === false);
  ok('several problems are reported together, not one at a time',
     validateConfig({ data_dir: 7, nope: 1 }).errors.length >= 3);
  ok('sub-fields are optional — a partial roles object validates',
     validateConfig({ ...good, roles: { validate: true } }).valid === true);

  ok('normalizeConfig fills every default', (() => {
    const n = normalizeConfig({ identity_path: '/x' });
    return n.data_dir === './xmbl-data' && n.roles.lead === false && n.resource_caps.disk_mb === 1024;
  })());
  ok('normalizeConfig merges roles one level deep instead of replacing the object', (() => {
    const n = normalizeConfig({ identity_path: '/x', roles: { lead: true } });
    return n.roles.lead === true && n.roles.validate === false;
  })());
  ok('a non-object roles value is ignored rather than corrupting the merge', (() => {
    const n = normalizeConfig({ identity_path: '/x', roles: 'all' });
    return n.roles.validate === false;
  })());
  ok('normalizeConfig with no argument returns the defaults',
     JSON.stringify(normalizeConfig()) === JSON.stringify(defaultConfig()));

  const cfgPath = join(dir, 'node.json');
  writeFileSync(cfgPath, JSON.stringify({ identity_path: '/x/xmbl.json', roles: { validate: true } }));
  const lc = loadConfig(cfgPath);
  ok('loadConfig normalizes and validates a good file', lc.roles.validate === true && lc.data_dir === './xmbl-data');
  const badPath = join(dir, 'bad-node.json');
  writeFileSync(badPath, JSON.stringify({ identity_path: '/x', typo_field: 1 }));
  ok('LOADCONFIG REFUSES AN INVALID FILE AND NAMES THE PATH AND THE FIELD',
     throws(() => loadConfig(badPath), /invalid xmbl-node config at .*typo_field/));
  ok('loadConfig on a missing file throws rather than returning defaults',
     throws(() => loadConfig(join(dir, 'ghost.json'))));
}

// ── 5. METRICS ARE UNAUTHENTICATED, SO THEY MUST STAY ON LOOPBACK ──
{
  const core = {
    xn: { getConnectedPeers: () => ['p1', 'p2'] },
    xpc: { mempool: {
      rawTx: new Map([['lead1', new Map([['a', 1], ['b', 2]])], ['lead2', new Map([['c', 3]])]]),
      validationTasks: new Map([['lead1', [1, 2, 3]]]),
      lockedUtxo: new Set(['u1']),
      processingTx: new Map([['t', 1]]),
      tx: new Map(),
    } },
    validationsCompleted: 5,
    xsc: { shardsStored: 9 },
    computeNode: { computeJobsRun: 2 },
    leadBatchesSealed: 4,
  };
  const m = collectMetrics(core, Date.now() - 5000);
  ok('uptime is reported in whole seconds', m.uptime_seconds >= 5 && Number.isInteger(m.uptime_seconds));
  ok('peer count comes from the network module', m.peer_count === 2);
  ok('THE RAW MEMPOOL DEPTH SUMS ACROSS EVERY LEADER, not just the first', m.mempool.raw === 3);
  ok('validation-task depth sums across leaders too', m.mempool.validation_tasks === 3);
  ok('the set- and map-shaped depths are read as sizes',
     m.mempool.locked_utxo === 1 && m.mempool.processing === 1 && m.mempool.tx === 0);
  ok('the role counters are surfaced',
     m.validations_completed === 5 && m.shards_stored === 9 && m.compute_jobs_run === 2 && m.lead_batches_sealed === 4);
  ok('earnings are derived from the same counters', m.earnings && typeof m.earnings === 'object');

  const empty = collectMetrics({}, Date.now());
  ok('A BARE CORE YIELDS ZEROS, NOT A CRASH — metrics must not be able to take the daemon down',
     empty.peer_count === 0 && empty.mempool.raw === 0 && empty.validations_completed === 0
     && empty.shards_stored === 0 && empty.compute_jobs_run === 0 && empty.lead_batches_sealed === 0);
  ok('an undefined core is handled the same way', collectMetrics(undefined, Date.now()).peer_count === 0);
  ok('every counter is a number — a metrics scrape must never see a string or null', (() => {
    const flat = (o) => Object.values(o).flatMap((v) => (v && typeof v === 'object' ? flat(v) : [v]));
    return flat(empty.mempool).every((v) => typeof v === 'number');
  })());

  const { server, port } = await createMetricsServer({ core, port: 0, startTime: Date.now() });
  ok('THE SERVER BINDS LOOPBACK ONLY — these counters are unauthenticated',
     server.address().address === '127.0.0.1');
  const res = await fetch(`http://127.0.0.1:${port}/`);
  const body = await res.json();
  ok('a request returns 200 with JSON', res.status === 200
     && res.headers.get('content-type') === 'application/json');
  ok('the served snapshot is the same shape collectMetrics builds',
     body.peer_count === 2 && body.mempool.raw === 3);
  ok('any path returns the same snapshot — there is one endpoint',
     (await (await fetch(`http://127.0.0.1:${port}/anything`)).json()).peer_count === 2);

  // A core whose getter throws must produce a 500, not an unhandled rejection that kills the process.
  const brk = await createMetricsServer({
    core: { get xn() { throw new Error('core is mid-restart'); } }, port: 0, startTime: Date.now(),
  });
  const bad = await fetch(`http://127.0.0.1:${brk.port}/`);
  ok('A THROWING CORE YIELDS 500, NOT A DEAD DAEMON', bad.status === 500);
  ok('...and the error is reported as JSON', /mid-restart/.test((await bad.json()).error));

  await new Promise((r) => server.close(r));
  await new Promise((r) => brk.server.close(r));
  ok('a second bind of the SAME loopback port is rejected rather than silently shadowing', await (async () => {
    const a = await createMetricsServer({ core, port: 0, startTime: Date.now() });
    let refused = false;
    try { await createMetricsServer({ core, port: a.port, startTime: Date.now() }); } catch { refused = true; }
    await new Promise((r) => a.server.close(r));
    return refused;
  })());
}

// ── 6. THE LOGGER IS IMPORTED BY EVERY SUBSYSTEM, SO IT MUST NOT THROW AT IMPORT ──
{
  ok('the default logger exists and has the pino level methods',
     logger && ['info', 'warn', 'error', 'debug'].every((m) => typeof logger[m] === 'function'));
  const child = createLogger('cubic-ledger');
  ok('createLogger returns a child logger', typeof child.info === 'function');
  ok('the child is tagged with its module name', child.bindings().module === 'cubic-ledger');
  ok('extra bindings are merged in', createLogger('x', { node: 'n1' }).bindings().node === 'n1');
  ok('the child is a distinct logger, not the singleton', child !== logger);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
