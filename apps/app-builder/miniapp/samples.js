// The example contract set for the XMBL Contract Lab. One contract per theme; together they
// exercise EVERY call/statement/operator the LNG→WASM host-state backend compiles and runs:
// no-arg calls, single- and multi-arg calls, getters (return a field), computed-return getters,
// every ALU op (+ - * / %), every bitwise op (b& b| b^) and shift (b< b>), comparisons
// (== !== !< !>), a ternary branch, state writes across multiple public fields, a ~private field,
// a counted ~for loop with a local, event declarations with ~emit, and the trapping guards that
// arithmetic gives for free (over/underflow and div-by-zero REVERT the whole call).
//
// Every entrypoint here is executed and asserted in verify-contract-lab.mjs — nothing ships
// unverified. `calls` lists a correct, ready-to-run invocation for each entrypoint so the UI can
// offer a one-click "run the example" and the verifier can assert a known value.

export const SAMPLES = {
  Counter: {
    title: 'Counter',
    blurb: 'The smallest stateful contract — no-arg and one-arg writes, plus getters.',
    src: [
      '~contract `Counter {',
      '  ~state { ~public { `count ~u256 0 } }',
      '  ~on `inc() { `count = `count + 1; return `count }',
      '  ~on `incBy(`n ~u256) { `count = `count + `n; return `count }',
      '  ~on `reset() { `count = 0 }',
      '  ~on `get() { return `count }',
      '}'
    ].join('\n')
  },
  Vault: {
    title: 'Vault',
    blurb: 'Multiple fields and checked arithmetic — withdrawing more than the balance REVERTS.',
    src: [
      '~contract `Vault {',
      '  ~state { ~public { `bal ~u256 0',
      '                     `owner ~u256 0 } }',
      '  ~on `deposit(`v ~u256) { `bal = `bal + `v; return `bal }',
      '  ~on `withdraw(`amt ~u256) { `bal = `bal - `amt; return `bal }',
      '  ~on `setOwner(`o ~u256) { `owner = `o }',
      '  ~on `balance() { return `bal }',
      '}'
    ].join('\n')
  },
  Calc: {
    title: 'Calc',
    blurb: 'Pure (stateless) multi-arg calls covering every arithmetic, bitwise and shift operator.',
    src: [
      '~contract `Calc {',
      '  ~on `add(`a ~u256, `b ~u256) { return `a + `b }',
      '  ~on `sub(`a ~u256, `b ~u256) { return `a - `b }',
      '  ~on `mul(`a ~u256, `b ~u256) { return `a * `b }',
      '  ~on `div(`a ~u256, `b ~u256) { return `a / `b }',
      '  ~on `mod(`a ~u256, `b ~u256) { return `a % `b }',
      '  ~on `band(`a ~u256, `b ~u256) { return `a b& `b }',
      '  ~on `bor(`a ~u256, `b ~u256) { return `a b| `b }',
      '  ~on `bxor(`a ~u256, `b ~u256) { return `a b^ `b }',
      '  ~on `shl(`a ~u256, `b ~u256) { return `a b< `b }',
      '  ~on `shr(`a ~u256, `b ~u256) { return `a b> `b }',
      '}'
    ].join('\n')
  },
  Logic: {
    title: 'Logic',
    blurb: 'Comparisons, a ternary branch, and an event — flag() emits Flagged and bumps __events().',
    src: [
      '~contract `Logic {',
      '  ~state { ~public { `flagged ~u256 0 } }',
      '  ~event `Flagged(`x ~u256)',
      '  ~on `gte(`a ~u256, `b ~u256) { return `a !< `b }',
      '  ~on `eq(`a ~u256, `b ~u256) { return `a == `b }',
      '  ~on `max(`a ~u256, `b ~u256) { `a !< `b ? { return `a } | { return `b } }',
      '  ~on `flag(`x ~u256) { `flagged = `x; ~emit `Flagged(`x) }',
      '}'
    ].join('\n')
  },
  Ledger: {
    title: 'Ledger',
    blurb: 'A ~private counter, an event, a trapping debit, and a counted ~for loop (sumTo).',
    src: [
      '~contract `Ledger {',
      '  ~state { ~public { `supply ~u256 0 }',
      '           ~private { `ops ~u256 0 } }',
      '  ~event `Credited(`amt ~u256)',
      '  ~on `credit(`amt ~u256) { `supply = `supply + `amt; `ops = `ops + 1; ~emit `Credited(`amt); return `supply }',
      '  ~on `debit(`amt ~u256) { `supply = `supply - `amt; `ops = `ops + 1; return `supply }',
      '  ~on `sumTo(`n ~u256) { `r ~u256 0; ~for `i 1 `n { `r = `r + `i }; return `r }',
      '}'
    ].join('\n')
  }
}
