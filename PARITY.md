# Native parity

This repository ships the Pi-native pstack surface, not a parallel family of host tools.

The live reference is `~/.pi/pstack`. That package is three extensions, the skill tree, four agents, and the dormant benny pack. It is the same architecture the reverse-engineering spec asks a non-Cursor harness to build: playbooks and principles as skills, `orch` / `watch-pr` / `check-plan` as real programs, and the host's own subagent / slash / todo primitives.

## Surface

| Piece | What it is |
|---|---|
| `extensions/subagent/` | Pi's subagent tool (single, parallel, chain) plus bundled agent discovery |
| `extensions/pstack-slash.ts` | `/how` becomes `/skill:how` so skill slashes match the original spelling |
| `extensions/todo.ts` | `todo` tool and `/todos` for verbatim playbook step lists |
| `skills/` | poteto-mode, 23 playbooks, 23 principles, how/why/arena/swarm/architect/interrogate, setup-pstack |
| `agents/` | `poteto-agent`, `Comment Sicko`, `reviewer`, `worker` |
| `skills/poteto-mode/scripts/` | `orch`, `watch-pr`, `check-plan.mjs`, `worktree-audit.sh`, `check-port.mjs` |

Skills call the `subagent` tool with `agent: "poteto-agent"` / `"worker"` / `"reviewer"` / `"Comment Sicko"`. They do not call a parallel spawn tool. `/setup-pstack` writes `~/.pi/agent/AGENTS.md`.

## Gates

```
npm test                       # check-port + conformance + vitest
node tests/native-parity.mjs   # byte compare to ~/.pi/pstack when that tree exists
bun test skills/poteto-mode/scripts
```

`check-port.mjs` fails when a skill drifts toward host-only tooling, when frontmatter will not load, when slash aliases drift from `skills/`, and when a relative link is dead. `tests/run-check-port.mjs` runs that checker over the published package files so local agent notes are not part of the gate.

## Not shipped here

See the README section of that name. Benny stays a dormant pack under `automations/benny/`.
