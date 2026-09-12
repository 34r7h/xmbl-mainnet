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

/** Recipient the value contracts create their outputs to (a data-segment string). */
export const RECIP = 'BENEF01';
const RPTR = 256;
/** The fee TRANSFER_FEE holds back from the input (its single output = input − FEE). */
export const FEE = 10;
/** The first slice SPLIT sends; its second output is (input − PART), so the two sum to the input. */
export const PART = 40;

// Every value contract here declares the SAME five UTXO imports in the SAME order, so a body can
// call them by a fixed function index: 0 input_count, 1 input_id, 2 utxo_amount, 3 utxo_spend,
// 4 utxo_create. The entrypoint is func index 5. Emitting the shared preamble once is what keeps
// the four contracts from drifting apart at the ABI boundary.
const UTXO_TYPES = sect(1, wvec([
  ftype([], [I32]),               // t0 input_count   ()->i32
  ftype([I32, I32], [I32]),       // t1 input_id      (i32,i32)->i32
  ftype([I32, I32], [I64]),       // t2 utxo_amount   (i32,i32)->i64
  ftype([I32, I32], [I64]),       // t3 utxo_spend    (i32,i32)->i64
  ftype([I32, I32, I64], [I64]),  // t4 utxo_create   (i32,i32,i64)->i64
  ftype([], []),                  // t5 entrypoint    ()->()
]));
const UTXO_IMPORTS = sect(2, wvec([
  impFn('env', 'xmbl_input_count', 0),
  impFn('env', 'xmbl_input_id', 1),
  impFn('env', 'xmbl_utxo_amount', 2),
  impFn('env', 'xmbl_utxo_spend', 3),
  impFn('env', 'xmbl_utxo_create', 4),
]));
const F_COUNT = 0, F_ID = 1, F_SPEND = 3, F_CREATE = 4, F_ENTRY = 5;

// A value contract: the shared 5-import preamble, one ()->() entrypoint (func idx 5), a bounded
// 1..2-page memory, the recipient string in a data segment at RPTR, and a caller-supplied body.
const valueContract = (name, localDecls, body) => Uint8Array.from([
  ...HDR,
  ...UTXO_TYPES,
  ...UTXO_IMPORTS,
  ...sect(3, wvec([[5]])),                              // functions: entrypoint -> t5
  ...sect(5, wvec([[0x01, ...uleb(1), ...uleb(2)]])),   // memory: 1 page min, 2 max (bounded)
  ...sect(7, wvec([
    [...wstr('memory'), 0x02, ...uleb(0)],
    [...wstr(name), 0x00, ...uleb(F_ENTRY)],
  ])),
  ...sect(10, wvec([(() => {
    const entry = [...localDecls, ...body];
    return [...uleb(entry.length), ...entry];
  })()])),
  ...sect(11, wvec([[0x00, 0x41, ...sleb(RPTR), 0x0b, ...wstr(RECIP)]])), // data: recipient @ RPTR
]);

// locals: local0 i64 (an amount accumulator), local1 i32 (a byte length) — every single-input body.
const LOCALS_AMT_LEN = [...uleb(2), ...uleb(1), I64, ...uleb(1), I32];
// The single-input prologue: len = input_id(0, ptr0); amt = spend(ptr0, len) → local0 = amt.
const SPEND_INPUT_0 = [
  0x41, ...sleb(0), 0x41, ...sleb(0), 0x10, ...uleb(F_ID), 0x21, ...uleb(1),   // len = input_id(0, ptr0)
  0x41, ...sleb(0), 0x20, ...uleb(1), 0x10, ...uleb(F_SPEND), 0x21, ...uleb(0), // amt = spend(ptr0, len)
];

// TRANSFER: spend input 0, create ONE output to RECIP of exactly that amount → conserves by
// construction, for ANY input id. When two inputs are staged it spends only input 0, leaving the
// other still spendable — the property that makes a partial spend safe.
export const TRANSFER = valueContract('transfer', LOCALS_AMT_LEN, [
  ...SPEND_INPUT_0,
  0x41, ...sleb(RPTR), 0x41, ...sleb(RECIP.length), 0x20, ...uleb(0), 0x10, ...uleb(F_CREATE), 0x1a, // create(recip, len, amt); drop
  0x0b,
]);

// TRANSFER_FEE: spend input 0, create ONE output of (amt − FEE); the FEE is withheld, not created.
// A correct call therefore conserves only when opts.fee === FEE — the load-bearing test of the
// `fee` term in ContractHost's conservation check (sumIn === sumOut + fee).
export const TRANSFER_FEE = valueContract('transfer', LOCALS_AMT_LEN, [
  ...SPEND_INPUT_0,
  0x41, ...sleb(RPTR), 0x41, ...sleb(RECIP.length), 0x20, ...uleb(0), 0x42, ...sleb(FEE), 0x7d, 0x10, ...uleb(F_CREATE), 0x1a, // create(recip, len, amt-FEE); drop
  0x0b,
]);

// SPLIT: spend input 0, create TWO outputs — PART and (amt − PART) — that sum to the input. A real
// change/split transfer; exercises the multi-output side of conservation (sumOut over > 1 output).
export const SPLIT = valueContract('transfer', LOCALS_AMT_LEN, [
  ...SPEND_INPUT_0,
  0x41, ...sleb(RPTR), 0x41, ...sleb(RECIP.length), 0x42, ...sleb(PART), 0x10, ...uleb(F_CREATE), 0x1a, // create(recip, len, PART); drop
  0x41, ...sleb(RPTR), 0x41, ...sleb(RECIP.length), 0x20, ...uleb(0), 0x42, ...sleb(PART), 0x7d, 0x10, ...uleb(F_CREATE), 0x1a, // create(recip, len, amt-PART); drop
  0x0b,
]);

// CONSOLIDATE: n = input_count(); loop spending EVERY presented input, summing amounts; create ONE
// output of the total. Exercises xmbl_input_count (its return drives the loop bound), multi-input
// spending, and a WASM loop — the "combine N utxos into one" contract, conserving for any n.
export const CONSOLIDATE = valueContract(
  'transfer',
  [...uleb(2), ...uleb(1), I64, ...uleb(3), I32], // local0 i64 total; local1..3 i32 n, i, len
  [
    0x10, ...uleb(F_COUNT), 0x21, ...uleb(1),                                        // n = input_count()
    0x02, 0x40,                                                                      // block
    0x03, 0x40,                                                                      //   loop
    0x20, ...uleb(2), 0x20, ...uleb(1), 0x4e, 0x0d, ...uleb(1),                      //     if i >= n: br 1 (exit block)
    0x20, ...uleb(2), 0x41, ...sleb(0), 0x10, ...uleb(F_ID), 0x21, ...uleb(3),       //     len = input_id(i, ptr0)
    0x41, ...sleb(0), 0x20, ...uleb(3), 0x10, ...uleb(F_SPEND),                      //     amt = spend(ptr0, len)
    0x20, ...uleb(0), 0x7c, 0x21, ...uleb(0),                                        //     total += amt
    0x20, ...uleb(2), 0x41, ...sleb(1), 0x6a, 0x21, ...uleb(2),                      //     i += 1
    0x0c, ...uleb(0),                                                                //     br 0 (continue loop)
    0x0b,                                                                            //   end loop
    0x0b,                                                                            // end block
    0x41, ...sleb(RPTR), 0x41, ...sleb(RECIP.length), 0x20, ...uleb(0), 0x10, ...uleb(F_CREATE), 0x1a, // create(recip, len, total); drop
    0x0b,                                                                            // end function
  ],
);

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
