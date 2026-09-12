// Hand-encoded WASM UTXO contracts, shared by the XCL conformance suite and the cross-node
// reproduction test so a single definition drives both (no drifting duplicate bytecode). These
// call the UTXO value ABI (xmbl_input_*/xmbl_utxo_*) exactly as a compiled contract would; they
// are emitted structurally so the mixed i32/i64 host signatures and data segments stay legible.
const HDR = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const uleb = (n) => { const o = []; let v = n >>> 0; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; o.push(b); } while (v); return o; };
const sleb = (n) => { const o = []; let more = true; while (more) { let b = n & 0x7f; n >>= 7; if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40))) more = false; else b |= 0x80; o.push(b); } return o; };
const wstr = (s) => [...uleb(s.length), ...[...s].map((c) => c.charCodeAt(0))];
const sect = (id, payload) => [id, ...uleb(payload.length), ...payload];
const wvec = (items) => [...uleb(items.length), ...items.flat()];
const ftype = (params, results) => [0x60, ...uleb(params.length), ...params, ...uleb(results.length), ...results];
const I32 = 0x7f, I64 = 0x7e;
const impFn = (mod, name, t) => [...wstr(mod), ...wstr(name), 0x00, ...uleb(t)];

/** Recipient the TRANSFER/MINT contracts create their output to (a data-segment string). */
export const RECIP = 'BENEF01';
const RPTR = 256;

// TRANSFER: enumerate input 0 (xmbl_input_id), spend it for its amount, create ONE output to a
// fixed recipient of exactly that amount → conserves by construction, for ANY input id.
export const TRANSFER = Uint8Array.from([
  ...HDR,
  ...sect(1, wvec([
    ftype([], [I32]),                     // t0 input_count       ()->i32
    ftype([I32, I32], [I32]),             // t1 input_id          (i32,i32)->i32
    ftype([I32, I32], [I64]),             // t2 amount/spend      (i32,i32)->i64
    ftype([I32, I32, I64], [I64]),        // t3 create            (i32,i32,i64)->i64
    ftype([], []),                        // t4 transfer          ()->()
  ])),
  ...sect(2, wvec([
    impFn('env', 'xmbl_input_count', 0),
    impFn('env', 'xmbl_input_id', 1),
    impFn('env', 'xmbl_utxo_amount', 2),
    impFn('env', 'xmbl_utxo_spend', 2),
    impFn('env', 'xmbl_utxo_create', 3),
  ])),
  ...sect(3, wvec([[4]])),                 // functions: transfer -> t4 (func idx 5)
  ...sect(5, wvec([[0x01, ...uleb(1), ...uleb(2)]])), // memory: 1 page min, 2 max (bounded)
  ...sect(7, wvec([
    [...wstr('memory'), 0x02, ...uleb(0)],
    [...wstr('transfer'), 0x00, ...uleb(5)],
  ])),
  ...sect(10, wvec([(() => {
    const body = [
      0x41, ...sleb(0), 0x41, ...sleb(0), 0x10, ...uleb(1), 0x21, ...uleb(1), // len = input_id(0, ptr0)
      0x41, ...sleb(0), 0x20, ...uleb(1), 0x10, ...uleb(3), 0x21, ...uleb(0), // amt = spend(ptr0, len)
      0x41, ...sleb(RPTR), 0x41, ...sleb(RECIP.length), 0x20, ...uleb(0), 0x10, ...uleb(4), 0x1a, // create(recip, len, amt); drop
      0x0b,
    ];
    const locals = [...uleb(2), ...uleb(1), I64, ...uleb(1), I32]; // local0 i64 amt, local1 i32 len
    const entry = [...locals, ...body];
    return [...uleb(entry.length), ...entry];
  })()])),
  ...sect(11, wvec([[0x00, 0x41, ...sleb(RPTR), 0x0b, ...wstr(RECIP)]])), // data: recipient @ RPTR
]);

// MINT: create an output WITHOUT spending any input → out>in. A contract that fabricates value;
// the host must refuse it and move nothing.
export const MINT = Uint8Array.from([
  ...HDR,
  ...sect(1, wvec([ftype([I32, I32, I64], [I64]), ftype([], [])])), // t0 create, t1 mint
  ...sect(2, wvec([impFn('env', 'xmbl_utxo_create', 0)])),          // func idx 0
  ...sect(3, wvec([[1]])),                                          // mint -> t1 (func idx 1)
  ...sect(5, wvec([[0x01, ...uleb(1), ...uleb(2)]])),
  ...sect(7, wvec([[...wstr('memory'), 0x02, ...uleb(0)], [...wstr('mint'), 0x00, ...uleb(1)]])),
  ...sect(10, wvec([(() => {
    const body = [0x41, ...sleb(RPTR), 0x41, ...sleb(RECIP.length), 0x42, 0xE4, 0x00, 0x10, ...uleb(0), 0x1a, 0x0b]; // create(recip,len,i64 100); drop
    const entry = [...uleb(0), ...body];
    return [...uleb(entry.length), ...entry];
  })()])),
  ...sect(11, wvec([[0x00, 0x41, ...sleb(RPTR), 0x0b, ...wstr(RECIP)]])),
]);
