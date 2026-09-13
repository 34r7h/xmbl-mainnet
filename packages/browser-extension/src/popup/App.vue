<template>
  <div id="shell">
    <header class="head">
      <div class="brand">
        <svg class="xmbl-mark" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 943.339996338 933.169998169"><g><circle class="c" cx="470.859992981" cy="126.000003815" r="120.000017166"/><circle class="c" cx="245.470001221" cy="208.750003815" r="120.000005722"/><circle class="c" cx="126" cy="417.009986877" r="119.999988556"/><circle class="c" cx="168.349994659" cy="653.349990845" r="120.000005722"/><circle class="c" cx="352.709991455" cy="807.169998169" r="120"/><circle class="c" cx="592.809967041" cy="806.500015259" r="120"/><circle class="c" cx="776.309967041" cy="651.649978638" r="120"/><circle class="c" cx="817.339996338" cy="415.08000946" r="120.000011444"/><circle class="c" cx="696.709991455" cy="207.490005493" r="120"/></g><g><circle class="c" cx="391.179992676" cy="250.590011597" r="82.940002441"/><circle class="c" cx="262.970001221" cy="355.960006714" r="82.940002441"/><circle class="c" cx="232.5" cy="519.099990845" r="82.940002441"/><circle class="c" cx="314.010009766" cy="663.659988403" r="82.940002441"/><circle class="c" cx="469.369987488" cy="722.000015259" r="82.939990997"/><circle class="c" cx="625.889984131" cy="666.829971313" r="82.940002441"/><circle class="c" cx="710.329986572" cy="523.959976196" r="82.940002441"/><circle class="c" cx="683.170013428" cy="360.229995728" r="82.940002441"/><circle class="c" cx="557.129974365" cy="252.270004272" r="82.940002441"/></g><g><circle class="c" cx="473.570014954" cy="307.180007935" r="58.05999694" transform="translate(94.498982891 725.430254783) rotate(-80.782526715)"/><circle class="c" cx="364" cy="345.800003052" r="58.059997559"/><circle class="c" cx="304.899993896" cy="445.810012817" r="58.059997559"/><circle class="c" cx="323.910003662" cy="560.419998169" r="58.059997559"/><circle class="c" cx="412.139984131" cy="635.990005493" r="58.059997559"/><circle class="c" cx="528.300018311" cy="637.169998169" r="58.059997559"/><circle class="c" cx="618.050018311" cy="563.399978638" r="58.059997559"/><circle class="c" cx="639.379974365" cy="449.210014343" r="58.060009003"/><circle class="c" cx="582.319976807" cy="348.020004272" r="58.059997559"/></g></svg>
        <h1 class="title">XMBL <b>Console</b></h1>
      </div>
      <p class="sub">The whole xmbl stack in one surface — contracts, crypto host capabilities, wallet, node &amp; modules, config — on the same compiler, identity and ledger a node runs.</p>
    </header>

    <nav class="tabs" role="tablist">
      <button v-for="t in TABS" :key="t.id" class="tab" role="tab" :aria-selected="tab === t.id" :class="{ on: tab === t.id }" @click="tab = t.id">{{ t.label }}</button>
    </nav>

    <main class="body">
      <Contracts v-show="tab === 'contracts'" />
      <Crypto v-show="tab === 'crypto'" />
      <Wallet v-show="tab === 'wallet'" />
      <Node v-show="tab === 'node'" />
      <Config v-show="tab === 'config'" />
    </main>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import Contracts from './Contracts.vue'
import Crypto from './Crypto.vue'
import Wallet from './Wallet.vue'
import Node from './Node.vue'
import Config from './Config.vue'

// Contracts is the real, proven in-page surface (@xmbl/lng compile + node-parity id), so it leads.
// The rest surface the whole stack: crypto host caps, the wallet, the node & module map, and config.
const TABS = [
  { id: 'contracts', label: 'Contracts' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'wallet', label: 'Wallet' },
  { id: 'node', label: 'Node' },
  { id: 'config', label: 'Config' },
]
const tab = ref('contracts')
</script>

