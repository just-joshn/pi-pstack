# pi-pstack

Native [Pi](https://pi.dev) package porting [Cursor pstack](https://github.com/cursor/plugins/tree/main/pstack) (v0.15.2) at maximum practical parity.

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

## Quick start

1. `pi install` this package.
2. Optional: `/setup-pstack` to write `~/.pi/agent/pstack-models.json` (per-role models).
3. `/poteto-mode` or `/skill:poteto-mode` for sticky poteto-mode.
4. Use skills via `/skill:<name>` (e.g. `/skill:how`, `/skill:arena`, `/skill:interrogate`).

## Tools (extensions)

| Tool | Purpose |
|------|---------|
| `pstack_spawn` | One isolated Pi child agent (`role`: poteto-agent / comment-sicko / general) |
| `pstack_swarm` | N parallel workers → one report |
| `pstack_arena` | N candidates (+ optional cross-judge) for arena pick/graft |
| `pstack_loop` | Heartbeat / settle / watcher wakes (Cursor `/loop` twin) |
| `pstack_deslop` | Diff slop scan (cursor-team-kit `/deslop` twin) |
| `pstack_control_cli` | CLI/TUI proof capture |
| `pstack_control_ui` | HTTP UI probe (+ browser MCP for full drives) |
| `pstack_sessions` | List/grep Pi sessions for recall |
| `pstack_babysit` | gh / watch-pr PR watch |
| `pstack_ship` | gh stack-aware land helper |
| `pstack_decision_log` | Append `decisions.tsv` rows (show-me-your-work) |
| `pstack_worktree` | Create/list git worktrees for isolated writes |

Cursor `Task` / `subagent_type` map to these tools. Built-in Pi tools remain `read` / `write` / `edit` / `bash`.

## Commands

- `/poteto-mode` [task] — sticky poteto-mode on (+ optional task)
- `/poteto-mode-off` — sticky off
- `/pstack` [task] — alias / help
- `/setup-pstack` — write model role config
- `/pstack-gates` — pre-ship gate reminder

Slash prompt aliases under `prompts/` expand common short names.

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
