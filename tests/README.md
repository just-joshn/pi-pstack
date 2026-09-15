# Tests

One entry point. `node tests/runner.mjs` runs every layer in order, bootstraps peer resolution
first, and prints a per-layer summary.

```
npm test                  # same as: node tests/runner.mjs
npm run test:unit         # one layer
npm run test:bootstrap    # create the peer symlink farm only
```

## Layers

| # | Name | Dir | What it proves | Needs |
| - | ---- | --- | -------------- | ----- |
| 1 | unit | `tests/layers/01-unit` | Pure functions with no Pi dependency | node |
| 2 | integration | `tests/layers/02-integration` | Extension registration, lifecycle, tools, session behavior in-process | node |
| 3 | smoke | `tests/layers/03-smoke` | `pi --no-extensions -e ./extensions/index.ts` loads and exits 0 | `pi` |
| 4 | reload | `tests/layers/04-reload` | Live `/reload` in a real TUI re-reads the extension | `pi`, `tmux` |
| 5 | rpc | `tests/layers/05-rpc` | Dialogs, notifications, commands over the RPC protocol | `pi` |
| 6 | tui | `tests/layers/06-tui` | Rendered TUI output and key handling via tmux panes | `pi`, `tmux` |
| 7 | third-party | `tests/layers/07-third-party` | Opt-in `pi-test-harness` compatibility gate (see its README) | `bun` for the live check |
| legacy | legacy | `extensions/test`, `skills/poteto-mode/scripts` | The pre-existing suites, wrapped verbatim | `bun` |

Layer 7 is opt-in. With no `--layer`, the runner prints `SKIP Layer 7 (third-party)` and keeps
going. `npm test` never touches the network.

## Flags

```
node tests/runner.mjs --layer N|legacy|all   # one layer, all layers, or the legacy commands
node tests/runner.mjs --list                 # layers, files, requires, legacy commands
node tests/runner.mjs --dry-run              # print what would run, run nothing
node tests/runner.mjs --verbose              # inherit child stdio instead of piping
node tests/runner.mjs --bail                 # stop at the first failing layer
node tests/runner.mjs tests/layers/01-unit/heartbeat-coalesce.test.ts   # positional files bypass the layer loop
```

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | Every selected layer passed (skips are not failures) |
| 1 | A test or legacy command failed, or a layer hit its timeout (180s default, 900s for layer 7) |
| 2 | Unknown option or unknown layer selector |
| 3 | A required external tool is missing (`pi`, `tmux`) |
| 4 | Peer bootstrap failed before any test ran |

## Peer bootstrap

The repo ships no `node_modules`. Extension code imports `@earendil-works/pi-*` and `typebox`, so
every run starts by symlinking those five peers from the installed Pi 0.85.1 into
`node_modules/` (`tests/support/link-peers.mjs`, gitignored, idempotent).

- `npm run test:bootstrap` runs the link step alone.
- `PI_INSTALL_DIR=/path/to/@earendil-works/pi-coding-agent` overrides the host install when the
  auto-detection guesses wrong.
- The link step refuses to replace a real file or directory at a link path. If a caller has their
  own `node_modules` content there, remove it or set `PI_INSTALL_DIR`.

## Requirements

- node 24.20 or newer. Layer 1 and layer 2 `.ts` files run under node's default type stripping.
- `pi` 0.85.1 on `PATH` for layers 3 through 6, plus the peers above.
- `bun` for the legacy `skills/poteto-mode/scripts` suite, and for the layer 7 live check.
- `tmux` for layers 4 and 6.

## Hermeticity

- Layers 2 through 6 run against temp `HOME`, `PI_CODING_AGENT_DIR`, and cwd directories, with
  `PI_OFFLINE=1` and `PI_SKIP_VERSION_CHECK=1`. Nothing reads or writes the real `~/.pi`.
- No ports are bound, so layers can run in parallel with each other.
- tmux panes inherit the tmux server environment, so those tests pass env explicitly in the
  spawned command.
- Layer 7 defaults to a skipped test. It installs packages and imports third-party code only under
  `PSTACK_VERIFY_PI_TEST_HARNESS=1`.

## Not part of `npm test`

`npm run parity:check` is a separate gate over the ported skills, agents, and docs. Its first run
clones the upstream repo, so it stays out of the test suite. Run it on its own before a release.
