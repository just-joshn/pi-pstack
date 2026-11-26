# Changelog

## 0.4.1 (Unreleased)

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

- Arena candidates no longer see the rubric; only the judge does.
- The arena judge excludes only the parent's vendor, so upstream's default panel has a judge. An arena with no judge runs and reports the judge as skipped, and a candidate that drops out leaves the judge scoring the rest.
- Interrogate adversaries and Comment Sicko work in their own writable worktrees, and the CI watcher has a shell, so each can do what upstream asks of it.
- Worker kickoffs no longer add a line that overrode `worker.md`.
- `/poteto-mode` and persistent mode give the skill's file path, so its relative paths resolve.
- Write workers keep MCP tools, as upstream's agent-mode subagents do.

CHANGED:

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
