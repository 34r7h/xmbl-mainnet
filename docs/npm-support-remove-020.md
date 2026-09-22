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

The dependents are this same project's own current release line — `@xmbl/cli@0.1.16`,
`@xmbl/contracts@0.1.16`, `@xmbl/core@0.1.16`, `@xmbl/consensus@0.1.16`,
`@xmbl/cubic-ledger@0.1.16` and `@xmbl/storage-compute@0.1.16` all depend on packages in that
list — so the criterion cannot be cleared without unpublishing the shipping release. Two full
passes in dependency order (dependents before dependencies) changed nothing.

## Request body

> All twelve `@xmbl/*` packages had a 0.2.0 published by mistake on 2026-09-21. 0.2.0 is not part
> of this project's version line — the line is 0.1.x and the current release is 0.1.16, which
> every package's `latest` dist-tag points to. 0.2.0 is nonetheless the highest version number, so
> anything resolving by version list rather than dist-tag picks up code that was never released.
>
> I removed 0.2.0 from `@xmbl/cli`, `@xmbl/contracts`, `@xmbl/core` and `@xmbl/lng`. The remaining
> eight return 405 "has dependent packages in the registry": `@xmbl/consensus`,
> `@xmbl/cubic-ledger`, `@xmbl/identity`, `@xmbl/networking`, `@xmbl/simulator`,
> `@xmbl/state-machine`, `@xmbl/storage-compute`, `@xmbl/zero-knowledge`.
>
> The only dependents are my own 0.1.16 packages, which are the current release and must stay. No
> third party depends on 0.2.0 — it was published and deprecated within a day.
>
> Please remove version 0.2.0 only from those eight packages. Every other version must stay.
> I am the sole owner (npm user `34r7h`).

## If npm declines

0.2.0 stays as semver-max on the eight. The deprecation string is then the only signal, and
`.github/workflows/tombstone-020.yml` keeps it pointing at the live `latest` after every release.
Re-run that workflow whenever the version line moves.
