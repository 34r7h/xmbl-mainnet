// Starter contracts offered in the extension's Create panel. Faithful subset of the miniapp's
// verified sample set (apps/app-builder/miniapp/samples.js) — each is real LNG the @xmbl/lng
// host-state backend compiles, deploys and runs in-page. Kept small (the miniapp is the full lab).

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
      '}'
    ].join('\n')
  }
}
