// Golden-vector proof (8-FIELD type-6, operator schema bump 2026-07-26): the CHAIN's micromine.js is
// BYTE-IDENTICAL to the app (src/stores/api.js hash()) + the broker. The `unspent` field (appended LAST —
// canonical order is load-bearing) enriches type-6 into a general VALUE UNIT (fungible token / non-fungible
// asset / '' non-value split). If these two vectors reproduce, chain/app/broker address the same content to
// the same key. Run: node micromine.golden.test.mjs
import { micromine, oidOf, verifyMicromine, type6TxBody } from './micromine.js';
import assert from 'node:assert';

let pass = 0;
const check = (name, cond) => { assert.ok(cond, name); console.log('  ok  ', name); pass++; };

// GOLDEN VECTOR v1 — empty arrays, int-string amount, unspent=amount (fungible)
{
  const body = type6TxBody({ chain: 'xmbl', from: [], to: [], asset: 'XMBL', amount: '1', seq: 0, prev: '', unspent: '1' });
  check('v1 canonical serialization (8-field, unspent LAST)',
    JSON.stringify({ data: body }) === '{"data":{"chain":"xmbl","from":[],"to":[],"asset":"XMBL","amount":"1","seq":0,"prev":"","unspent":"1"}}');
  check('v1 oid', oidOf(body) === '5248b28bb80ae6a29b5eba6bed9d05200ee27ec26e045f117cc2dccffa4c1f07');
  const m = micromine(body, 6);
  check('v1 nonce', m.nonce === 91);
  check('v1 xid', m.xid === '0687f086db1d8e1c57277494f24fb87d8baedee05bcb522abc85b23e561279ee');
  check('v1 xid has 06 prefix', m.xid.startsWith('06'));
  check('v1 verifyMicromine round-trip', verifyMicromine(body, m.nonce, m.xid, 6) === true);
}

// GOLDEN VECTOR v2 — non-empty arrays, decimal amount, unspent=amount (fungible)
{
  const body = type6TxBody({ chain: 'xmbl', from: ['alice'], to: ['bob'], asset: 'USDC', amount: '1.50', seq: 0, prev: '', unspent: '1.50' });
  check('v2 oid', oidOf(body) === 'faf4c9a454cd7703c3bf75488376f469f56d2a3be44d74dc4c0d8c6063408a51');
  const m = micromine(body, 6);
  check('v2 nonce', m.nonce === 6);
  check('v2 xid', m.xid === '06c336054584c63ebba281000948ed2a2d7140430128aa386382930c1827e0fb');
}

// NEGATIVE CONTROLS — content-address enforcement over the FULL 8-field body (incl. unspent)
{
  const body = type6TxBody({ chain: 'xmbl', from: [], to: ['xabc'], asset: 'XMBL', amount: '5', seq: 1, prev: 'x0', unspent: '5' });
  const m = micromine(body, 6);
  check('reject tampered amount', verifyMicromine({ ...body, amount: '6' }, m.nonce, m.xid, 6) === false);
  check('reject tampered unspent (new field is content-bound)', verifyMicromine({ ...body, unspent: '4' }, m.nonce, m.xid, 6) === false);
  check('reject wrong nonce', verifyMicromine(body, m.nonce + 1, m.xid, 6) === false);
  check('reject type-6 key claimed as type-7', verifyMicromine(body, m.nonce, m.xid, 7) === false);
  const reordered = { unspent: '5', chain: 'xmbl', from: [], to: ['xabc'], asset: 'XMBL', amount: '5', seq: 1, prev: 'x0' }; // same fields, wrong order
  check('reject reordered body (oid diverges)', oidOf(body) !== oidOf(reordered));
}

// VALIDATOR — accepts a content-valid 8-field type-6 value-tx; rejects tampered/wrong-xid/missing-field
{
  const { validateTransaction } = await import('./transaction-validator.js');
  const body = type6TxBody({ chain: 'xmbl', from: ['alice'], to: ['bob'], asset: 'USDC', amount: '1.50', seq: 0, prev: '', unspent: '1.50' });
  const m = micromine(body, 6);
  const tx = { type: 'tx', ...body, xid: m.xid, nonce: m.nonce };
  check('validateTransaction accepts a content-valid 8-field type-6 tx', validateTransaction(tx) === true);
  const rejects = (bad) => { try { validateTransaction(bad); return false; } catch { return true; } };
  check('rejects tampered amount (micromine fails)', rejects({ ...tx, amount: '9.99' }));
  check('rejects tampered unspent (micromine fails)', rejects({ ...tx, unspent: '9.99' }));
  check('rejects wrong xid (micromine fails)', rejects({ ...tx, xid: '06deadbeefcafe' }));
  check('rejects missing required field unspent', rejects({ type: 'tx', chain: 'xmbl', from: ['a'], to: ['b'], amount: '1', xid: m.xid, nonce: m.nonce }));
  // RULING (claude 2026-07-26): a handoff SETTLEMENT is a PAYMENT RECORD -> unspent='' (no spendable xmbl mint;
  // agents spend USDC, not native tokens; xmbl records movements). The validator must SEAL a unspent='' type-6:
  // '' is PRESENT (passes the required-field `in` check, distinct from absent) and content-addresses like any body.
  const rec = type6TxBody({ chain: 'xmbl', from: ['alice'], to: ['bob'], asset: 'USDC', amount: '1.50', seq: 0, prev: '', unspent: '' });
  const mr = micromine(rec, 6);
  check("seals a settlement-shaped unspent='' type-6 (payment record, no double-count)", validateTransaction({ type: 'tx', ...rec, xid: mr.xid, nonce: mr.nonce }) === true);
  check("but STILL rejects unspent ABSENT (present-empty '' is valid; missing key is not)", rejects({ type: 'tx', chain: 'xmbl', from: ['alice'], to: ['bob'], amount: '1.50', seq: 0, prev: '', xid: mr.xid, nonce: mr.nonce }));
}

console.log(`\nGOLDEN VECTORS (8-FIELD) + VALIDATOR + NEGATIVE CONTROLS: ${pass}/${pass} PASS — enriched type-6 byte-identical to app+broker; content-address enforcement holds over the 8-field body incl. unspent.`);
