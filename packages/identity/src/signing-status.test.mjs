// THE DISCRIMINATOR FOR "NODE IS UP AND PUBLISHES NO CHAIN BLOCK".
// A node attaches its signed statement only when address && publicKey && privateKey are all present, and the
// broker builds xmbl.chain solely from a verified statement — dropping the block entirely when there is none.
// So a verify-only identity produces a node that reports up, answers `chain`, and publishes nothing, with no
// operator-visible reason. MEASURED 2026-09-16: 3 of the 4 live coordinators on the network were in that
// state and telling them apart required a shell on each box.
import { test } from 'node:test';
import assert from 'node:assert';
import { Identity } from './identity.js';

test('a full keypair reports can_sign true and names nothing missing', async () => {
  const id = await Identity.create();
  const s = id.signingStatus();
  assert.strictEqual(s.can_sign, true);
  assert.deepStrictEqual(s.missing, []);
  assert.strictEqual(s.verify_only, false);
  assert.ok(s.address && s.address.startsWith('xmb'));
});

test('a verify-only identity names the missing field instead of failing silently', async () => {
  const full = await Identity.create();
  const vo = Identity.fromPublicKey(full.publicKey);
  const s = vo.signingStatus();
  assert.strictEqual(s.can_sign, false);
  assert.deepStrictEqual(s.missing, ['privateKey'], 'must name the field, not just say no');
  assert.strictEqual(s.verify_only, true);
  assert.strictEqual(s.address, full.address, 'it still knows which node it is — that is what makes it diagnosable');
});

test('signingStatus never returns key material', async () => {
  const id = await Identity.create();
  const blob = JSON.stringify(id.signingStatus());
  assert.ok(!blob.includes(id.privateKey), 'private key must not appear');
  assert.ok(!blob.includes(id.publicKey), 'public key must not appear');
});
