# Changelog

## 0.5.1 (Unreleased)

CHANGED:

- GitHub Actions verifies and stages an npm tarball on a version bump. A maintainer reviews and approves it on npm with 2FA.
- After npm publishes the approved version, GitHub Actions verifies its provenance and creates the matching tag and release from the exact source commit.

## 0.5.0 (Unreleased)

BREAKING CHANGES:

- Supported Node.js releases now start at 22.23.5, 24.22.3, or 26.13.1 within those major versions. The tested Pi range is 1.6.0 to 1.6.1.

CHANGED:

- Use npm and Biome for root development. The bundled `watch-pr` command still uses Bun.
- CI checks the packed Pi extension, audits dependencies, and reports root and bundled CLI coverage.

FIXED:

- `pstack_workers` no longer leaves workers queued after failed admission or session shutdown.
- Benny advances the Slack cursor only after a runner acknowledges its claim. It reports an incomplete claim without replaying the report.
- `watch-pr --timeout` cancels active queries during discovery and polling.
- Statechart reports child startup failures and removes its temporary directories.
- The `autopilot-stack` checklist keeps parent-branch rebases and stops after verification, before merge.

## 0.4.1 (2026-11-26)

BREAKING CHANGES:

- Every skill, playbook, principle, agent and reference is now upstream's file, ported by hand, in place of a summary written from the source map. Skills follow upstream's steps, so their behavior changes wherever the summaries differed.
- With no `pstack-models.json`, roles take upstream's default models (Opus 5.5, and a Fable 5.2, Opus 5.5 and Gemini 4 Neon panel), matched to the models workers can use, instead of the parent model.
- `pstack_delegate` starts writing workers without asking, as upstream's Autonomy rule lets reversible work proceed.
- Benny jobs follow upstream's design: both start on a new top-level report (`source_channel_id`, `message_ts`, `thread_ts`), and repro waits for the triage marker itself. A Benny job's `config` holds only `sourceChannel` and `defaultBranch`; the rest of the configuration is upstream's YAML, which the agent reads. The tool policy that refused `bash`, commits and PR tools is gone, since upstream's repro runs tests, commits and opens a draft PR. The configuration example is now `src/automations/benny/templates/configuration.example.yaml`.
- The `quality-agent` worker role is now `thermo-nuclear-code-quality-review`, its upstream name.

NEW FEATURES:

- `/reframe` and `/skill:reframe` from upstream pstack 0.15.48. It gives the expert terms for what you are building, with checked sources and terms from neighboring fields, and rewrites your description with them. It does not do the task.
- The two Team Kit rules, `no-inline-imports` and `typescript-exhaustive-switch`, in upstream's wording, are appended to the system prompt while poteto-mode is on. Upstream marks them `alwaysApply`; they are limited to poteto-mode so that sessions not using pstack, which may not be TypeScript projects, do not pay for them. Before, the package only kept them as reference files that nothing loaded.
- `pstack_delegate` takes `model` and `thinking` per call, `models` for panel seats and swarm race arms, `resume` to continue a worker's own session, and `background` to return at once while workers keep running.
- `pstack_workers` lists the session's workers with their state and last activity, and stops a background worker.
- `pstack_wake` action `start` lets the agent arm the wake loop, as upstream's agent arms `/loop`.
- `pstack_plan` action `add` adds tasks to the open plan, after a given task or at the end.
- The guide (`src/docs/guide`) and upstream's scripts ship with the package: `watch-pr`, `worktree-audit.sh`, `log.sh`, the statechart tools and the PR review canvas.
- A custom job takes an optional HMAC-signed event, which `/make-bot-ui` uses to wake a bot from a button.
- After saving, `/setup-pstack` offers each verification skill the project lacks.
- Benny is upstream's automation pack, ported by hand, in `src/automations/benny/`, with the runtime it needs in Pi: `/pstack-automation` drafts each job from upstream's prompt template, `check-benny.mjs` checks the target repository the way upstream's setup does, `watch-slack.mjs` starts both jobs for each new top-level Slack report, and the runner gives each run a fresh checkout of the default branch, upstream's trigger in its placeholders and pstack's project-scoped skills.

FIXED:

