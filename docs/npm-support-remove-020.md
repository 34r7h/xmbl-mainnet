# npm support request — remove 0.2.0 from eight @xmbl packages

File at https://www.npmjs.com/support (Other → package removal). Paste the body below.

## Status

0.2.0 was published in error on 2026-09-21T03:06:14Z across twelve `@xmbl/*` packages. Four were
removed with `npm unpublish` on 2026-09-22:

    cli  contracts  core  lng

Eight refuse, every attempt, with:

    405 Method Not Allowed - PUT https://registry.npmjs.org/@xmbl%2f<pkg>/-rev/<rev>
    You can no longer unpublish this package.
    Failed criteria:
      has dependent packages in the registry

    consensus  cubic-ledger  identity  networking  simulator
    state-machine  storage-compute  zero-knowledge

The dependents npm names are this same project's own release line — `@xmbl/cli`,
`@xmbl/contracts`, `@xmbl/core`, `@xmbl/consensus`, `@xmbl/cubic-ledger` and
`@xmbl/storage-compute` all depend on packages in that list — so the criterion cannot be cleared without unpublishing the shipping release. Two full
passes in dependency order (dependents before dependencies) changed nothing.

## Request body

> All twelve `@xmbl/*` packages had a 0.2.0 published by mistake on 2026-09-21. 0.2.0 is not part
> of this project's version line — the line is 0.1.x and the current release is 0.1.17, which
> every package's `latest` dist-tag points to. 0.2.0 is nonetheless the highest version number, so
> anything resolving by version list rather than dist-tag picks up code that was never released.
>
> I removed 0.2.0 from `@xmbl/cli`, `@xmbl/contracts`, `@xmbl/core` and `@xmbl/lng`. The remaining
> eight return 405 "has dependent packages in the registry": `@xmbl/consensus`,
> `@xmbl/cubic-ledger`, `@xmbl/identity`, `@xmbl/networking`, `@xmbl/simulator`,
> `@xmbl/state-machine`, `@xmbl/storage-compute`, `@xmbl/zero-knowledge`.
>
> The only dependents are my own 0.1.x packages, which are the current release and must stay. No
> third party depends on 0.2.0 — it was published and deprecated within a day.
>
> Please remove version 0.2.0 only from those eight packages. Every other version must stay.
> I am the sole owner (npm user `34r7h`).

## What is NOT a path (settled 2026-09-22)

`npm unpublish` from CI on the release token. Run
[35702814104](https://github.com/34r7h/xmbl-mainnet/actions/runs/35702814104) tried all eight in
dependency order, three passes, and every one returned:

    npm error 403 Forbidden - PUT https://registry.npmjs.org/@xmbl%2f<pkg>/-rev/<rev>
    Granular access tokens that bypass two-factor authentication may not perform this action.
    https://gh.io/npm-gat-bypass2fa-deprecation

npm does not accept a 2FA-bypassing token for unpublish at all, so no token this repo can hold
will do it. The workflow was deleted rather than left to be re-run. Unpublish is therefore
interactive-only: `scripts/purge-020-webauth.sh` from the owner's terminal, one browser approval
per package, before the window closes at **2026-09-24T03:06:14Z**.

One thing the 405s have never explained: the 0.1.x line pins `^0.1.12`/`^0.1.16`, and a caret range
on a 0.x version cannot match 0.2.0 — so the shipping release is not a dependent *of 0.2.0*. The
only ranges that match it are 0.2.0's own: consensus -> identity, cubic-ledger; cubic-ledger ->
identity; storage-compute -> identity; the other five depend on nothing. If npm's criterion is
version-level, six of the eight are removable today and the earlier failures were a dependents
index that had not caught up with cli/contracts/core/lng going away minutes before. If it is
package-level, none are and support is the only route. One interactive pass settles it.

## If npm declines

0.2.0 stays as semver-max on the eight. The deprecation string is then the only signal, and
`.github/workflows/tombstone-020.yml` keeps it pointing at the live `latest` after every release.
Re-run that workflow whenever the version line moves.
