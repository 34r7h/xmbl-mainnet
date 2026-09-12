<template>
  <div id="shell">
    <header class="head">
      <h1 class="title">XMBL <b>Wallet</b></h1>
      <p class="sub">A wallet & contract client for xmbl — built on the same compiler and content-addressed identity a node runs.</p>
    </header>

    <nav class="tabs" role="tablist">
      <button class="tab" role="tab" :aria-selected="tab === 'contracts'" :class="{ on: tab === 'contracts' }" @click="tab = 'contracts'">Contracts</button>
      <button class="tab" role="tab" :aria-selected="tab === 'wallet'" :class="{ on: tab === 'wallet' }" @click="tab = 'wallet'">Wallet</button>
    </nav>

    <main class="body">
      <Contracts v-show="tab === 'contracts'" />
      <Wallet v-show="tab === 'wallet'" />
    </main>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import Contracts from './Contracts.vue'
import Wallet from './Wallet.vue'

// Contracts is the real, proven surface (in-page @xmbl/lng compile + node-parity id), so it leads.
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