- Write workers have MCP tools, as poteto-mode says. `--no-extensions` also turned off Pi's built-in MCP, `codemode` and `tool_search` extensions, so they had none; they now load all three and get `codemode` and `tool_search`, the only ways Pi reaches an MCP tool that is not exposed directly.
- `pstack_delegate` mode `interrogate` honors an explicit `readOnly: true`; only its default is writable.
- Resuming a worker that is still running, or that another resume is running, is refused, instead of starting a second Pi process on the same session. A resume with `background: true` is refused, since resume runs in the foreground.
- A worker whose first launch left no session cannot be resumed; before, the resume started a fresh session with only the follow-up task.
- A job runner that is sent `SIGTERM` or `SIGINT` kills its Pi with `SIGKILL` if it has not exited 5 seconds later, and records the run as `stopped`. A stop that arrives while a Benny run is still fetching, checking out or probing its skills kills that step, records `stopped`, and Pi never starts. A stopped run always exits nonzero, even when its Pi exits cleanly on `SIGTERM`, and the runner handles a stop from its first line, so a stop can never leave a claimed run folder without a receipt.
- Two resumes of one worker started together cannot both run.
- A foreground worker whose `pstack_delegate` call is cancelled is listed as `stopped`, not `failed`, including one still waiting for a slot, which no longer stays `queued`.
- A job runner stopped while it opens its log files no longer starts Pi.
- A resume refuses `readOnly`, `role`, `modelRole`, `models`, `base`, `rubric` and `concurrency` instead of silently ignoring them; it continues the worker as it was.
- A Benny run's skill check no longer receives `PSTACK_EVENT_SECRET` or `PSTACK_SLACK_TRIGGER_TOKEN`; it gets the same cleaned environment as the run.
- A Benny job reaches the MCP tools it names. It loaded only `builtin:mcp`, and Pi offers MCP tools only through `codemode` and `tool_search`, so a job that named its Slack tools could not call them; jobs now load the same three built-in extensions as write workers.
- The Slack watcher waits for each run's process to start, so a failed start fails the dispatch, and the report is retried, instead of crashing the watcher after the report was marked seen.
- `check-benny.mjs` counts a required path that is committed as a folder or a symlink as missing, removes only its own worktree instead of pruning every stale one, and stops a Pi probe that ignores `SIGTERM`.
- The Benny skill check gives up after 60 seconds if Pi does not answer, instead of hanging the check or the run.
- `check-benny.mjs` tells a job file from a repository by what is on disk, not by a `.json` suffix.
- A second Slack watcher on the same state file refuses to start, instead of both overwriting each other's cursors. The claim is a localhost port derived from the state file's path, which the OS frees when the watcher exits, crash included, so there is no stale claim to recover.
- The Slack watcher stops on a saved state file it cannot read whole, including an empty or malformed cursor, instead of dropping it and skipping that channel's reports or replaying its history.
- `check-benny.mjs` checks a referenced path with spaces whole when it is in backticks or on its own line.
- A failed `pstack_plan` call shows its error in the conversation instead of "No plan".
- A resumed worker is listed with the resume's outcome and report, not the run it continued.
- `check-benny.mjs` requires every file of the Benny pack, as upstream's setup does, not only its entry files.
- The Slack watcher's cursor moves past messages that are not reports, and saves at once, so it no longer fetches them again on every poll, even while another channel's poll is failing.
- Every worker run goes through one registry: foreground and background workers, resumes and arena judges. `pstack_workers` lists those waiting for a slot as `queued`, can stop any queued or running one, and lists a stopped one as `stopped`, not `failed`.
- `pstack_workers` lists a finished foreground worker, including an arena's judge, as `done`, or `failed` with its error, as it lists a background one.
- Stopping a queued background worker takes it off the queue at once and lists it as `stopped`; it no longer waits for a running worker to finish.
- The `autopilot-stack` plan is `autopilot-full`'s seven steps with its two overrides applied, as the playbook says, not only the two overrides. The stacking exception is attached to the step it qualifies, not listed as a separate task that contradicts it.
- Background workers run with no time limit, as `pstack_delegate` says; they had a hidden 7-day cap.
- `pstack_workers` lists a running foreground worker as `running`, not `finished`, and no longer lists an arena's `blinded/` folder as a worker.
- The Slack watcher replaces its cursor file atomically, so a crash mid-write cannot leave a file that stops every later poll.
- A Benny prompt that uses only some of the trigger placeholders also gets the whole trigger appended, so the run always knows its report's timestamp.
- `pstack_workers` lists a worker its session left queued or running as `interrupted`, instead of queued forever.
- Two Benny jobs in one folder each run the same report; they no longer share a run folder. One job reached through two paths, such as a symlinked folder or a symlink to the job file, is still one job: its run folder, run key and watcher's claim follow the file's real path.
- The Slack watcher sets and saves every new channel's starting point before polling any channel, so a failing poll elsewhere cannot skip a new channel's first reports.
- Benny runs that start together, as triage and repro always do, no longer collide on the repository's fetch. Each fetches the default branch into its own ref; before, when the branch had moved, one of the two failed about half the time, and runs on different branches could check out each other's code.
- Background workers respect `concurrency`, are listed as `queued` until they start, and a worker that fails before its session exists is listed with its error. Status files are written atomically, so a listing never reads half a file.
- The package ships upstream pstack's and Cursor Team Kit's MIT license notices, in `src/licenses/`, with the files it ports from them. 0.4.0 shipped those files without the notices.
- Arena candidates no longer see the rubric; only the judge does.
- The arena judge excludes only the parent's vendor, so upstream's default panel has a judge. An arena with no judge runs and reports the judge as skipped, and a candidate that drops out leaves the judge scoring the rest.
- Interrogate adversaries and Comment Sicko work in their own writable worktrees, and the CI watcher has a shell, so each can do what upstream asks of it.
- Worker kickoffs no longer add a line that overrode `worker.md`.
- `/poteto-mode`, every workflow command, persistent mode and `pstack_plan start` give the file's path and both bases upstream's files use: a path starting with `../` resolves from the file's folder, other relative paths from its skill's folder. A playbook's `playbooks/shipping.md` and its `../references/bugbot-triage.md` both resolve; `pstack_plan start` gave no location at all.
- Write workers keep MCP tools, as upstream's agent-mode subagents do.

