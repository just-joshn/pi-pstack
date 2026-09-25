# pstack on Pi: runtime map

Pstack's Cursor orchestration calls now run through the `pstack-agents` extension. Read this map before your first `Task`, `Shell`, goal, or todo call in a session. Pi's agent directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) contains per-user configuration and session data.

## Delegation

Loading `/skill:poteto-mode`, or a pstack skill whose steps launch agents, authorizes only the fan-out that skill names. Use the configured `subagent_type` for each role. Do not replace a prescribed Task with parent work because the task looks small.

## Task and run tools

| Cursor tool or field | Pi behavior |
|---|---|
| `Task({description, prompt, subagent_type, ...})` | Launch an agent. `description`, `prompt`, and `subagent_type` are required. `generalPurpose` resolves to `pstack-general`; `poteto-agent`, `pstack-reader`, and `Comment Sicko` name their agent files. |
| `run_in_background: true` | Return an `agent_id` and notify the parent on completion. Without it, `Task` runs in the foreground and returns the child's text. Parallel fan-out uses several `Task` calls in one message. |
| `readonly: true` | Limit the agent to `read`, `grep`, `find`, and `ls`. |
| `model` | Pass a configured provider/model id and thinking suffix, such as `openai-codex/gpt-6-luna:max`. Omit `model` to use the parent model. See [Which model a spawn uses](#which-model-a-spawn-uses). |
| `attachments` | Attach file paths as context. Pi includes each file in the child's first prompt. |
| `environment: "local"` | Run in the current checkout. The agent can see its uncommitted state. |
| `environment: "cloud"` | Run locally in a separate managed git worktree. The worktree separates files, not processes: it is not a sandbox, and the run keeps your shell, network, and credential access. Set `cloud_base_branch` to a named branch after fetching it, for example `origin/main`. Do not pass a raw SHA. |
| `Task({resume: agent_id, ...})` | Continue an existing agent. Include its current task details and standing orders in the new prompt. |
| `Task({resume: agent_id, interrupt: true})` | Stop an agent. |
| `SubagentAwait({agent_id, timeout_ms})` | Wait for an agent. Use `timeout_ms: 0` for a status probe. A timeout does not stop the agent. |
| `Shell({command, is_background, output_notification})` | Run a shell command. `output_notification` accepts a regex string or `{pattern, reason?, debounce?, notification_limit?}` with patterns up to 500 characters; debounce is in seconds with a five-second default and minimum, and the notification limit defaults to 100. Set both background fields to receive a wake on a matching output line and another when the command exits. |
| `Await({task_id, block_until_ms?, regex?})` | Wait for a Shell task, an agent, or a matching Shell output line. A timeout does not stop the run. |
| `CreateGoal({objective})` | Create the current conversation branch's goal. It requires an interactive TUI or RPC session. |
| `UpdateGoal({status})` | Set the goal to `ACTIVE`, `PAUSED`, `COMPLETE`, or `CLEARED`. `/goal` shows the current goal. |

`Task` has no timeout field. `Shell` has `timeout` and `hard_timeout` fields. Keep long-running agent work in a background Task and inspect it with `SubagentAwait`.

## Loops and goals

Use a background Shell loop for recurring or event-driven work. Print a unique sentinel line and set `output_notification` to a regex that matches it. For a fixed interval:

```bash
while true; do
  sleep <seconds>
  echo 'AGENT_LOOP_TICK_<purpose>'
done
```

For an event watcher, print `AGENT_LOOP_WAKE_<purpose>` only when the event fires. Use a separate one-shot background Shell that prints the same wake prefix as a fallback heartbeat when needed. Use `Await` to receive output and completion notifications. Track the Shell task_id. Stop it with `Task({ resume: task_id, interrupt: true })`, which stops its whole process group. Never kill the PID. Use `Await({task_id})` to confirm it stopped.

An active goal continues across turns and pauses after three continuations without a tool call. Create it with `CreateGoal({objective})`. Update it with `UpdateGoal({status: "ACTIVE"})`, `UpdateGoal({status: "PAUSED"})`, `UpdateGoal({status: "COMPLETE"})`, or `UpdateGoal({status: "CLEARED"})`.

## Humans, todos, and transcripts

| Cursor term | Pi equivalent |
|---|---|
| `AskQuestion` | The `questionnaire` tool (the `questionnaire` extension). Use `questionnaire({questions: [{id, prompt, options: [{value, label, description?}], allowOther?, allowMultiple?}]})`. Dialogs work whenever the session has a UI, including RPC. Without a UI, ask in chat using the lettered block and end the turn. Ask only for a genuine product or preference call. |
| `TodoWrite`, todolist | The `todo` tool (the `todo` extension). Add all steps in one call with `todo({action: "add", items: [...]})`. Mark work with `todo({action: "set", id, status: "in_progress"})` and close it with `completed` or `cancelled`. Keep skipped steps as `<step> skip: <reason>`. |
| Active workspace transcripts (`agent-transcripts/`) | Cursor's `agent-transcripts/` maps to the directory holding `$PI_SESSION_FILE`: `~/.pi/agent/sessions/--<cwd with each "/" as "-">--/`. Top-level sessions are `<timestamp>_<id>.jsonl`. A Task transcript is under `<session file basename>/<agent_id>/session.jsonl`; run data is under `pstack-agents/<agent_id>/` in that same directory. |
| Transcript boundaries | Stay in the active workspace's session directory. Do not glob across `~/.pi/agent/sessions/*/`. Transcripts are JSON Lines. Chat turns use `type: "message"`; tool calls are content items of type `toolCall` with `name` and `arguments`. |

## Configuration, skills, and plugins

| Cursor term | Pi equivalent |
|---|---|
| `~/.cursor/rules/pstack-models.mdc` | The block between `<!-- pstack-models:begin -->` and `<!-- pstack-models:end -->` in `~/.pi/agent/AGENTS.md`. `/skill:setup-pstack` writes it. |
| Model-scope configuration | `~/.pi/agent/extensions/pstack-agents.json` stores a top-level `modelScope` object; `/skill:setup-pstack` writes it. |
| `.cursor/skills/<name>/` | `.pi/skills/<name>/` in the project, or `.agents/skills/<name>/`. |
| `~/.cursor/skills/<name>/` | `~/.pi/agent/skills/<name>/`. Pstack's own skills are package resources. |
| `.cursor/rules/`, `AGENTS.md` rules | `AGENTS.md` in the project, or `.pi/APPEND_SYSTEM.md`. |
| Slash skill `/<name>` | `/skill:<name>`. Skills with `disable-model-invocation: true` run only through that command or when another skill names their path. |
| Cursor's built-in `create-skill` | The local `create-skill` skill (`/skill:create-skill`). |
| `mode: true`, `reminder:`, sticky mode | The `pstack-mode` extension keeps poteto-mode active for the session, repeats its reminder, shows `👑 poteto`, and supports `/poteto off`. `/skill:setup-pstack` also writes the reminder into the pstack block of `~/.pi/agent/AGENTS.md`, so it survives compaction and new sessions. |
| Paths in poteto-mode playbooks | Resolve references from the skill directory. Use `playbooks/...` or `scripts/...` for files in this skill and `../<skill>/...` for another skill. Pass absolute paths to Tasks because agents can run in another checkout. |
| Broken installed skill | Confirm breakage from the skill's own references. Edit the installed copy at the path Pi loaded it from; never search `~` or unrelated repos for its source. Open a PR only against a skills repo the operator named. |

## MCP and external evidence

Pi has no built-in MCP. MCP tools exist only when an adapter extension is installed. A Task inherits the parent's active tools unless its agent definition sets a `tools` list. `readonly: true` permits only `read`, `grep`, `find`, and `ls`, so use a writable agent such as `pstack-general` when the task needs MCP.

Find evidence sources in this order:

1. MCP tools in your tool list, or available to a writable `pstack-general` Task.
2. Local CLIs on `PATH`. Check with `command -v`. Examples include `gh`, `glab`, `linear`, `jira`, `sentry-cli`, `datadog-ci`, `bq`, `snowsql`, `databricks`, and `psql`.
3. Local exports and files, such as docs folders, `*.md` design notes, saved chat exports, and incident docs in the repo.

A category with none of these is a gap. Name it in the coverage map. Never fake it.

## Which model a spawn uses

Map every Task to its pstack role before setting `model`. Code writers use `feature, refactoring`, `bug-fix`, `perf-issue`, or `hillclimb`. Reviewers, judges, verifiers, auditors, synthesizers, and prose use `judgment and prose` unless a skill names a role. Explorers and investigators use their skill's role. A Task that fits no line uses `judgment and prose`.

Use the exact provider/model id and thinking suffix in the pstack model block. A role value of `inherit-parent` or `auto` means omit `model` to inherit the parent model. `/skill:setup-pstack` writes `modelScope` to `~/.pi/agent/extensions/pstack-agents.json`; a Task model outside that configured scope fails. See the `pstack-models` block in `~/.pi/agent/AGENTS.md` when its values are available in the context. If the block is absent, use the skill defaults.
