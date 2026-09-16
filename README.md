# pi-pstack

Native [Pi](https://pi.dev) package porting [Cursor pstack](https://github.com/cursor/plugins/tree/main/pstack) (v0.15.2) as a **local Pi twin**.

**Parity target: pstack 0.15.2 @ `5bf2b1544db739998121a306340631963c2ff3de`** (the normative pin in [`upstream.lock.json`](./upstream.lock.json); `port/upstream.json` is the machine-consumed copy). The lock file records that this revision is content-verified equivalent to `c1c0a32802223f4be824112dd83d33ad29a8b26c`: zero commits touch `pstack/` between the two, and the `pstack/` tree SHA is identical at both. Every non-excluded ledger row is `VERIFIED` with a proof that runs in `npm test`, and every row carries one DoD class. `node spec/spec-check.mjs --require-complete` and `npm run spec:gate` are the release gates; the class split and the Cursor-side comparison procedure live in [`spec/SPEC.md`](./spec/SPEC.md) and [`spec/DIFFERENTIAL.md`](./spec/DIFFERENTIAL.md).

This is **not** Cursor-equivalence theater: skill/playbook *files* match upstream, and extensions implement the closest executable Pi-native behavior.

**Content parity is machine-checked.** Every file under `skills/`, `agents/`, `automations/`, and `docs/` is `apply(declared Cursor→Pi bindings, upstream pstack@v0.15.2)`. `npm run parity:check` fails on any drift, any unmigrated Cursor mechanism, any unknown `pstack_*` tool, or any dead `scripts/...` path. 103 of 153 upstream files are byte-identical; 48 differ only where a binding names a Cursor mechanism; 2 whole-mechanism files are declared overrides: each override's must list pins named upstream sections, the leftover scan rejects Cursor mechanisms, and the override is hand-maintained and reviewed. See [port/README.md](./port/README.md).

**Status is not kept in this file.** The live contract and per-obligation ledger are [`spec/SPEC.md`](./spec/SPEC.md) and [`spec/contracts/`](./spec/contracts/). The coverage command is `npm run spec:check`. [PARITY.md](./PARITY.md) is the historical snapshot.

**Parity matrix.** The generated compatibility matrix and the completion report are [`compat/REPORT.md`](./compat/REPORT.md), generated from `compat/parity.json`. Regenerate with `npm run compat:report`; `npm run compat:gate` fails when the report is stale.

**Hosted capabilities.** The capabilities that need hosted infrastructure, their environment variables, and their local twins are in [`docs/HOSTED.md`](./docs/HOSTED.md).

if you want to go fast, go deep first. pstack helps you write less, but higher quality code — rigorous agent workflows you can parallelize with confidence.

## Install

### Prerequisites

- **bun** `>=1.0.0` on `PATH`, the `engines` requirement in [`package.json`](./package.json). The four `pstack_babysit` `watch-pr-*` recipes spawn `skills/poteto-mode/scripts/watch-pr/watch-pr` (shebang `#!/usr/bin/env bun`), and `skills/poteto-mode/scripts/orch/orch.ts` does the same. Without bun the first `pstack_babysit` call fails its `bun --version` precheck with a message naming the missing binary.
- **gh** on `PATH` for `pstack_babysit` and `pstack_ship`; the `gh-checks-watch` and `gh-view-json` recipes call it directly.
- **pi** on `PATH` for `pi install`, and **npm** to run the repo scripts.

From a local checkout (this package):

```bash
pi install /absolute/path/to/pi-pstack
# or project-local:
pi install -l ./pi-pstack
```

Once published / pushed to git:

```bash
pi install git:github.com/<org>/pi-pstack
# or
pi install npm:pi-pstack
# scoped (future):
pi install npm:@just-joshn/pi-pstack
```

Try without installing:

```bash
pi -e /absolute/path/to/pi-pstack
```

### Verify

```bash
npm run compat:gate        # the single completion gate
node spec/spec-check.mjs   # ledger coverage and integrity
npm run compat:check       # parity matrix schema, staleness, and dependency coverage
npm run parity:check       # content parity against the pinned upstream tree
npm run test:hosted        # hosted worker and benny service tests
```

## Parity check (contributors)

```bash
npm run spec:check     # structural ledger check over spec/
npm run spec:gate      # the 100 percent completion gate
npm run parity:check   # ported tree == upstream + declared bindings; tools/scripts resolve
npm run parity:sync    # regenerate the ported tree after an upstream bump
npm run test:differential  # execute the pinned reference and the ported twin on identical fixtures
npm run test:acceptance    # drive the representative workflows through the real handlers
npm run test:coverage      # merged coverage over extensions/ and services/; fails under 80 percent branch or function
```

The pinned upstream commit is in `port/upstream.json`. Never hand-edit a ported file: a legitimate platform difference belongs in `port/bindings/`, and everything else belongs upstream.

## Testing

One entry point runs every default project plus the gates that precede them:

```bash
npm test                       # typecheck + compat/spec/conformance gates, then vitest run
npx vitest run --project unit  # one project
npm run test:list              # projects and test files Vitest will collect
```

| Project | Proves |
|---------|--------|
| conformance (gate) | AGENTS.md rules over project-owned code (`extensions/`, `tests/`, `port/`): file and function size, nesting depth, no `console.log`, no in-place mutation, no empty catch, no secret patterns. The byte-pinned ported tree reports warn-only via `npm run conformance -- --all` |
| unit | pure extension functions with no Pi dependency |
| integration | extension registration, lifecycle events, tool interception, and session behavior through the public SDK + faux provider |
| smoke | the real `pi --no-extensions -e ./extensions/index.ts` load, with a broken-extension negative control |
| reload | `.pi/extensions/` + `/reload` in a real tmux TUI re-reads an edited extension |
| rpc | dialogs, notifications, and status over the RPC protocol (`/setup-pstack` select → confirm → notify) |
| tui | rendered TUI output and key-driven commands in a tmux pane |
| third-party | opt-in `pi-test-harness` compatibility gate (`npm run test:third-party`); never on the network by default |
| user-journeys | user-perspective journeys over the fake Pi host; gate is all critical journeys or 80% of the runtime behavior inventory |
| inventory | docs, port bindings, and root artifacts match the pinned upstream |
| hosted | the worker and benny services on a real loopback `http.Server` |
| acceptance | representative workflows driven through the real extension handlers |
| extensions | hermetic checks for skill commands, sticky input, and the spawn/orchestrate seams |
| scripts | the ported `watch-pr` and `orch` test suites, bound from bun:test to Vitest |
| differential (`npm run test:differential`) | the pinned upstream executables and the ported twin on identical fixtures |
| audit (`npm run test:audit`) | the audit work-list predicates over gates, docs, and security guards |

Tests are hermetic (temp `HOME` and agent dirs, `PI_OFFLINE=1`, no ports) and need `pi` on PATH, plus `tmux` for the reload and tui projects and `bun` for the scripts and differential suites. Projects and their requirements live in `tests/registry.mjs`; `vitest.config.ts` builds them into Vitest projects. `npm run parity:check` stays a separate gate because its first run clones upstream. Full matrix, flags, and exit codes: [`tests/README.md`](./tests/README.md).

## Quick start

1. `pi install` this package.
2. Optional: `/setup-pstack` to write `~/.pi/agent/pstack-models.json` (per-role models; concrete skill defaults, not inherit-only).
3. `/poteto-mode` or `/skill:poteto-mode` for sticky poteto-mode.
4. Use skills via `/skill:<name>` (e.g. `/skill:how`, `/skill:arena`, `/skill:interrogate`).

## Tools (extensions)

| Tool | Purpose |
|------|---------|
| `pstack_spawn` | One isolated Pi child (`role`: poteto-agent / comment-sicko / investigator / general). Background **omit→true** (sync needs `background: false`); resume via `resumeSessionDir` / `resumeJobId` → `--session-dir` + `--continue`/`-c` |
| `pstack_jobs` | List / status / await / abort\|cancel detached background spawn jobs (surfaces `sessionDir` for resume) |
| `pstack_swarm` | N parallel workers → one report |
| `pstack_arena` | N candidates (+ optional cross-judge) for arena pick/graft |
| `pstack_loop` | Heartbeat / settle / watcher / **dynamic** (settle+watcher) wakes |
| `pstack_deslop` | Diff slop scan with severity + line samples |
| `pstack_control_cli` | CLI/TUI proof capture |
| `pstack_control_ui` | HTTP UI probe (+ browser MCP for full drives; HTTP-only otherwise) |
| `pstack_sessions` | List/grep Pi sessions for recall |
| `pstack_babysit` | gh / watch-pr PR watch |
| `pstack_ship` | gh stack-aware land helper |
| `pstack_decision_log` | Append `decisions.tsv` rows (show-me-your-work) |
| `pstack_worktree` | Create/list git worktrees for isolated writes |

Cursor `Task` / `subagent_type` map to these tools. Built-in Pi tools remain `read` / `write` / `edit` / `bash`. Parallel fleets use **local** `pstack_spawn` + `pstack_worktree` (not Cursor cloud VMs).

### Child cwd containment

`pstack_spawn` and `pstack_task` accept a `cwd` and a `resumeSessionDir`. Both are resolved through `realpath` and must stay inside the workspace root (the parent tool's cwd); the same rule keeps `pstack_decision_log` writes under `.pi`. A path that escapes through a symlink or an absolute path is refused with an error naming the requested path and the resolved location. For an intentional second workspace, set `PSTACK_ALLOWED_CWD` to a `path.delimiter`-separated root list; that escape hatch applies to spawn cwd and `resumeSessionDir`, never to the decision log.

## Commands

- `/poteto-mode` [task] — sticky poteto-mode on (+ optional task)
- `/poteto-mode-off` — sticky off
- `/pstack` [task] — alias / help
- `/setup-pstack` — write model role config
- `/pstack-gates` — pre-ship gate reminder

Per-skill slash aliases are generated extension commands in `extensions/commands/skill-commands.ts`, registered for every skill whose name is not reserved.

## Honesty / known gaps

Host ceilings and exclusions are recorded in [`spec/SPEC.md`](./spec/SPEC.md) section 4.

**Not supported** (one-line): Cursor plugin marketplace · Automations Slack bus · cloud agent VMs · full Electron/IDE control-ui · Grok Bot `update_state` / secret-request cards.

## Layout

```
pi-pstack/
  package.json          # keywords: ["pi-package"], pi: { extensions, skills }
  LICENSE, NOTICE
  README.md, CHANGELOG.md, PARITY.md
  spec/                 # contract, ledger, checker
  extensions/           # TypeScript (index + subagents, orchestration, models, …)
  skills/               # all upstream skills (adapted bindings)
  agents/               # poteto-agent + comment-sicko (reference prompts)
  docs/guide/           # upstream guide (lightly adapted)
```

## Shipping (v1)

GitHub (`gh`) only. Origin/Graphite optional where noted in playbooks; no Graphite required.

## Attribution

Original pstack © Lauren Tan (MIT). This port adapts platform bindings for Pi; see NOTICE and PARITY.md.
