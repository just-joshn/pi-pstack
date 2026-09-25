# How findings for U3b

## Agent discovery and request parsing

- `extensions/pstack-agents/index.ts` registers Task and `executeTask` passes Pi runtime context to `loadTaskContext` and then `parseTaskInput` in `agents.ts`.
- `parseAgentFiles` reads `<agentDir>/agents` then trusted nearest `.pi/agents`, with later sources overriding names. It does not scan package `agents/`. The package definitions already exist under this worktree's `agents/`.
- `generalPurpose` maps to `pstack-general`, or `pstack-reader` when readonly. Frontmatter fields are validated into `AgentDefinition`; `is_background` is currently omitted. Run background defaults only from `input.run_in_background === true`.
- `modelScope` currently parses `<agentDir>/settings.json` at `subagents.modelScope`, unlike the setup skill's `<agentDir>/extensions/pstack-agents.json` top-level `modelScope`.
- `withGuardExtensions` currently searches `<agentDir>/extensions/pstack-guards.ts`. The runner disables discovered extensions and explicitly loads the request's selected extension paths.
- `runner.mjs` starts child Pi from an `AgentLaunchRequest`, constructing CLI args for model/tools, extension paths, skills inheritance, system prompt, and attachments.

## Task/Shell execution and results

- `index.ts` registers Task, Shell, Await, SubagentAwait, CreateGoal, and UpdateGoal. Task/Shell create launch records then call `runs.ts`; the detached `runner.mjs` stores request/status/events and child output.
- `contracts.ts` validates and reduces `events.jsonl`. Child assistant messages are stored in `RunRecordSummary.messages`, including raw usage data, but `RunStore` exposes no usage aggregation.
- Foreground Task and Shell results include final child output or shell log output in full. They mention transcript/log paths. Tool wrappers catch execution exceptions and return `{isError:true}`, though Pi's documented tool contract requires throwing. Failed run states are also returned as `isError`; Await timeout/detach is represented normally.
- Pi helpers `truncateHead`/`truncateTail` are documented for large model-facing tool output. The task can bound output in `index.ts`, and could sum child usage using the persisted message events without lifecycle changes.

## Guards, mode, and todo

- `pstack-guards.ts` blocks selected background polling commands, child reads of poteto playbooks, and unauthorized writes under `SKILLS_ROOT`. Its current skill root is built from `homedir()/.pi/agent/skills`; it does not include `getAgentDir()/skills` for custom agent directories or package `skills/`.
- `pstack-mode.ts` stores sticky mode in branch custom entries and inserts hidden prompt messages. Its reminder and named-skill instruction contain hard-coded `~/.pi/agent/skills/...` paths.
- `todo.ts` keeps `todos` and `nextId` in closure state, reconstructs from branch tool-result details, and has synchronous mutations. Pi permits same-message tool calls to run in parallel; the tool does not declare `executionMode`.
- The current registered-extension tests use lightweight harnesses, but many fake Pi objects use `as never`. Baseline typecheck reports seven errors in tests/todo result typing.

## Spec and baseline evidence

- Pi docs say package resources are package-root relative; skill docs say relative references resolve from the loaded skill and Pi tells the model the skill path; CLI `--skill <path>` loads a file or directory.
- Pi extension docs say throw from `execute()` for failure, attach nested usage, use sequential execution for shared in-memory state, and truncate large output with a full artifact path.
- Baseline `bun test extensions`: 69 pass. Baseline `npm run typecheck`: 7 errors. A direct empty-agent-dir discovery repro returned `[]`.
