# pi-pstack

Native [Pi](https://pi.dev) package porting [Cursor pstack](https://github.com/cursor/plugins/tree/main/pstack) (v0.15.2) as a **local Pi twin**.

This is **not** Cursor-equivalence theater: skill/playbook *files* match upstream, and extensions implement the closest executable Pi-native behavior.

**Content parity is machine-checked.** Every file under `skills/`, `agents/`, `automations/`, and `docs/` is `apply(declared Cursor→Pi bindings, upstream pstack@v0.15.2)`. `npm run parity:check` fails on any drift, any unmigrated Cursor mechanism, any unknown `pstack_*` tool, or any dead `scripts/...` path. 104 of 153 upstream files are byte-identical; 47 differ only where a binding names a Cursor mechanism; 2 whole-mechanism files are declared overrides with their non-Cursor sections pinned verbatim. See [port/README.md](./port/README.md).

**Local-scope scorecard** (after close-orch-p0/p1/p1b — see [PARITY.md](./PARITY.md)): **EQUIVALENT** sticky / Task-spawn (Cap2) / loop / worktrees / ship / models / recall / readonly; **PARTIAL** deslop only (honest residual, off the user's orch bar); **NOT** cloud agents, marketplace, Automations/Slack, Grok Bot cards. Cap2 resume = `--session-dir` + `--continue`/`-c` (Pi `continueRecent`); background omit→true; concurrency 8; swarm/arena = intentional sync gather.

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
npm run parity:check   # ported tree == upstream + declared bindings; tools/scripts resolve
npm run parity:sync    # regenerate the ported tree after an upstream bump
```

The pinned upstream commit is in `port/upstream.json`. Never hand-edit a ported file: a legitimate platform difference belongs in `port/bindings.mjs`, and everything else belongs upstream.

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

Slash prompt aliases under `prompts/` expand common short names.

## Honesty / known gaps

See **[PARITY.md](./PARITY.md) → Behavioral scorecard (12 capabilities)** for the Verifier-aligned summary. Artifact counts (ported/rewritten) are not runtime equivalence. Highest-leverage twins: Cap2 local-Task spawn (omit→true bg, `--continue` resume, jobs, concurrency 8), `pstack_loop` dynamic mode, worktree fleets, auto-readonly comment-sicko/investigator, gh shipping tools. **deslop** stays PARTIAL; Benny under `automations/benny/` is a manual twin (**NOT** on the local orch bar — no Automations Slack bus).

**Not supported** (one-line): Cursor plugin marketplace · Automations Slack bus · cloud agent VMs · full Electron/IDE control-ui · Grok Bot `update_state` / secret-request cards.

## Layout

```
pi-pstack/
  package.json          # keywords: ["pi-package"], pi: { extensions, skills, prompts }
  LICENSE, NOTICE
  README.md, CHANGELOG.md, PARITY.md
  extensions/           # TypeScript (index + subagents, orchestration, models, …)
  skills/               # all upstream skills (adapted bindings)
  prompts/              # slash aliases
  agents/               # poteto-agent + comment-sicko (reference prompts)
  docs/guide/           # upstream guide (lightly adapted)
```

## Shipping (v1)

GitHub (`gh`) only. Origin/Graphite optional where noted in playbooks; no Graphite required.

## Attribution

Original pstack © Lauren Tan (MIT). This port adapts platform bindings for Pi; see NOTICE and PARITY.md.
