// THE FILE THAT HOLDS EVERY NODE'S SIGNING KEY WAS 45% COVERED.
//
// agent-keystore is the only thing standing between a committed `xmbl.json` and a stolen node identity.
// It wraps each MAYO secret in AES-256-GCM under an HKDF-derived key whose `info` and whose GCM AAD are
// both the agent_id — so an envelope is bound to ONE agent and cannot be replayed under another. It also
// owns the machine master key, which derives nothing less than every node identity on the box: losing it
// is unrecoverable, and minting a SECOND one silently forks the box.
//
// The half that no suite had ever run is the half that matters: the AAD binding, the tamper paths, the
// refusal to clobber a damaged record, the agent_id validation that stops a path segment from escaping,
// and getPublicRecord's promise that it returns nothing secret. Each of those fails SILENTLY or
// CATASTROPHICALLY, never noisily, which is exactly why they need a check rather than a reading.
//
// EVERY call below passes BOTH `agentsDir` and `masterKeyPath` explicitly. The module's defaults are
// ~/.handoff/agents and ~/.handoff/xmbl-master.key — this machine's LIVE keystore. A suite that forgot one
// of those would mint or read real keys.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  loadMasterKey, encryptSecret, decryptSecret, ensureAgentIdentity,
  ensureIdentityAtPath, loadIdentityAtPath, loadAgentIdentity, getPublicRecord,
} from './agent-keystore.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const threw = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return re ? re.test(e.message) : true; }
};

// A sandbox that is NOT the operator's ~/.handoff. Everything below lives here.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'xmbl-keystore-test-'));
const agentsDir = path.join(SANDBOX, 'agents');
const masterKeyPath = path.join(SANDBOX, 'xmbl-master.key');
const MK = crypto.randomBytes(32);                       // injected master key: no file, no env
const OPTS = { agentsDir, masterKey: MK };
const mode = (p) => fs.statSync(p).mode & 0o777;

// Guard rail: if any of these resolve under the real home, the suite is pointed at live keys.
ok('THE SANDBOX IS NOT THE OPERATOR’S ~/.handoff',
   !agentsDir.startsWith(path.join(os.homedir(), '.handoff'))
   && !masterKeyPath.startsWith(path.join(os.homedir(), '.handoff')));

// ── 1. THE MASTER KEY: opts BEATS env BEATS file, AND THE FILE IS CREATED 0600 ─────────────────────
{
  const injected = loadMasterKey({ masterKey: MK, masterKeyPath });
  ok('an injected Buffer is returned unchanged', Buffer.isBuffer(injected) && injected.equals(MK));
  ok('INJECTING A KEY DOES NOT CREATE A KEY FILE', !fs.existsSync(masterKeyPath));

  ok('a 64-char hex string decodes to the same 32 bytes',
     loadMasterKey({ masterKey: MK.toString('hex'), masterKeyPath }).equals(MK));
  ok('a base64 string decodes to the same 32 bytes',
     loadMasterKey({ masterKey: MK.toString('base64'), masterKeyPath }).equals(MK));
  ok('A KEY OF THE WRONG LENGTH IS REFUSED, not padded or truncated',
     await threw(() => loadMasterKey({ masterKey: Buffer.alloc(16).toString('base64'), masterKeyPath }),
                 /must be 32 bytes/));
  ok('...and the error says how many bytes it actually got',
     await threw(() => loadMasterKey({ masterKey: Buffer.alloc(16).toString('base64'), masterKeyPath }),
                 /got 16/));

  // env beats file, opts beats env.
  const envKey = crypto.randomBytes(32);
  const prev = process.env.HANDOFF_XMBL_MASTER_KEY;
  process.env.HANDOFF_XMBL_MASTER_KEY = envKey.toString('base64');
  try {
    ok('the env var is used when no key is injected',
       loadMasterKey({ masterKeyPath }).equals(envKey));
    ok('OPTS OUTRANK THE ENV VAR', loadMasterKey({ masterKey: MK, masterKeyPath }).equals(MK));
    ok('...and the env var still creates no file', !fs.existsSync(masterKeyPath));
  } finally {
    if (prev === undefined) delete process.env.HANDOFF_XMBL_MASTER_KEY;
    else process.env.HANDOFF_XMBL_MASTER_KEY = prev;
  }

  // First use with neither: the file is minted, 0600, and is stable across calls.
  const fileKeyPath = path.join(SANDBOX, 'minted', 'xmbl-master.key');
  const first = loadMasterKey({ masterKeyPath: fileKeyPath });
  ok('FIRST USE MINTS A MASTER KEY FILE', fs.existsSync(fileKeyPath));
  ok('...32 bytes of it', first.length === 32);
  ok('...AT MODE 0600 — nothing else on the box may read it', mode(fileKeyPath) === 0o600);
  ok('A SECOND CALL ADOPTS THE SAME KEY RATHER THAN MINTING A NEW ONE — a second key silently forks the box',
     loadMasterKey({ masterKeyPath: fileKeyPath }).equals(first));

  // A key file left world-readable is re-clamped on read, not merely tolerated.
  fs.chmodSync(fileKeyPath, 0o644);
  loadMasterKey({ masterKeyPath: fileKeyPath });
  ok('READING A LOOSE KEY FILE RE-CLAMPS IT TO 0600', mode(fileKeyPath) === 0o600);
}

