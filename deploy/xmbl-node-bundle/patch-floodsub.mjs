#!/usr/bin/env node
// postinstall: make @libp2p/floodsub's peer-stream CLEANUP path idempotent.
//
// The bug (took the whole xmbl mesh down on 2026-09-13): floodsub's peer-stream error handlers do
// `this.{in,out}boundPb?.unwrap().unwrap().abort(err)` inside a `.catch(err => {...})`. When the
// underlying Yamux stream is ALREADY closed, abort() calls unshift() on it and throws
// StreamStateError ("Cannot push data onto a stream that is closed"). That throw escapes the catch as
// an unhandledRejection, which Node treats as fatal — the entire node process dies. The seed (the
// rendezvous every peer dials, so the highest connection churn) hit this cleanup path constantly and
// crash-looped until its supervisor's restart budget was exhausted; with the sole bootstrap seed dead,
// every other node was isolated (peers=0). It is a bug in the cleanup path — the peer is already being
// discarded — so the correct fix is to make abort() idempotent by wrapping each call in try/catch. We
// deliberately do NOT swallow arbitrary exceptions or keep the process alive on other faults: a real
// bug must still crash so the supervisor restarts a fresh (not half-initialised, consensus-voting) node.
//
// Why a postinstall and not a committed node_modules edit: vendor/xmbl-node/node_modules is git-ignored
// and NOT shipped in /xmbl-node-bundle.tgz — every box builds it on-box with `npm install`, which pulls
// floodsub fresh from the registry (unpatched). This hook re-applies the fix after every install, so it
// survives a from-registry reinstall. Idempotent (marker-guarded) and NEVER fails an install (always
// exits 0; a missing file or a pattern that drifted on a version bump logs a warning, not an error).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, 'node_modules', '@libp2p', 'floodsub', 'dist', 'src', 'peer-streams.js');

try {
  if (!fs.existsSync(target)) { console.log('[patch-floodsub] floodsub not present — skipping'); process.exit(0); }
  let s = fs.readFileSync(target, 'utf8');
  if (s.includes('/*hf-abort-guard*/')) { console.log('[patch-floodsub] already patched'); process.exit(0); }
  const patterns = [
    'this.inboundPb?.unwrap().unwrap().abort(err);',
    'this.outboundPb?.unwrap().unwrap().abort(err);',
  ];
  let sites = 0;
  for (const p of patterns) {
    const wrapped = 'try { /*hf-abort-guard*/ ' + p + ' } catch (_e) {}';
    const parts = s.split(p);
    sites += parts.length - 1;
    s = parts.join(wrapped);
  }
  if (sites === 0) {
    console.warn('[patch-floodsub] WARNING: abort pattern not found (floodsub version drift?) — NOT patched; verify the cleanup-path fix still applies to this version');
    process.exit(0);
  }
  fs.writeFileSync(target, s);
  console.log('[patch-floodsub] patched ' + sites + ' abort site(s) in floodsub peer-streams.js');
} catch (e) {
  console.warn('[patch-floodsub] non-fatal error, install continues: ' + (e && e.message ? e.message : e));
}
process.exit(0);
