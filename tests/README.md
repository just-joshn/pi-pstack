# Tests

Vitest 5 is the only test runner. `npm test` runs the static gates first, then `vitest run` over
every default project. `tests/registry.mjs` is the single manifest: `vitest.config.ts` turns each
non-opt-in entry into a Vitest project, and `spec/spec-check.mjs` reads the same file to know which
test files a ledger row may reference.

```
npm test                       # typecheck + compat/spec/conformance gates, then vitest run
npx vitest run --project unit  # one project
npm run test:list              # projects and test files Vitest will collect
npx vitest run tests/layers/01-unit/heartbeat-coalesce.test.ts   # one file (or any path filter)
npx vitest run --bail          # stop at the first failing test
```

## Projects

| # | Project | Dir | What it proves | Needs |
| - | ------- | --- | -------------- | ----- |
| 0 | conformance (gate) | `tests/conformance.mjs` | AGENTS.md rules over `extensions/`, `tests/`, `port/`: file/function size, nesting, console.log, in-place mutation, empty catch, secrets. The parity-pinned ported tree reports warn-only (`--all`) | node |
| 1 | unit | `tests/layers/01-unit` | Pure functions with no Pi dependency | node |
| 2 | integration | `tests/layers/02-integration` | Extension registration, lifecycle, tools, session behavior in-process | node |
| 3 | smoke | `tests/layers/03-smoke` | `pi --no-extensions -e ./extensions/index.ts` loads and exits 0 | `pi` |
| 4 | reload | `tests/layers/04-reload` | Live `/reload` in a real TUI re-reads the extension | `pi`, `tmux` |
| 5 | rpc | `tests/layers/05-rpc` | Dialogs, notifications, commands over the RPC protocol | `pi` |
| 6 | tui | `tests/layers/06-tui` | Rendered TUI output and key handling via tmux panes | `pi`, `tmux` |
| 7 | third-party | `tests/layers/07-third-party` | Opt-in `pi-test-harness` compatibility gate (see its README) | `bun` |
| 8 | user-journeys | `tests/layers/08-user-journeys` | User-perspective journeys through the fake Pi host, gated as all-critical-journeys or 80% of the runtime behavior inventory | node |
| 9 | inventory | `tests/inventory` | Docs, port bindings, and root artifacts match the pinned upstream | node |
| 10 | hosted | `tests/hosted` | The worker and benny services over real loopback HTTP | node |
| 11 | acceptance | `tests/acceptance` | Representative workflows through the real extension handlers | node |
| 12 | extensions | `extensions/test` | Skill commands, sticky input, and the spawn/orchestrate seams | node |
| 13 | scripts | `skills/poteto-mode/scripts` | The ported `watch-pr` and `orch` suites, bound from bun:test to Vitest | `git`, `bun` |
| 14 | differential | `tests/differential` | The pinned upstream executables and the ported twin on identical fixtures | `git`, `bun` |
| 15 | audit | `tests/audit` | The audit work-list predicates over gates, docs, and security guards | node |

Projects 7, 14, and 15 are opt-in: they install packages, clone upstream, or track known-red
findings, so they live in `vitest.opt-in.config.ts` and never run under a plain `vitest run`.

```
npm run test:third-party
npm run test:differential
npm run test:audit
```

`test:differential` exits 1 on any behavioral difference (one known difference today: the
`worktree-audit` column for a recently-chatted worktree). `test:audit` is a work list; a FAIL there
is a finding, not a broken suite.

## Running one project

```
npm run test:unit          # vitest run --project unit
npm run test:integration
npm run test:smoke
npm run test:reload
npm run test:rpc
npm run test:tui
npm run test:journeys
npm run test:inventory
npm run test:hosted
npm run test:acceptance
npm run test:extensions
npm run test:scripts
npm run test:coverage:unit         # unit floor over extensions/**
npm run test:coverage:integration  # integration floor over the extension entry points
npm run test:coverage:e2e          # e2e floor over services/**
npm run test:coverage:all          # full run: aggregate and per-file floors
npm run test:coverage              # all four floors in sequence
```

## Coverage floors