// ── 2. THE ENVELOPE IS BOUND TO ITS AGENT — THE PROPERTY THE WHOLE SCHEME RESTS ON ────────────────
{
  const secret = 'a-mayo-secret-' + crypto.randomBytes(16).toString('hex');
  const env = encryptSecret(secret, MK, 'agent-a');

  ok('the envelope is self-describing', env.v === 1 && env.alg === 'AES-256-GCM' && env.kdf === 'HKDF-SHA256');
  ok('it carries a salt, an iv, a tag and ciphertext', !!(env.salt && env.iv && env.tag && env.ct));
  ok('THE PLAINTEXT IS NOWHERE IN THE ENVELOPE', !JSON.stringify(env).includes(secret));
  ok('the round trip returns the exact secret', decryptSecret(env, MK, 'agent-a') === secret);

  ok('AN ENVELOPE FOR ONE AGENT CANNOT BE DECRYPTED AS ANOTHER — the HKDF info and the GCM AAD both bind it',
     await threw(() => decryptSecret(env, MK, 'agent-b')));
  ok('...and not under a different master key either',
     await threw(() => decryptSecret(env, crypto.randomBytes(32), 'agent-a')));

  // Every field is authenticated: flipping any one of them must fail closed.
  const flip = (b64) => {
    const b = Buffer.from(b64, 'base64');
    b[0] ^= 0xff;
    return b.toString('base64');
  };
  for (const field of ['ct', 'tag', 'iv', 'salt']) {
    ok(`TAMPERING WITH \`${field}\` IS DETECTED, not decrypted into garbage`,
       await threw(() => decryptSecret({ ...env, [field]: flip(env[field]) }, MK, 'agent-a')));
  }

  // Two encryptions of one secret must differ — a fresh salt and iv each time.
  const e2 = encryptSecret(secret, MK, 'agent-a');
  ok('ENCRYPTING TWICE GIVES DIFFERENT CIPHERTEXT — the salt and iv are fresh, not fixed',
     e2.ct !== env.ct && e2.salt !== env.salt && e2.iv !== env.iv);
  ok('...and both still decrypt to the same secret', decryptSecret(e2, MK, 'agent-a') === secret);

  ok('a truncated ciphertext fails rather than returning a short secret',
     await threw(() => decryptSecret({ ...env, ct: Buffer.from(env.ct, 'base64').subarray(0, 4).toString('base64') }, MK, 'agent-a')));
  ok('an empty secret round-trips (a zero-length plaintext is still authenticated)',
     decryptSecret(encryptSecret('', MK, 'agent-a'), MK, 'agent-a') === '');
  ok('a unicode secret round-trips byte-exactly',
     decryptSecret(encryptSecret('鍵 🔑 clé', MK, 'agent-a'), MK, 'agent-a') === '鍵 🔑 clé');
}

// ── 3. agent_id IS A PATH SEGMENT, SO IT IS VALIDATED BEFORE IT TOUCHES THE FILESYSTEM ────────────
{
  const bad = ['../escape', 'a/b', '/abs', '.', '..', '', 'has space', 'semi;colon', 'tilde~', 'null\0byte'];
  let refused = 0;
  for (const id of bad) if (await threw(() => ensureAgentIdentity(id, OPTS), /invalid agent_id/)) refused++;
  ok(`EVERY TRAVERSAL-CAPABLE agent_id IS REFUSED (${refused}/${bad.length})`, refused === bad.length);

  let nonString = 0;
  for (const id of [null, undefined, 42, {}, []]) {
    if (await threw(() => ensureAgentIdentity(id, OPTS), /invalid agent_id/)) nonString++;
  }
  ok('a non-string agent_id is refused too', nonString === 5);

  ok('the read paths validate it as well, not just the write path',
     await threw(() => getPublicRecord('../escape', OPTS), /invalid agent_id/)
     && await threw(() => loadAgentIdentity('../escape', OPTS), /invalid agent_id/));

  ok('a legitimate id with dots, dashes and underscores is accepted',
     !(await threw(() => ensureAgentIdentity('agent.one-two_3', OPTS))));
}

