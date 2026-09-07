// Crypto/geometry stdlib tests: the xmbl.* reference implementations (decision 4)
// that lower to the XCL host imports (xmbl_verkle_*, xmbl_cubic_sig_verify,
// xmbl_mayo_verify, xmbl_lwe_decrypt, xmbl_coord_send).
import { run } from './lng.js';
function exec(src) { let b = ''; run(src, { write: s => (b += s) }); return b; }

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };
const eqOut = (name, src, want) => { let g; try { g = exec(src); } catch (e) { g = 'ERR:' + e.message; } ok(name + (g === want ? '' : ` (want ${JSON.stringify(want)} got ${JSON.stringify(g)})`), g === want); };

// geometry — canonical origin (face 1, position 4) is (0,0,0)
eqOut('geo.coord origin', "`c `xmbl.geo.coord(1, 4)\n~p `c.x\n~p `c.y\n~p `c.z", '0\n0\n0\n');
eqOut('geo.coord face2 pos0', "`c `xmbl.geo.coord(2, 0)\n~p `c.x\n~p `c.y\n~p `c.z", '-1\n1\n1\n');

// cubic curve from 3 non-collinear points
eqOut('cubic.curve non-singular', "`c `xmbl.cubic.curve((`x 0,`y 0,`z 0),(`x 1,`y 0,`z 0),(`x 0,`y 1,`z 0))\n~p `c.nonSingular", '~t\n');
eqOut('cubic.curve collinear flagged', "`c `xmbl.cubic.curve((`x 0,`y 0,`z 0),(`x 1,`y 1,`z 1),(`x 2,`y 2,`z 2))\n~p `c.collinear", '~t\n');

// Cubic-SIG: valid, tampered, and geometric replay
const SIG = "`sk 'secret'\n`pk `xmbl.cubic.pk(`sk)\n`co (`x 1,`y 0,`z 2)\n`sig `xmbl.cubic.sign('hello', `sk, `co)\n";
eqOut('cubic-sig verifies', SIG + "~p `xmbl.cubic.verify('hello', `sig, `pk, `co)", '~t\n');
eqOut('cubic-sig rejects tampered msg', SIG + "~p `xmbl.cubic.verify('HELLO', `sig, `pk, `co)", '~f\n');
eqOut('cubic-sig rejects wrong pk', SIG + "~p `xmbl.cubic.verify('hello', `sig, `xmbl.cubic.pk('other'), `co)", '~f\n');
eqOut('cubic-sig rejects replay to other coords', SIG + "~p `xmbl.cubic.verify('hello', `sig, `pk, (`x 2,`y 2,`z 2))", '~f\n');

// MAYO PQ signature
eqOut('mayo verifies', "`pk `xmbl.mayo.pk('alice')\n`s `xmbl.mayo.sign('m', 'alice')\n~p `xmbl.mayo.verify('m', `s, `pk)", '~t\n');
eqOut('mayo rejects tampered', "`pk `xmbl.mayo.pk('alice')\n`s `xmbl.mayo.sign('m', 'alice')\n~p `xmbl.mayo.verify('m2', `s, `pk)", '~f\n');

// PQ-Cubic-LWE KEM roundtrip
eqOut('lwe roundtrip', "`pk `xmbl.lwe.pk('k')\n`ct `xmbl.lwe.encrypt('topsecret', `pk)\n~p `xmbl.lwe.decrypt(`ct, 'k')", 'topsecret\n');
ok('lwe ciphertext hides plaintext', !exec("`pk `xmbl.lwe.pk('k')\n~p `xmbl.lwe.encrypt('topsecret', `pk)").includes('topsecret'));

// Verkle host imports + moving root
eqOut('verkle set/get', "`xmbl.verkle.set('bal', 100)\n~p `xmbl.verkle.get('bal')", '100\n');
eqOut('verkle missing → ~n', "~p `xmbl.verkle.get('nope')", '~n\n');
ok('verkle root moves on write', exec("`a `xmbl.verkle.set('x',1)\n~p `a").trim() !== exec("`a `xmbl.verkle.set('x',1)\n`b `xmbl.verkle.set('y',2)\n~p `b").trim());

// Coordinator channel (xmbl_coord_send)
eqOut('coord send + log', "`xmbl.coord.send('agent7', 'PAUSE')\n`xmbl.coord.send('agent9', 'RESUME')\n~p `xmbl.coord.log()", "('agent7', 'agent9')\n");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
