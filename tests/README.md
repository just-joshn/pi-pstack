# Tests

`npm test` runs three gates in order:

1. `node tests/run-check-port.mjs` — native `check-port.mjs` over the published package files.
2. `node tests/conformance.mjs` — AGENTS.md style rules over `tests/`.
3. `vitest run` — the `unit` project in `tests/native/`.

```
npm test
npx vitest run --project unit
node tests/native-parity.mjs          # compare to ~/.pi/pstack when present
bun test skills/poteto-mode/scripts   # orch and watch-pr, needs bun
```

## Projects

| # | Project | Dir | What it proves | Needs |
| - | ------- | --- | -------------- | ----- |
| 0 | check-port (gate) | `tests/run-check-port.mjs` | Native port does not drift toward host-only tooling | node |
| 1 | conformance (gate) | `tests/conformance.mjs` | AGENTS.md rules over `tests/` | node |
| 2 | unit | `tests/native` | Slash rewrite, bundled agents, package `pi` manifest | node |
| 3 | scripts (opt-in) | `skills/poteto-mode/scripts` | `orch` and `watch-pr` bun:test suites | bun, git |

The native extensions, skills, and agents are the live Pi pstack surface. Do not restyle them to make a coverage number move. Prove behavior with check-port, native-parity, and the unit tests above.