// ── 4. ensureAgentIdentity IS CREATE-ONCE, 0600, AND REFUSES TO CLOBBER ──────────────────────────
{
  const id = 'keystore-suite-a';
  const r1 = await ensureAgentIdentity(id, OPTS);
  ok('the first call CREATES', r1.created === true);
  ok('it returns an address and a public key', !!r1.address && !!r1.public_key);
  ok('the file lands where the agentsDir says', r1.path === path.join(agentsDir, id, 'xmbl.json'));
  ok('THE KEYSTORE FILE IS MODE 0600', mode(r1.path) === 0o600);

  const r2 = await ensureAgentIdentity(id, OPTS);
  ok('THE SECOND CALL DOES NOT REGENERATE — an agent that loses its address loses its history',
     r2.created === false && r2.address === r1.address && r2.public_key === r1.public_key);

  const onDisk = JSON.parse(fs.readFileSync(r1.path, 'utf8'));
  ok('the record carries the agent_id it was created for', onDisk.agent_id === id);
  ok('...a version and a creation timestamp', onDisk.version === 1 && !!onDisk.created_at);
  ok('THE SECRET ON DISK IS AN ENVELOPE, NOT A KEY',
     typeof onDisk.secret_key_encrypted === 'object' && onDisk.secret_key_encrypted.alg === 'AES-256-GCM');
  ok('there is no plaintext secret field anywhere in the record',
     !('secret_key' in onDisk) && !('private_key' in onDisk) && !('privateKey' in onDisk));

  // The loaded identity must be the SAME key, and it must actually sign.
  const ident = await loadAgentIdentity(id, OPTS);
  ok('LOADING DECRYPTS BACK TO THE SAME PUBLIC KEY', ident.publicKey === r1.public_key);
  ok('...and to the same address', ident.address === r1.address);
  ok('THE DECRYPTED SECRET IS NOT ON DISK IN THE CLEAR',
     !fs.readFileSync(r1.path, 'utf8').includes(ident.privateKey));

  // A damaged record is a hard error. Overwriting it would destroy the only copy of the key.
  const brokenDir = path.join(SANDBOX, 'broken-agents');
  for (const [name, rec] of [['no public_key', { address: 'x', secret_key_encrypted: {} }],
                             ['no address', { public_key: 'x', secret_key_encrypted: {} }],
                             ['no secret', { public_key: 'x', address: 'x' }]]) {
    const f = path.join(brokenDir, 'damaged', 'xmbl.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(rec));
    const before = fs.readFileSync(f, 'utf8');
    ok(`A RECORD WITH ${name} IS A HARD ERROR`,
       await threw(() => ensureAgentIdentity('damaged', { agentsDir: brokenDir, masterKey: MK }),
                   /missing fields; refusing to overwrite/));
    ok(`...AND THE DAMAGED FILE IS LEFT EXACTLY AS IT WAS (${name})`, fs.readFileSync(f, 'utf8') === before);
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  }

  // A pre-existing keystore with loose permissions is clamped on the idempotent path.
  fs.chmodSync(r1.path, 0o644);
  await ensureAgentIdentity(id, OPTS);
  ok('A PRE-EXISTING KEYSTORE FILE LEFT WORLD-READABLE IS RE-CLAMPED TO 0600', mode(r1.path) === 0o600);
}

// ── 5. getPublicRecord RETURNS BROKER-SAFE FIELDS AND NOTHING ELSE ───────────────────────────────
// This is the function whose output is PUBLISHED. A leak here is a leak to everyone.
{
  const id = 'keystore-suite-b';
  const created = await ensureAgentIdentity(id, OPTS);
  const rec = getPublicRecord(id, OPTS);

  ok('it reports the agent id, the address and the public key',
     rec.agent_id === id && rec.address === created.address && rec.public_key === created.public_key);
  ok('IT RETURNS EXACTLY THREE FIELDS — nothing rides along',
     Object.keys(rec).sort().join() === 'address,agent_id,public_key');

  const ident = await loadAgentIdentity(id, OPTS);
  const serialized = JSON.stringify(rec);
  ok('THE SECRET IS NOT IN THE PUBLISHED RECORD', !serialized.includes(ident.privateKey));
  // Asserted on the KEYS, not on substrings: a base64 public key can contain any letter pair by chance,
  // and `serialized.includes('ct')` duly went red the first time a key happened to contain it. The claim
  // being made is "no envelope field rides along", and that is a statement about the record's shape.
  ok('...nor is any part of the encrypted envelope',
     ['secret_key_encrypted', 'salt', 'iv', 'tag', 'ct', 'created_at', 'version']
       .every((k) => !(k in rec)));

  ok('an agent with no keystore is an error, not an empty record',
     await threw(() => getPublicRecord('never-created', OPTS), /no xmbl.json/));
  ok('...and loading one is too',
     await threw(() => loadAgentIdentity('never-created', OPTS), /no xmbl.json/));
}

// ── 6. THE identity_path WRAPPERS BIND THE AAD TO THE <agent_id> SEGMENT, NOT TO ANY PARENT DIR ──
// The node config carries one `identity_path` string. The wrapper derives agent_id from it — and REQUIRES
// the `xmbl.json` filename, so the crypto AAD binds to the directory the operator intended and not to
// whatever a parent happens to be called.
{
  const idPath = path.join(SANDBOX, 'nodes', 'node-alpha', 'xmbl.json');
  const r = await ensureIdentityAtPath(idPath, { masterKey: MK });
  ok('ensureIdentityAtPath creates at exactly the path it was given',
     r.created === true && r.path === idPath && fs.existsSync(idPath));
  ok('...at mode 0600', mode(idPath) === 0o600);

  const again = await ensureIdentityAtPath(idPath, { masterKey: MK });
  ok('it is create-once, like the agent_id form', again.created === false && again.address === r.address);

  const loaded = await loadIdentityAtPath(idPath, { masterKey: MK });
  ok('LOADING BY PATH DECRYPTS THE SAME IDENTITY', loaded.publicKey === r.public_key);

  // The AAD is the DIRECTORY name, so the record is bound to `node-alpha`.
  const onDisk = JSON.parse(fs.readFileSync(idPath, 'utf8'));
  ok('the record is bound to the directory segment, which is the agent id', onDisk.agent_id === 'node-alpha');
  ok('DECRYPTING IT UNDER A DIFFERENT SEGMENT NAME FAILS',
     await threw(() => decryptSecret(onDisk.secret_key_encrypted, MK, 'node-beta')));

  // A path that is not <dir>/<agent_id>/xmbl.json must be refused, both ways.
  for (const bad of [path.join(SANDBOX, 'nodes', 'node-alpha', 'identity.json'),
                     path.join(SANDBOX, 'nodes', 'xmbl.JSON'),
                     path.join(SANDBOX, 'nodes', 'node-alpha')]) {
    ok(`A PATH THAT IS NOT .../xmbl.json IS REFUSED (${path.basename(bad)})`,
       await threw(() => ensureIdentityAtPath(bad, { masterKey: MK }), /must be a .*xmbl\.json/)
       && await threw(() => loadIdentityAtPath(bad, { masterKey: MK }), /must be a .*xmbl\.json/));
  }
  for (const empty of ['', '   ', null, undefined, 42]) {
    ok(`AN EMPTY identity_path IS AN ERROR, NOT A DEFAULT (${JSON.stringify(empty)})`,
       await threw(() => ensureIdentityAtPath(empty, { masterKey: MK }),
                   /identity_path is empty|must be a .*xmbl\.json/));
  }
}

// ── 7. TWO AGENTS ON ONE MASTER KEY ARE STILL CRYPTOGRAPHICALLY SEPARATE ─────────────────────────
// The master key is per-MACHINE. Separation between agents comes only from the HKDF info and the AAD, so
// it is worth proving at the file level rather than at the function level.
{
  const a = await ensureAgentIdentity('sep-a', OPTS);
  const b = await ensureAgentIdentity('sep-b', OPTS);
  ok('two agents get DIFFERENT identities', a.address !== b.address && a.public_key !== b.public_key);

  const recA = JSON.parse(fs.readFileSync(a.path, 'utf8'));
  ok('SWAPPING ONE AGENT’S ENVELOPE INTO THE OTHER’S SLOT DOES NOT YIELD A USABLE KEY',
     await threw(() => decryptSecret(recA.secret_key_encrypted, MK, 'sep-b')));

  // The real swap: move the whole file. ensureAgentIdentity returns it (the fields are present), but the
  // moment anything tries to USE the key, the binding refuses. Pinned because the returned `false` looks
  // like success.
  const swapDir = path.join(SANDBOX, 'swap');
  fs.mkdirSync(path.join(swapDir, 'sep-b'), { recursive: true });
  fs.copyFileSync(a.path, path.join(swapDir, 'sep-b', 'xmbl.json'));
  const swapped = await ensureAgentIdentity('sep-b', { agentsDir: swapDir, masterKey: MK });
  ok('a file swapped between agents still reports fields (the shape check cannot see the fraud)',
     swapped.created === false && swapped.address === a.address);
  ok('BUT LOADING IT FAILS — the AAD catches the swap at the only point that matters',
     await threw(() => loadAgentIdentity('sep-b', { agentsDir: swapDir, masterKey: MK })));
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
ok('the sandbox is cleaned up', !fs.existsSync(SANDBOX));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
