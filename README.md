# pstack for Pi

This package ports [pstack](https://github.com/cursor/plugins/tree/main/pstack) 0.15.5, Lauren Tan's Cursor plugin, to the [Pi coding agent](https://pi.dev). It installs as one Pi package with the pstack skills, the two pstack agents, and the Pi extensions that stand in for Cursor's built-in tools.

The skill text is the upstream text wherever Pi can run it unchanged. The parity tooling in `parity/` measures that lexically: 4,879 of 4,933 upstream sentences are carried (98.91%), and each of the 362 Pi-only sentences has a recorded reason. The score counts matching wording, not matching behavior. The tests, the runtime probes, and the audit reports in `parity/evidence/` cover behavior.

## Install

This package is tested on Pi 0.87.1. To install from GitHub, run:

```bash
pi install git:github.com/just-joshn/pi-pstack@pi-pstack-0.15.5
```

To install from a local checkout, run `pi install ./pi-pstack`. Pi records the package in `~/.pi/agent/settings.json`. Add `--local` to record it in the project's `.pi/settings.json` instead.

If you copied pstack skills, agents, or extensions into `~/.pi/agent` before, move those copies out first. Pi keeps the first skill it finds for each name, so an old copy hides the package's copy. An old copy of an extension loads alongside the package's copy.

## Get started

1. Run `/skill:setup-pstack`. Pick a reasoning budget and a model for each role.
2. Run `/skill:poteto-mode` for any task that needs rigor. The footer shows `👑 poteto` while the mode is on. Type `/poteto off` to turn it off.

The other skills are situational. poteto-mode loads them when a playbook calls for them. You can also run any skill directly, for example `/skill:how how does the cache get invalidated?`.

`setup-pstack` writes two files in Pi's agent directory (`~/.pi/agent` by default, or `$PI_CODING_AGENT_DIR` when set):

- `AGENTS.md` gets a block between `<!-- pstack-models:begin -->` and `<!-- pstack-models:end -->`. The block holds the model for each role and the poteto-mode reminder. The rest of the file is left as it is.
- `extensions/pstack-agents.json` gets a `modelScope` object. The `Task` tool refuses any model outside its `allow` list.

## What the package contains

| Path | Contents |
|---|---|
| `skills/` | The 47 upstream pstack skills, plus seven skills that the upstream text names and Cursor ships built in: `control-cli`, `control-ui`, `create-skill`, `deslop`, `goal`, `loop`, and `skill-design-principles`. |
| `agents/` | `poteto-agent` and `Comment Sicko` from upstream, plus `pstack-general` and `pstack-reader`, which stand in for Cursor's writable and read-only general agents. |
| `extensions/pstack-agents/` | The `Task`, `SubagentAwait`, `Shell`, `Await`, `CreateGoal`, and `UpdateGoal` tools and the `/goal` command. |
| `extensions/pstack-mode.ts` | Sticky poteto-mode (Cursor's `mode: true` and `reminder:`), the footer badge, and `/poteto`. |
| `extensions/questionnaire.ts` | The `questionnaire` tool, Pi's form of Cursor's `AskQuestion`. |
| `extensions/todo.ts` | The `todo` tool and `/todos`, Pi's form of Cursor's `TodoWrite`. |
| `extensions/pstack-guards.ts` | Guards that block a background polling loop in `bash`, block `write` and `edit` calls on installed skills unless you asked for the edit, and keep Task children other than `poteto-agent` out of the poteto-mode playbooks. |
| `docs/`, `automations/`, `assets/` | Upstream files, unchanged. |

## How Pi differs from Cursor

Pi has no built-in subagent, background shell, goal, or question tools. The `pstack-agents` extension adds them with Cursor's argument names, and `skills/poteto-mode/references/pi-runtime.md` maps every Cursor term the skills use. The differences a user notices are:

- Skills run as `/skill:<name>`, not `/<name>`.
- `Task` runs in the foreground unless `run_in_background` is true or the agent file sets `is_background: true`. A background run keeps going when Pi quits, and its completion notice arrives once after you resume the session. A foreground run stops when its session shuts down.
- A Cursor cloud agent runs locally in its own git worktree, which separates files but is not a sandbox (`environment: "cloud"` with `cloud_base_branch`). `Task` refuses `machine` and `cloud_requested_environment_build_id` with an error, because Pi has no remote machines.
- Subagent token usage and cost reach the parent session's totals once for each run attempt, on the first `Task`, `SubagentAwait`, or `Await` result that sees the run finish successfully. A failed run, or a background run that you never wait on, is not counted.
- `pstack-guards.ts` and the model allow list are Pi additions. Cursor has neither. The guards check tool calls. They are not a sandbox: a shell command can still write a skill file.

## Check the package

The tests run with [Bun](https://bun.sh). To run every check from a checkout, run:

```bash
npm install
npm run check
```

`npm run check` runs the type check, the unit and probe tests, the parity checks against the vendored upstream in `parity/upstream/0.15.5`, `parity/lint-package.mjs`, and `parity/provenance.mjs`. The lint reads the `npm pack` file list and fails on unportable paths, a broken manifest, or invalid skill frontmatter. `parity/provenance.mjs` fails if a file is a byte-for-byte copy from the pre-package tree. `parity/decisions-package.tsv` records every packaging decision and the evidence for it.

## Credits and license

pstack is by [Lauren Tan](https://x.com/poteto). The upstream README is at `parity/upstream/0.15.5/pstack/README.md`, and the [pstack guide](./docs/guide/README.md) walks through a first task. The Pi port is by [@just-joshn](https://github.com/just-joshn). Both are MIT licensed. See `LICENSE`.
