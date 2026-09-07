// e49408b7 type-scoped submit fix — the SECURITY INVARIANT pinned here (self-runnable: Identity only).
// core.submitTransaction routes `contentAddressed ? tx : signTransaction(tx)`. This module pins the half that
// MUST NOT weaken: signTransaction OVERWRITES `from` to the signer for NODE-AUTHORED txs, so verifyTransaction's
// derivedAddress===from sig-ownership fires (advisor's security constraint — an unconditional from-preserve was
// a regression). The CONTENT-ADDRESSED half (a type-6 whose from=[payer] is a mined body field is forwarded
// UNCHANGED + unsigned, and the validator accepts it) is proven by the cross-impl round-trip in the commit
// message (real submit-sign path -> feat/xmbl-chain-typeval validator, 6/6) + advisor's full-path verify.
// Run: node signtx-invariant.test.mjs
import { Identity } from './identity.js';
import assert from 'node:assert';

const node = await Identity.create();   // real MAYO keypair

// NODE-AUTHORED (string `from`, no xid): from OVERWRITTEN to the signer + signed — the invariant kept.
const signed = await node.signTransaction({ type: 'utxo', from: 'xmbSOMEONEelse', to: ['y'], amount: '1' });
assert.strictEqual(signed.from, node.address, 'node-authored: from OVERWRITTEN to the signer (sig-ownership invariant)');
assert.ok(typeof signed.sig === 'string' && signed.sig.length > 0, 'node-authored: signed');

// PROOF signTransaction mangles a content-addressed `from` -> core.submitTransaction MUST skip signing type-6
// (which it does; this asserts the reason the routing exists).
const mangled = await node.signTransaction({ type: 'tx', xid: '06abc', nonce: 1, chain: 'xmbl', from: ['xmbPAYER'], to: ['xmbPAYEE'], asset: 'USDC', amount: '1.50', seq: 0, prev: '', unspent: '' });
assert.strictEqual(mangled.from, node.address, 'signTransaction MANGLES a content-addressed from -> core routes type-6 AROUND it');

console.log('SIGN-TX INVARIANT: PASS — node-authored from-overwrite + sig kept; signing mangles a content-addressed from (why core.submitTransaction skips signing type-6).');