<!-- Global (unscoped): tokens + shared primitives, visible to every child component. -->
<style>
  #shell {
    --font: "Albert Sans", "Avenir Next", "Helvetica Neue", Arial, system-ui, sans-serif;
    --mono: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;

    --paper: oklch(97.8% 0 0);
    --paper-raised: oklch(99.5% 0 0);
    --paper-deep: oklch(95% 0 0);
    --ink: oklch(13% 0 0);
    --text: oklch(22% 0 0);
    --muted: oklch(46% 0 0);
    --faint: oklch(58% 0 0);
    --rule: oklch(13% 0 0 / .08);
    --rule-2: oklch(13% 0 0 / .14);

    --kinpaku: oklch(84% .19 80.46);
    --kinpaku-rich: oklch(77% .13 82);
    --kinpaku-deep: oklch(61% .085 78);
    --on-gold: oklch(14% .018 95);
    --accent-soft: oklch(77% .13 82 / .24);
    --accent-dim: oklch(77% .13 82 / .14);

    --patina: oklch(70% .12 188);
    --patina-ink: oklch(41% .11 190);

    --inst: oklch(24% 0 0);
    --inst-deep: oklch(17% 0 0);
    --inst-raised: oklch(31% 0 0);
    --inst-text: oklch(93% 0 0);
    --inst-muted: oklch(68% 0 0);
    --inst-rule: oklch(100% 0 0 / .12);

    --good: var(--patina);
    --good-ink: var(--patina-ink);
    --bad: oklch(64% .17 25);
    --bad-ink: oklch(52% .18 27);
    --bad-dim: oklch(64% .17 25 / .14);

    --r-sm: 3px;
    --r-md: 8px;
    --r-pill: 999px;

    --cap-lift: inset 0 1px 0 oklch(100% 0 0 / .9), 0 1px 0 oklch(13% 0 0 / .14), 0 2px 3px oklch(13% 0 0 / .08);
    --cap-press: inset 0 1px 2px oklch(13% 0 0 / .16);
    --track-recess: inset 0 1px 3px oklch(13% 0 0 / .14), inset 0 -1px 0 oklch(100% 0 0 / .7);

    --ease: cubic-bezier(.2, .8, .2, 1);
    --quick: .12s;

    width: 460px;
    box-sizing: border-box;
    font-family: var(--font);
    font-size: 14px;
    line-height: 1.5;
    color: var(--text);
    background: var(--paper);
    -webkit-font-smoothing: antialiased;
  }

  @media (prefers-color-scheme: dark) {
    #shell {
      --paper: oklch(19% 0 0);
      --paper-raised: oklch(23% 0 0);
      --paper-deep: oklch(15% 0 0);
      --ink: oklch(97% 0 0);
      --text: oklch(90% 0 0);
      --muted: oklch(68% 0 0);
      --faint: oklch(58% 0 0);
      --rule: oklch(100% 0 0 / .1);
      --rule-2: oklch(100% 0 0 / .16);
      --on-gold: oklch(14% .018 95);
      --patina-ink: oklch(72% .11 188);
      --cap-lift: inset 0 1px 0 oklch(100% 0 0 / .08), 0 1px 2px oklch(0% 0 0 / .4);
      --track-recess: inset 0 1px 3px oklch(0% 0 0 / .4), inset 0 -1px 0 oklch(100% 0 0 / .04);
    }
  }

  html, body { margin: 0; padding: 0; background: var(--paper); }
  #shell * { box-sizing: border-box; }

  .head { padding: 16px 18px 12px; border-bottom: 1px solid var(--rule); }
  .brand { display: flex; align-items: center; gap: 10px; }
  .xmbl-mark { width: 26px; height: 26px; flex: 0 0 auto; display: block; }
  /* monochrome, theme-aware: dark discs / paper separators on light; inverts in dark mode */
  .xmbl-mark .c { fill: var(--ink); stroke: var(--paper); stroke-width: 14px; stroke-miterlimit: 10; }
  .title { margin: 0; font-size: 1.25rem; font-weight: 400; letter-spacing: .01em; color: var(--ink); }
  .title b { font-weight: 700; }
  .sub { margin: 5px 0 0; font-size: .8125rem; line-height: 1.45; color: var(--muted); }

  .tabs { display: flex; gap: 2px; padding: 10px 18px 0; border-bottom: 1px solid var(--rule); }
  .tab {
    appearance: none; border: 0; background: transparent; cursor: pointer;
    font: inherit; font-weight: 600; font-size: .8125rem; color: var(--muted);
    padding: 8px 14px 10px; border-bottom: 2px solid transparent; margin-bottom: -1px;
    transition: color var(--quick) var(--ease), border-color var(--quick) var(--ease);
  }
  .tab:hover { color: var(--ink); }
  .tab.on { color: var(--ink); border-bottom-color: var(--kinpaku); }

  .body { padding: 16px 18px 20px; max-height: 520px; overflow-y: auto; }

  /* eyebrows / section labels */
  .eyebrow {
    font-family: var(--mono); font-size: .625rem; font-weight: 600; letter-spacing: .12em;
    text-transform: uppercase; color: var(--patina-ink);
  }
  .sec { margin-top: 18px; }
  .sec:first-child { margin-top: 0; }
  .sec-h { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
  .hint { font-size: .75rem; color: var(--faint); }

  /* buttons — physical cap-lift; primary is the gold LED, spent sparingly */
  .btn {
    appearance: none; font: inherit; font-weight: 600; font-size: .8125rem; cursor: pointer;
    color: var(--ink); background: var(--paper-raised); border: 1px solid var(--rule-2);
    border-radius: var(--r-sm); padding: 8px 13px; box-shadow: var(--cap-lift);
    transition: background var(--quick) var(--ease), box-shadow var(--quick) var(--ease), color var(--quick) var(--ease);
  }
  .btn:hover { background: var(--paper); }
  .btn:active { box-shadow: var(--cap-press); }
  .btn:disabled { opacity: .5; cursor: default; box-shadow: none; }
  .btn.primary { color: var(--on-gold); background: var(--kinpaku); border-color: var(--kinpaku-deep); }
  .btn.primary:hover { background: var(--kinpaku-rich); }
  .btn.sm { padding: 5px 9px; font-size: .75rem; }
  .btn.ghost { background: transparent; box-shadow: none; border-color: var(--rule-2); }
  .btn.danger { color: var(--bad-ink); border-color: var(--bad-dim); background: transparent; box-shadow: none; }
  .btn.danger:hover { background: var(--bad-dim); }

  /* inputs — genuine form fields, track-recessed (a 1-2 field form is not an input wall) */
  .in, .sel, textarea.code {
    font: inherit; font-size: .8125rem; color: var(--ink); background: var(--paper-raised);
    border: 1px solid var(--rule-2); border-radius: var(--r-sm); padding: 8px 10px;
    box-shadow: var(--track-recess); width: 100%; box-sizing: border-box;
    transition: border-color var(--quick) var(--ease), box-shadow var(--quick) var(--ease);
  }
  .in:focus, .sel:focus, textarea.code:focus {
    outline: none; border-color: var(--kinpaku-deep); box-shadow: var(--track-recess), 0 0 0 3px var(--accent-soft);
  }
  .sel { cursor: pointer; }
  textarea.code { font-family: var(--mono); font-size: .75rem; line-height: 1.55; min-height: 132px; resize: vertical; white-space: pre; }

  .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 9px; }
  .field label { font-size: .75rem; color: var(--muted); }

  .row { display: flex; gap: 8px; align-items: center; }
  .row.wrap { flex-wrap: wrap; }
  .spread { display: flex; gap: 8px; align-items: center; justify-content: space-between; }

  /* status line — replaces every blocking alert() */
  .status { margin-top: 10px; font-size: .8125rem; border-radius: var(--r-sm); padding: 8px 11px; border: 1px solid var(--rule-2); }
  .status.ok { color: var(--good-ink); border-color: oklch(70% .12 188 / .3); background: oklch(70% .12 188 / .1); }
  .status.bad { color: var(--bad-ink); border-color: var(--bad-dim); background: var(--bad-dim); }
  .status.info { color: var(--muted); background: var(--paper-deep); }

  .note { font-size: .75rem; line-height: 1.5; color: var(--faint); margin: 10px 0 0; }
  .mono { font-family: var(--mono); }
  .code-block {
    font-family: var(--mono); font-size: .6875rem; line-height: 1.5; color: var(--inst-text);
    background: var(--inst-deep); border-radius: var(--r-md); padding: 11px; margin: 8px 0 0;
    overflow-x: auto; white-space: pre; word-break: normal;
  }
</style>
