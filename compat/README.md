# compat

The compatibility matrix for the pinned Cursor pstack port.

## Source of truth

`spec/contracts/*.tsv` is the behavioral source of truth, together with
`spec/surfaces.tsv`, `spec/mechanisms.tsv`, and `upstream.lock.json`. Nothing here
replaces the ledger.

## Generated

`compat/parity.json` and `compat/capabilities.json` are generated projections of
the ledger and must not be hand-edited. `parity.json` holds one row per ledger
row plus one inventory row per in-scope artifact of the pinned upstream tree, so a
pin bump that adds an artifact fails the inventory test. `compat:check` fails when
either file is stale.

    npm run compat:generate

## Authored

`compat/dependencies.json` is authored by hand and schema-checked by
`compat:check`. It lists every row of `spec/mechanisms.tsv` exactly once with a
disposition of reproduced, prerequisite, hosted, or exception. No mechanism
outside that table may appear.

## Check

    npm run compat:check    # schema, staleness, ledger coverage, vocabulary, dependencies
    npm run compat:gate     # completion gate: spec-check, compat:check, npm test, parity:check

The inventory layer of `npm test` (`tests/inventory/`) reads `parity.json` and the
pinned clone and fails on an uncovered upstream artifact. Populate the clone with
`npm run parity:check` when it is missing.