`npm run test:coverage` enforces four floors, each scoped to the code its tier owns.

| Gate | Scope | Floor |
| ---- | ----- | ----- |
| unit | `extensions/**` | 80% branches |
| integration | `extensions/index.ts`, `extensions/*/index.ts`, `extensions/commands/skill-commands.ts` | 80% branches |
| e2e | `services/**` | 80% branches |
| full run | `extensions/**` and `services/**` | aggregate 80% branches and functions, plus 80% branches and functions per file |

Every project imports `extensions/index.ts`, so an unscoped per-tier run scores each tier against the whole tree. Under that denominator the integration and e2e tiers would have to reproduce the unit suite's branch matrix, including internal error paths their surfaces cannot reach, so each tier is scoped to the code it owns instead. The unit and integration scopes overlap on the extension entry points on purpose. That code is verified at two levels, first as a unit and then through the extension boundary. The integration floor measures those entry-point files, not every file an integration test touches.

The smoke, reload, rpc, and tui projects run `pi` in a child process, and Vitest's v8 provider instruments only the worker process, so those projects contribute no in-process coverage. They stay in the e2e tier run and remain functional gates.

One measurement caveat. A test that loads an extension through `withSession` exercises it through Pi's own TypeScript loader, while a test that imports the same file directly exercises Vitest's transform. Both copies map to one source path, and the merged V8 branch counts can under-report when both run in the same tier. The clearest case is `extensions/companions/index.ts`, which reads 81.13% in a single-file run and 46.22% in the merged integration tier. The floors are set below the merged readings, so the artifact lowers the number rather than hiding a gap. Treat a per-file jump or drop that only appears in the merged run as this artifact before chasing it as a regression.

Or call Vitest directly. `--project` accepts a name, a glob, or a `!name` exclusion.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | Every selected project passed |
| 1 | A test, gate, or project failed; a layer exceeded its per-test timeout; or a global setup check failed |
| 2 | Vitest CLI misuse (unknown option, unknown project) |

A missing external tool (`pi`, `tmux`, `git`, `bun`) fails in `globalSetup` with the tool named,
before any worker starts. Vitest reports it as a project-level error and exits 1.

## Peer bootstrap

The repo ships no `node_modules`. Extension code imports `@earendil-works/pi-*` and `typebox`, so
`tests/support/vitest.global-setup.mjs` symlinks those five peers from the installed Pi 0.85.1 into
`node_modules/` before the first worker spawns (idempotent).

- `npm run test:bootstrap` runs the link step alone.
- `PI_INSTALL_DIR=/path/to/@earendil-works/pi-coding-agent` overrides the host install when the
  auto-detection guesses wrong.
- The link step refuses to replace a real file or directory at a link path. If a caller has their
  own `node_modules` content there, remove it or set `PI_INSTALL_DIR`.

## Requirements

- node 24.20 or newer. TypeScript test files run through Vite's transform, not node's type stripping.
- `pi` 0.85.1 on `PATH` for the smoke, reload, rpc, and tui projects, plus the peers above.
- `tmux` for the reload and tui projects.
- `bun` for the scripts project (the `orch` CLI runs under Bun, as upstream does) and the opt-in
  third-party and differential suites.

## Hermeticity

- Every project runs in a fork with `isolate: true`, so `process.chdir` and env mutations stay in
  one file's process.
- Layers 2 through 6 run against temp `HOME`, `PI_CODING_AGENT_DIR`, and cwd directories, with
  `PI_OFFLINE=1` and `PI_SKIP_VERSION_CHECK=1`. Nothing reads or writes the real `~/.pi`.
- No ports are bound except ephemeral loopback listeners in the hosted tests.
- The third-party and differential suites install or clone only when explicitly invoked.

## Not part of `npm test`

- `npm run parity:check` is a separate gate over the ported skills, agents, and docs. Its first run
  clones the upstream repo, so it stays out of the test suite. Run it on its own before a release.
- `npm run test:differential`, `npm run test:third-party`, and `npm run test:audit`.
- `npm run test:coverage` is the same suite plus coverage instrumentation.