CHANGED:

- The plan no longer sits in a widget above the editor. Each `pstack_plan` change draws the checklist in the conversation, with a one-line header such as `pstack_plan update 2 → done`, and scrolls away like any tool call; the status bar keeps its one-line progress.
- The source map follows upstream `cursor/plugins` at `41e4009` (pstack 0.15.48) instead of `7a58391` (pstack 0.15.46). Team Kit has no changes between the two. The map has 162 nodes, and the package has 77 skills and 53 slash commands.
- `scripts/generate.py` only builds the catalog, the plan steps from each playbook, and the parity listings.
- A test checks that no ported file names a Cursor mechanism. During the port, each file was also checked against upstream's for its name, headings, numbered steps and line layout; the upstream copies are not kept in the repository.

## 0.2.0 (2026-11-25)

BREAKING CHANGES:

- The headless job runner moved from `scripts/run-job.mjs` to `src/jobs/run-job.mjs`. Update any scheduler or script that runs it from an installed package: `node src/jobs/run-job.mjs --run <job.json> [signed-event.json]`.
- The package no longer has top-level `agents/`, `lib/`, `reference/`, `scripts/` or `skills/` directories. They are now under `src/`. For example, the Benny configuration example is now at `src/reference/benny/config.example.json`.

ADDED:

- oxlint enforces the coding-style limits: functions under 50 lines, files under 800 lines, and nesting no deeper than 4 levels. `no-console` is now an error.
- Tests for the input boundaries of JSON parsing and record checks, and of job and signed-event validation.
- Tests that a running write worker's worktree is reported active and cannot be removed, that the job runner passes Pi skill and extension paths that exist, and that the package publishes only `src/`.

CHANGED:

- The package publishes only `src/`, and Pi loads the skills from `src/skills`.
- The coverage gate covers every TypeScript file in `src/`, which now includes `src/lib/` and `src/jobs/job-input.ts`.
- `scripts/generate.py` writes its outputs into `src/` and reports stale files with paths relative to the repository root.
- Tests are organized with one file per feature and no `describe` wrappers.
- Extension functions longer than 50 lines are split into smaller functions.
- The worktrees module owns the record of which worktrees write workers are using. Delegation no longer edits a set shared through `src/index.ts`.
- The parent diff that `pstack_delegate` gives workers starts at the merge base with the remote's default branch (`origin/HEAD`), so it includes committed branch work. Before, it held only uncommitted changes, and reviewers of committed work got an empty file. Without `origin/HEAD`, it still starts at `HEAD`.
- The branch state that extension commands read is a frozen copy, so it changes only through a commit that saves it and refreshes the status bar.
- The package `homepage` links to the repository README instead of a deleted branch.

## 0.1.1 (2026-11-25)

NEW FEATURES:

- pstack workers can use models whose provider an extension registers, such as `claude/*` from pi-claude-oauth. `/setup-pstack` lists those models, and delegation loads only the extension that lists the worker's model.

ADDED:

- GitHub Actions checks every pull request: formatting, lint, type checking, generated files, tests with the coverage gate on Node 22.19.0, 24 and 26, and a smoke test on real Pi.
- A push to `main` publishes a new `version` to npm and creates its tag and GitHub release.
- An action lockfile, a lockfile check and a Dependabot configuration for the workflows.
- A coverage gate that requires 80% statement, branch, function and line coverage in each extension file, and 31 tests that meet it.

CHANGED:

- The extension moved from `extensions/` to `src/`, with `src/index.ts` as the entry point.
- The code passes strict TypeScript compiler settings and type-aware oxlint rules.
- The source map and catalog data are validated by type guards when they load.
- The tests are TypeScript on Vitest 5.
- `bun fmt` formats the repository.

REMOVED:

- oxfmt.
- The `smoke`, `generate`, `check:generated` and `check:ci` package scripts. Run `node scripts/smoke.ts` and `python3 scripts/generate.py [--check]` directly.

## 0.1.0 (2026-11-24)

NEW FEATURES:

- A native Pi extension for the pstack and Team Kit workflows.
- 76 native skills, including 52 slash commands, and 22 ordered playbooks, generated from the upstream source map.
- Branch-local plans and goals, `poteto-mode`, and bounded wake loops that only the operator can start.
- Catalog browsing, a decision log and session history.
- Read-only and isolated write delegates in single, swarm, arena and interrogate modes, with configurable role models and a cross-provider arena judge.
- Worktree audit, creation and approved removal.
- PR inspection and a shipping gate that merges a verified prefix of PRs only after operator approval.
- A local headless job runner, with disabled automation drafts and dormant Benny configuration and instructions.
- Public npm distribution as `pi-pstack-workflow-kit`.
