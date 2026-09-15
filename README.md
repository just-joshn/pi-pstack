# pi-pstack

Native [Pi](https://pi.dev) package porting [Cursor pstack](https://github.com/cursor/plugins/tree/main/pstack) (v0.15.2) as a **local Pi twin**.

**Parity target: pstack 0.15.2 @ `c1c0a32802223f4be824112dd83d33ad29a8b26c`** (pinned in `port/upstream.json`). Every ledger row is `VERIFIED` with a proof that runs in `npm test`, and every row carries one DoD class. `node spec/spec-check.mjs --require-complete` and `npm run spec:gate` are the release gates; the class split and the Cursor-side comparison procedure live in [`spec/SPEC.md`](./spec/SPEC.md) and [`spec/DIFFERENTIAL.md`](./spec/DIFFERENTIAL.md).

This is **not** Cursor-equivalence theater: skill/playbook *files* match upstream, and extensions implement the closest executable Pi-native behavior.

**Content parity is machine-checked.** Every file under `skills/`, `agents/`, `automations/`, and `docs/` is `apply(declared Cursor→Pi bindings, upstream pstack@v0.15.2)`. `npm run parity:check` fails on any drift, any unmigrated Cursor mechanism, any unknown `pstack_*` tool, or any dead `scripts/...` path. 103 of 153 upstream files are byte-identical; 48 differ only where a binding names a Cursor mechanism; 2 whole-mechanism files are declared overrides: each override's must list pins named upstream sections, the leftover scan rejects Cursor mechanisms, and the override is hand-maintained and reviewed. See [port/README.md](./port/README.md).

**Status is not kept in this file.** The live contract and per-obligation ledger are [`spec/SPEC.md`](./spec/SPEC.md) and [`spec/contracts/`](./spec/contracts/). The coverage command is `npm run spec:check`. [PARITY.md](./PARITY.md) is the historical snapshot.

if you want to go fast, go deep first. pstack helps you write less, but higher quality code — rigorous agent workflows you can parallelize with confidence.

## Install

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

## Parity check (contributors)

```bash
npm run spec:check     # structural ledger check over spec/
npm run spec:gate      # the 100 percent completion gate
npm run parity:check   # ported tree == upstream + declared bindings; tools/scripts resolve
npm run parity:sync    # regenerate the ported tree after an upstream bump
```

The pinned upstream commit is in `port/upstream.json`. Never hand-edit a ported file: a legitimate platform difference belongs in `port/bindings/`, and everything else belongs upstream.

## Testing

One entry point runs seven layers plus the pre-existing suites:

```bash
npm test                          # layers 0-6 + legacy; layer 7 is opt-in
node tests/runner.mjs --layer 2   # one layer
node tests/runner.mjs --list      # layers, files, requirements
```

| Layer | Proves |
|-------|--------|
| 0 conformance | AGENTS.md rules over project-owned code (`extensions/`, `tests/`, `port/`): file and function size, nesting depth, no `console.log`, no in-place mutation, no empty catch, no secret patterns. The byte-pinned ported tree reports warn-only via `npm run conformance -- --all` |
| 1 unit | pure extension functions with no Pi dependency |
| 2 integration | extension registration, lifecycle events, tool interception, and session behavior through the public SDK + faux provider |
| 3 smoke | the real `pi --no-extensions -e ./extensions/index.ts` load, with a broken-extension negative control |
| 4 reload | `.pi/extensions/` + `/reload` in a real tmux TUI re-reads an edited extension |
| 5 rpc | dialogs, notifications, and status over the RPC protocol (`/setup-pstack` select → confirm → notify) |
| 6 tui | rendered TUI output and key-driven commands in a tmux pane |
| 7 third-party | opt-in `pi-test-harness` compatibility gate; skipped by default, never on the network |
| legacy | `npm run test:extensions` and the upstream bun:test suite, wrapped verbatim |

Tests are hermetic (temp `HOME` and agent dirs, `PI_OFFLINE=1`, no ports) and need `pi` on PATH, plus `tmux` for layers 4 and 6. `npm run parity:check` stays a separate gate because its first run clones upstream. Full matrix, flags, and exit codes: [`tests/README.md`](./tests/README.md).

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
